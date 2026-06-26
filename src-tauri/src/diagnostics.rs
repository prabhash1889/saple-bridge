use serde::{Serialize, Deserialize};
use std::process::Command;
use std::fs;
use std::path::Path;
use crate::keychain;
use crate::process_ext::CommandNoWindow;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsResult {
    pub os: String,
    pub shell: String,
    pub workspace_write: bool,
    pub git_available: bool,
    pub keychains: Vec<KeychainStatus>,
    pub provider_clis: Vec<CliStatus>,
    pub mcp_config: McpConfigStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainStatus {
    pub provider: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigStatus {
    pub has_mcp_json: bool,
    pub has_mcp_config_json: bool,
    pub saple_memory_configured: bool,
}

#[tauri::command]
pub async fn run_diagnostics(project_path: String) -> Result<DiagnosticsResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_diagnostics_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn run_diagnostics_inner(project_path: String) -> Result<DiagnosticsResult, String> {
    // 1. OS check
    let os = if cfg!(target_os = "windows") {
        "Windows Desktop".to_string()
    } else if cfg!(target_os = "macos") {
        "macOS Desktop".to_string()
    } else {
        "Linux Desktop".to_string()
    };

    // 2. Shell check
    let shell = if cfg!(target_os = "windows") {
        let cmd_ok = Command::new("cmd").args(["/C", "echo 1"]).no_window().output().is_ok();
        let ps_ok = Command::new("powershell").args(["-Command", "echo 1"]).no_window().output().is_ok();
        if ps_ok {
            "PowerShell (Active)".to_string()
        } else if cmd_ok {
            "CMD (Active)".to_string()
        } else {
            "None / Unavailable".to_string()
        }
    } else {
        let bash_ok = Command::new("bash").args(["-c", "echo 1"]).no_window().output().is_ok();
        let sh_ok = Command::new("sh").args(["-c", "echo 1"]).no_window().output().is_ok();
        if bash_ok {
            "Bash (Active)".to_string()
        } else if sh_ok {
            "Sh (Active)".to_string()
        } else {
            "None / Unavailable".to_string()
        }
    };

    // 3. Workspace write access check
    let workspace_write = if !project_path.is_empty() {
        let test_file = Path::new(&project_path).join(".saple-diag-test.tmp");
        match fs::write(&test_file, "saple diagnostics write test") {
            Ok(_) => {
                let _ = fs::remove_file(test_file);
                true
            }
            Err(_) => false,
        }
    } else {
        false
    };

    // 4. Git status availability check
    let git_available = if !project_path.is_empty() {
        let status_output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&project_path)
            .no_window()
            .output();
        match status_output {
            Ok(output) => output.status.success(),
            Err(_) => false,
        }
    } else {
        false
    };

    // 5. Keychain check — verify the OS keychain backend works using a THROWAWAY service.
    // We never write into a real `saple_provider_*` slot: a failed cleanup there would overwrite
    // the user's stored key (the same bug already fixed in `test_provider_connection`). The
    // backend is global, so one probe applies to every provider row.
    let probe_service = "saple_diagnostics_probe".to_string();
    let probe_val = "saple-diagnostics-probe";
    let backend_status = match keychain::set_api_key_inner(probe_service.clone(), probe_val.to_string()) {
        Ok(_) => {
            let retrieved = keychain::get_api_key_inner(probe_service.clone());
            let _ = keychain::delete_api_key_inner(probe_service);
            match retrieved {
                Ok(val) if val == probe_val => "ok".to_string(),
                Ok(_) => "mismatch".to_string(),
                Err(e) => format!("retrieval failed: {}", e),
            }
        }
        Err(e) => format!("set failed: {}", e),
    };

    let mut keychains = Vec::new();
    let providers = vec!["codex", "claude", "gemini", "openrouter", "opencode", "pi", "custom"];
    for p in providers {
        keychains.push(KeychainStatus {
            provider: p.to_string(),
            status: backend_status.clone(),
            error: None,
        });
    }

    // 6. Provider CLIs check — resolve each CLI on PATH (cross-platform via `which`) and probe
    // `--version`. Shares the same spec as the per-provider `check_provider_cli` command so the two
    // never disagree. `openrouter`/`custom` have no dedicated CLI and are omitted.
    let mut provider_clis = Vec::new();
    for provider in ["codex", "claude", "gemini", "opencode", "cursor", "droid", "copilot", "pi"] {
        if let Some((bin, args)) = provider_cli_spec(provider) {
            provider_clis.push(probe_cli(provider, bin, &args));
        }
    }

    // 7. MCP config status check
    let base = Path::new(&project_path);
    let has_mcp_json = base.join(".mcp.json").exists();
    let has_mcp_config_json = base.join("mcp_config.json").exists();
    let mut saple_memory_configured = false;

    if has_mcp_json {
        if let Ok(content) = fs::read_to_string(base.join(".mcp.json")) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(servers) = val.get("mcpServers").and_then(|s| s.as_object()) {
                    if servers.contains_key("saple-memory") {
                        saple_memory_configured = true;
                    }
                }
            }
        }
    }
    if !saple_memory_configured && has_mcp_config_json {
        if let Ok(content) = fs::read_to_string(base.join("mcp_config.json")) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(servers) = val.get("mcpServers").and_then(|s| s.as_object()) {
                    if servers.contains_key("saple-memory") {
                        saple_memory_configured = true;
                    }
                }
            }
        }
    }

    Ok(DiagnosticsResult {
        os,
        shell,
        workspace_write,
        git_available,
        keychains,
        provider_clis,
        mcp_config: McpConfigStatus {
            has_mcp_json,
            has_mcp_config_json,
            saple_memory_configured,
        },
    })
}

