use keyring::Entry;

const KEYCHAIN_USER: &str = "saple_bridge_user";

/// The renderer may only touch keychain entries following the documented
/// `saple_provider_<provider>_api_key` contract (see CLAUDE.md). `service` crosses the
/// renderer→Rust trust boundary, so mutating commands reject anything else — the account is
/// already pinned to `saple_bridge_user`, this closes off the service namespace too.
fn validate_service_name(service: &str) -> Result<(), String> {
    let provider = service
        .strip_prefix("saple_provider_")
        .and_then(|rest| rest.strip_suffix("_api_key"))
        .unwrap_or("");
    let valid = !provider.is_empty()
        && provider
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Invalid keychain service '{}': expected saple_provider_<provider>_api_key",
            service
        ))
    }
}

#[tauri::command]
pub async fn set_api_key(service: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_api_key_inner(service, key))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn set_api_key_inner(service: String, key: String) -> Result<(), String> {
    validate_service_name(&service)?;
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

// NOTE: there is intentionally no `get_api_key` Tauri command. Secrets are read only in Rust
// (e.g. PTY launch) via `get_api_key_inner`; the renderer uses `has_api_key` /
// `test_provider_connection` so a raw key never crosses the IPC boundary.
pub(crate) fn get_api_key_inner(service: String) -> Result<String, String> {
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

/// Report whether a key is stored for `service` WITHOUT returning the secret to the renderer.
/// The settings UI uses this (not `get_api_key`) so the key string never crosses the IPC
/// boundary — Rust reads it internally via `get_api_key_inner`.
#[tauri::command]
pub async fn has_api_key(service: String) -> Result<bool, String> {
    validate_service_name(&service)?;
    tauri::async_runtime::spawn_blocking(move || match get_api_key_inner(service) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::validate_service_name;

    #[test]
    fn accepts_provider_convention_services() {
        for s in [
            "saple_provider_codex_api_key",
            "saple_provider_claude_api_key",
            "saple_provider_openrouter_api_key",
            "saple_provider_custom_api_key",
            "saple_provider_a1_b2_api_key",
        ] {
            assert!(validate_service_name(s).is_ok(), "{s} should be accepted");
        }
    }

    #[test]
    fn rejects_arbitrary_services() {
        for s in [
            "openai_api_key",
            "saple_provider__api_key",
            "saple_provider_UPPER_api_key",
            "saple_provider_a b_api_key",
            "some_other_apps_secret",
            "",
        ] {
            assert!(validate_service_name(s).is_err(), "{s:?} should be rejected");
        }
    }
}

/// Provider connectivity "test" for the Settings UI. Confirms a key is stored for `provider`
/// by reading it internally in Rust — it never returns or overwrites the secret. (The previous
/// renderer implementation wrote a sentinel `"test-connection"` into the keychain, destroying the
/// user's real key.) The seam is here for a future real per-provider HTTP probe.
#[tauri::command]
pub async fn test_provider_connection(provider: String) -> Result<bool, String> {
    let service = format!("saple_provider_{}_api_key", provider);
    has_api_key(service).await
}

#[tauri::command]
pub async fn delete_api_key(service: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_api_key_inner(service))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn delete_api_key_inner(service: String) -> Result<(), String> {
    validate_service_name(&service)?;
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    // We match on error because if the key doesn't exist, delete_password returns an error
    // which we can safely ignore or return
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Safe to ignore if already deleted
        Err(e) => Err(e.to_string()),
    }
}
