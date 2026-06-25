//! Claude Code (Max/Pro **subscription**) provider — delegates the agentic turn to the user's
//! logged-in `claude` CLI instead of calling the Anthropic API with a key.
//!
//! Why a subprocess: a Claude Max/Pro subscription is billed separately from the pay-as-you-go API
//! and cannot be used through an `x-api-key` request. The sanctioned way to use it programmatically
//! is the official `claude` CLI, which holds the subscription OAuth login. We spawn it headless
//! (`-p --output-format stream-json --include-partial-messages`), **strip `ANTHROPIC_API_KEY` from
//! the child env** (or the CLI silently bills the API key instead of the subscription), feed the
//! user's message on stdin, and translate the newline-delimited JSON stream into Amber's
//! `AmberMessage` log + live UI increments. The CLI runs the *whole* tool loop itself, so this path
//! never touches Amber's HTTP `provider::run_turn` / `MAX_ITERATIONS`.
//!
//! Continuity: the CLI owns conversation history. We capture its `session_id` from the stream and
//! `--resume` it on the next message; the id is persisted on the `Conversation`.
//!
//! Caveat: the spawned CLI inherits the user's global Claude config, so their own SessionStart
//! hooks / MCP servers run. (Most are harmless; a hook that does `git checkout` would affect the
//! project working tree.) We deliberately do not pass `--safe-mode`, so the project's `.mcp.json`
//! (e.g. `saple-memory`) stays available.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::types::{AmberMessage, ContentPart, ToolResult};

/// Pre-approved tools the embedded agent may use without an (impossible, in headless mode) prompt.
/// Mirrors Amber's existing builtins (read/write files, run commands) plus search + the in-repo
/// `saple-memory` MCP. Space-separated per the CLI's `--allowedTools` contract.
const ALLOWED_TOOLS: &str =
    "Read Glob Grep Edit Write Bash WebFetch WebSearch TodoWrite NotebookEdit mcp__saple-memory";

/// A live UI increment forwarded to the renderer as the stream arrives.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    TextDelta(String),
    ToolUseStart {
        id: String,
        name: String,
    },
    ToolResult {
        tool_use_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
}

/// The assembled result of one `claude` invocation.
#[derive(Debug, Default)]
pub struct SessionOutcome {
    /// Assistant turns + tool results produced this run (to append to the conversation log).
    pub messages: Vec<AmberMessage>,
    /// The CLI session id, used to `--resume` on the next message.
    pub session_id: Option<String>,
    /// A user-facing error (auth/API/process), if the run did not complete cleanly.
    pub error: Option<String>,
}

/// Status of the local `claude` CLI, surfaced in Amber settings.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    pub available: bool,
    pub logged_in: bool,
    pub version: Option<String>,
    pub auth_method: Option<String>,
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------
// Stream parser (pure + unit-testable; no process/Tauri coupling)
// ---------------------------------------------------------------------------

/// Accumulates `claude --output-format stream-json` NDJSON lines into Amber's message log while
/// forwarding live increments through `emit`.
#[derive(Default)]
struct StreamState {
    session_id: Option<String>,
    messages: Vec<AmberMessage>,
    error: Option<String>,
    /// In-progress assistant turn keyed by provider message id. Consecutive `assistant` events with
    /// the same id are fragments of one turn (e.g. a thinking block, then a tool_use block).
    cur_id: Option<String>,
    cur_parts: Vec<ContentPart>,
    /// tool_use id → tool name, so a `tool_result` (which omits the name) can be labelled.
    tool_names: HashMap<String, String>,
}

impl StreamState {
    fn flush_assistant(&mut self) {
        if self.cur_id.take().is_some() {
            let parts = std::mem::take(&mut self.cur_parts);
            if !parts.is_empty() {
                self.messages.push(AmberMessage::Assistant { content: parts });
            }
        }
    }

