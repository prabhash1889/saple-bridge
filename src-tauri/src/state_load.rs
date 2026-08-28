//! Structured state-file loading and recovery (Improvement Plan Phase 2).
//!
//! Every persisted store must distinguish `missing` from `unreadable`/`corrupt`. A corrupt
//! `.saple/*.json` file is never treated as empty state: the original bytes are preserved in a
//! sibling `.bak` copy, the path is flagged corrupt (which blocks every subsequent write through
//! [`crate::fs_lock`]) until the user picks a recovery action.
//!
//! It also centralizes JSON text reading: UTF-8 BOMs are stripped consistently, and UTF-16/32
//! content is reported clearly instead of failing with an opaque parse error.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::project_roots::get_project_file_path;

/// Outcome of loading a persisted state file. Serialized to the renderer with a `status` tag so
/// the frontend can branch on `missing | loaded | corrupt | locked | ioError`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StateLoadResult {
    /// File does not exist - a fresh project; the caller may initialize empty state freely.
    Missing,
    /// File exists, reads as text, and (for `.json`) parses cleanly.
    Loaded { content: String },
    /// File exists but its JSON is unparseable. Original bytes were preserved at `backup_path`
    /// and every write to this path is blocked until a recovery action clears the flag.
    Corrupt { error: String, backup_path: String },
    /// Another live process holds the cross-process sentinel for this file right now.
    Locked,
    /// The file exists but could not be read (permissions, encoding, ...).
    IoError { error: String },
}

/// Reads a text file with consistent encoding handling: strips a UTF-8 BOM, rejects UTF-16/32
/// BOMs with a clear message, and surfaces IO errors distinctly from parse errors.
pub(crate) enum JsonText {
    Ok(String),
    Io(std::io::Error),
    Encoding(String),
}

pub(crate) fn read_json_text(path: &Path) -> JsonText {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return JsonText::Io(e),
    };
    // UTF-32 and UTF-16 both start with a 2-byte BOM pattern (FF FE / FE FF); reject them before
    // any decode attempt so the user gets "re-save as UTF-8" guidance instead of mojibake or a
    // confusing serde error.
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return JsonText::Encoding(format!(
            "{} is encoded as UTF-16/UTF-32 (byte-order mark detected). Re-save it as UTF-8 to use it with Saple Bridge.",
            path.display()
        ));
    }
    let bytes = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => rest.to_vec(),
        None => bytes,
    };
    match String::from_utf8(bytes) {
        Ok(s) => JsonText::Ok(s),
        Err(_) => JsonText::Encoding(format!(
            "{} is not valid UTF-8. Re-save it as UTF-8 to use it with Saple Bridge.",
            path.display()
        )),
    }
}

fn is_json_file(file_path: &str) -> bool {
    Path::new(file_path)
        .extension()
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

/// Sibling backup path preserving the original bytes of a corrupt file:
/// `<dir>/<name>.corrupt-<unix_ms>.bak`.
fn corrupt_backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "state".to_string());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.with_file_name(format!("{}.corrupt-{}.bak", name, ts))
}

fn existing_corrupt_backup(path: &Path, contents: &[u8]) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let prefix = format!("{}.corrupt-", name);
    let mut backups: Vec<PathBuf> = std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|candidate| {
            candidate
                .file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.starts_with(&prefix) && name.ends_with(".bak")
                })
                .unwrap_or(false)
        })
        .filter(|candidate| std::fs::read(candidate).ok().as_deref() == Some(contents))
        .collect();
    backups.sort();
    backups.pop()
}

/// Preserve the original bytes of a corrupt file and flag the path so all writes are blocked
/// until a recovery action resolves it. Returns the backup path. Shared with other modules
/// (review records, project config) that parse JSON outside [`load_state_inner`].
pub(crate) fn preserve_and_flag_corrupt(path: &Path, parse_error: &str) -> Result<PathBuf, String> {
    let contents = std::fs::read(path)
        .map_err(|e| format!("Failed to preserve corrupt file {}: {}", path.display(), e))?;
    let backup =
        existing_corrupt_backup(path, &contents).unwrap_or_else(|| corrupt_backup_path(path));
    if !backup.exists() {
        std::fs::write(&backup, &contents)
            .map_err(|e| format!("Failed to preserve corrupt file {}: {}", path.display(), e))?;
    }
    crate::fs_lock::flag_corrupt(path, parse_error);
    Ok(backup)
}

/// True when another live process currently holds the cross-process sentinel for `path`. A
/// leftover sentinel from a dead process does not count as locked.
fn probe_locked(path: &Path) -> bool {
    crate::fs_lock::sentinel_held_by_live_process(path)
}

