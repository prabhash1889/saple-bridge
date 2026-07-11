//! Atomic, serialized file writes for `.saple/*` project state.
//!
//! Two writers can target the same project file at once: the renderer (Kanban/swarm saves) and
//! the stdio MCP server (the standalone `saple-mcp <path>` sidecar) while an agent edits tasks. A
//! naive `fs::write` can interleave or expose a half-written file, silently corrupting
//! `tasks.json` / `state.json`.
//!
//! `atomic_write` fixes both failure modes:
//!   * **Per-path mutex** — serializes concurrent writers to the same file *within this process*
//!     so two threads never write the same target at once.
//!   * **Temp file + rename** — the bytes land in a sibling temp file that is then `rename`d over
//!     the target. `rename` is atomic on a single filesystem, so a reader (including the other
//!     process) only ever sees the old or the new file, never a partial one.

use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
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

/// Two spellings of the same file (relative vs absolute, `..` segments, Windows case) must share
/// one mutex, so key on the canonical path. The target may not exist yet — canonicalize the
/// parent and re-attach the file name; fall back to the raw path if even that fails.
fn lock_key(path: &Path) -> String {
    let canonical = path.canonicalize().or_else(|_| match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent.canonicalize().map(|p| p.join(name)),
        _ => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no parent")),
    });
    canonical
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// Above this size, unheld locks are pruned on the next lookup so the registry cannot grow
/// without bound over a long session (one entry per distinct file ever written).
const LOCK_MAP_PRUNE_THRESHOLD: usize = 256;

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let key = lock_key(path);
    let mut map = locks().lock().unwrap();
    if map.len() > LOCK_MAP_PRUNE_THRESHOLD {
        // strong_count == 1 means only the map itself holds the lock — no writer is using it.
        // A writer that grabbed a clone before this prune keeps its Arc alive and is retained.
        map.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Fingerprints of the last content this process wrote to each path, keyed like `lock_for` so
/// two spellings of a file collapse to one entry. The file watcher (`watcher.rs`) consults this
/// to tell its own atomic_write echoes (temp-file+rename fires a change event on the target) from
/// genuine external edits, so a save the renderer just made doesn't bounce back as a reload.
fn own_writes() -> &'static Mutex<HashMap<String, u64>> {
    static OWN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    OWN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fingerprint(contents: &[u8]) -> u64 {
    // DefaultHasher is seeded with fixed keys, so it's stable within a process run — all we need
    // to compare our last write against the bytes currently on disk.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    contents.hash(&mut h);
    h.finish()
}

/// True when `contents` matches the last bytes this process wrote to `path` — i.e. a change event
/// for `path` is our own atomic_write echoing back, not an external edit.
pub fn is_last_own_write(path: &Path, contents: &[u8]) -> bool {
    let key = lock_key(path);
    own_writes().lock().unwrap().get(&key).copied() == Some(fingerprint(contents))
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
        Ok(()) => {
            let mut map = own_writes().lock().unwrap();
            // Bounded like the lock registry: on overflow, clear rather than track which entries
            // are stale. Worst case a few own writes lose their fingerprint and trigger one
            // harmless self-reload each.
            if map.len() > LOCK_MAP_PRUNE_THRESHOLD {
                map.clear();
            }
            map.insert(lock_key(path), fingerprint(contents));
            Ok(())
        }
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

    #[test]
    fn tags_own_writes_for_echo_suppression() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-own-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");

        atomic_write(&path, b"[{\"id\":\"a\"}]").unwrap();
        // The bytes we just wrote read back as our own write (the watcher would skip them)...
        assert!(is_last_own_write(&path, b"[{\"id\":\"a\"}]"));
        // ...but content an external writer put there does not.
        assert!(!is_last_own_write(&path, b"[{\"id\":\"a\"},{\"id\":\"external\"}]"));

        // A later own write moves the fingerprint forward.
        atomic_write(&path, b"[]").unwrap();
        assert!(is_last_own_write(&path, b"[]"));
        assert!(!is_last_own_write(&path, b"[{\"id\":\"a\"}]"));

        let _ = fs::remove_dir_all(&dir);
    }
}
