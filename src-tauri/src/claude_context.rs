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

/// <CLAUDE_CONFIG_DIR|~/.claude> — same config-dir resolution as diagnostics.rs.
fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|h| PathBuf::from(h).join(".claude"))
        })
}

fn claude_projects_dir() -> Option<PathBuf> {
    claude_config_dir().map(|d| d.join("projects"))
}

/// First `model` value found across the given settings files, in order.
fn model_from_settings_files(paths: &[PathBuf]) -> Option<String> {
    for p in paths {
        let Ok(text) = fs::read_to_string(p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
            return Some(m.to_string());
        }
    }
    None
}

/// Claude Code's effective `model` setting for a project: .claude/settings.local.json,
/// then .claude/settings.json, then the user-level settings.json.
fn model_setting(cwd: &str) -> Option<String> {
    let mut paths = vec![
        Path::new(cwd).join(".claude").join("settings.local.json"),
        Path::new(cwd).join(".claude").join("settings.json"),
    ];
    if let Some(cfg) = claude_config_dir() {
        paths.push(cfg.join("settings.json"));
    }
    model_from_settings_files(&paths)
}

/// Transcripts record the bare API model id ("claude-opus-4-8") even when the session
/// runs the 1M-context beta - that marker only exists in the `model` *setting* (e.g.
/// "opus[1m]"). If the setting is a [1m] variant of the transcript's model, tag the
/// returned model so the frontend picks the 1M window.
fn apply_large_context_marker(usage: &mut ClaudeContextUsage, setting: Option<&str>) {
    if usage.model.contains("[1m]") {
        return;
    }
    let Some(base) = setting.and_then(|s| s.strip_suffix("[1m]")) else {
        return;
    };
    // "opus[1m]" applies to "claude-opus-4-8", but "sonnet[1m]" must not.
    if !base.is_empty() && usage.model.contains(base) {
        usage.model.push_str("[1m]");
    }
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
    pane_model: Option<String>,
) -> Result<Option<ClaudeContextUsage>, String> {
    if !is_valid_session_uuid(&session_uuid) {
        return Err("Invalid Claude session id".to_string());
    }
    // File IO on a blocking worker, same discipline as spawn_pty.
    tauri::async_runtime::spawn_blocking(move || {
        let dir = claude_projects_dir()?.join(project_slug(&cwd));
        let spawned_at = spawned_at_ms.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
        let mut usage = resolve_transcript(&dir, &session_uuid, spawned_at, EXACT_FRESH_WINDOW)
            .and_then(|p| read_usage(&p))?;
        // A pane launched with an explicit --model overrides Claude's model setting, and
        // spawn_pty cannot pass a "[1m]" model (bracket is outside is_safe_model), so the
        // settings marker only applies to panes running the CLI's default model.
        let launched_with_default = pane_model.as_deref().is_none_or(|m| m.is_empty() || m == "default");
        if launched_with_default {
            apply_large_context_marker(&mut usage, model_setting(&cwd).as_deref());
        }
        Some(usage)
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

    fn usage(model: &str) -> ClaudeContextUsage {
        ClaudeContextUsage { used_tokens: 1, model: model.to_string() }
    }

    #[test]
    fn large_context_marker_applies_only_to_matching_1m_setting() {
        // "opus[1m]" setting marks an opus transcript.
        let mut u = usage("claude-opus-4-8");
        apply_large_context_marker(&mut u, Some("opus[1m]"));
        assert_eq!(u.model, "claude-opus-4-8[1m]");

        // A different model family's [1m] setting must not mark it.
        let mut u = usage("claude-opus-4-8");
        apply_large_context_marker(&mut u, Some("sonnet[1m]"));
        assert_eq!(u.model, "claude-opus-4-8");

        // Non-[1m] setting, absent setting, and already-marked models are no-ops.
        let mut u = usage("claude-opus-4-8");
        apply_large_context_marker(&mut u, Some("opus"));
        assert_eq!(u.model, "claude-opus-4-8");
        let mut u = usage("claude-opus-4-8");
        apply_large_context_marker(&mut u, None);
        assert_eq!(u.model, "claude-opus-4-8");
        let mut u = usage("claude-opus-4-8[1m]");
        apply_large_context_marker(&mut u, Some("opus[1m]"));
        assert_eq!(u.model, "claude-opus-4-8[1m]");

        // Full model id in the setting also matches.
        let mut u = usage("claude-opus-4-8");
        apply_large_context_marker(&mut u, Some("claude-opus-4-8[1m]"));
        assert_eq!(u.model, "claude-opus-4-8[1m]");
    }

    #[test]
    fn model_setting_prefers_local_over_project_settings() {
        let dir = std::env::temp_dir().join(format!(
            "saple-claude-settings-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let claude = dir.join(".claude");
        fs::create_dir_all(&claude).unwrap();

        let local = claude.join("settings.local.json");
        let project = claude.join("settings.json");
        let paths = vec![local.clone(), project.clone()];

        // No files -> None; malformed local is skipped in favor of the next file.
        assert_eq!(model_from_settings_files(&paths), None);
        fs::write(&project, r#"{"model":"opus[1m]"}"#).unwrap();
        fs::write(&local, "{not json").unwrap();
        assert_eq!(model_from_settings_files(&paths), Some("opus[1m]".to_string()));

        // A valid local file wins over the project file.
        fs::write(&local, r#"{"model":"sonnet"}"#).unwrap();
        assert_eq!(model_from_settings_files(&paths), Some("sonnet".to_string()));

        fs::remove_dir_all(&dir).unwrap();
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
