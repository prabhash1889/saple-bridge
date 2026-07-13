use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Serialize, Deserialize};
use crate::process_ext::CommandNoWindow;

pub(crate) fn get_project_file_path(project_path: &str, file_path: &str) -> Result<PathBuf, String> {
    use std::path::Component;

    let base = Path::new(project_path);
    let canonical_base = base.canonicalize().map_err(|e| format!("Base path error: {}", e))?;

    // Reject absolute paths and traversal up front. `Path::join` with an absolute path silently
    // discards the base (e.g. `base.join("C:\\Windows\\x")` -> `C:\Windows\x`), so without this an
    // absolute or `..`-laden `file_path` would escape the workspace entirely.
    let rel = Path::new(file_path);
    if rel.is_absolute() {
        return Err("Access denied: absolute paths are not allowed".to_string());
    }
    for comp in rel.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Access denied: path escapes the project workspace".to_string());
            }
            _ => {}
        }
    }

    let target = canonical_base.join(rel);

    // If the target already exists, canonicalize the *full* path (resolving symlinks) and confirm
    // containment before handing it back.
    if target.exists() {
        let canonical_target = target.canonicalize().map_err(|e| format!("Target path error: {}", e))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("Access denied: path is outside the project workspace".to_string());
        }
        return Ok(canonical_target);
    }

    // Target doesn't exist yet (a write that will create it). Prove containment by canonicalizing
    // the nearest existing ancestor *before* creating any directories — so a symlinked parent can't
    // trick us into create_dir_all outside the workspace.
    if let Some(parent) = target.parent() {
        let mut existing = parent;
        while !existing.exists() {
            match existing.parent() {
                Some(p) => existing = p,
                None => break,
            }
        }
        let canonical_existing = existing
            .canonicalize()
            .map_err(|e| format!("Parent path error: {}", e))?;
        if !canonical_existing.starts_with(&canonical_base) {
            return Err("Access denied: path is outside the project workspace".to_string());
        }
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {}", e))?;
        }
    }

    Ok(target)
}

fn default_enable_edit_mode() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub workspace_id: String,
    pub workspace_name: String,
    pub memory_mode: String,
    pub default_provider: String,
    pub default_model_by_provider: HashMap<String, String>,
    pub max_parallel_agents: u32,
    #[serde(default = "default_enable_edit_mode")]
    pub enable_edit_mode: bool,
    /// Per-workspace verification command presets shown in the Review room.
    /// `default` keeps configs written before this field existed deserializable.
    #[serde(default)]
    pub verification_presets: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub path: String,
    pub name: String,
    pub writable: bool,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub has_saple_config: bool,
    pub has_bridge_memory: bool,
    pub has_mcp_config: bool,
}

/// Full MCP configuration status for the project Settings → MCP tab.
///
/// Returned by [`check_mcp_status`]. Distinct from
/// [`crate::diagnostics::McpConfigStatus`], which is a leaner subset embedded in
/// the diagnostics report: this struct additionally surfaces `other_servers`
/// (non-`saple-memory` servers found in the config) for the Settings UI.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub has_mcp_json: bool,
    pub has_mcp_config_json: bool,
    pub saple_memory_configured: bool,
    pub other_servers: Vec<String>,
    /// True when a `saple-memory` entry exists but still points at the old embedded server
    /// (`command` is the Bridge binary, or `args` begins with the retired `"mcp"` subcommand).
    /// Such configs launch the GUI instead of the MCP server now — the UI should prompt a reinstall.
    pub legacy_config: bool,
}

fn default_model_by_provider() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("codex".to_string(), "gpt-4o".to_string());
    m.insert("claude".to_string(), "claude-sonnet-4-20250514".to_string());
    m.insert("gemini".to_string(), "gemini-2.5-pro".to_string());
    m.insert("opencode".to_string(), "default".to_string());
    m.insert("pi".to_string(), "default".to_string());
    m
}

