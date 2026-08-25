//! Durable application log (Phase 4 observability).
//!
//! One append-style log file under the OS application log directory
//! (`%LOCALAPPDATA%/<identifier>/logs` via Tauri's `app_log_dir`), with a size cap and a single
//! generation of rotation so it can never grow unbounded. Hand-rolled instead of pulling in a
//! logging framework: the surface is tiny (a few lines per session), and redaction has to be
//! bespoke anyway because the hard requirement is "no secrets ever reach disk".
//!
//! Failure-silent by contract: every I/O error is swallowed. Diagnostics must never crash the app.
//!
//! The same directory also hosts the privileged-action audit log (`audit.rs`), and
//! `log_dir()` is exposed so support tooling (e.g. a "Copy diagnostics report" action) can find it.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Current log file name inside [`log_dir`].
pub const LOG_FILE_NAME: &str = "saple-bridge.log";
/// Previous generation, kept when the current file rotates out.
const ROTATED_FILE_NAME: &str = "saple-bridge.log.old";
/// Hard cap on one log generation. A few MB covers months of normal use; anything larger means
/// something is spamming, which rotation then bounds at 2x this value.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Install the durable log location. Called once from `lib.rs` setup with Tauri's resolved
/// `app_log_dir`. Creating the directory here keeps first-write cheap; failure is tolerated and
/// retried on each write.
pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir);
}

/// The configured log directory, if initialization ran. Exposed for diagnostics tooling that
/// needs to point the user at (or copy) the durable evidence files.
#[allow(dead_code)]
pub fn log_dir() -> Option<&'static PathBuf> {
    LOG_DIR.get()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Warn/Info/Debug are consumed by callers landing with later Phase 4 work
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }
}

/// Append one redacted, timestamped line to the durable log. Best-effort: returns silently when
/// logging was never initialized or any I/O step fails.
pub fn log(level: Level, source: &str, message: &str) {
    if let Some(dir) = LOG_DIR.get() {
        let _ = write_entry(dir, level.as_str(), source, message);
    }
}

/// Write one log line into `dir`. The testable core of [`log`]: takes the directory explicitly so
/// unit tests never touch (or depend on) process-global state. Rotation happens before the write:
/// once the current file exceeds `MAX_LOG_BYTES`, it is renamed to `.old` (replacing the previous
/// generation) and the write starts a fresh file.
fn write_entry(dir: &Path, level: &str, source: &str, message: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let file = dir.join(LOG_FILE_NAME);
    rotate_if_needed(&file)?;

    let line = format!(
        "{} {} [{}] {}\n",
        crate::project::now_iso(),
        level,
        sanitize_source(source),
        redact(message)
    );
    let mut handle = OpenOptions::new().create(true).append(true).open(&file)?;
    // Single write call: an interleaving writer can only splice between writes, never mid-line.
    handle.write_all(line.as_bytes())
}

fn rotate_if_needed(file: &Path) -> std::io::Result<()> {
    let oversized = fs::metadata(file).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    if oversized {
        let rotated = file.with_file_name(ROTATED_FILE_NAME);
        let _ = fs::remove_file(&rotated);
        fs::rename(file, rotated)?;
    }
    Ok(())
}

/// Source tags come from call sites (module names); keep them to a safe charset so a weird tag
/// can never break the line format or smuggle content past redaction context.
fn sanitize_source(source: &str) -> String {
    let cleaned: String = source
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect();
    let truncated: String = cleaned.chars().take(64).collect();
    if truncated.is_empty() { "unknown".to_string() } else { truncated }
}

// --- Secret redaction ---------------------------------------------------------------------------

/// Replacement marker for anything that looked like a credential.
const REDACTED: &str = "[REDACTED]";

/// Known credential value shapes. Only the run of secret characters after these prefixes is
/// replaced; the prefix itself stays so the log still says WHAT kind of token leaked. Prefixes
/// are distinctive enough that requiring a non-word character before them avoids false hits like
/// "task-123456789".
const TOKEN_PREFIXES: &[&str] = &[
    "sk-proj-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "glpat-",
    "xoxb-", "xoxa-", "xoxp-", "xoxs-", "AKIA", "ASIA", "AIza", "ya29.", "sq0atp-",
];

/// Key names whose assigned value is treated as a credential (`api_key=...`, `"token": "..."`).
const SECRET_KEYS: &[&str] = &[
    "api_key", "apikey", "access_token", "refresh_token", "id_token", "client_secret",
    "secret", "password", "passwd", "authorization", "auth_token", "session_key",
    "private_key", "service_key", "bearer", "key", "token",
];

