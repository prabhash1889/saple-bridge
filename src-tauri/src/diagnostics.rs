use serde::{Serialize, Deserialize};
use std::process::Command;
use std::fs;
use std::path::Path;
use crate::keychain;
use crate::process_ext::CommandNoWindow;
use crate::providers::{self, CliStatus};

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

// `CliStatus` (per-provider CLI install/version) is owned by `providers.rs`, which also
// owns the probe that produces it; diagnostics only embeds it in the report.

/// MCP config presence flags embedded in the diagnostics report.
///
/// A lean subset of [`crate::project::McpStatus`] (the Settings → MCP tab type):
/// it omits `other_servers` because diagnostics only needs to confirm that
/// `saple-memory` is configured, not enumerate every server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigStatus {
    pub has_mcp_json: bool,
    pub has_mcp_config_json: bool,
    pub saple_memory_configured: bool,
}

#[tauri::command]
pub async fn run_diagnostics(
    project_path: String,
    registry: tauri::State<'_, std::sync::Arc<crate::project_roots::ProjectRootRegistry>>,
) -> Result<DiagnosticsResult, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_diagnostics_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn run_diagnostics_inner(registry: &crate::project_roots::ProjectRootRegistry, project_path: String) -> Result<DiagnosticsResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
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
    for f in providers::all().iter().filter(|f| f.reports_keychain_status) {
        keychains.push(KeychainStatus {
            provider: f.id.to_string(),
            status: backend_status.clone(),
            error: None,
        });
    }

    // 6. Provider CLIs check — resolve each CLI on PATH (cross-platform via `which`) and probe
    // `--version`. The spec comes from the same provider table `check_provider_cli` uses, so the
    // two never disagree. Providers without a version probe are omitted.
    let mut provider_clis = Vec::new();
    for f in providers::all().iter().filter(|f| f.probes_version) {
        if let Some((bin, args)) = providers::cli_probe_spec(f.id) {
            provider_clis.push(providers::probe_cli(f.id, bin, &args));
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

// Per-provider readiness commands (`check_provider_cli`, `check_provider_signin`) moved to
// `providers.rs` alongside the facts they read; they are still registered under the same
// command names, so the renderer API is unchanged.
