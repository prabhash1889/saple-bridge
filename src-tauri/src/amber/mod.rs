//! Amber — an AI agent that lives inside Saple Bridge.
//!
//! The agent loop runs here in Rust (where the keychain, path-contained FS, command execution, and
//! outbound HTTPS live). The renderer sends the message log and receives a live stream of
//! `amber://event` deltas + an `amber://run` lifecycle event. API keys are read via
//! `keychain::get_api_key_inner` and never cross back to the renderer.

mod anthropic;
mod builtins;
mod claude_code;
mod openai;
mod persist;
mod provider;
mod sse;
mod tools;
mod types;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::keychain::get_api_key_inner;
use crate::project::now_iso;
use provider::{Provider, ProviderEvent, ProviderRequest};
use types::{AmberMessage, ContentPart, Conversation, ConversationSummary, ToolResult};

/// Hard cap on agent iterations (turn → tools → turn …) to bound a runaway loop.
const MAX_ITERATIONS: usize = 12;
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Tracks in-flight runs so they can be cancelled. First cancel-aware registry in this codebase;
/// structurally mirrors `pty::PtyRegistry`.
pub struct AmberRegistry {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// One shared HTTP client for every provider call: connection pooling + bounded
    /// connect/overall timeouts (a hung TLS handshake or stalled response can't wedge a run
    /// forever). reqwest::Client is internally Arc, so clones are cheap.
    http: reqwest::Client,
}

impl AmberRegistry {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .unwrap_or_default();
        Self {
            runs: Mutex::new(HashMap::new()),
            http,
        }
    }

    fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    /// Register a run and return its cancel flag.
    fn start(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.runs
            .lock()
            .unwrap()
            .insert(id.to_string(), flag.clone());
        flag
    }

    fn cancel(&self, id: &str) {
        if let Some(flag) = self.runs.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn finish(&self, id: &str) {
        self.runs.lock().unwrap().remove(id);
    }
}

impl Default for AmberRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Event helpers (mirror pty.rs `emit`)
// ---------------------------------------------------------------------------

fn emit_event(app: &AppHandle, payload: Value) {
    let _ = app.emit("amber://event", payload);
}

fn emit_run(app: &AppHandle, id: &str, status: &str, message: Option<&str>) {
    let _ = app.emit(
        "amber://run",
        json!({ "conversationId": id, "status": status, "message": message }),
    );
}

fn emit_error(app: &AppHandle, id: &str, message: &str) {
    emit_event(
        app,
        json!({ "type": "error", "conversationId": id, "message": message }),
    );
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/// Reject a non-empty custom `base_url` that isn't HTTPS. The provider request carries the API
/// key in a header, so a renderer-supplied `http://`/arbitrary-scheme base URL would be an IPC→SSRF
/// path to exfiltrate the key in cleartext. The default (empty) base URL uses the provider's
/// hardcoded HTTPS endpoint and is always allowed.
fn validate_base_url(base_url: &str) -> Result<(), String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if !trimmed.to_ascii_lowercase().starts_with("https://") {
        return Err("Amber base URL must start with https://".to_string());
    }
    Ok(())
}

fn default_model(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "claude-opus-4-8",
        Provider::OpenAiCompatible => "gpt-4o",
    }
}

fn build_system_prompt() -> String {
    format!(
        "{}\n\n## Amber builtin tools\nYou also have direct project tools: `read_file`, \
`write_file`, `list_files` (all paths are project-relative), and `run_command` (PowerShell on \
Windows, 30s timeout, runs in the project root). Prefer the memory/task tools for durable \
knowledge. Keep tool calls focused — large file reads and command output are truncated before you \
see them.",
        crate::mcp::SAPLE_ONBOARDING_PROMPT
    )
}