/// Strip anything resembling a credential from `message`: known token shapes, `Bearer ...`
/// headers, and key/value pairs whose key names a secret. Absolute user paths are intentionally
/// KEPT - they are needed to diagnose anything - but values that look like credentials go.
///
/// All three detectors run against the ORIGINAL text and share one mask, which is collapsed into
/// `[REDACTED]` markers once at the end. Chaining string-to-string passes would instead feed each
/// pass the previous pass's output, where the `[REDACTED]` markers themselves would confuse the
/// value scanners (e.g. `api_key=sk-x` -> token pass -> kv pass re-masking around the marker).
pub fn redact(message: &str) -> String {
    if message.is_empty() {
        return message.to_string();
    }
    let chars: Vec<char> = message.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let mut masked = vec![false; chars.len()];
    mask_token_prefixes(&chars, &lower, &mut masked);
    mask_bearer_values(&chars, &lower, &mut masked);
    mask_key_values(&chars, &lower, &mut masked);
    rebuild(&chars, &masked)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn mark(masked: &mut [bool], start: usize, end: usize) {
    for m in &mut masked[start..end] {
        *m = true;
    }
}

fn mask_token_prefixes(chars: &[char], lower: &[char], masked: &mut [bool]) {
    for prefix in TOKEN_PREFIXES {
        let p: Vec<char> = prefix.chars().map(|c| c.to_ascii_lowercase()).collect();
        let mut i = 0;
        while i + p.len() <= lower.len() {
            if lower[i..i + p.len()] == p[..]
                && (i == 0 || !is_word_char(chars[i - 1]))
            {
                // Replace the run of token-ish characters following the prefix.
                let mut j = i + p.len();
                while j < chars.len()
                    && (chars[j].is_ascii_alphanumeric() || matches!(chars[j], '_' | '-'))
                    && j - i < 512
                {
                    j += 1;
                }
                if j > i + p.len() {
                    mark(masked, i + p.len(), j);
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
}

fn mask_bearer_values(chars: &[char], lower: &[char], masked: &mut [bool]) {
    let needle: Vec<char> = "bearer".chars().collect();
    let mut i = 0;

    while i + needle.len() <= lower.len() {
        if lower[i..i + needle.len()] == needle[..]
            && (i == 0 || !is_word_char(chars[i - 1]))
        {
            let mut j = i + needle.len();
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let start = j;
            // '.' stays in the run: JWTs are dot-separated triples.
            while j < chars.len()
                && !chars[j].is_whitespace()
                && !matches!(chars[j], '"' | ',' | ')' | ']' | '}')
                && j - start < 512
            {
                j += 1;
            }
            if j > start {
                mark(masked, start, j);
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

fn mask_key_values(chars: &[char], lower: &[char], masked: &mut [bool]) {
    for key in SECRET_KEYS {
        let k: Vec<char> = key.chars().collect();
        let mut i = 0;
        while i + k.len() <= lower.len() {
            // A preceding `"` opens a JSON-quoted key (`"apiKey"`), so it does NOT disqualify;
            // only word characters / dashes mean we are inside a longer identifier.
            let boundary_before =
                i == 0 || !(is_word_char(lower[i - 1]) || lower[i - 1] == '-');
            let end = i + k.len();
            let boundary_after =
                end == lower.len() || !(is_word_char(lower[end]) || lower[end] == '-');
            if lower[i..end] == k[..] && boundary_before && boundary_after {
                // Walk to the assignment separator, tolerating JSON quoting: `key": "v`,
                // `key = v`, `key=v`.
                let mut j = end;
                if j < chars.len() && chars[j] == '"' {
                    j += 1;
                }
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j >= chars.len() || !matches!(chars[j], ':' | '=') {
                    i = end;
                    continue;
                }
                j += 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                let start = j;
                let stop_char = match chars.get(start) {
                    Some('"') => Some('"'),
                    Some('\'') => Some('\''),
                    _ => None,
                };
                if let Some(q) = stop_char {
                    j += 1;
                    while j < chars.len() && chars[j] != q && j - start < 514 {
                        j += 1;
                    }
                    j = (j + 1).min(chars.len()); // include the closing quote
                } else {
                    while j < chars.len()
                        && !chars[j].is_whitespace()
                        && !matches!(chars[j], ',' | ';' | ')' | ']' | '}')
                        && j - start < 512
                    {
                        j += 1;
                    }
                    // A scheme indicator (`Authorization: Bearer <token>`) names the credential,
                    // it is not one. Leave it visible so the bearer pass can redact the value
                    // that follows; redacting the scheme word too would hide what leaked.
                    let word: String = chars[start..j].iter().collect::<String>().to_ascii_lowercase();
                    if matches!(word.as_str(), "bearer" | "basic" | "digest") {
                        i = end;
                        continue;
                    }
                }
                if j > start {
                    mark(masked, start, j);
                }
                i = j.max(end);
                continue;
            }
            i += 1;
        }
    }
}

/// Collapse every masked span into a single `[REDACTED]` marker per span.
fn rebuild(chars: &[char], masked: &[bool]) -> String {
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if masked[i] {
            out.push_str(REDACTED);
            while i < chars.len() && masked[i] {
                i += 1;
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[tauri::command]
pub fn log_renderer_error(message: String, source: Option<String>) -> Result<(), String> {
    log(
        Level::Error,
        source.as_deref().unwrap_or("renderer"),
        &message,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "saple-applog-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn redacts_known_token_shapes_but_keeps_the_prefix() {
        assert_eq!(redact("using sk-abcd1234EFGH5678 today"), "using sk-[REDACTED] today");
        assert_eq!(
            redact("Authorization: Bearer abc123.def_456"),
            "Authorization: Bearer [REDACTED]"
        );
        assert_eq!(
            redact("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz"),
            // The ghp_ value shape is caught even though the key itself (`GITHUB_TOKEN`) has an
            // underscore-boundary and is deliberately NOT treated as a bare assignment target.
            "export GITHUB_TOKEN=ghp_[REDACTED]"
        );
        // A word merely containing a prefix substring ("task-...") must not be touched...
        assert_eq!(redact("task-123456789 pending"), "task-123456789 pending");
        // ...and neither may a too-short lookalike.
        assert_eq!(redact("risk-1 ok"), "risk-1 ok");
    }

    #[test]
    fn redacts_key_value_secrets_in_several_spellings() {
        assert_eq!(
            redact("failed with api_key=hunter2 please retry"),
            "failed with api_key=[REDACTED] please retry"
        );
        assert_eq!(
            redact("{\"apiKey\": \"super-secret-value\"}"),
            // The quoted value (quotes included) collapses to a single marker.
            "{\"apiKey\": [REDACTED]}"
        );
        assert_eq!(
            redact("client_secret: 'abc def' trailing"),
            "client_secret: [REDACTED] trailing"
        );
        // Harmless assignments stay readable.
        assert_eq!(
            redact("timeout_seconds=90 retries=3"),
            "timeout_seconds=90 retries=3"
        );
    }

    #[test]
    fn stacked_detectors_collapse_to_one_marker() {
        // A kv-named secret whose value ALSO matches a token shape must come out as one marker,
        // not as fragments left behind by the passes re-scanning each other's markers.
        assert_eq!(
            redact("spawn failed: api_key=sk-abcdef123456"),
            "spawn failed: api_key=[REDACTED]"
        );
        assert_eq!(
            redact("{\"apiKey\": \"ghp_abcdefghijklmnopqrstuvwxyz\"}"),
            "{\"apiKey\": [REDACTED]}"
        );
    }

    #[test]
    fn keeps_absolute_paths_and_plain_text() {
        let msg = "write failed for C:\\Users\\dev\\project\\.saple\\tasks.json (os error 32)";
        assert_eq!(redact(msg), msg);
        assert_eq!(redact("ordinary log line"), "ordinary log line");
    }

    #[test]
    fn writes_timestamped_level_lines_to_the_given_directory() {
        let dir = temp_dir("basic");
        write_entry(&dir, "ERROR", "project", "boom: api_key=xyz123").unwrap();

        let contents = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(contents.contains("ERROR [project] boom: api_key=[REDACTED]"), "{contents}");
        assert!(contents.starts_with("20"), "line must start with an ISO timestamp: {contents}");
        assert_eq!(contents.lines().count(), 1);

        write_entry(&dir, "INFO", "swarm", "second line").unwrap();
        let contents = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert_eq!(contents.lines().count(), 2, "entries append");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_when_the_file_exceeds_the_size_cap() {
        let dir = temp_dir("rotate");
        fs::create_dir_all(&dir).unwrap();
        // Small synthetic check: write entries until over the cap would be slow, so verify the
        // rotation branch directly by planting an oversized current file.
        let big = "x".repeat((MAX_LOG_BYTES + 1) as usize);
        fs::write(dir.join(LOG_FILE_NAME), big).unwrap();

        write_entry(&dir, "WARN", "test", "after rotation").unwrap();

        let rotated = fs::read_to_string(dir.join(ROTATED_FILE_NAME)).unwrap();
        assert_eq!(rotated.len() as u64, MAX_LOG_BYTES + 1, "old generation preserved");
        let current = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(current.contains("WARN [test] after rotation"), "fresh file started");

        // Second rotation replaces (never stacks onto) the single old generation.
        let big2 = "y".repeat((MAX_LOG_BYTES + 2) as usize);
        fs::write(dir.join(LOG_FILE_NAME), big2).unwrap();
        write_entry(&dir, "WARN", "test", "again").unwrap();
        let rotated = fs::read_to_string(dir.join(ROTATED_FILE_NAME)).unwrap();
        assert!(rotated.starts_with('y'), "old generation replaced");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitizes_hostile_source_tags() {
        let dir = temp_dir("source");
        write_entry(&dir, "INFO", "bad source\nINJECTED", "msg").unwrap();
        let contents = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(contents.contains("[bad_source_INJECTED]"), "{contents}");
        assert!(!contents.contains("INJECTED] bad") && contents.lines().count() == 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninitialized_logging_is_a_silent_no_op() {
        // init() was never called in this test binary's shared state unless another test did;
        // either way this must not panic and must return without writing anywhere new.
        log(Level::Info, "test", "no-op");
    }
}