/// The CLI binary (to resolve on PATH) and version args for a provider, or `None` for providers
/// with no dedicated CLI (`openrouter` is API-key/env only; `custom` is user-supplied). The binary
/// names mirror the launch mapping in `pty.rs::spawn_pty` so detection and launch never disagree.
/// `copilot` ships inside the `gh` CLI, so we resolve `gh` and probe `gh copilot --version`.
fn provider_cli_spec(provider: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match provider {
        "codex" => Some(("codex", vec!["--version"])),
        "claude" => Some(("claude", vec!["--version"])),
        "gemini" => Some(("gemini", vec!["--version"])),
        "opencode" => Some(("opencode", vec!["--version"])),
        "cursor" => Some(("cursor-agent", vec!["--version"])),
        "droid" => Some(("droid", vec!["--version"])),
        "copilot" => Some(("gh", vec!["copilot", "--version"])),
        "pi" => Some(("pi", vec!["--version"])),
        _ => None,
    }
}

/// Resolve `bin` on PATH with `which` (handles `PATHEXT` on Windows — no shell needed), then run
/// the version args. `available` reflects PATH resolution; `version` is best-effort.
fn probe_cli(name: &str, bin: &str, args: &[&str]) -> CliStatus {
    match which::which(bin) {
        Ok(path) => {
            let mut command = Command::new(&path);
            command.args(args);
            command.no_window();
            let version = match command.output() {
                Ok(output) => {
                    let text = if output.status.success() {
                        String::from_utf8_lossy(&output.stdout).trim().to_string()
                    } else {
                        String::from_utf8_lossy(&output.stderr).trim().to_string()
                    };
                    if text.is_empty() { None } else { Some(text) }
                }
                Err(_) => None,
            };
            CliStatus { name: name.to_string(), available: true, version }
        }
        Err(_) => CliStatus { name: name.to_string(), available: false, version: None },
    }
}

/// Detect whether a single provider's CLI is installed (and its version). Backs the provider
/// readiness UI (`providerStore.refreshReadiness`). Providers with no CLI return `available:
/// false, version: None` without probing.
#[tauri::command]
pub async fn check_provider_cli(provider: String) -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(move || match provider_cli_spec(&provider) {
        Some((bin, args)) => probe_cli(&provider, bin, &args),
        None => CliStatus { name: provider, available: false, version: None },
    })
    .await
    .map_err(|e| e.to_string())
}

/// User home directory, cross-platform without an extra crate (`USERPROFILE` on Windows,
/// `HOME` elsewhere).
fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Detect whether the user is signed in to a provider via the CLI's own subscription/OAuth login
/// (independent of any API key stored in our keychain). Returns `Some(true|false)` for providers we
/// know how to probe, or `None` for providers without a sign-in concept. Backs the "Signed in" vs
/// "No key" distinction in the provider readiness UI.
#[tauri::command]
pub async fn check_provider_signin(provider: String) -> Result<Option<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        // Codex ships a scriptable status check that exits 0 when logged in.
        "codex" => {
            let signed_in = match which::which("codex") {
                Ok(path) => Command::new(&path)
                    .args(["login", "status"])
                    .no_window()
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false),
                Err(_) => false,
            };
            Some(signed_in)
        }
        // Claude Code writes its OAuth credentials to <config>/.credentials.json, where <config> is
        // CLAUDE_CONFIG_DIR if set, else ~/.claude.
        "claude" => {
            let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| home_dir().map(|h| h.join(".claude")));
            let exists = dir
                .map(|d| d.join(".credentials.json").exists())
                .unwrap_or(false);
            Some(exists)
        }
        _ => None,
    })
    .await
    .map_err(|e| e.to_string())
}
