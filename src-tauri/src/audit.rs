//! Privileged-action audit log (Phase 4 observability).
//!
//! A durable, append-style record of every privileged action Bridge performs on behalf of a
//! caller: shell executions, PTY spawns, destructive file operations. One JSON line per action:
//!
//! `{"ts":...,"source":...,"command":...,"cwd":...,"exit_code":...,"error":...,"duration_ms":...}`
//!
//! The file lives next to the application log (see `app_log::log_dir`), is never rewritten in
//! place (append-only; the size cap rotates to a `.old` generation instead of truncating), and
//! command strings are passed through the same secret redaction as the app log.
//!
//! Like `app_log`, this module is failure-silent and a no-op until `app_log::init` has run.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;


use serde::Serialize;

/// Audit file name inside [`crate::app_log::log_dir`].
pub const AUDIT_FILE_NAME: &str = "audit.log";
/// Previous generation kept when the current file rotates out.
const ROTATED_FILE_NAME: &str = "audit.log.old";
/// Hard cap per generation (2x this is the worst-case disk footprint).
const MAX_AUDIT_BYTES: u64 = 10 * 1024 * 1024;

/// What happened to an audited action that ran to completion.
#[derive(Debug, Clone, Copy)]
pub struct Outcome {
    /// Process exit code where one exists (`shell.run`). `None` for actions without a child
    /// process or for runs killed by timeout/cancel before exit.
    pub exit_code: Option<i32>,
    /// Structured stop reason for non-completed runs ("timed-out", "cancelled").
    pub stop: Option<&'static str>,
}

impl Outcome {
    pub fn exited(exit_code: i32) -> Self {
        Outcome { exit_code: Some(exit_code), stop: None }
    }

    pub fn ok() -> Self {
        Outcome::exited(0)
    }
}

/// One completed privileged action. Internal serialization shape; field names are the contract
/// support tooling will read.
#[derive(Serialize)]
struct AuditEntry<'a> {
    ts: String,
    source: &'a str,
    command: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    duration_ms: u128,
}

/// Record one privileged action. Call at the END of the action with the `Instant` captured just
/// before it started. Best-effort and failure-silent: no-op when logging is uninitialized, and I/O
/// errors are swallowed - auditing must never break the action it audits.
pub fn record(source: &str, command: &str, cwd: Option<&str>, started: Instant, outcome: &Result<Outcome, String>) {
    let Some(dir) = crate::app_log::log_dir() else { return };
    let entry = match outcome {
        Ok(out) => AuditEntry {
            ts: crate::project::now_iso(),
            source,
            command,
            cwd,
            exit_code: out.exit_code,
            error: out.stop,
            duration_ms: started.elapsed().as_millis(),
        },
        Err(err) => AuditEntry {
            ts: crate::project::now_iso(),
            source,
            command,
            cwd,
            // Never persist raw error text verbatim: it may embed key material from provider
            // CLIs. Redacted like any other log content, and bounded so a huge error blob does
            // not dominate the audit file.
            error: Some(&bounded(err)),
            exit_code: None,
            duration_ms: started.elapsed().as_millis(),
        },
    };
    let _ = append_entry(dir, &entry);
}

fn bounded(s: &str) -> String {
    const MAX_ERROR_CHARS: usize = 512;
    let redacted = crate::app_log::redact(s);
    if redacted.chars().count() <= MAX_ERROR_CHARS {
        return redacted;
    }
    let truncated: String = redacted.chars().take(MAX_ERROR_CHARS).collect();
    format!("{}[truncated]", truncated)
}

/// Append one entry as a JSON line into `dir`. The testable core of [`record`].
fn append_entry(dir: &Path, entry: &AuditEntry) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let file = dir.join(AUDIT_FILE_NAME);
    rotate_if_needed(&file)?;

    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut handle = OpenOptions::new().create(true).append(true).open(&file)?;
    handle.write_all(line.as_bytes())
}

fn rotate_if_needed(file: &Path) -> std::io::Result<()> {
    let oversized = fs::metadata(file).map(|m| m.len() > MAX_AUDIT_BYTES).unwrap_or(false);
    if oversized {
        let rotated: PathBuf = file.with_file_name(ROTATED_FILE_NAME);
        let _ = fs::remove_file(&rotated);
        fs::rename(file, rotated)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("saple-audit-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn entry_for(dir: &Path, command: &str, exit_code: Option<i32>, error: Option<String>, dur_ms: u128) {
        let entry = AuditEntry {
            ts: "2026-01-01T00:00:00Z".to_string(),
            source: "review",
            command,
            cwd: Some("C:\\proj"),
            exit_code,
            error: error.as_deref(),
            duration_ms: dur_ms,
        };
        append_entry(dir, &entry).unwrap();
    }

    #[test]
    fn writes_one_json_line_per_action_with_all_fields() {
        let dir = temp_dir("basic");
        fs::create_dir_all(&dir).unwrap();

        entry_for(&dir, "shell.run", Some(0), None, 1234);
        let fail = bounded("spawn failed: api_key=sk-abcdef123456");
        entry_for(&dir, "shell.run", None, Some(fail), 5);

        let contents = fs::read_to_string(dir.join(AUDIT_FILE_NAME)).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);

        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["source"], "review");
        assert_eq!(first["command"], "shell.run");
        assert_eq!(first["cwd"], "C:\\proj");
        assert_eq!(first["exit_code"], 0);
        assert_eq!(first["duration_ms"], 1234);
        assert!(first.get("error").is_none(), "success entries carry no error");

        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(
            second["error"],
            "spawn failed: api_key=[REDACTED]",
            "errors are redacted before hitting the audit trail"
        );
        assert!(second.get("exit_code").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_errors_are_bounded_and_redacted() {
        let blob = format!("boom {} sk-abcdef1234567890", "x".repeat(2000));
        let cut = bounded(&blob);
        assert!(cut.chars().count() <= 512 + "[truncated]".len());
        assert!(!cut.contains("sk-abcdef1234567890"), "secret must not survive bounding");
        assert!(cut.ends_with("[truncated]"));
    }

    #[test]
    fn stop_reasons_are_recorded_in_the_error_field() {
        let dir = temp_dir("stop");
        fs::create_dir_all(&dir).unwrap();

        let timed_out = Some("timed-out".to_string());
        entry_for(&dir, "shell.run", None, timed_out, 90_000);

        let contents = fs::read_to_string(dir.join(AUDIT_FILE_NAME)).unwrap();
        let value: serde_json::Value = serde_json::from_str(contents.trim()).unwrap();
        assert_eq!(value["error"], "timed-out");
        assert!(value.get("exit_code").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_replaces_the_single_old_generation() {
        let dir = temp_dir("rotate");
        fs::create_dir_all(&dir).unwrap();
        let big = "z".repeat((MAX_AUDIT_BYTES + 1) as usize);
        fs::write(dir.join(AUDIT_FILE_NAME), big).unwrap();

        entry_for(&dir, "delete_path", Some(0), None, 1);

        let rotated = fs::metadata(dir.join(ROTATED_FILE_NAME)).unwrap();
        assert_eq!(rotated.len(), MAX_AUDIT_BYTES + 1);
        let current = fs::read_to_string(dir.join(AUDIT_FILE_NAME)).unwrap();
        assert_eq!(current.lines().count(), 1, "fresh generation holds only the new entry");

        let _ = fs::remove_dir_all(&dir);
    }
}