/// Load a contained project state file as a structured outcome. Corrupt JSON preserves the
/// original bytes, flags the path (blocking writes), and reports the backup location.
pub(crate) fn load_state_inner(project_path: &str, file_path: &str) -> Result<StateLoadResult, String> {
    let path = get_project_file_path(project_path, file_path)?;
    if !path.exists() {
        return Ok(StateLoadResult::Missing);
    }
    if probe_locked(&path) {
        return Ok(StateLoadResult::Locked);
    }

    let text = match read_json_text(&path) {
        JsonText::Ok(t) => t,
        JsonText::Io(e) => return Ok(StateLoadResult::IoError { error: e.to_string() }),
        JsonText::Encoding(m) => return Ok(StateLoadResult::IoError { error: m }),
    };

    if !is_json_file(file_path) {
        return Ok(StateLoadResult::Loaded { content: text });
    }

    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(_) => {
            // The user may have repaired the file externally while it was flagged; a clean
            // parse lifts the write block automatically.
            crate::fs_lock::clear_corrupt_flag(&path);
            Ok(StateLoadResult::Loaded { content: text })
        }
        Err(e) => {
            let err = format!("Failed to parse {} as JSON: {}", file_path, e);
            let backup = preserve_and_flag_corrupt(&path, &err)?;
            Ok(StateLoadResult::Corrupt {
                error: err,
                backup_path: backup.to_string_lossy().to_string(),
            })
        }
    }
}

/// Apply a user-chosen recovery action to a corrupt-flagged state file and return the fresh
/// load outcome.
///
/// - `retry`: re-validate the current on-disk bytes (the user fixed them externally).
/// - `restore_backup`: copy the preserved `.corrupt-*.bak` back over the target, then validate.
/// - `start_empty`: clear the flag so the store can initialize fresh state (the corrupt copy
///   stays on disk next to the file).
pub(crate) fn resolve_state_corruption_inner(
    project_path: &str,
    file_path: &str,
    action: &str,
) -> Result<StateLoadResult, String> {
    let path = get_project_file_path(project_path, file_path)?;

    match action {
        "retry" | "start_empty" => {}
        "restore_backup" => {
            // Restore the most recent preserved copy for this file, then re-validate below.
            // Lift the flag first: the atomic write itself is blocked while the path is flagged,
            // and re-validation below re-flags if the restored bytes are still broken.
            crate::fs_lock::clear_corrupt_flag(&path);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .ok_or_else(|| "Invalid state file path".to_string())?;
            let prefix = format!("{}.corrupt-", name);
            let mut backups: Vec<PathBuf> = std::fs::read_dir(
                path.parent().ok_or_else(|| "Invalid state file path".to_string())?,
            )
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&prefix) && n.to_string_lossy().ends_with(".bak"))
                    .unwrap_or(false)
            })
            .collect();
            backups.sort();
            let backup = backups
                .pop()
                .ok_or_else(|| "No preserved corrupt copy found to restore".to_string())?;
            let bytes = std::fs::read(&backup).map_err(|e| e.to_string())?;
            crate::fs_lock::atomic_write(&path, &bytes)?;
        }
        other => return Err(format!("Unknown recovery action '{}'", other)),
    }

    if action == "start_empty" {
        // Explicit operator decision: unblock writes; the caller initializes empty state.
        crate::fs_lock::clear_corrupt_flag(&path);
        return Ok(StateLoadResult::Missing);
    }

    load_state_inner(project_path, file_path)
}