pub(crate) fn now_iso() -> String {
    // Simple ISO-8601 without external crate dependency
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Format as ISO date (approximate, good enough for config timestamps)
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;
    
    // Compute year/month/day from days since epoch (1970-01-01)
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let months_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1usize;
    for &md in &months_days {
        if remaining < md { break; }
        remaining -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, remaining + 1, hours, minutes, seconds)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[tauri::command]
pub async fn ensure_workspace_dirs(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ensure_workspace_dirs_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_workspace_dirs_inner(project_path: String) -> Result<(), String> {
    let dirs = [
        ".saple",
        ".saple/agents",
        ".saple/agents/logs",
        ".saple/agents/prompts",
        ".saple/agents/transcripts",
        ".saple/swarm",
        ".saple/swarm/mailbox",
        ".saple/swarm/handoffs",
        ".saple/swarm/context",
        ".saple/memory",
        ".saple/review",
    ];
    for dir in &dirs {
        let path = get_project_file_path(&project_path, dir)?;
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("Failed to create {}: {}", dir, e))?;
        }
    }
    
    // Also check memory mode to ensure .bridgememory exists if needed
    let mode = crate::memory::get_memory_mode(&project_path);
    if mode == "bridge-compatible" || mode == "both" {
        let path = get_project_file_path(&project_path, ".bridgememory")?;
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("Failed to create .bridgememory: {}", e))?;
        }
    }

    // Project open is the one hook every user passes through — repair stale sidecar paths here.
    #[cfg(not(debug_assertions))]
    heal_mcp_configs(&project_path);

    Ok(())
}

#[tauri::command]
pub async fn ensure_project_config(project_path: String) -> Result<WorkspaceConfig, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_project_config_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_project_config_inner(project_path: String) -> Result<WorkspaceConfig, String> {
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;

    if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
    } else {
        let now = now_iso();
        let base = Path::new(&project_path);
        let name = base.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".to_string());
        
        let config = WorkspaceConfig {
            workspace_id: uuid::Uuid::new_v4().to_string(),
            workspace_name: name,
            memory_mode: "saple".to_string(),
            default_provider: "codex".to_string(),
            default_model_by_provider: default_model_by_provider(),
            max_parallel_agents: 12,
            enable_edit_mode: true,
            verification_presets: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        crate::fs_lock::atomic_write(&config_path, json.as_bytes())?;
        
        Ok(config)
    }
}

#[tauri::command]
pub async fn read_project_config(project_path: String) -> Result<WorkspaceConfig, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_config_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn read_project_config_inner(project_path: String) -> Result<WorkspaceConfig, String> {
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;
    if !config_path.exists() {
        return Err("Config file not found".to_string());
    }
    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
}

#[tauri::command]
pub async fn write_project_config(project_path: String, config: WorkspaceConfig) -> Result<WorkspaceConfig, String> {
    tauri::async_runtime::spawn_blocking(move || write_project_config_inner(project_path, config))
        .await
        .map_err(|e| e.to_string())?
}

fn write_project_config_inner(project_path: String, config: WorkspaceConfig) -> Result<WorkspaceConfig, String> {
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;
    let mut updated = config;
    updated.updated_at = now_iso();
    let json = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    crate::fs_lock::atomic_write(&config_path, json.as_bytes())?;
    Ok(updated)
}

