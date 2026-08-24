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
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

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

// --- Corrupt-state guard (Phase 2: state integrity) -------------------------------------------
//
// A store whose JSON failed to parse must never be silently overwritten by a later save: the
// corrupt bytes are the only evidence of what went wrong. `state_load.rs` flags such paths here
// and every write through this module (the single funnel for atomic project-state writes) is
// blocked until a recovery action clears the flag.

fn corrupt_flags() -> &'static Mutex<HashMap<String, String>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Flag `path` as corrupt with a human-readable reason; blocks all writes through this module.
pub fn flag_corrupt(path: &Path, reason: &str) {
    let key = lock_key(path);
    corrupt_flags().lock().unwrap().insert(key, reason.to_string());
}

/// Clear the corrupt flag (a recovery action validated the file or the user chose to start
/// empty). Returns whether a flag was present.
pub fn clear_corrupt_flag(path: &Path) -> bool {
    let key = lock_key(path);
    corrupt_flags().lock().unwrap().remove(&key).is_some()
}

fn corrupt_reason(path: &Path) -> Option<String> {
    let key = lock_key(path);
    corrupt_flags().lock().unwrap().get(&key).cloned()
}

/// Atomically write `contents` to `path`, serialized against other writers of the same path.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let guard = lock_for(path);
    let _held = guard.lock().unwrap();
    write_unlocked(path, contents)
}

/// Run `f` while holding both the per-path mutex AND the cross-process sentinel lock, so a full
/// read-modify-write (load JSON, mutate, save) against a canonical collection file is serialized
/// against the saple-mcp sidecar too — not just this process. Fails safely (returns `Err`) when
/// the cross-process lock cannot be taken; `f` MUST persist via [`write_unlocked`] (it already
/// holds the same non-reentrant mutex; [`atomic_write`] would deadlock re-acquiring it). Mirrors
/// saple-mcp's `with_path_lock` so both crates contend on the same sentinel.
pub fn with_path_lock<R>(path: &Path, f: impl FnOnce() -> R) -> Result<R, String> {
    let guard = lock_for(path);
    let _held = guard.lock().unwrap();
    with_cross_process_lock(path, f)
}

/// Temp-file + rename write **without** taking the per-path lock — only safe while already holding
/// it (e.g. inside a [`with_path_lock`] closure); otherwise use [`atomic_write`]. Still tags the
/// write in `own_writes` so the file watcher recognizes the rename event as our own echo.
pub fn write_unlocked(path: &Path, contents: &[u8]) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);

    // Phase 2: a corrupt-flagged state file is never overwritten; recovery must clear the flag
    // first (retry / restore backup / explicit start-empty).
    if let Some(reason) = corrupt_reason(path) {
        return Err(format!(
            "Write blocked: {} is flagged as corrupt ({}). Use recovery to retry, restore the preserved copy, or start empty.",
            path.display(),
            reason
        ));
    }

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
    match rename_with_retry(&tmp, path) {
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

// --- Windows rename retry (Phase 2) ------------------------------------------------------------
//
// On Windows a rename over an open target briefly fails with a sharing violation (os error 32/33)
// whenever an antivirus scanner, search indexer, or another reader holds the destination. That is
// transient by nature, so retry a few times with short backoff before giving up.

/// Transient Windows sharing/lock violations that a bounded retry can clear.
fn is_transient_rename_error(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(32) | Some(33))
}