    fn push_line(&mut self, line: &str, emit: &mut dyn FnMut(UiEvent)) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return, // non-JSON noise (e.g. a stray warning line)
        };

        match v.get("type").and_then(Value::as_str) {
            Some("system") => {
                if v.get("subtype").and_then(Value::as_str) == Some("init") && self.session_id.is_none()
                {
                    self.session_id = str_field(&v, "session_id");
                }
            }
            Some("stream_event") => {
                let ev = match v.get("event") {
                    Some(e) => e,
                    None => return,
                };
                match ev.get("type").and_then(Value::as_str) {
                    Some("content_block_start") => {
                        let cb = ev.get("content_block");
                        if cb.and_then(|c| c.get("type")).and_then(Value::as_str) == Some("tool_use") {
                            let id = cb
                                .and_then(|c| c.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let name = cb
                                .and_then(|c| c.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if !id.is_empty() {
                                self.tool_names.insert(id.clone(), name.clone());
                                emit(UiEvent::ToolUseStart { id, name });
                            }
                        }
                    }
                    Some("content_block_delta") => {
                        let delta = ev.get("delta");
                        if delta.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("text_delta")
                        {
                            if let Some(t) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                                if !t.is_empty() {
                                    emit(UiEvent::TextDelta(t.to_string()));
                                }
                            }
                        }
                    }
                    _ => {} // message_start/stop/delta, thinking/signature/input_json deltas
                }
            }
            Some("assistant") => {
                let msg = match v.get("message") {
                    Some(m) => m,
                    None => return,
                };
                let id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if self.cur_id.as_deref() != Some(id.as_str()) {
                    self.flush_assistant();
                    self.cur_id = Some(id);
                }
                if let Some(content) = msg.get("content").and_then(Value::as_array) {
                    for block in content {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    self.cur_parts.push(ContentPart::Text { text: t.to_string() });
                                }
                            }
                            Some("tool_use") => {
                                let tid = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                let name = block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                let input = block.get("input").cloned().unwrap_or(Value::Null);
                                if !tid.is_empty() {
                                    self.tool_names.insert(tid.clone(), name.clone());
                                }
                                self.cur_parts
                                    .push(ContentPart::ToolUse { id: tid, name, input });
                            }
                            _ => {} // thinking / redacted_thinking — not part of Amber's log
                        }
                    }
                }
                // An auth/API failure arrives as a top-level `error` on the assistant event.
                if let Some(err) = v.get("error").and_then(Value::as_str) {
                    if self.error.is_none() {
                        self.error = Some(humanize_error(err, v.get("message")));
                    }
                }
            }
            Some("user") => {
                // Tool results for the preceding assistant turn.
                self.flush_assistant();
                let mut results = Vec::new();
                if let Some(content) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let tool_use_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                            let content = stringify_tool_content(block.get("content"));
                            let name = self.tool_names.get(&tool_use_id).cloned().unwrap_or_default();
                            emit(UiEvent::ToolResult {
                                tool_use_id: tool_use_id.clone(),
                                name: name.clone(),
                                content: content.clone(),
                                is_error,
                            });
                            results.push(ToolResult {
                                tool_use_id,
                                name,
                                content,
                                is_error,
                            });
                        }
                    }
                }
                if !results.is_empty() {
                    self.messages.push(AmberMessage::ToolResults { results });
                }
            }
            Some("result") => {
                self.flush_assistant();
                if self.session_id.is_none() {
                    self.session_id = str_field(&v, "session_id");
                }
                if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) && self.error.is_none() {
                    let msg = v
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("Claude Code run failed");
                    self.error = Some(match v.get("api_error_status").and_then(Value::as_i64) {
                        Some(s) => format!("{} (status {})", msg, s),
                        None => msg.to_string(),
                    });
                }
            }
            _ => {} // rate_limit_event, etc.
        }
    }

    fn finish(mut self) -> SessionOutcome {
        self.flush_assistant();
        SessionOutcome {
            messages: self.messages,
            session_id: self.session_id,
            error: self.error,
        }
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A `tool_result.content` is a string in the common case, or an array of `{type:"text",text}`.
fn stringify_tool_content(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// `error` is a short code (e.g. `authentication_failed`); prefer the human text if present.
fn humanize_error(err: &str, message: Option<&Value>) -> String {
    let text = message
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find_map(|b| b.get("text").and_then(Value::as_str)));
    match text {
        Some(t) => format!("{} ({})", t, err),
        None => err.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Subprocess plumbing
// ---------------------------------------------------------------------------

/// Run one turn by delegating to the `claude` CLI. `emit` forwards live increments; the returned
/// [`SessionOutcome`] carries the assembled log + session id for persistence.
pub async fn run_session(
    project_path: Option<&str>,
    model: &str,
    last_user_text: &str,
    resume_session_id: Option<&str>,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(UiEvent) + Send),
) -> Result<SessionOutcome, String> {
    let bin = resolve_binary().ok_or_else(|| {
        "Claude Code CLI not found. Install it from https://claude.com/claude-code and run \
         `claude` once to log in with your subscription."
            .to_string()
    })?;

    let mut cmd = base_command(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--permission-mode")
        .arg("acceptEdits")
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS);
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model.trim());
    }
    if let Some(sid) = resume_session_id {
        if !sid.is_empty() {
            cmd.arg("--resume").arg(sid);
        }
    }

    // Force the subscription login: a set ANTHROPIC_API_KEY/AUTH_TOKEN would override it.
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");

    if let Some(pp) = project_path {
        if !pp.is_empty() {
            cmd.current_dir(pp);
        }
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch the claude CLI: {}", e))?;

    // Send the user's message on stdin, then close it (EOF) so the CLI begins.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(last_user_text.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    // Drain stderr concurrently — only used if the process dies without a structured error.
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if let Ok(mut g) = buf.lock() {
                    g.push_str(&l);
                    g.push('\n');
                }
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude produced no stdout".to_string())?;
    let mut reader = BufReader::new(stdout).lines();
    let mut state = StreamState::default();
    let mut cancelled = false;

    loop {
        tokio::select! {
            line = reader.next_line() => match line {
                Ok(Some(l)) => state.push_line(&l, emit),
                Ok(None) => break, // EOF
                Err(e) => {
                    if state.error.is_none() {
                        state.error = Some(format!("stream read error: {}", e));
                    }
                    break;
                }
            },
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.start_kill();
                    cancelled = true;
                    break;
                }
            }
        }
    }

    let _ = child.wait().await;
    let mut outcome = state.finish();

    if cancelled {
        // A user cancel is not an error; mod.rs maps it to the `cancelled` lifecycle event.
        outcome.error = None;
        return Ok(outcome);
    }

    if outcome.error.is_none() && outcome.messages.is_empty() && outcome.session_id.is_none() {
        let detail = stderr_buf
            .lock()
            .map(|g| g.trim().to_string())
            .unwrap_or_default();
        outcome.error = Some(if detail.is_empty() {
            "Claude Code produced no output. Is it installed and logged in? Run `claude` once to \
             sign in."
                .to_string()
        } else {
            format!("Claude Code error: {}", detail)
        });
    }

    Ok(outcome)
}

