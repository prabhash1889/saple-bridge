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

    // 5. Keychain check
    let mut keychains = Vec::new();
    let providers = vec!["codex", "claude", "gemini", "opencode", "pi", "custom"];
    for p in providers {
        let service = format!("saple_provider_{}_api_key", p);
        let test_val = "diagnostics-test-key";
        
        let status = match keychain::set_api_key_inner(service.clone(), test_val.to_string()) {
            Ok(_) => {
                let retrieved = keychain::get_api_key_inner(service.clone());
                let _ = keychain::delete_api_key_inner(service);
                match retrieved {
                    Ok(val) if val == test_val => "ok".to_string(),
                    Ok(_) => "mismatch".to_string(),
                    Err(e) => format!("retrieval failed: {}", e),
                }
            }
            Err(e) => format!("set failed: {}", e),
        };

        keychains.push(KeychainStatus {
            provider: p.to_string(),
            status,
            error: None,
        });
    }

    // 6. Provider CLIs check
    let mut provider_clis = Vec::new();
    let clis = vec![
        ("codex", "codex", vec!["--version"]),
        ("claude", "claude", vec!["--version"]),
        ("gemini", "gemini", vec!["--version"]),
        ("opencode", "opencode", vec!["--version"]),
        ("pi", "pi", vec!["--version"]),
    ];
    for (name, cmd_name, args) in clis {
        let mut command = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(&["/C", cmd_name]);
            c.args(&args);
            c
        } else {
            let mut c = Command::new(cmd_name);
            c.args(&args);
            c
        };
        command.no_window();

        let (available, version) = match command.output() {
            Ok(output) => {
                let v = if output.status.success() {
                    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
                } else {
                    Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
                };
                (true, v)
            }
            Err(_) => (false, None),
        };

        provider_clis.push(CliStatus {
            name: name.to_string(),
            available,
            version,
        });
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
