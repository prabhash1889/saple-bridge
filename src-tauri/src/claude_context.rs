// Context-left readout for Claude Code panes. Claude Code writes a JSONL transcript per
// session under <CLAUDE_CONFIG_DIR|~/.claude>/projects/<project-slug>/<session-uuid>.jsonl;
// every assistant entry carries `message.usage`, whose input+cache token sum is the current
// context size. spawn_pty launches `claude --session-id <uuid>` with a bridge-generated
// uuid, so the initial transcript filename is known exactly. `/clear` and `/resume` typed
// inside the pane switch it to a new session file whose id the bridge cannot predict, so
// spawn_pty also injects a per-pane `--settings` file (prepare_pane_hook) whose
// SessionStart hook records the live session's id and transcript path to a pane-keyed
// file in the app data dir. Each pane therefore reads exactly its own transcript; panes
// never look at each other's sessions.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

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

/// Per-pane hook files (settings + latest SessionStart payload) live in the app data
/// dir - they are bridge plumbing, not project state.
pub fn pane_hook_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("claude-panes"))
}

/// Shell command for the SessionStart hook: copy the hook's stdin JSON into the pane's
/// session file. Runs under Claude Code's hook shell on each supported OS.
#[cfg(windows)]
fn capture_command(session_file: &Path) -> String {
    // PowerShell single-quoted literal: double any embedded quote.
    let p = session_file.display().to_string().replace('\'', "''");
    format!(
        "powershell -NoProfile -Command \"[Console]::In.ReadToEnd() | Set-Content -Encoding UTF8 -LiteralPath '{p}'\""
    )
}
#[cfg(not(windows))]
fn capture_command(session_file: &Path) -> String {
    let p = session_file.display().to_string().replace('\'', r"'\''");
    format!("cat > '{p}'")
}

/// Hook files are tiny but accumulate one pair per pane spawn; sweep anything untouched
/// for a week.
fn prune_stale(dir: &Path) {
    const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let stale = mtime(&p)
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|age| age > KEEP);
        if stale {
            let _ = fs::remove_file(&p);
        }
    }
}

/// Write the pane's `--settings` file: a SessionStart hook that records the live
/// session's id and transcript path to <dir>/<uuid>.session.json. SessionStart fires on
/// startup, /clear, /resume and /compact, so the badge follows in-pane session switches
/// exactly instead of guessing among sibling transcripts. Best-effort: on None the pane
/// launches without the hook and the badge sticks to the spawn-time transcript.
pub fn prepare_pane_hook(dir: &Path, session_uuid: &str) -> Option<PathBuf> {
    // Both paths end up inside shell command lines built with double quotes; the app
    // data dir is bridge-controlled and never contains one, but refuse rather than emit
    // a broken or injectable command.
    if dir.display().to_string().contains('"') || !is_valid_session_uuid(session_uuid) {
        return None;
    }
    fs::create_dir_all(dir).ok()?;
    prune_stale(dir);
    let session_file = dir.join(format!("{session_uuid}.session.json"));
    let settings = serde_json::json!({
        "hooks": {
            "SessionStart": [{
                "hooks": [{ "type": "command", "command": capture_command(&session_file) }]
            }]
        }
    });
    let settings_file = dir.join(format!("{session_uuid}.settings.json"));
    fs::write(&settings_file, settings.to_string()).ok()?;
    Some(settings_file)
}

/// Transcript path recorded by the pane's SessionStart hook - the file for the session
/// currently live in this pane. PowerShell's Set-Content writes a BOM; strip it.
fn transcript_from_hook(dir: &Path, session_uuid: &str) -> Option<PathBuf> {
    let text = fs::read_to_string(dir.join(format!("{session_uuid}.session.json"))).ok()?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    v.get("transcript_path").and_then(|p| p.as_str()).map(PathBuf::from)
}

#[tauri::command]
pub async fn get_claude_context_usage(
    app: tauri::AppHandle,
    cwd: String,
    session_uuid: String,
    pane_model: Option<String>,
) -> Result<Option<ClaudeContextUsage>, String> {
    if !is_valid_session_uuid(&session_uuid) {
        return Err("Invalid Claude session id".to_string());
    }
    let hook_dir = pane_hook_dir(&app);
    // File IO on a blocking worker, same discipline as spawn_pty.
    tauri::async_runtime::spawn_blocking(move || {
        // The hook-recorded transcript is exact and follows /clear + /resume; the
        // spawn-time filename covers panes where the hook has not fired (yet).
        let transcript = hook_dir
            .as_deref()
            .and_then(|d| transcript_from_hook(d, &session_uuid))
            .filter(|p| p.is_file())
            .or_else(|| {
                let p = claude_projects_dir()?
                    .join(project_slug(&cwd))
                    .join(format!("{session_uuid}.jsonl"));
                p.is_file().then_some(p)
            })?;
        let mut usage = read_usage(&transcript)?;
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
    fn pane_hook_roundtrip_records_transcript_path() {
        let dir = std::env::temp_dir().join(format!(
            "saple-claude-hook-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let uuid = "123e4567-e89b-42d3-a456-426614174000";

        // No session file yet -> no transcript.
        assert_eq!(transcript_from_hook(&dir, uuid), None);

        // prepare writes a settings file whose hook command targets the session file.
        let settings_file = prepare_pane_hook(&dir, uuid).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_file).unwrap()).unwrap();
        let cmd = settings
            .pointer("/hooks/SessionStart/0/hooks/0/command")
            .and_then(|c| c.as_str())
            .unwrap();
        assert!(cmd.contains(&format!("{uuid}.session.json")));

        // A BOM-prefixed payload (PowerShell Set-Content) still parses.
        let payload = format!(
            "\u{feff}{{\"session_id\":\"{uuid}\",\"transcript_path\":\"C:\\\\t\\\\x.jsonl\",\"source\":\"clear\"}}"
        );
        fs::write(dir.join(format!("{uuid}.session.json")), payload).unwrap();
        assert_eq!(
            transcript_from_hook(&dir, uuid),
            Some(PathBuf::from(r"C:\t\x.jsonl"))
        );

        // Malformed payloads (hook interrupted mid-write) are ignored, not errors.
        fs::write(dir.join(format!("{uuid}.session.json")), "{trunc").unwrap();
        assert_eq!(transcript_from_hook(&dir, uuid), None);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn capture_command_escapes_single_quotes_in_path() {
        let cmd = capture_command(Path::new("/tmp/o'brien/s.json"));
        #[cfg(windows)]
        assert!(cmd.contains("o''brien"));
        #[cfg(not(windows))]
        assert!(cmd.contains(r"o'\''brien"));
    }
}