#[allow(clippy::too_many_arguments)]
async fn run_agent(
    app: AppHandle,
    conversation_id: String,
    project_path: Option<String>,
    provider_str: String,
    model_in: String,
    base_url: String,
    mut messages: Vec<AmberMessage>,
    cancel: Arc<AtomicBool>,
) {
    emit_run(&app, &conversation_id, "started", None);

    // "Claude Code" provider: delegate the whole agentic turn to the user's logged-in `claude` CLI
    // on their Max/Pro subscription. The CLI owns the tool loop, so this bypasses the keychain read
    // and the HTTP `MAX_ITERATIONS` loop below entirely.
    if provider_str == "claude-code" {
        run_claude_code(app, conversation_id, project_path, model_in, messages, cancel).await;
        return;
    }

    // Refuse a non-HTTPS custom endpoint before the key is read (closes an IPC→SSRF key-exfil path).
    if let Err(msg) = validate_base_url(&base_url) {
        emit_error(&app, &conversation_id, &msg);
        emit_run(&app, &conversation_id, "error", Some(&msg));
        app.state::<AmberRegistry>().finish(&conversation_id);
        return;
    }

    let http = app.state::<AmberRegistry>().http();

    // Read the key once, in Rust, on the blocking pool. It never crosses back to the renderer.
    let service = format!("saple_amber_{}_api_key", provider_str);
    let key = match tauri::async_runtime::spawn_blocking(move || get_api_key_inner(service)).await {
        Ok(Ok(k)) => k,
        _ => {
            let msg = format!(
                "No API key stored for '{}'. Add one in Amber settings.",
                provider_str
            );
            emit_error(&app, &conversation_id, &msg);
            emit_run(&app, &conversation_id, "error", Some(&msg));
            app.state::<AmberRegistry>().finish(&conversation_id);
            return;
        }
    };

    let provider = Provider::parse(&provider_str);
    let model = if model_in.is_empty() {
        default_model(provider).to_string()
    } else {
        model_in
    };
    let system = build_system_prompt();
    let tools_schema = tools::build_tool_schemas();

    let mut final_error: Option<String> = None;

    for _ in 0..MAX_ITERATIONS {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        let req = ProviderRequest {
            model: model.clone(),
            system: system.clone(),
            messages: messages.clone(),
            tools: tools_schema.clone(),
            max_tokens: DEFAULT_MAX_TOKENS,
            api_key: key.clone(),
            base_url: base_url.clone(),
        };

        // Forward streaming increments to the UI as they arrive.
        let app_emit = app.clone();
        let cid_emit = conversation_id.clone();
        let mut emit_cb = move |ev: ProviderEvent| match ev {
            ProviderEvent::TextDelta(text) => emit_event(
                &app_emit,
                json!({ "type": "text_delta", "conversationId": cid_emit.clone(), "text": text }),
            ),
            ProviderEvent::ToolUseStart { id, name } => emit_event(
                &app_emit,
                json!({ "type": "tool_use_start", "conversationId": cid_emit.clone(), "toolUseId": id, "name": name }),
            ),
            ProviderEvent::Usage {
                input_tokens,
                output_tokens,
            } => emit_event(
                &app_emit,
                json!({ "type": "usage", "conversationId": cid_emit.clone(), "inputTokens": input_tokens, "outputTokens": output_tokens }),
            ),
        };

        let result = provider::run_turn(provider, &http, &req, &cancel, &mut emit_cb).await;

        let turn = match result {
            Ok(t) => t,
            Err(e) => {
                // A cancel mid-stream is not an error.
                if e != "cancelled" && !cancel.load(Ordering::SeqCst) {
                    final_error = Some(e);
                }
                break;
            }
        };

        messages.push(AmberMessage::Assistant {
            content: turn.content.clone(),
        });
        // Persist after every turn so a crash / provider failure mid-multi-turn run doesn't lose
        // the assistant message (and tool results below). Cheap relative to the network round-trip.
        persist_conversation(
            &app,
            &conversation_id,
            project_path.as_deref(),
            &provider_str,
            &model,
            &messages,
            None,
        );
        emit_event(
            &app,
            json!({ "type": "turn_done", "conversationId": conversation_id, "stopReason": turn.stop_reason }),
        );

        if turn.stop_reason != "tool_use" {
            break;
        }

        // Dispatch every requested tool on the blocking pool, then feed results back.
        let mut results: Vec<ToolResult> = Vec::new();
        for part in &turn.content {
            if let ContentPart::ToolUse { id, name, input } = part {
                emit_event(
                    &app,
                    json!({ "type": "tool_running", "conversationId": conversation_id, "toolUseId": id, "name": name }),
                );
                let id_c = id.clone();
                let name_c = name.clone();
                let input_c = input.clone();
                let pp = project_path.clone();
                let tr = tauri::async_runtime::spawn_blocking(move || {
                    tools::dispatch_blocking(&id_c, &name_c, input_c, pp.as_deref())
                })
                .await
                .unwrap_or_else(|e| ToolResult {
                    tool_use_id: id.clone(),
                    name: name.clone(),
                    content: format!("Tool dispatch failed: {}", e),
                    is_error: true,
                });

                emit_event(
                    &app,
                    json!({ "type": "tool_result", "conversationId": conversation_id, "toolUseId": tr.tool_use_id, "name": tr.name, "content": tr.content, "isError": tr.is_error }),
                );
                results.push(tr);
            }
        }
        messages.push(AmberMessage::ToolResults { results });
    }

    persist_conversation(
        &app,
        &conversation_id,
        project_path.as_deref(),
        &provider_str,
        &model,
        &messages,
        None,
    );

    if let Some(e) = final_error {
        emit_error(&app, &conversation_id, &e);
        emit_run(&app, &conversation_id, "error", Some(&e));
    } else if cancel.load(Ordering::SeqCst) {
        emit_run(&app, &conversation_id, "cancelled", None);
    } else {
        emit_run(&app, &conversation_id, "done", None);
    }

    app.state::<AmberRegistry>().finish(&conversation_id);
}