#[tauri::command]
pub async fn read_project_file(project_path: String, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_project_file_inner(project_path: String, file_path: String) -> Result<String, String> {
    let full_path = get_project_file_path(&project_path, &file_path)?;
    if !full_path.exists() {
        return Err("File not found".to_string());
    }
    fs::read_to_string(full_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_project_file(project_path: String, file_path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_project_file_inner(project_path, file_path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn write_project_file_inner(project_path: String, file_path: String, content: String) -> Result<(), String> {
    let full_path = get_project_file_path(&project_path, &file_path)?;
    crate::fs_lock::atomic_write(&full_path, content.as_bytes())
}

#[tauri::command]
pub async fn get_workspace_summary(project_path: String) -> Result<WorkspaceSummary, String> {
    tauri::async_runtime::spawn_blocking(move || get_workspace_summary_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_workspace_summary_inner(project_path: String) -> Result<WorkspaceSummary, String> {
    let base = Path::new(&project_path);
    let canonical_base = base.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let name = base.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    
    // Check writable by trying to create a test file
    let writable = fs::write(canonical_base.join(".saple_write_test"), "test").is_ok();
    let _ = fs::remove_file(canonical_base.join(".saple_write_test"));
    
    // Check git repo
    let branch = git_current_branch_inner(&project_path).ok();
    let is_git_repo = branch.is_some();
    
    // Check saple config
    let has_saple_config = canonical_base.join(".saple").join("config.json").exists();
    
    // Check bridge memory
    let has_bridge_memory = canonical_base.join(".bridgememory").exists();
    
    // Check MCP config
    let has_mcp_config = canonical_base.join(".mcp.json").exists() || canonical_base.join("mcp_config.json").exists();
    
    Ok(WorkspaceSummary {
        path: project_path,
        name,
        writable,
        is_git_repo,
        branch,
        has_saple_config,
        has_bridge_memory,
        has_mcp_config,
    })
}

fn git_current_branch_inner(project_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(project_path)
        .no_window()
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if branch.is_empty() {
            Err("Not a git repository or no branch".to_string())
        } else {
            Ok(branch)
        }
    } else {
        Err("Not a git repository".to_string())
    }
}

#[tauri::command]
pub async fn git_current_branch(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_current_branch_inner(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_mcp_config(project_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_mcp_config_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Absolute path to the `saple-mcp` sidecar binary that MCP configs should reference.
///
/// The MCP server now lives in the standalone `saple-mcp` crate and ships as a Tauri sidecar.
/// External clients (Claude Code) launch it directly from `.mcp.json`, so this must be a concrete
/// on-disk path, not a Tauri Command handle.
///   * **dev** — the triple-suffixed staging file under `src-tauri/binaries/` that
///     `scripts/prepare-sidecar.mjs` produces (TARGET_TRIPLE / SAPLE_BRIDGE_MANIFEST_DIR are baked
///     in by build.rs).
///   * **release** — the per-user staged copy from `ensure_stable_sidecar`. The exe-adjacent
///     bundled copy is only a fallback: install directories are not stable paths (the MSIX
///     WindowsApps dir is versioned per Store update and its ACLs block external clients; an
///     NSIS install can be moved), so `.mcp.json` must never point into them.
fn sidecar_binary_path() -> Result<PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };

    #[cfg(debug_assertions)]
    {
        let triple = env!("TARGET_TRIPLE");
        let manifest_dir = env!("SAPLE_BRIDGE_MANIFEST_DIR"); // = src-tauri/
        let name = format!("saple-mcp-{}{}", triple, ext);
        Ok(Path::new(manifest_dir).join("binaries").join(name))
    }
    #[cfg(not(debug_assertions))]
    {
        if let Some(dir) = stable_sidecar_dir() {
            let staged = dir.join(format!("saple-mcp{}", ext));
            if staged.exists() {
                return Ok(staged);
            }
        }
        bundled_sidecar_path(ext)
    }
}

/// The sidecar as bundled next to the app binary (Tauri strips the target triple at bundle time;
/// on macOS this is `…app/Contents/MacOS/`).
#[cfg(not(debug_assertions))]
fn bundled_sidecar_path(ext: &str) -> Result<PathBuf, String> {
    let mut dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get binary path: {}", e))?;
    dir.pop(); // strip the app binary file name -> its directory
    Ok(dir.join(format!("saple-mcp{}", ext)))
}

/// Per-user directory the sidecar is staged into: survives app updates and is readable by
/// external processes (unlike the MSIX WindowsApps install dir). Same path for the NSIS and
/// Store builds on purpose, so switching installs never ping-pongs `.mcp.json`.
#[cfg(not(debug_assertions))]
fn stable_sidecar_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    return std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("ai.saple.bridge").join("bin"));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|d| {
        PathBuf::from(d)
            .join("Library")
            .join("Application Support")
            .join("ai.saple.bridge")
            .join("bin")
    });
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    None
}

/// Stage the bundled sidecar into `stable_sidecar_dir` (called once at startup, release builds).
/// Copy-to-temp then rename, so an MCP client launching concurrently never sees a half-written
/// exe. If the staged copy is locked by a running server the rename fails and the old copy stays
/// in place until a later launch. Never fatal: while no staged copy exists,
/// `sidecar_binary_path` falls back to the bundled one.
#[cfg(not(debug_assertions))]
pub fn ensure_stable_sidecar() {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let Ok(src) = bundled_sidecar_path(ext) else { return };
    let Ok(src_meta) = fs::metadata(&src) else { return }; // no bundled sidecar next to the exe
    let Some(dir) = stable_sidecar_dir() else { return };
    let dest = dir.join(format!("saple-mcp{}", ext));

    // ponytail: freshness = same size and dest not older; hash the files if this ever misfires.
    let up_to_date = fs::metadata(&dest)
        .map(|d| {
            d.len() == src_meta.len()
                && matches!(
                    (d.modified(), src_meta.modified()),
                    (Ok(dest_t), Ok(src_t)) if dest_t >= src_t
                )
        })
        .unwrap_or(false);
    if up_to_date {
        return;
    }

    let tmp = dir.join(format!("saple-mcp{}.new", ext));
    let staged = fs::create_dir_all(&dir)
        .and_then(|_| fs::copy(&src, &tmp).map(|_| ()))
        .and_then(|_| fs::rename(&tmp, &dest));
    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        eprintln!("saple-bridge: failed to stage sidecar at {}: {}", dest.display(), e);
    }
}

/// Rewrite a `saple-memory` entry whose `command` points at a stale sidecar location (a
/// versioned MSIX dir from before a Store update, or a moved install). Only entries whose
/// command file name is `saple-mcp` are touched — legacy embedded-server configs keep going
/// through the explicit reinstall banner. Returns true when the config was modified.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn heal_saple_memory_command(config: &mut serde_json::Value, current_sidecar: &str) -> bool {
    let entry = match config.get_mut("mcpServers").and_then(|s| s.get_mut("saple-memory")) {
        Some(e) => e,
        None => return false,
    };
    let cmd = match entry.get("command").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return false,
    };
    let is_ours = Path::new(cmd)
        .file_stem()
        .map(|s| s.to_string_lossy().eq_ignore_ascii_case("saple-mcp"))
        .unwrap_or(false);
    if !is_ours || cmd == current_sidecar {
        return false;
    }
    entry["command"] = serde_json::Value::String(current_sidecar.to_string());
    true
}

/// Self-heal MCP configs on project open. After a Store update the old WindowsApps sidecar path
/// no longer exists, so without this every previously configured project silently loses its
/// `saple-memory` server. Release only: dev builds resolve the sidecar to a repo-local staging
/// path that must not leak into user configs.
#[cfg(not(debug_assertions))]
fn heal_mcp_configs(project_path: &str) {
    let Ok(current) = sidecar_binary_path() else { return };
    if !current.exists() {
        return;
    }
    let current = current.to_string_lossy().to_string();
    for file in [".mcp.json", "mcp_config.json"] {
        let Ok(path) = get_project_file_path(project_path, file) else { continue };
        let Ok(content) = fs::read_to_string(&path) else { continue };
        let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        if heal_saple_memory_command(&mut val, &current) {
            if let Ok(pretty) = serde_json::to_string_pretty(&val) {
                let _ = crate::fs_lock::atomic_write(&path, pretty.as_bytes());
            }
        }
    }
}

fn install_mcp_config_inner(project_path: String) -> Result<String, String> {
    let binary_path = sidecar_binary_path()?;
    let binary_str = binary_path.to_string_lossy().to_string();

    let mcp_config = serde_json::json!({
        "mcpServers": {
            "saple-memory": {
                "command": binary_str,
                "args": [&project_path]
            }
        }
    });
    
    let config_str = serde_json::to_string_pretty(&mcp_config).map_err(|e| e.to_string())?;
    
    // Write .mcp.json preserving other servers
    let mcp_json_path = get_project_file_path(&project_path, ".mcp.json")?;
    if mcp_json_path.exists() {
        let existing = fs::read_to_string(&mcp_json_path).map_err(|e| e.to_string())?;
        let mut existing_json: serde_json::Value =
            serde_json::from_str(&existing).map_err(|e| e.to_string())?;
        if let Some(servers) = existing_json.get_mut("mcpServers") {
            if let Some(obj) = servers.as_object_mut() {
                obj.insert("saple-memory".to_string(), mcp_config["mcpServers"]["saple-memory"].clone());
            }
        } else {
            existing_json["mcpServers"] = serde_json::json!({"saple-memory": mcp_config["mcpServers"]["saple-memory"].clone()});
        }
        let merged = serde_json::to_string_pretty(&existing_json).map_err(|e| e.to_string())?;
        crate::fs_lock::atomic_write(&mcp_json_path, merged.as_bytes())?;
    } else {
        crate::fs_lock::atomic_write(&mcp_json_path, config_str.as_bytes())?;
    }
    
    // Also write mcp_config.json (same content)
    let mcp_config_path = get_project_file_path(&project_path, "mcp_config.json")?;
    if mcp_config_path.exists() {
        let existing = fs::read_to_string(&mcp_config_path).map_err(|e| e.to_string())?;
        let mut existing_json: serde_json::Value =
            serde_json::from_str(&existing).map_err(|e| e.to_string())?;
        if let Some(servers) = existing_json.get_mut("mcpServers") {
            if let Some(obj) = servers.as_object_mut() {
                obj.insert("saple-memory".to_string(), mcp_config["mcpServers"]["saple-memory"].clone());
            }
        } else {
            existing_json["mcpServers"] = serde_json::json!({"saple-memory": mcp_config["mcpServers"]["saple-memory"].clone()});
        }
        let merged = serde_json::to_string_pretty(&existing_json).map_err(|e| e.to_string())?;
        crate::fs_lock::atomic_write(&mcp_config_path, merged.as_bytes())?;
    } else {
        crate::fs_lock::atomic_write(&mcp_config_path, config_str.as_bytes())?;
    }
    
    Ok(format!("MCP config installed for project at {}", project_path))
}

/// Preview the sidecar's tool catalog (Settings → MCP). The MCP server is no longer in-process, so
/// spawn `saple-mcp`, send one `tools/list` request, and return its `result`. Keeps Bridge ignorant
/// of the catalog contents (no drift). `.no_window()` suppresses the console flash on Windows.
#[tauri::command]
pub async fn test_mcp_tools(project_path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, Write};
        use std::process::Stdio;

        let bin = sidecar_binary_path()?;
        if !bin.exists() {
            return Err(format!(
                "saple-mcp sidecar not found at {}. Run `npm run prepare-sidecar`.",
                bin.display()
            ));
        }

        let mut child = Command::new(&bin)
            .arg(&project_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .no_window()
            .spawn()
            .map_err(|e| format!("Failed to spawn saple-mcp: {}", e))?;

        // `tools/list` needs no prior `initialize` in this server, so skip the handshake.
        let req = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n";
        child.stdin.take()
            .ok_or("Failed to open saple-mcp stdin")?
            .write_all(req.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().ok_or("Failed to open saple-mcp stdout")?)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;

        let _ = child.kill();
        let _ = child.wait();

        let resp: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("Invalid response from saple-mcp: {}", e))?;
        resp.get("result").cloned().ok_or_else(|| {
            resp["error"]["message"].as_str().unwrap_or("No result in response").to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_mcp_status(project_path: String) -> Result<McpStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_mcp_status_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a parsed MCP config's `saple-memory` entry is a pre-sidecar (legacy) one: its `command`
/// resolves to the Bridge binary, or its `args` still lead with the retired `"mcp"` subcommand.
/// Those configs now launch the GUI instead of the MCP server, so they need a reinstall.
fn saple_memory_is_legacy(config: &serde_json::Value) -> bool {
    let entry = match config.get("mcpServers").and_then(|s| s.get("saple-memory")) {
        Some(e) => e,
        None => return false,
    };

    // Old args began with the "mcp" subcommand: ["mcp", "<project>"]. New args are ["<project>"].
    if entry.get("args").and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str()) == Some("mcp")
    {
        return true;
    }

    // Old command was the Bridge executable itself (re-invoked in "mcp" mode).
    if let Some(cmd) = entry.get("command").and_then(|c| c.as_str()) {
        let stem = std::path::Path::new(cmd)
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if stem.contains("saple-bridge") || stem.contains("saple_bridge") {
            return true;
        }
    }

    false
}

fn check_mcp_status_inner(project_path: String) -> Result<McpStatus, String> {
    // Route both paths through `get_project_file_path` for containment parity with the rest of
    // the module, rather than joining onto the raw project path.
    let mcp_json_path = get_project_file_path(&project_path, ".mcp.json")?;
    let mcp_config_path = get_project_file_path(&project_path, "mcp_config.json")?;

    let has_mcp_json = mcp_json_path.exists();
    let has_mcp_config_json = mcp_config_path.exists();
    let mut saple_memory_configured = false;
    let mut other_servers = Vec::new();
    let mut legacy_config = false;

    // Check .mcp.json
    if has_mcp_json {
        let content = fs::read_to_string(&mcp_json_path).map_err(|e| e.to_string())?;
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(servers) = val.get("mcpServers").and_then(|s| s.as_object()) {
                for key in servers.keys() {
                    if key == "saple-memory" {
                        saple_memory_configured = true;
                    } else {
                        other_servers.push(key.clone());
                    }
                }
            }
            legacy_config |= saple_memory_is_legacy(&val);
        }
    }

    // Check mcp_config.json too
    if has_mcp_config_json {
        let content = fs::read_to_string(&mcp_config_path).map_err(|e| e.to_string())?;
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(servers) = val.get("mcpServers").and_then(|s| s.as_object()) {
                for key in servers.keys() {
                    if key == "saple-memory" {
                        saple_memory_configured = true;
                    } else if !other_servers.contains(key) {
                        other_servers.push(key.clone());
                    }
                }
            }
            legacy_config |= saple_memory_is_legacy(&val);
        }
    }

    Ok(McpStatus {
        has_mcp_json,
        has_mcp_config_json,
        saple_memory_configured,
        other_servers,
        legacy_config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saple-proj-test-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // canonicalize so comparisons match what get_project_file_path computes
        dir.canonicalize().unwrap()
    }

    #[test]
    fn allows_relative_paths_inside_workspace() {
        let dir = temp_project();
        let p = get_project_file_path(dir.to_str().unwrap(), ".saple/tasks.json").unwrap();
        assert!(p.starts_with(&dir));
        assert!(dir.join(".saple").exists(), "parent dir created");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let dir = temp_project();
        let err = get_project_file_path(dir.to_str().unwrap(), "../escape.txt").unwrap_err();
        assert!(err.contains("escapes"), "got: {}", err);
        let err2 = get_project_file_path(dir.to_str().unwrap(), ".saple/../../escape.txt").unwrap_err();
        assert!(err2.contains("escapes"), "got: {}", err2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_paths() {
        let dir = temp_project();
        let abs = if cfg!(windows) { "C:\\Windows\\System32\\drivers\\etc\\hosts" } else { "/etc/passwd" };
        let err = get_project_file_path(dir.to_str().unwrap(), abs).unwrap_err();
        assert!(err.contains("absolute") || err.contains("escapes"), "got: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_create_dirs_when_path_escapes() {
        let dir = temp_project();
        let _ = get_project_file_path(dir.to_str().unwrap(), "../sibling/deep/path.txt");
        let escaped = dir.parent().unwrap().join("sibling");
        assert!(!escaped.exists(), "must not create directories outside the workspace");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn allows_long_nested_relative_path() {
        let dir = temp_project();
        let long_rel = format!(".saple/{}/note.md", "a/".repeat(40));
        let p = get_project_file_path(dir.to_str().unwrap(), &long_rel).unwrap();
        assert!(p.starts_with(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_legacy_mcp_command_and_args() {
        // Old config: command is the Bridge binary, args lead with the "mcp" subcommand.
        let legacy_cmd = serde_json::json!({
            "mcpServers": { "saple-memory": {
                "command": "C:\\Program Files\\Saple Bridge\\saple-bridge.exe",
                "args": ["mcp", "C:\\proj"]
            }}
        });
        assert!(saple_memory_is_legacy(&legacy_cmd), "bridge-binary command should be legacy");

        // Even with a renamed command, a leading "mcp" arg marks it legacy.
        let legacy_args = serde_json::json!({
            "mcpServers": { "saple-memory": { "command": "saple-mcp", "args": ["mcp", "/proj"] }}
        });
        assert!(saple_memory_is_legacy(&legacy_args), "leading mcp arg should be legacy");

        // New config: standalone sidecar, args are just the project path.
        let current = serde_json::json!({
            "mcpServers": { "saple-memory": { "command": "/opt/app/saple-mcp", "args": ["/proj"] }}
        });
        assert!(!saple_memory_is_legacy(&current), "sidecar config must not be flagged");

        // No saple-memory entry at all.
        let none = serde_json::json!({ "mcpServers": { "other": { "command": "x", "args": [] }}});
        assert!(!saple_memory_is_legacy(&none));
    }

    #[test]
    fn heals_stale_sidecar_command() {
        // Native paths per host: heal_saple_memory_command uses Path::file_stem to recognize the
        // "saple-mcp" binary, and only the host's separator counts (a backslash is a literal
        // filename char on Unix, so Windows paths wouldn't parse on the mac runner). Real configs
        // always hold host-native paths, so mirror that here to keep the heal covered on both OSes.
        #[cfg(windows)]
        let (current, stale, proj) = (
            "C:\\Users\\u\\AppData\\Local\\ai.saple.bridge\\bin\\saple-mcp.exe",
            "C:\\Program Files\\WindowsApps\\pkg_1.0.21_x64__h\\saple-mcp.exe",
            "C:\\proj",
        );
        #[cfg(not(windows))]
        let (current, stale, proj) = (
            "/Users/u/Library/Application Support/ai.saple.bridge/bin/saple-mcp",
            "/Applications/Saple Bridge.app/Contents/MacOS/saple-mcp",
            "/proj",
        );
        let mut cfg = serde_json::json!({ "mcpServers": {
            "saple-memory": { "command": stale, "args": [proj] },
            "other": { "command": "npx", "args": ["x"] }
        }});
        assert!(heal_saple_memory_command(&mut cfg, current));
        assert_eq!(cfg["mcpServers"]["saple-memory"]["command"], current);
        // Args and unrelated servers must survive untouched.
        assert_eq!(cfg["mcpServers"]["saple-memory"]["args"][0], proj);
        assert_eq!(cfg["mcpServers"]["other"]["command"], "npx");
    }

    #[test]
    fn heal_leaves_current_foreign_and_legacy_commands_alone() {
        let current = "/opt/bin/saple-mcp";

        let mut same =
            serde_json::json!({ "mcpServers": { "saple-memory": { "command": current, "args": [] }}});
        assert!(!heal_saple_memory_command(&mut same, current), "up-to-date path must not rewrite");

        // Legacy embedded-server config (bridge exe) goes through the reinstall banner, not the heal.
        let mut legacy = serde_json::json!({ "mcpServers": {
            "saple-memory": { "command": "C:\\x\\saple-bridge.exe", "args": ["mcp", "p"] }
        }});
        assert!(!heal_saple_memory_command(&mut legacy, current));

        let mut none = serde_json::json!({ "mcpServers": {} });
        assert!(!heal_saple_memory_command(&mut none, current));
    }
}