/// Rename `from` onto `to`, retrying transient Windows sharing violations with short bounded
/// backoff (5 attempts, doubling from 25 ms). `rename_impl` is injectable for tests.
pub(crate) fn rename_with_retry_impl(
    from: &Path,
    to: &Path,
    mut rename_impl: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    const MAX_ATTEMPTS: u32 = 5;
    let backoff_start = Duration::from_millis(25);

    let mut attempt = 0;
    loop {
        attempt += 1;
        match rename_impl(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if is_transient_rename_error(&e) && attempt < MAX_ATTEMPTS => {
                std::thread::sleep(backoff_start * attempt);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

pub(crate) fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    rename_with_retry_impl(from, to, |f, t| fs::rename(f, t))
}

/// The sentinel file that serializes cross-process writers of `target`: a sibling `.<name>.lock`
/// (same directory, same shape as the atomic-write temp files the watcher already tolerates).
fn sentinel_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "f".to_string());
    target.with_file_name(format!(".{}.lock", name))
}

/// Hold an OS-wide advisory lock on `target` across `f`, so a Bridge process and a saple-mcp sidecar
/// never interleave read-modify-write cycles on the same canonical file and drop a record.
///
/// The lock is a sentinel file created with `create_new` (an atomic "create only if absent" on both
/// Windows and Unix — no extra dependency, no per-OS `LockFileEx`/`flock` split). The sentinel
/// records the holder's PID, so a holder that crashed mid-write is detected via PID liveness and
/// its sentinel is stolen; a *live* holder is waited for at most `WAIT_TIMEOUT`.
///
/// Phase 2: locking now fails safely. If the lock cannot be taken within the wait budget (or the
/// sentinel cannot be created at all), this returns an error instead of silently proceeding
/// unlocked — an unlocked read-modify-write is exactly how records get dropped. Locks are also no
/// longer stolen merely for being older than a threshold; only proven-dead PIDs are stolen.
pub fn with_cross_process_lock<R>(target: &Path, f: impl FnOnce() -> R) -> Result<R, String> {
    const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

    with_cross_process_lock_timeout(target, WAIT_TIMEOUT, f)
}

pub(crate) fn with_cross_process_lock_timeout<R>(
    target: &Path,
    wait_timeout: Duration,
    f: impl FnOnce() -> R,
) -> Result<R, String> {
    let lock = sentinel_path(target);
    let acquired = acquire_cross_process_lock(&lock, wait_timeout)?;
    let out = f();
    if acquired {
        let _ = fs::remove_file(&lock);
    }
    Ok(out)
}

fn acquire_cross_process_lock(lock: &Path, wait_timeout: Duration) -> Result<bool, String> {
    let start = Instant::now();
    loop {
        match fs::OpenOptions::new().write(true).create_new(true).open(lock) {
            Ok(mut file) => {
                let _ = write!(file, "{}", std::process::id());
                return Ok(true);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                // A sentinel whose recorded PID is dead belongs to a crashed process: steal it.
                // A live holder (or an unparsable fresh sentinel) is waited for instead.
                let contents = fs::read_to_string(lock).unwrap_or_default();
                match contents.trim().parse::<u32>() {
                    Ok(pid) if pid != std::process::id() && !pid_alive(pid) => {
                        let _ = fs::remove_file(lock);
                        continue;
                    }
                    _ => {
                        if start.elapsed() > wait_timeout {
                            return Err(format!(
                                "Another process holds the write lock {} (holder pid {}). \
                                 Refusing to proceed unlocked to avoid losing state.",
                                lock.display(),
                                contents.trim()
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
            // Can't create the sentinel (perms?) — fail closed rather than write unlocked.
            Err(e) => {
                return Err(format!(
                    "Cannot create cross-process lock {}: {}",
                    lock.display(),
                    e
                ))
            }
        }
    }
}

/// Whether another process with `pid` is currently alive. Used to distinguish a crashed lock
/// holder (steal its sentinel) from a live one (wait). Unknown PIDs are conservatively treated
/// as alive so we never steal from a running process.
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    // Linux exposes /proc/<pid>; on other Unixes without libc wired up, stay conservative.
    Path::new("/proc").join(pid.to_string()).exists()
}

/// True when `target`'s cross-process sentinel exists AND its holder is still alive. The state
/// loader uses this to report a `Locked` outcome instead of reading a file that is being replaced.
pub(crate) fn sentinel_held_by_live_process(target: &Path) -> bool {
    let lock = sentinel_path(target);
    if !lock.exists() {
        return false;
    }
    let contents = fs::read_to_string(&lock).unwrap_or_default();
    match contents.trim().parse::<u32>() {
        Ok(pid) => pid != std::process::id() && pid_alive(pid),
        Err(_) => true, // can't prove the holder is dead - treat as locked
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

    #[test]
    fn corrupt_flag_blocks_writes_until_cleared() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-corrupt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");
        atomic_write(&path, b"original").unwrap();

        flag_corrupt(&path, "parse error");
        let blocked = atomic_write(&path, b"overwritten");
        assert!(blocked.is_err(), "corrupt-flagged writes must be refused");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "original",
            "flagged file must keep its bytes"
        );

        assert!(clear_corrupt_flag(&path));
        atomic_write(&path, b"recovered").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "recovered");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transient_rename_failures_are_retried_then_recovered() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-rename-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("from.tmp");
        let to = dir.join("to.json");
        fs::write(&from, b"data").unwrap();

        // Fail with a Windows sharing violation twice, then succeed: bounded backoff recovers.
        let mut calls = 0;
        let result = rename_with_retry_impl(&from, &to, |f, t| {
            calls += 1;
            if calls <= 2 {
                Err(std::io::Error::from_raw_os_error(32))
            } else {
                fs::rename(f, t)
            }
        });
        assert!(result.is_ok());
        assert_eq!(calls, 3);
        assert_eq!(fs::read_to_string(&to).unwrap(), "data");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistent_rename_failure_reports_after_bounded_attempts() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-rename2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("from.tmp");
        let to = dir.join("locked.json");

        let mut calls = 0;
        let result = rename_with_retry_impl(&from, &to, |_f, _t| {
            calls += 1;
            Err(std::io::Error::from_raw_os_error(33))
        });
        assert!(result.is_err());
        assert_eq!(calls, 5, "must stop at the bounded attempt count");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_transient_rename_errors_fail_immediately() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-rename3-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("missing.tmp");
        let to = dir.join("x.json");

        let mut calls = 0;
        let result = rename_with_retry_impl(&from, &to, |_f, _t| {
            calls += 1;
            Err(std::io::Error::from_raw_os_error(2)) // not a sharing violation
        });
        assert!(result.is_err());
        assert_eq!(calls, 1, "only transient sharing violations may be retried");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_holder_blocks_and_dead_holder_is_stolen() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-cp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");
        let lock = sentinel_path(&target);

        // A sentinel naming a dead process is stolen immediately.
        fs::write(&lock, "999999999").unwrap();
        let out = with_cross_process_lock_timeout(&target, Duration::from_millis(50), || 42);
        assert_eq!(out.unwrap(), 42, "dead holder's sentinel must be stolen");
        assert!(!lock.exists(), "sentinel removed after release");

        // A sentinel held by THIS process (live pid) must fail closed, not proceed unlocked.
        fs::write(&lock, std::process::id().to_string()).unwrap();
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran_clone = ran.clone();
        let result = with_cross_process_lock_timeout(&target, Duration::from_millis(30), move || {
            ran_clone.store(true, Ordering::SeqCst);
        });
        assert!(result.is_err(), "a live holder must fail closed after the wait budget");
        assert!(!ran.load(Ordering::SeqCst), "closure must NOT run unlocked");
        assert_eq!(
            fs::read_to_string(&lock).unwrap(),
            std::process::id().to_string(),
            "the live holder's sentinel is left alone"
        );

        // An unparsable sentinel is treated as locked (conservative) - no age-based stealing.
        fs::write(&lock, "").unwrap();
        let result = with_cross_process_lock_timeout(&target, Duration::from_millis(30), || ());
        assert!(result.is_err(), "unparsable sentinel must fail closed, not be stolen by age");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unparsable_sentinel_counts_as_locked_for_the_loader() {
        let dir = std::env::temp_dir().join(format!("saple-fslock-probe-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("tasks.json");
        assert!(!sentinel_held_by_live_process(&target));

        fs::write(sentinel_path(&target), "garbage").unwrap();
        assert!(sentinel_held_by_live_process(&target), "unprovable holder counts as locked");

        fs::remove_file(sentinel_path(&target)).unwrap();
        fs::write(sentinel_path(&target), "999999999").unwrap();
        assert!(!sentinel_held_by_live_process(&target), "dead holder does not count as locked");

        let _ = fs::remove_dir_all(&dir);
    }
}
