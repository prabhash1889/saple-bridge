use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use serde::{Serialize, Deserialize};
use crate::error_code::CodedError;
use crate::process_ext::CommandNoWindow;
use crate::project_roots::ProjectRootRegistry;

// Path policy (containment resolution, protected writer paths, destructive targets) lives in
// `project_roots` as of Phase 5; import from `crate::project_roots` directly.
use crate::project_roots::{get_project_file_path, get_project_write_path};

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
    /// Feature flag for the Missions orchestration room and its Tauri commands (default off).
    /// Default-off keeps configs written before this field existed deserializable.
    #[serde(default)]
    pub missions_enabled: bool,
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
    // "default" means the provider CLI picks its own current model (spawn_pty omits the --model
    // flag for "default"). Preferred over pinning a version-stamped id that silently rots as new
    // models ship; a concrete model belongs only in an explicit per-agent override.
    let mut m = HashMap::new();
    for provider in ["codex", "claude", "gemini", "opencode", "pi"] {
        m.insert(provider.to_string(), "default".to_string());
    }
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
pub async fn ensure_workspace_dirs(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ensure_workspace_dirs_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_workspace_dirs_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<(), CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
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
        ".saple/review",
    ];
    for dir in &dirs {
        let path = get_project_file_path(&project_path, dir)?;
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("Failed to create {}: {}", dir, e))?;
        }
    }

    // Memory directories come from the layout owner so mode rules live in one place.
    for dir in crate::memory_layout::required_dir_names(&project_path) {
        let path = get_project_file_path(&project_path, dir)?;
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("Failed to create {}: {}", dir, e))?;
        }
    }

    // Project open is the one hook every user passes through — repair stale sidecar paths here.
    #[cfg(not(debug_assertions))]
    crate::sidecar::heal_mcp_configs(&project_path);

    Ok(())
}

#[tauri::command]
pub async fn ensure_project_config(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<WorkspaceConfig, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ensure_project_config_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_project_config_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<WorkspaceConfig, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;

    if config_path.exists() {
        // Phase 2: a corrupt config is never silently recreated over; original bytes are
        // preserved and writes to the config stay blocked until recovery.
        match crate::state_load::read_json_text(&config_path) {
            crate::state_load::JsonText::Ok(content) => {
                serde_json::from_str(&content).map_err(|e| {
                    let err = format!("Failed to parse config: {}", e);
                    match crate::state_load::preserve_and_flag_corrupt(&config_path, &err) {
                        Ok(backup) => format!(
                            "{}. Original bytes preserved at {} - resolve recovery before writing.",
                            err,
                            backup.display()
                        ),
                        Err(preserve_err) => format!("{} ({})", err, preserve_err),
                    }
                })
                .map_err(CodedError::internal)
            }
            crate::state_load::JsonText::Io(e) => Err(e.to_string().into()),
            crate::state_load::JsonText::Encoding(m) => Err(m.into()),
        }
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
            missions_enabled: false,
            created_at: now.clone(),
            updated_at: now,
        };
        
        let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        crate::fs_lock::atomic_write(&config_path, json.as_bytes())?;
        
        Ok(config)
    }
}

#[tauri::command]
pub async fn read_project_config(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<WorkspaceConfig, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || read_project_config_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn read_project_config_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<WorkspaceConfig, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;
    if !config_path.exists() {
        return Err("Config file not found".to_string().into());
    }
    match crate::state_load::read_json_text(&config_path) {
        crate::state_load::JsonText::Ok(content) => serde_json::from_str(&content)
            .map_err(|e| CodedError::internal(format!("Failed to parse config: {}", e))),
        crate::state_load::JsonText::Io(e) => Err(e.to_string().into()),
        crate::state_load::JsonText::Encoding(m) => Err(m.into()),
    }
}

#[tauri::command]
pub async fn write_project_config(
    project_path: String,
    config: WorkspaceConfig,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<WorkspaceConfig, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || write_project_config_inner(&registry, project_path, config))
        .await
        .map_err(|e| e.to_string())?
}

fn write_project_config_inner(registry: &ProjectRootRegistry, project_path: String, config: WorkspaceConfig) -> Result<WorkspaceConfig, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let config_path = get_project_file_path(&project_path, ".saple/config.json")?;
    let mut updated = config;
    updated.updated_at = now_iso();
    let json = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    crate::fs_lock::atomic_write(&config_path, json.as_bytes())?;
    Ok(updated)
}

#[tauri::command]
pub async fn read_project_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || read_project_file_inner(&registry, project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_project_file_inner(registry: &ProjectRootRegistry, project_path: String, file_path: String) -> Result<String, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let full_path = get_project_file_path(&project_path, &file_path)?;
    if !full_path.exists() {
        return Err("File not found".to_string().into());
    }
    fs::read_to_string(full_path).map_err(|e| CodedError::internal(e.to_string()))
}

