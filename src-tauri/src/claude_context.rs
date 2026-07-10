// Context-left readout for Claude Code panes. Claude Code writes a JSONL transcript per
// session under <CLAUDE_CONFIG_DIR|~/.claude>/projects/<project-slug>/<session-uuid>.jsonl;
// every assistant entry carries `message.usage`, whose input+cache token sum is the current
// context size. spawn_pty launches `claude --session-id <uuid>` with a bridge-generated
// uuid, so the transcript filename is known exactly. Read-only: nothing here writes.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeContextUsage {
    pub used_tokens: u64,
    pub model: String,
}

/// Session ids cross the renderer→Rust trust boundary and are interpolated into both the
/// provider launch command and a transcript filename, so restrict to UUID shape (hex + '-').
pub(crate) fn is_valid_session_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Claude Code names a project's transcript dir by replacing every non-alphanumeric
/// path character with '-' (e.g. "C:\Users\x" -> "C--Users-x").
fn project_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// <CLAUDE_CONFIG_DIR|~/.claude>/projects — same config-dir resolution as diagnostics.rs.
fn claude_projects_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|h| PathBuf::from(h).join(".claude"))
        })
        .map(|d| d.join("projects"))
}

// Transcripts grow to many MB over a long session; only the tail is read each poll.
const TAIL_BYTES: u64 = 64 * 1024;

/// Newest assistant entry with usage in the transcript tail. Sidechain (subagent) entries
/// track their own separate context window and are skipped. A line truncated by the tail
/// seek simply fails to parse and is passed over.
fn parse_tail(tail: &str) -> Option<ClaudeContextUsage> {
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
            continue;
        }
        let Some(usage) = v.pointer("/message/usage") else {
            continue;
        };
        let tok = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let used = tok("input_tokens") + tok("cache_creation_input_tokens") + tok("cache_read_input_tokens");
        if used == 0 {
            continue;
        }
        let model = v
            .pointer("/message/model")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        return Some(ClaudeContextUsage { used_tokens: used, model });
    }
    None
}

fn read_usage(path: &Path) -> Option<ClaudeContextUsage> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    parse_tail(&String::from_utf8_lossy(&bytes))
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// File creation time, falling back to mtime on filesystems without it (both Windows
/// and macOS - the supported targets - report it).
fn created_or_mtime(p: &Path) -> Option<SystemTime> {
    let m = fs::metadata(p).ok()?;
    m.created().or_else(|_| m.modified()).ok()
}

/// While the pane's own transcript was written this recently, it is trusted
/// unconditionally and siblings are never considered.
const EXACT_FRESH_WINDOW: Duration = Duration::from_secs(120);

/// Transcript for this pane. Normally exactly <session_uuid>.jsonl; siblings only enter
/// the picture for `/clear` / `/resume` typed inside the pane, which start a new session
/// file whose id we cannot know. Two guards keep concurrent Claude panes in the same
/// project from shadowing each other: the exact file wins outright while it is still
/// being written (fresh window), and a sibling is adopted only if it was CREATED after
/// both the pane spawn and the exact file's last write - i.e. a session that started
/// after ours went quiet, which is what /clear looks like.
// ponytail: still ambiguous if a sibling pane opens >2min after this pane's last message;
// exact re-attribution would need per-process transcript tracking.
fn resolve_transcript(
    dir: &Path,
    session_uuid: &str,
    spawned_at: Option<SystemTime>,
    fresh_window: Duration,
) -> Option<PathBuf> {
    let exact = dir.join(format!("{session_uuid}.jsonl"));
    let exact_mtime = mtime(&exact);
    if let Some(em) = exact_mtime {
        let quiet_for = SystemTime::now().duration_since(em).unwrap_or_default();
        if quiet_for < fresh_window {
            return Some(exact);
        }
    }

    let floor = match (exact_mtime, spawned_at) {
        (Some(e), Some(s)) => e.max(s),
        (Some(e), None) => e,
        (None, Some(s)) => s,
        // Neither our file nor a spawn time: adopting would grab unrelated old sessions.
        (None, None) => return exact.exists().then_some(exact),
    };

    let mut best: Option<(SystemTime, PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p == exact || p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(c) = created_or_mtime(&p) else { continue };
            if c < floor {
                continue; // session predates ours going quiet: another pane's, not a /clear
            }
            let m = mtime(&p).unwrap_or(c);
            if best.as_ref().is_none_or(|(bm, _)| m > *bm) {
                best = Some((m, p));
            }
        }
    }
    best.map(|(_, p)| p)
        .or_else(|| exact.exists().then_some(exact))
}