/// Probe the local CLI for the settings panel.
pub async fn status() -> ClaudeCodeStatus {
    let bin = match resolve_binary() {
        Some(b) => b,
        None => {
            return ClaudeCodeStatus {
                available: false,
                detail: Some("`claude` CLI not found on PATH.".to_string()),
                ..Default::default()
            }
        }
    };

    let version = run_capture(&bin, &["--version"])
        .await
        .ok()
        .map(|o| o.trim().to_string())
        .filter(|s| !s.is_empty());

    let (logged_in, auth_method) = match run_capture(&bin, &["auth", "status"]).await {
        Ok(out) => match serde_json::from_str::<Value>(out.trim()) {
            Ok(v) => (
                v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false),
                str_field(&v, "authMethod"),
            ),
            Err(_) => (false, None),
        },
        Err(_) => (false, None),
    };

    ClaudeCodeStatus {
        available: true,
        logged_in,
        version,
        auth_method,
        detail: None,
    }
}

async fn run_capture(bin: &PathBuf, args: &[&str]) -> Result<String, String> {
    let mut cmd = base_command(bin);
    cmd.args(args);
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Locate the `claude` executable. `Command::new("claude")` won't find a Windows `.cmd` shim, so we
/// resolve a concrete path from PATH (+ the native-install dir) ourselves.
fn resolve_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd", "claude.bat"]
    } else {
        &["claude"]
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        dirs.extend(path.split(sep).filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        if cfg!(windows) {
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
        }
    }

    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Windows `.cmd`/`.bat` shims must be launched through `cmd /c`; a native `.exe` runs directly.
fn base_command(bin: &PathBuf) -> Command {
    let is_shim = cfg!(windows)
        && bin
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
    if is_shim {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(bin);
        c
    } else {
        Command::new(bin)
    }
}

// ---------------------------------------------------------------------------
// Tests — fed real `stream-json` line shapes captured from `claude` 2.1.x.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(lines: &[&str]) -> (SessionOutcome, Vec<UiEvent>) {
        let mut state = StreamState::default();
        let mut events = Vec::new();
        for l in lines {
            state.push_line(l, &mut |e| events.push(e));
        }
        (state.finish(), events)
    }

    #[test]
    fn parses_tool_turn_then_text() {
        let lines = [
            r#"{"type":"system","subtype":"init","session_id":"sess-1","tools":[]}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}}"#,
            r#"{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}"#,
            r#"{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"package.json"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"file contents"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"saple-workspace"}}}"#,
            r#"{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"`saple-workspace`"}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","result":"`saple-workspace`"}"#,
        ];
        let (out, events) = collect(&lines);

        assert_eq!(out.session_id.as_deref(), Some("sess-1"));
        assert!(out.error.is_none());
        assert_eq!(out.messages.len(), 3);

        match &out.messages[0] {
            AmberMessage::Assistant { content } => {
                assert_eq!(content.len(), 1, "thinking block must be dropped, tool_use kept");
                assert!(matches!(&content[0], ContentPart::ToolUse { name, .. } if name == "Read"));
            }
            other => panic!("expected assistant tool_use turn, got {:?}", other),
        }
        match &out.messages[1] {
            AmberMessage::ToolResults { results } => {
                assert_eq!(results.len(), 1);
                assert_eq!(results[0].tool_use_id, "toolu_1");
                assert_eq!(results[0].name, "Read");
                assert_eq!(results[0].content, "file contents");
                assert!(!results[0].is_error);
            }
            other => panic!("expected tool results, got {:?}", other),
        }
        match &out.messages[2] {
            AmberMessage::Assistant { content } => {
                assert!(matches!(&content[0], ContentPart::Text { text } if text == "`saple-workspace`"));
            }
            other => panic!("expected assistant text turn, got {:?}", other),
        }

        assert!(events
            .iter()
            .any(|e| matches!(e, UiEvent::ToolUseStart { name, .. } if name == "Read")));
        assert!(events
            .iter()
            .any(|e| matches!(e, UiEvent::TextDelta(t) if t == "saple-workspace")));
        assert!(events
            .iter()
            .any(|e| matches!(e, UiEvent::ToolResult { name, .. } if name == "Read")));
    }

    #[test]
    fn surfaces_auth_error() {
        let lines = [
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Invalid API key"}]},"error":"authentication_failed"}"#,
            r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Invalid API key","session_id":"s"}"#,
        ];
        let (out, _) = collect(&lines);
        let err = out.error.expect("auth failure should surface an error");
        assert!(err.contains("Invalid API key"), "got: {}", err);
        assert!(err.contains("authentication_failed"), "got: {}", err);
    }

    #[test]
    fn ignores_noise_and_partial_deltas() {
        let lines = [
            r#"{"type":"system","subtype":"hook_started","session_id":"s2"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private"}}}"#,
            r#"not json at all"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s2","result":"done"}"#,
        ];
        let (out, events) = collect(&lines);
        assert_eq!(out.session_id.as_deref(), Some("s2"));
        assert!(out.messages.is_empty());
        assert!(out.error.is_none());
        assert!(
            !events.iter().any(|e| matches!(e, UiEvent::TextDelta(_))),
            "thinking deltas must not leak as text"
        );
    }
}
