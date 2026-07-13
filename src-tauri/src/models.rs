// Live model discovery (P8). Bridge's model pickers are comboboxes fed by three layered sources:
// stable CLI aliases and recents live in the frontend; this module supplies the third layer -
// the provider's own current model list, fetched with the keychain API key.
//
// The key is read only in Rust (never crosses IPC, mirroring keychain.rs) and used for one GET to
// the vendor's models endpoint. Discovery is best-effort: no key, offline, an auth failure, or a
// provider without a public models API all resolve to an empty list so the picker silently falls
// back to aliases + recents. `is_safe_model` in pty.rs remains the launch-time gate; nothing here
// changes what can actually launch.

use std::time::Duration;

use crate::keychain::get_api_key_inner;

// How a provider authenticates its models endpoint and where the id list lives in the response.
#[derive(Clone, Copy)]
enum Auth {
    // Authorization: Bearer <key> — OpenAI-compatible (codex/OpenAI, OpenRouter, xAI/grok).
    Bearer,
    // x-api-key + anthropic-version headers.
    Anthropic,
    // x-goog-api-key header (Google Generative Language API).
    Google,
}

// Maps a Bridge CLI provider id to (endpoint, auth, json array key, id field). Only providers with
// a public models-list API appear here; every other provider has no live source. Endpoints are the
// stable list routes, not version-pinned — the ids they return are the live catalog, not baked into
// source (so nothing rots here).
fn models_source(provider: &str) -> Option<(&'static str, Auth, &'static str, &'static str)> {
    match provider {
        "claude" => Some(("https://api.anthropic.com/v1/models", Auth::Anthropic, "data", "id")),
        "codex" => Some(("https://api.openai.com/v1/models", Auth::Bearer, "data", "id")),
        "openrouter" => Some(("https://openrouter.ai/api/v1/models", Auth::Bearer, "data", "id")),
        "grok" => Some(("https://api.x.ai/v1/models", Auth::Bearer, "data", "id")),
        // Google returns `models: [{ name: "models/gemini-..." }]`; the "models/" prefix is stripped below.
        "gemini" => Some((
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
            Auth::Google,
            "models",
            "name",
        )),
        _ => None,
    }
}

/// List the provider's current model ids using the stored keychain key. Returns an empty list on any
/// failure (no key, offline, auth error, unknown provider) so callers can silently degrade.
#[tauri::command]
pub async fn list_provider_models(provider: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_provider_models_inner(&provider)))
        .await
        .map_err(|e| e.to_string())?
}

fn list_provider_models_inner(provider: &str) -> Vec<String> {
    // `provider` reaches a keychain service name; hold it to the same lowercase/digit shape the
    // keychain validator enforces so a malformed id can't probe an unexpected service.
    if provider.is_empty()
        || !provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Vec::new();
    }
    let Some((url, auth, array_key, id_field)) = models_source(provider) else {
        return Vec::new();
    };
    let key = match get_api_key_inner(format!("saple_provider_{}_api_key", provider)) {
        Ok(k) if !k.is_empty() => k,
        _ => return Vec::new(), // no key stored — skip discovery, don't surface an error
    };

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .build();
    let mut req = agent.get(url);
    req = match auth {
        Auth::Bearer => req.set("Authorization", &format!("Bearer {}", key)),
        Auth::Anthropic => req
            .set("x-api-key", &key)
            .set("anthropic-version", "2023-06-01"),
        Auth::Google => req.set("x-goog-api-key", &key),
    };

    let body = match req.call() {
        Ok(resp) => match resp.into_json::<serde_json::Value>() {
            Ok(v) => v,
            Err(_) => return Vec::new(), // non-JSON body — silent fallback
        },
        Err(_) => return Vec::new(), // offline / auth failure — silent fallback
    };

    parse_model_ids(&body, array_key, id_field)
}

// Pull `<array_key>[].<id_field>` out of a models response. Gemini's ids carry a "models/" prefix
// (its id field is `name`), stripped so the picker shows the same short id users pass to `--model`.
fn parse_model_ids(body: &serde_json::Value, array_key: &str, id_field: &str) -> Vec<String> {
    let Some(arr) = body.get(array_key).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| item.get(id_field).and_then(|v| v.as_str()))
        .map(|id| id.trim_start_matches("models/").to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_malformed_providers_yield_no_models() {
        assert!(list_provider_models_inner("opencode").is_empty()); // no public models API
        assert!(list_provider_models_inner("BadProvider").is_empty()); // uppercase rejected
        assert!(list_provider_models_inner("").is_empty());
    }

    #[test]
    fn parses_openai_style_ids() {
        let body = serde_json::json!({ "data": [{ "id": "gpt-x" }, { "id": "o-next" }, {}] });
        assert_eq!(parse_model_ids(&body, "data", "id"), vec!["gpt-x", "o-next"]);
    }

    #[test]
    fn strips_gemini_models_prefix() {
        let body = serde_json::json!({ "models": [{ "name": "models/gemini-flash" }, { "name": "" }] });
        assert_eq!(parse_model_ids(&body, "models", "name"), vec!["gemini-flash"]);
    }

    #[test]
    fn missing_array_is_empty() {
        assert!(parse_model_ids(&serde_json::json!({}), "data", "id").is_empty());
    }
}