#[tauri::command]
pub async fn get_claude_context_usage(
    cwd: String,
    session_uuid: String,
    spawned_at_ms: Option<u64>,
) -> Result<Option<ClaudeContextUsage>, String> {
    if !is_valid_session_uuid(&session_uuid) {
        return Err("Invalid Claude session id".to_string());
    }
    // File IO on a blocking worker, same discipline as spawn_pty.
    tauri::async_runtime::spawn_blocking(move || {
        let dir = claude_projects_dir()?.join(project_slug(&cwd));
        let spawned_at = spawned_at_ms.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
        resolve_transcript(&dir, &session_uuid, spawned_at, EXACT_FRESH_WINDOW)
            .and_then(|p| read_usage(&p))
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_claude_code_convention() {
        assert_eq!(
            project_slug(r"C:\Users\Prabhash\code\SAPLE-ALL\saple-bridge"),
            "C--Users-Prabhash-code-SAPLE-ALL-saple-bridge"
        );
        assert_eq!(project_slug("/home/user/.claude"), "-home-user--claude");
    }

    #[test]
    fn session_uuid_validation() {
        assert!(is_valid_session_uuid("123e4567-e89b-42d3-a456-426614174000"));
        assert!(!is_valid_session_uuid("123e4567-e89b-42d3-a456-42661417400")); // 35 chars
        assert!(!is_valid_session_uuid("123e4567-e89b-42d3-a456-42661417400\"")); // shell metachar
        assert!(!is_valid_session_uuid(""));
    }

    fn assistant_line(used: (u64, u64, u64), model: &str, sidechain: bool) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{},"message":{{"model":"{}","usage":{{"input_tokens":{},"cache_creation_input_tokens":{},"cache_read_input_tokens":{},"output_tokens":9}}}}}}"#,
            sidechain, model, used.0, used.1, used.2
        )
    }

    #[test]
    fn parse_tail_takes_last_main_chain_assistant_usage() {
        let tail = [
            assistant_line((100, 0, 0), "claude-opus-4-8", false),
            r#"{"type":"user","message":{"role":"user"}}"#.to_string(),
            assistant_line((5, 10, 85000), "claude-opus-4-8", false),
            assistant_line((7, 0, 999999), "claude-haiku-4-5", true), // sidechain: skipped
            r#"{"type":"assistant","message":{"model":"x","usage":{"input_tokens":0}}}"#.to_string(), // zero usage: skipped
            r#"{"truncated..."#.to_string(), // malformed (tail cut): skipped
        ]
        .join("\n");
        let usage = parse_tail(&tail).unwrap();
        assert_eq!(usage.used_tokens, 85015);
        assert_eq!(usage.model, "claude-opus-4-8");
    }

    #[test]
    fn parse_tail_empty_or_garbage_is_none() {
        assert_eq!(parse_tail(""), None);
        assert_eq!(parse_tail("not json\nstill not json"), None);
    }

    #[test]
    fn resolve_prefers_exact_file_and_adopts_only_newer_siblings() {
        let dir = std::env::temp_dir().join(format!(
            "saple-claude-ctx-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let uuid = "123e4567-e89b-42d3-a456-426614174000";
        // Zero fresh-window so the "gone quiet" adoption path is exercised without sleeping
        // for the real 120s window.
        let stale = Duration::ZERO;

        // Pre-existing unrelated session, then our pane spawns, then our transcript appears.
        let old = dir.join("00000000-0000-4000-8000-000000000000.jsonl");
        fs::write(&old, "old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let spawned_at = Some(SystemTime::now());
        std::thread::sleep(std::time::Duration::from_millis(30));

        // Before our file exists, the pre-spawn sibling must NOT be adopted.
        assert_eq!(resolve_transcript(&dir, uuid, spawned_at, stale), None);

        let exact = dir.join(format!("{uuid}.jsonl"));
        fs::write(&exact, "ours").unwrap();

        // A fresh exact file wins unconditionally, even against later-modified siblings
        // (two active panes in one project must not shadow each other).
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(&old, "old but touched later").unwrap();
        assert_eq!(
            resolve_transcript(&dir, uuid, spawned_at, EXACT_FRESH_WINDOW),
            Some(exact.clone())
        );

        // Even once quiet, a sibling merely MODIFIED later (created before our session)
        // is another pane's conversation, not our /clear -> keep the exact file.
        assert_eq!(resolve_transcript(&dir, uuid, spawned_at, stale), Some(exact.clone()));

        // /clear scenario: a session file CREATED after ours went quiet -> adopted.
        std::thread::sleep(std::time::Duration::from_millis(30));
        let newer = dir.join("ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl");
        fs::write(&newer, "post-clear").unwrap();
        assert_eq!(resolve_transcript(&dir, uuid, spawned_at, stale), Some(newer));

        fs::remove_dir_all(&dir).unwrap();
    }
}