#[tauri::command]
pub async fn load_state_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, std::sync::Arc<crate::project_roots::ProjectRootRegistry>>,
) -> Result<StateLoadResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || load_state_inner(&project_path, &file_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_state_corruption(
    project_path: String,
    file_path: String,
    action: String,
    registry: tauri::State<'_, std::sync::Arc<crate::project_roots::ProjectRootRegistry>>,
) -> Result<StateLoadResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || resolve_state_corruption_inner(&project_path, &file_path, &action))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_roots::ProjectRootRegistry;
    use std::sync::Arc;

    struct TempProject {
        path: PathBuf,
        _registry: Arc<ProjectRootRegistry>,
    }

    impl TempProject {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("saple_state_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join(".saple")).unwrap();
            let registry = Arc::new(ProjectRootRegistry::new());
            registry.register_root(&path).unwrap();
            TempProject { path, _registry: registry }
        }
        fn project(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            crate::fs_lock::clear_corrupt_flag(&self.path.join(".saple").join("tasks.json"));
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn tasks_rel() -> &'static str {
        ".saple/tasks.json"
    }

    #[test]
    fn missing_reported_for_absent_file() {
        let p = TempProject::new();
        let out = load_state_inner(&p.project(), tasks_rel()).unwrap();
        assert!(matches!(out, StateLoadResult::Missing));
    }

    #[test]
    fn loaded_content_round_trips_and_strips_bom() {
        let p = TempProject::new();
        let file = p.path.join(".saple").join("tasks.json");
        std::fs::write(&file, "\u{feff}[]".as_bytes()).unwrap();
        match load_state_inner(&p.project(), tasks_rel()).unwrap() {
            StateLoadResult::Loaded { content } => assert_eq!(content, "[]", "BOM must be stripped"),
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn utf16_is_reported_clearly_not_parsed_as_garbage() {
        let p = TempProject::new();
        let file = p.path.join(".saple").join("tasks.json");
        std::fs::write(&file, [0xFF, 0xFE]).unwrap();
        match load_state_inner(&p.project(), tasks_rel()).unwrap() {
            StateLoadResult::IoError { error } => {
                assert!(error.contains("UTF"), "message should mention encoding: {}", error)
            }
            other => panic!("expected ioError, got {:?}", other),
        }
    }

    #[test]
    fn corrupt_preserves_bytes_flags_writes_and_recovers() {
        let p = TempProject::new();
        let rel = tasks_rel();
        let file = p.path.join(".saple").join("tasks.json");
        std::fs::write(&file, "{ not json").unwrap();

        // First load flags corruption and preserves the original bytes.
        let out = load_state_inner(&p.project(), rel).unwrap();
        let StateLoadResult::Corrupt { error, backup_path } = out else {
            panic!("expected corrupt, got {:?}", out);
        };
        assert!(error.contains("parse"));
        assert_eq!(
            std::fs::read_to_string(&backup_path).unwrap(),
            "{ not json",
            "original bytes must be preserved verbatim"
        );

        // Repeated polls reuse the preserved copy instead of leaking one backup per read.
        let StateLoadResult::Corrupt {
            backup_path: repeated_backup,
            ..
        } = load_state_inner(&p.project(), rel).unwrap()
        else {
            panic!("expected corrupt on repeated load");
        };
        assert_eq!(repeated_backup, backup_path);
        let backup_count = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.starts_with("tasks.json.corrupt-") && name.ends_with(".bak")
            })
            .count();
        assert_eq!(backup_count, 1);

        // Subsequent writes through the shared atomic-write funnel are blocked...
        let blocked = crate::fs_lock::atomic_write(&file, b"[]");
        assert!(blocked.is_err(), "writes to a corrupt-flagged file must be blocked");
        assert!(blocked.unwrap_err().contains("corrupt"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");

        // ...until the user explicitly starts empty.
        let resolved = resolve_state_corruption_inner(&p.project(), rel, "start_empty").unwrap();
        assert!(matches!(resolved, StateLoadResult::Missing));
        assert!(crate::fs_lock::atomic_write(&file, b"[]").is_ok(), "flag cleared, writes resume");
    }

    #[test]
    fn restore_backup_recovers_the_preserved_copy() {
        let p = TempProject::new();
        let rel = tasks_rel();
        let file = p.path.join(".saple").join("tasks.json");
        std::fs::write(&file, "broken{{{").unwrap();

        let StateLoadResult::Corrupt { .. } = load_state_inner(&p.project(), rel).unwrap() else {
            panic!("expected corrupt");
        };

        let out = resolve_state_corruption_inner(&p.project(), rel, "restore_backup").unwrap();
        let StateLoadResult::Corrupt { .. } = out else {
            panic!("restoring preserved broken bytes should re-flag corrupt, got {:?}", out);
        };

        // Simulate an external fix, then retry validates and unblocks.
        std::fs::write(&file, r#"[{"id":"a"}]"#).unwrap();
        let retried = resolve_state_corruption_inner(&p.project(), rel, "retry").unwrap();
        assert!(matches!(retried, StateLoadResult::Loaded { .. }));
        assert!(crate::fs_lock::atomic_write(&file, b"[]").is_ok());
    }

    #[test]
    fn non_json_files_load_without_parse_validation() {
        let p = TempProject::new();
        let file = p.path.join(".saple").join("notes.md");
        std::fs::write(&file, "# any text <>{").unwrap();
        match load_state_inner(&p.project(), ".saple/notes.md").unwrap() {
            StateLoadResult::Loaded { content } => assert_eq!(content, "# any text <>{"),
            other => panic!("expected loaded, got {:?}", other),
        }
    }
}