/// "Claude Code" provider run: hand the turn to the `claude` CLI (subscription), stream its NDJSON
/// into the same `amber://event` UI events, append the assembled log, and persist the CLI session
/// id for `--resume`. Unlike the API-key path, the CLI runs the tool loop, so there is no iteration
/// loop here — one `run_session` does the whole turn.
async fn run_claude_code(
    app: AppHandle,
    conversation_id: String,
    project_path: Option<String>,
    model_in: String,
    mut messages: Vec<AmberMessage>,
    cancel: Arc<AtomicBool>,
) {
    let last_user_text = messages
        .iter()
        .rev()
        .find_map(|m| match m {
            AmberMessage::User { content } => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default();

    // Resume the CLI session if this conversation already has one.
    let resume_id = persist::load(&app, project_path.as_deref(), &conversation_id)
        .ok()
        .and_then(|c| c.claude_session_id);

    let app_emit = app.clone();
    let cid_emit = conversation_id.clone();
    let mut emit = move |ev: claude_code::UiEvent| match ev {
        claude_code::UiEvent::TextDelta(text) => emit_event(
            &app_emit,
            json!({ "type": "text_delta", "conversationId": cid_emit.clone(), "text": text }),
        ),
        claude_code::UiEvent::ToolUseStart { id, name } => emit_event(
            &app_emit,
            json!({ "type": "tool_use_start", "conversationId": cid_emit.clone(), "toolUseId": id, "name": name }),
        ),
        claude_code::UiEvent::ToolResult {
            tool_use_id,
            name,
            content,
            is_error,
        } => emit_event(
            &app_emit,
            json!({ "type": "tool_result", "conversationId": cid_emit.clone(), "toolUseId": tool_use_id, "name": name, "content": content, "isError": is_error }),
        ),
    };

    let result = claude_code::run_session(
        project_path.as_deref(),
        &model_in,
        &last_user_text,
        resume_id.as_deref(),
        &cancel,
        &mut emit,
    )
    .await;

    // Flush any buffered streaming text before the store reloads the canonical log.
    emit_event(
        &app,
        json!({ "type": "turn_done", "conversationId": conversation_id, "stopReason": "end_turn" }),
    );

    match result {
        Ok(outcome) => {
            messages.extend(outcome.messages);
            persist_conversation(
                &app,
                &conversation_id,
                project_path.as_deref(),
                "claude-code",
                &model_in,
                &messages,
                outcome.session_id.as_deref(),
            );
            if let Some(err) = outcome.error {
                emit_error(&app, &conversation_id, &err);
                emit_run(&app, &conversation_id, "error", Some(&err));
            } else if cancel.load(Ordering::SeqCst) {
                emit_run(&app, &conversation_id, "cancelled", None);
            } else {
                emit_run(&app, &conversation_id, "done", None);
            }
        }
        Err(e) => {
            // Persist at least the user message so the conversation isn't lost.
            persist_conversation(
                &app,
                &conversation_id,
                project_path.as_deref(),
                "claude-code",
                &model_in,
                &messages,
                None,
            );
            emit_error(&app, &conversation_id, &e);
            emit_run(&app, &conversation_id, "error", Some(&e));
        }
    }

    app.state::<AmberRegistry>().finish(&conversation_id);
}

fn persist_conversation(
    app: &AppHandle,
    id: &str,
    project_path: Option<&str>,
    provider: &str,
    model: &str,
    messages: &[AmberMessage],
    claude_session_id: Option<&str>,
) {
    let title = messages
        .iter()
        .find_map(|m| match m {
            AmberMessage::User { content } => Some(first_line(content)),
            _ => None,
        })
        .unwrap_or_else(|| "New chat".to_string());

    // Preserve the original created_at (and any existing session id) if this conversation exists.
    let existing = persist::load(app, project_path, id).ok();
    let created_at = existing
        .as_ref()
        .map(|c| c.created_at.clone())
        .unwrap_or_else(now_iso);
    let claude_session_id = claude_session_id
        .map(str::to_string)
        .or_else(|| existing.and_then(|c| c.claude_session_id));

    let convo = Conversation {
        id: id.to_string(),
        title,
        provider: provider.to_string(),
        model: model.to_string(),
        messages: messages.to_vec(),
        created_at,
        updated_at: now_iso(),
        claude_session_id,
    };
    let _ = persist::save(app, project_path, &convo);
}

fn first_line(s: &str) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(60).collect::<String>())
    } else if line.is_empty() {
        "New chat".to_string()
    } else {
        line.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn amber_send_message(
    app: AppHandle,
    registry: State<'_, AmberRegistry>,
    conversation_id: String,
    project_path: Option<String>,
    provider: String,
    model: String,
    base_url: Option<String>,
    messages: Vec<AmberMessage>,
) -> Result<(), String> {
    let cancel = registry.start(&conversation_id);
    tauri::async_runtime::spawn(run_agent(
        app,
        conversation_id,
        project_path,
        provider,
        model,
        base_url.unwrap_or_default(),
        messages,
        cancel,
    ));
    Ok(())
}

#[tauri::command]
pub async fn amber_cancel(
    registry: State<'_, AmberRegistry>,
    conversation_id: String,
) -> Result<(), String> {
    registry.cancel(&conversation_id);
    Ok(())
}

#[tauri::command]
pub async fn amber_list_conversations(
    app: AppHandle,
    project_path: Option<String>,
) -> Result<Vec<ConversationSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || persist::list(&app, project_path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn amber_load_conversation(
    app: AppHandle,
    project_path: Option<String>,
    conversation_id: String,
) -> Result<Conversation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        persist::load(&app, project_path.as_deref(), &conversation_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn amber_delete_conversation(
    app: AppHandle,
    project_path: Option<String>,
    conversation_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        persist::delete(&app, project_path.as_deref(), &conversation_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn amber_list_tools() -> Result<Value, String> {
    Ok(tools::build_tool_schemas())
}

/// Probe the local `claude` CLI (availability + login) for the "Claude Code" provider settings.
#[tauri::command]
pub async fn amber_claude_code_status() -> Result<Value, String> {
    let status = claude_code::status().await;
    serde_json::to_value(status).map_err(|e| e.to_string())
}
