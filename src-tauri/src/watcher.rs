//! Watches the open project's `.saple` state files for external edits.
//!
//! The renderer only reads `tasks.json` / `swarm/state.json` / `agents/sessions.json` on project
//! open, and every save rewrites the whole in-memory array. So when an external writer (the
//! `saple-mcp` sidecar, an agent) adds a task while the app is open, the next drag persists the
//! stale snapshot and silently drops the external change.
//!
//! This module closes that gap: it watches `.saple` and emits `saple-file-changed` when one of the
//! three tracked files changes on disk, so the frontend can force-reload the affected store before
//! its next save. Echoes of our own [`crate::fs_lock::atomic_write`] (a temp-file+rename fires a
//! change event on the target) are filtered out by fingerprint, so a save the renderer just made
//! never bounces back as a reload.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The active watcher, if any. Dropping the `Debouncer` stops its background thread, so switching
/// projects (or closing the last one) is just a matter of replacing/clearing this.
pub struct WatcherState(pub Mutex<Option<ActiveWatcher>>);

pub struct ActiveWatcher {
    project_path: String,
    // Held only to keep the watch alive; dropping it tears the watcher down.
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        WatcherState(Mutex::new(None))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangedPayload {
    /// Which store to reload: "tasks" | "swarm" | "sessions".
    file: String,
    project_path: String,
}

/// (store key, forward-slash path suffix). The `.saple/` prefix keeps a stray `tasks.json`
/// elsewhere in the tree from matching, and the temp files atomic_write creates
/// (`.tasks.json.tmp-<pid>-<n>`) never match any suffix.
const TRACKED: [(&str, &str); 3] = [
    ("tasks", "/.saple/tasks.json"),
    ("swarm", "/.saple/swarm/state.json"),
    ("sessions", "/.saple/agents/sessions.json"),
];

fn tracked_kind(path: &Path) -> Option<&'static str> {
    let norm = path.to_string_lossy().replace('\\', "/");
    TRACKED
        .iter()
        .find(|(_, suffix)| norm.ends_with(suffix))
        .map(|(kind, _)| *kind)
}

/// Start (or re-point) the watcher at `project_path`'s `.saple` directory. Idempotent for the
/// path already being watched, so the frontend can call it on every project-open without churn.
#[tauri::command]
pub fn watch_project_files(
    project_path: String,
    app_handle: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();

    if guard.as_ref().map(|w| w.project_path == project_path).unwrap_or(false) {
        return Ok(());
    }

    // Drop the old watcher (stops its thread) before arming the new one.
    *guard = None;

    let saple_dir = Path::new(&project_path).join(".saple");
    if !saple_dir.exists() {
        // Nothing to watch yet — re-armed on the next project open once `.saple` exists.
        return Ok(());
    }

    let emit_path = project_path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            // One reload per file per burst, even if it was rewritten several times in the window.
            let mut emitted: Vec<&str> = Vec::new();
            for event in events {
                let Some(kind) = tracked_kind(&event.path) else { continue };
                if emitted.contains(&kind) {
                    continue;
                }
                // Skip our own atomic_write echoing back; only surface genuine external edits.
                if let Ok(bytes) = std::fs::read(&event.path) {
                    if crate::fs_lock::is_last_own_write(&event.path, &bytes) {
                        continue;
                    }
                }
                emitted.push(kind);
                let _ = app_handle.emit(
                    "saple-file-changed",
                    FileChangedPayload {
                        file: kind.to_string(),
                        project_path: emit_path.clone(),
                    },
                );
            }
        },
    )
    .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(&saple_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch {}: {}", saple_dir.display(), e))?;

    *guard = Some(ActiveWatcher { project_path, _debouncer: debouncer });
    Ok(())
}

/// Stop watching (last workspace closed). Also happens automatically when the app exits.
#[tauri::command]
pub fn unwatch_project_files(state: State<'_, WatcherState>) -> Result<(), String> {
    *state.0.lock().unwrap() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_tracked_files_only() {
        assert_eq!(tracked_kind(Path::new("/home/u/proj/.saple/tasks.json")), Some("tasks"));
        assert_eq!(
            tracked_kind(Path::new("/home/u/proj/.saple/swarm/state.json")),
            Some("swarm")
        );
        assert_eq!(
            tracked_kind(Path::new("/home/u/proj/.saple/agents/sessions.json")),
            Some("sessions")
        );
        // Windows separators normalize the same way.
        assert_eq!(
            tracked_kind(Path::new(r"C:\proj\.saple\swarm\state.json")),
            Some("swarm")
        );
        // The temp file atomic_write renames from must not look like a real change.
        assert_eq!(tracked_kind(Path::new("/home/u/proj/.saple/.tasks.json.tmp-123-4")), None);
        // Unrelated `.saple` files (prompts, memory, mailbox) are ignored.
        assert_eq!(tracked_kind(Path::new("/home/u/proj/.saple/memory/note.md")), None);
        assert_eq!(tracked_kind(Path::new("/home/u/proj/tasks.json")), None);
    }
}
