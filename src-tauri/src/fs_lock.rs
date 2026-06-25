//! Atomic, serialized file writes for `.saple/*` project state.
//!
//! Two writers can target the same project file at once: the renderer (Kanban/swarm saves) and
//! the stdio MCP server (running as a separate `saple-bridge mcp <path>` process) while an agent
//! edits tasks. A naive `fs::write` can interleave or expose a half-written file, silently
//! corrupting `tasks.json` / `state.json`.
//!
//! `atomic_write` fixes both failure modes:
//!   * **Per-path mutex** — serializes concurrent writers to the same file *within this process*
//!     so two threads never write the same target at once.
//!   * **Temp file + rename** — the bytes land in a sibling temp file that is then `rename`d over
//!     the target. `rename` is atomic on a single filesystem, so a reader (including the other
//!     process) only ever sees the old or the new file, never a partial one.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Process-wide registry of per-path locks. Keyed by the path string so every writer of a given
/// file shares one mutex. (Cross-process serialization is impossible here; the temp+rename below
/// is what keeps the *other* process from seeing a torn write.)
fn locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = path.to_string_lossy().to_string();
    let mut map = locks().lock().unwrap();
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Atomically write `contents` to `path`, serialized against other writers of the same path.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let guard = lock_for(path);
    let _held = guard.lock().unwrap();

    let parent = path
        .parent()
        .ok_or_else(|| "Cannot write file with no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());

    // Sibling temp file (same directory) so the rename stays on one filesystem. The pid + counter
    // keep concurrent writers to *different* files from colliding even before the per-path lock.
    let unique = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{}.tmp-{}-{}", file_name, std::process::id(), unique));

    fs::write(&tmp, contents).map_err(|e| format!("Failed to write temp file: {}", e))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("Failed to commit file write: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");

        atomic_write(&path, b"first").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");

        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");

        // No stray temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files not cleaned up: {:?}", leftovers.len());

        let _ = fs::remove_dir_all(&dir);
    }
}