#[tauri::command]
pub async fn write_project_file(
    project_path: String,
    file_path: String,
    content: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || write_project_file_inner(&registry, project_path, file_path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn write_project_file_inner(registry: &ProjectRootRegistry, project_path: String, file_path: String, content: String) -> Result<(), CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let full_path = get_project_write_path(&project_path, &file_path)?;
    crate::fs_lock::atomic_write(&full_path, content.as_bytes()).map_err(CodedError::internal)
}

#[tauri::command]
pub async fn get_workspace_summary(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<WorkspaceSummary, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_workspace_summary_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_workspace_summary_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<WorkspaceSummary, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let base = Path::new(&project_path);
    let canonical_base = base.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let name = base.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    
    // Check writable by trying to create a test file
    let writable = fs::write(canonical_base.join(".saple_write_test"), "test").is_ok();
    let _ = fs::remove_file(canonical_base.join(".saple_write_test"));
    
    // Check git repo
    let branch = git_current_branch_inner(registry, &project_path).ok();
    let is_git_repo = branch.is_some();
    
    // Check saple config
    let has_saple_config = canonical_base.join(".saple").join("config.json").exists();
    
    // Check bridge memory
    let has_bridge_memory = crate::memory_layout::bridge_memory_dir(&project_path).exists();
    
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

/// Read the ordinary branch name straight from `.git/HEAD` without spawning git.
/// Handles the `ref: refs/heads/<name>` form and `.git` being a file (worktree/submodule
/// `gitdir:` link, resolved relative to the project). Detached HEAD and unreadable files
/// return None so callers fall back to a real git invocation.
fn read_head_branch(project_path: &str) -> Option<String> {
    let dot_git = Path::new(project_path).join(".git");
    let head_path = if dot_git.is_dir() {
        dot_git.join("HEAD")
    } else if dot_git.is_file() {
        let link = fs::read_to_string(&dot_git).ok()?;
        let target = link.trim().strip_prefix("gitdir:")?.trim();
        let target_path = Path::new(target);
        if target_path.is_absolute() {
            target_path.join("HEAD")
        } else {
            Path::new(project_path).join(target).join("HEAD")
        }
    } else {
        return None;
    };

    let head = fs::read_to_string(head_path).ok()?;
    let head = head.trim();
    let ref_name = head.strip_prefix("ref:")?.trim();
    let branch = ref_name.strip_prefix("refs/heads/")?;
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

fn git_current_branch_inner(registry: &ProjectRootRegistry, project_path: &str) -> Result<String, CodedError> {
    registry.ensure_inside_approved_root(project_path)?;
    // Fast path: an ordinary branch name is directly readable from .git/HEAD; only fall
    // back to spawning git when it cannot be read that way (detached HEAD, unusual setup).
    if let Some(branch) = read_head_branch(project_path) {
        return Ok(branch);
    }
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(project_path)
        .no_window()
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if branch.is_empty() {
            Err("Not a git repository or no branch".to_string().into())
        } else {
            Ok(branch)
        }
    } else {
        Err("Not a git repository".to_string().into())
    }
}

#[tauri::command]
pub async fn git_current_branch(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || git_current_branch_inner(&registry, &project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_mcp_config(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || install_mcp_config_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn install_mcp_config_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<String, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    let binary_path = crate::sidecar::sidecar_binary_path()?;
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

#[tauri::command]
pub async fn check_mcp_status(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<McpStatus, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || check_mcp_status_inner(&registry, project_path))
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

fn check_mcp_status_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<McpStatus, CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
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
    use crate::error_code::ErrorCode;
    use std::path::PathBuf;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saple-proj-test-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // canonicalize so comparisons match what get_project_file_path computes
        dir.canonicalize().unwrap()
    }

    /// A registry with `dir` approved - the "legitimately opened workspace" fixture.
    fn approved(dir: &Path) -> ProjectRootRegistry {
        let registry = ProjectRootRegistry::new();
        registry.register_root(dir).unwrap();
        registry
    }

    #[test]
    fn privileged_inners_reject_unregistered_absolute_root() {
        // Every inner returns different payload types; erase them by mapping to (),
        // keeping assertions on the presence/absence of the registry rejection only.
        let dir = temp_project();
        let sibling = temp_project();
        let config = WorkspaceConfig {
            workspace_id: "w".into(), workspace_name: "w".into(), memory_mode: "saple".into(),
            default_provider: "codex".into(), default_model_by_provider: HashMap::new(),
            max_parallel_agents: 1, enable_edit_mode: true, verification_presets: vec![],
            missions_enabled: false,
            created_at: String::new(), updated_at: String::new(),
        };
        let all_cases = |registry: &ProjectRootRegistry, path: String| -> Vec<(&'static str, Result<(), CodedError>)> {
            vec![
                ("ensure_workspace_dirs", ensure_workspace_dirs_inner(registry, path.clone()).map(|_| ())),
                ("read_project_file", read_project_file_inner(registry, path.clone(), "x.txt".into()).map(|_| ())),
                ("write_project_file", write_project_file_inner(registry, path.clone(), "x.txt".into(), "x".into())),
                ("read_project_config", read_project_config_inner(registry, path.clone()).map(|_| ())),
                ("write_project_config", write_project_config_inner(registry, path.clone(), config.clone()).map(|_| ())),
                ("get_workspace_summary", get_workspace_summary_inner(registry, path.clone()).map(|_| ())),
                ("git_current_branch", git_current_branch_inner(registry, &path).map(|_| ())),
                ("check_mcp_status", check_mcp_status_inner(registry, path.clone()).map(|_| ())),
                ("install_mcp_config", install_mcp_config_inner(registry, path).map(|_| ())),
            ]
        };

        // Unregistered absolute root must be refused everywhere with a clear message.
        let stranger = approved(&dir);
        for (name, result) in all_cases(&stranger, sibling.to_string_lossy().to_string()) {
            let err = result.unwrap_err();
            assert_eq!(err.code, ErrorCode::RootNotApproved);
            assert!(
                err.message.contains("not inside an approved project root"),
                "case '{}': expected registry rejection, got: {}",
                name,
                err.message
            );
        }

        // The approved root passes the gate: failures (if any) are ordinary ones like
        // "Config file not found", never the registry rejection.
        let own = approved(&dir);
        for (name, result) in all_cases(&own, dir.to_string_lossy().to_string()) {
            if let Err(err) = result {
                assert!(
                    !err.message.contains("not inside an approved project root"),
                    "case '{}': approved root must pass the gate, got: {}",
                    name,
                    err.message
                );
            }
        }

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn workspace_config_missions_flag_defaults_off_and_round_trips() {
        // Config written before the flag existed must parse with the flag off.
        let legacy = serde_json::json!({
            "workspaceId": "w", "workspaceName": "w", "memoryMode": "saple",
            "defaultProvider": "codex", "defaultModelByProvider": {},
            "maxParallelAgents": 1, "enableEditMode": true, "verificationPresets": [],
            "createdAt": "", "updatedAt": ""
        });
        let config: WorkspaceConfig = serde_json::from_value(legacy).unwrap();
        assert!(!config.missions_enabled);

        // Explicitly on survives a serialize/deserialize round trip.
        let mut config = config;
        config.missions_enabled = true;
        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["missionsEnabled"], serde_json::json!(true));
        let reparsed: WorkspaceConfig = serde_json::from_value(value).unwrap();
        assert!(reparsed.missions_enabled);
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
    fn head_branch_reads_ordinary_branch_without_git() {
        let dir = std::env::temp_dir().join(format!("saple-head-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed", args);
        };
        git(&["init", "-b", "feature/head-read"]);
        git(&["config", "user.email", "test@saple.local"]);
        git(&["config", "user.name", "Saple Test"]);

        assert_eq!(
            read_head_branch(dir.to_string_lossy().as_ref()),
            Some("feature/head-read".to_string()),
            "ordinary branch must come straight from .git/HEAD"
        );

        // Detached HEAD has no ref: prefix -> None (callers fall back to git).
        git(&["commit", "--allow-empty", "-m", "c"]);
        git(&["checkout", "--detach"]);
        assert_eq!(read_head_branch(dir.to_string_lossy().as_ref()), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn head_branch_follows_worktree_gitdir_links() {
        let dir = std::env::temp_dir().join(format!("saple-head-wt-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        let main = dir.join("main");
        let wt = dir.join("linked");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&wt).unwrap();

        let git_in = |sub: &Path, args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(sub).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git_in(&main, &["init", "-b", "trunk"]);
        git_in(&main, &["config", "user.email", "test@saple.local"]);
        git_in(&main, &["config", "user.name", "Saple Test"]);
        fs::write(main.join("f.txt"), "x\n").unwrap();
        git_in(&main, &["add", "."]);
        git_in(&main, &["commit", "-m", "base"]);

        // Real worktree: .git in the linked dir is a file pointing back at the gitdir.
        git_in(&main, &["worktree", "add", wt.to_string_lossy().as_ref(), "-b", "wt-branch"]);

        // Absolute gitdir link.
        let link_content = fs::read_to_string(wt.join(".git")).unwrap();
        assert!(link_content.starts_with("gitdir:"), "worktree .git must be a gitdir link");
        assert_eq!(
            read_head_branch(wt.to_string_lossy().as_ref()),
            Some("wt-branch".to_string()),
            "absolute gitdir link must resolve"
        );

        // Relative gitdir link.
        let abs_target = link_content.trim().strip_prefix("gitdir:").unwrap().trim().to_string();
        let relative = make_relative(&abs_target, &wt).unwrap_or_else(|| abs_target.clone());
        if !relative.is_empty() && Path::new(&relative).is_relative() {
            fs::write(wt.join(".git"), format!("gitdir: {}", relative)).unwrap();
            assert_eq!(
                read_head_branch(wt.to_string_lossy().as_ref()),
                Some("wt-branch".to_string()),
                "relative gitdir link must resolve against the project path"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// Best-effort relative path from `base` to `target` (same drive on Windows), or
    /// None when they cannot be related.
    fn make_relative(target: &str, base: &Path) -> Option<String> {
        let target = Path::new(target).canonicalize().ok()?;
        let base = base.canonicalize().ok()?;
        target.strip_prefix(&base).ok().map(|p| p.to_string_lossy().to_string())
    }
}
