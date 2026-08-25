//! `saple-mcp` sidecar ownership: bundled-path resolution, per-user staging, stale-config
//! healing, and the one-shot process probe behind `test_mcp_tools`.
//!
//! The MCP server lives in the sibling `../saple-mcp` repository and ships as a Tauri sidecar
//! binary. External clients (Claude Code) launch it directly from `.mcp.json`, so Bridge only
//! ever needs a concrete on-disk path plus copy-and-rename staging; it never hosts the server.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use crate::error_code::CodedError;
use crate::process_ext::CommandNoWindow;
use crate::project_roots::ProjectRootRegistry;
// Release-only staging/healing helpers are cfg'd out of dev builds, so their imports follow.
#[cfg(not(debug_assertions))]
use std::fs;
#[cfg(not(debug_assertions))]
use crate::project_roots::get_project_file_path;

/// Absolute path to the `saple-mcp` sidecar binary that MCP configs should reference.
///
/// The MCP server now lives in the standalone `saple-mcp` crate and ships as a Tauri sidecar.
/// External clients (Claude Code) launch it directly from `.mcp.json`, so this must be a concrete
/// on-disk path, not a Tauri Command handle.
///   * **dev** - the triple-suffixed staging file under `src-tauri/binaries/` that
///     `scripts/prepare-sidecar.mjs` produces (TARGET_TRIPLE / SAPLE_BRIDGE_MANIFEST_DIR are baked
///     in by build.rs).
///   * **release** - the per-user staged copy from `ensure_stable_sidecar`. The exe-adjacent
///     bundled copy is only a fallback: install directories are not stable paths (the MSIX
///     WindowsApps dir is versioned per Store update and its ACLs block external clients; an
///     NSIS install can be moved), so `.mcp.json` must never point into them.
pub(crate) fn sidecar_binary_path() -> Result<PathBuf, String> {
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
/// command file name is `saple-mcp` are touched - legacy embedded-server configs keep going
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
pub(crate) fn heal_mcp_configs(project_path: &str) {
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

/// Preview the sidecar's tool catalog (Settings → MCP). The MCP server is no longer in-process, so
/// spawn `saple-mcp`, send one `tools/list` request, and return its `result`. Keeps Bridge ignorant
/// of the catalog contents (no drift). `.no_window()` suppresses the console flash on Windows.
#[tauri::command]
pub async fn test_mcp_tools(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<serde_json::Value, CodedError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || test_mcp_tools_inner(&registry, project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn test_mcp_tools_inner(registry: &ProjectRootRegistry, project_path: String) -> Result<serde_json::Value, CodedError> {
    use std::io::{BufRead, Write};
    use std::process::Stdio;

    registry.ensure_inside_approved_root(&project_path)?;

    let bin = sidecar_binary_path()?;
    if !bin.exists() {
        return Err(CodedError::internal(format!(
            "saple-mcp sidecar not found at {}. Run `npm run prepare-sidecar`.",
            bin.display()
        )));
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
    resp.get("result")
        .cloned()
        .ok_or_else(|| CodedError::internal(
            resp["error"]["message"].as_str().unwrap_or("No result in response"),
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
