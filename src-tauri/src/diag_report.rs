//! Diagnostics report assembly (Phase 4 observability).
//!
//! `collect_diagnostics` builds the single support bundle behind Settings > "Copy diagnostics
//! report": app identity, OS facts, live session/watcher counts, and bounded tails of the two
//! durable evidence files (app log + privileged-action audit) that Phase 4 already maintains.
//!
//! Redaction contract: every line read back from disk is passed through [`crate::app_log::redact`]
//! again before it leaves the process. The files were written redacted, but re-redacting is cheap
//! defense in depth - a future writer regression must not leak through a diagnostics copy. API
//! keys and keychain values are never read here at all; only presence counts are reported.

use std::fs;
use std::io::{Read, Seek};
use std::path::Path;

use serde::Serialize;

/// How many trailing lines of the app log to include. Enough for a support session; small enough
/// that a pasted report stays readable.
const LOG_TAIL_LINES: usize = 200;
/// Trailing audit entries included verbatim (redacted), plus a total-entry count.
const AUDIT_TAIL_LINES: usize = 50;
/// Hard byte cap on any single file read, even if rotation has not run yet.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub generated_at: String,
    pub app_name: String,
    pub app_version: String,
    pub app_identifier: String,
    pub os: String,
    pub arch: String,
    /// The renderer-selected project root at copy time, if any. Reported as-is: this command is
    /// read-only and never touches the path, and absolute paths are deliberately kept by redaction
    /// because they are required to diagnose anything.
    pub project_path: Option<String>,
    pub pty_session_count: usize,
    pub project_watcher_active: bool,
    pub swarm_watcher_active: bool,
    /// Last [`LOG_TAIL_LINES`] redacted lines of `saple-bridge.log`, oldest first.
    pub log_tail: Vec<String>,
    /// True when the log had more lines than were included.
    pub log_truncated: bool,
    /// Last [`AUDIT_TAIL_LINES`] redacted audit entries (JSON lines).
    pub audit_recent: Vec<String>,
    /// Total number of audit entries currently on disk (current generation only).
    pub audit_entry_count: usize,
}

#[tauri::command]
pub fn collect_diagnostics(
    app: tauri::AppHandle,
    project_path: Option<String>,
    pty: tauri::State<'_, crate::pty::PtyRegistry>,
    watchers: tauri::State<'_, crate::watcher::WatcherState>,
    swarm_watchers: tauri::State<'_, crate::watcher::SwarmWatcherState>,
) -> Result<DiagnosticsReport, String> {
    let package = app.package_info();
    let pty_count = pty
        .sessions
        .lock()
        .map(|sessions| sessions.len())
        .unwrap_or(0);
    let project_watcher_active = watchers
        .0
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);
    let swarm_watcher_active = swarm_watchers
        .0
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);

    let log_dir = crate::app_log::log_dir();
    let (log_tail, log_truncated) = log_dir
        .map(|dir| tail_lines(&dir.join(crate::app_log::LOG_FILE_NAME), LOG_TAIL_LINES))
        .unwrap_or_else(|| (Vec::new(), false));
    // The audit file lives next to the app log but has no public path accessor; reuse the same
    // directory handle rather than adding one.
    let (audit_recent, audit_entry_count) = log_dir
        .map(|dir| {
            let lines = tail_lines(&dir.join(crate::audit::AUDIT_FILE_NAME), AUDIT_TAIL_LINES);
            let total = fs::read_to_string(dir.join(crate::audit::AUDIT_FILE_NAME))
                .map(|contents| contents.lines().count())
                .unwrap_or(0);
            (lines.0, total)
        })
        .unwrap_or_else(|| (Vec::new(), 0));

    Ok(DiagnosticsReport {
        generated_at: crate::project::now_iso(),
        app_name: package.name.clone(),
        app_version: package.version.to_string(),
        app_identifier: app.config().identifier.clone(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        project_path,
        pty_session_count: pty_count,
        project_watcher_active,
        swarm_watcher_active,
        log_tail,
        log_truncated,
        audit_recent,
        audit_entry_count,
    })
}

/// Read up to `max_bytes` from the end of `path` and return its last `max_lines` lines (oldest
/// first), each passed through secret redaction. Missing or unreadable files yield an empty list -
/// diagnostics must degrade gracefully, never error over absent evidence.
fn tail_lines(path: &Path, max_lines: usize) -> (Vec<String>, bool) {
    let Ok(mut file) = fs::File::open(path) else {
        return (Vec::new(), false);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(MAX_READ_BYTES);
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).is_err() {
        return (Vec::new(), false);
    }
    let mut bytes = Vec::new();
    // Lossy conversion: a seek boundary can split a multibyte char; losing one glyph beats
    // losing the whole tail over an encoding error.
    if file.read_to_end(&mut bytes).is_err() {
        return (Vec::new(), false);
    }
    let buf = String::from_utf8_lossy(&bytes);

    // A leading partial line means we seeked into the middle of one; drop it rather than emit a
    // truncated half-line that could confuse the reader.
    let mut lines: Vec<&str> = buf.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    // A trailing partial line (file still being written mid-read) is kept only if terminated.
    let total = lines.len();
    let skipped = total.saturating_sub(max_lines);
    let selected: Vec<String> = lines
        .into_iter()
        .skip(skipped)
        .map(|line| crate::app_log::redact(line))
        .collect();
    (selected, skipped > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_file(tag: &str, contents: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saple-diagrep-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.log");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn tail_returns_the_last_n_lines_oldest_first() {
        let path = temp_file("tail", "l1\nl2\nl3\nl4\nl5\n");
        let (lines, truncated) = tail_lines(&path, 3);
        assert_eq!(lines, vec!["l3", "l4", "l5"]);
        assert!(truncated, "dropped lines must be flagged");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn short_files_are_returned_whole_and_not_flagged() {
        let path = temp_file("short", "a\nb\n");
        let (lines, truncated) = tail_lines(&path, 200);
        assert_eq!(lines, vec!["a", "b"]);
        assert!(!truncated);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_files_degrade_to_empty_evidence() {
        let missing = std::env::temp_dir().join(format!("saple-diagrep-absent-{}", std::process::id()));
        let (lines, truncated) = tail_lines(&missing, 10);
        assert!(lines.is_empty() && !truncated);
    }

    #[test]
    fn tails_are_secret_redacted_before_leaving_the_process() {
        let path = temp_file("redact", "ok line\nspawn failed api_key=sk-abcdef123456\n");
        let (lines, _) = tail_lines(&path, 10);
        assert_eq!(lines[0], "ok line");
        assert_eq!(lines[1], "spawn failed api_key=[REDACTED]");
        assert!(!lines[1].contains("abcdef"), "secret value must not survive");

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_file_without_a_trailing_newline_still_yields_its_last_line() {
        let path = temp_file("nonl", "l1\nl2\nfinal partial write");
        let (lines, truncated) = tail_lines(&path, 10);
        assert_eq!(lines, vec!["l1", "l2", "final partial write"]);
        assert!(!truncated);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
