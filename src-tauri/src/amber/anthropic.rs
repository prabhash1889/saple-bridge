//! Anthropic `/v1/messages` streaming provider.
//!
//! Request shape and SSE handling follow the Messages API: `x-api-key` + `anthropic-version`
//! headers, required `max_tokens`, `stream:true`, and tool args streamed as `input_json_delta`
//! fragments accumulated by content-block `index`. `temperature`/`thinking` are intentionally
//! omitted (current Opus models reject them).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::provider::{ProviderEvent, ProviderRequest, TurnResult};
use super::sse::{SseDecoder, SseEvent};
use super::types::{AmberMessage, ContentPart};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_ERROR_BODY: usize = 2_000;
/// Total send attempts (1 initial + retries) for transient overload/rate-limit responses.
const MAX_ATTEMPTS: u32 = 4;
/// Cap a server-supplied `Retry-After` (or our backoff) so a hostile/huge value can't park a run.
const MAX_BACKOFF_SECS: u64 = 60;

/// Sleep `dur`, but wake early (returning `true`) if the run is cancelled. Polls the flag in small
/// steps so a cancel during a long `Retry-After` wait is honored promptly.
async fn sleep_cancelable(dur: Duration, cancel: &AtomicBool) -> bool {
    let step = Duration::from_millis(100);
    let mut elapsed = Duration::ZERO;
    while elapsed < dur {
        if cancel.load(Ordering::SeqCst) {
            return true;
        }
        let this = step.min(dur - elapsed);
        tokio::time::sleep(this).await;
        elapsed += this;
    }
    cancel.load(Ordering::SeqCst)
}

/// Build the JSON request body from the provider-neutral log.
pub(crate) fn build_body(req: &ProviderRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for m in &req.messages {
        match m {
            AmberMessage::User { content } => {
                messages.push(json!({ "role": "user", "content": content }));
            }
            AmberMessage::Assistant { content } => {
                let blocks: Vec<Value> = content
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Text { text } if text.is_empty() => None,
                        ContentPart::Text { text } => Some(json!({ "type": "text", "text": text })),
                        ContentPart::ToolUse { id, name, input } => Some(json!({
                            "type": "tool_use", "id": id, "name": name, "input": input
                        })),
                    })
                    .collect();
                messages.push(json!({ "role": "assistant", "content": blocks }));
            }
            AmberMessage::ToolResults { results } => {
                let blocks: Vec<Value> = results
                    .iter()
                    .map(|r| {
                        let mut b = json!({
                            "type": "tool_result",
                            "tool_use_id": r.tool_use_id,
                            "content": r.content,
                        });
                        if r.is_error {
                            b["is_error"] = json!(true);
                        }
                        b
                    })
                    .collect();
                // Anthropic: all tool results for a turn go in ONE user message.
                messages.push(json!({ "role": "user", "content": blocks }));
            }
        }
    }

    json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "system": req.system,
        "messages": messages,
        "tools": req.tools,
    })
}

/// Accumulates SSE events into the final assistant turn. Pure / network-free so it is unit-tested
/// directly. Tool-call args arrive as `partial_json` fragments keyed by content-block `index`.
#[derive(Default)]
pub(crate) struct AnthropicState {
    blocks: BTreeMap<usize, Block>,
    order: Vec<usize>,
    pub stop_reason: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub done: bool,
}

enum Block {
    Text(String),
    Tool { id: String, name: String, json: String },
}

impl AnthropicState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one SSE event in, returning any streaming increments to forward to the UI.
    pub fn handle_event(&mut self, ev: &SseEvent) -> Result<Vec<ProviderEvent>, String> {
        let mut out = Vec::new();
        let evt = ev.event.as_deref().unwrap_or("");
        let data: Value = serde_json::from_str(&ev.data)
            .map_err(|e| format!("Malformed SSE JSON ({}): {}", e, truncate(&ev.data, 200)))?;

        match evt {
            "message_start" => {
                if let Some(it) = data["message"]["usage"]["input_tokens"].as_u64() {
                    self.input_tokens = it as u32;
                }
            }
            "content_block_start" => {
                let idx = data["index"].as_u64().unwrap_or(0) as usize;
                let cb = &data["content_block"];
                match cb["type"].as_str() {
                    Some("text") => {
                        self.insert_block(idx, Block::Text(String::new()));
                    }
                    Some("tool_use") => {
                        let id = cb["id"].as_str().unwrap_or_default().to_string();
                        let name = cb["name"].as_str().unwrap_or_default().to_string();
                        out.push(ProviderEvent::ToolUseStart {
                            id: id.clone(),
                            name: name.clone(),
                        });
                        self.insert_block(
                            idx,
                            Block::Tool {
                                id,
                                name,
                                json: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let idx = data["index"].as_u64().unwrap_or(0) as usize;
                let delta = &data["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(t) = delta["text"].as_str() {
                            if let Some(Block::Text(s)) = self.blocks.get_mut(&idx) {
                                s.push_str(t);
                            }
                            out.push(ProviderEvent::TextDelta(t.to_string()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(p) = delta["partial_json"].as_str() {
                            if let Some(Block::Tool { json, .. }) = self.blocks.get_mut(&idx) {
                                json.push_str(p);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {}
            "message_delta" => {
                if let Some(sr) = data["delta"]["stop_reason"].as_str() {
                    self.stop_reason = sr.to_string();
                }
                if let Some(ot) = data["usage"]["output_tokens"].as_u64() {
                    self.output_tokens = ot as u32;
                }
            }
            "message_stop" => {
                self.done = true;
                out.push(ProviderEvent::Usage {
                    input_tokens: self.input_tokens,
                    output_tokens: self.output_tokens,
                });
            }
            "error" => {
                let msg = data["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown streaming error");
                return Err(format!("Anthropic stream error: {}", msg));
            }
            _ => {}
        }
        Ok(out)
    }

    fn insert_block(&mut self, idx: usize, block: Block) {
        if !self.blocks.contains_key(&idx) {
            self.order.push(idx);
        }
        self.blocks.insert(idx, block);
    }

    /// Assemble the ordered content parts once the stream is complete.
    pub fn into_turn_result(self) -> TurnResult {
        let mut content = Vec::new();
        for idx in &self.order {
            match self.blocks.get(idx) {
                Some(Block::Text(s)) if !s.is_empty() => {
                    content.push(ContentPart::Text { text: s.clone() })
                }
                Some(Block::Tool { id, name, json }) => {
                    let input = serde_json::from_str(json).unwrap_or_else(|_| json!({}));
                    content.push(ContentPart::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input,
                    });
                }
                _ => {}
            }
        }
        TurnResult {
            content,
            stop_reason: if self.stop_reason.is_empty() {
                "end_turn".to_string()
            } else {
                self.stop_reason
            },
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
        }
    }
}

/// Stream one assistant turn from Anthropic. `client` is the shared timeout-bounded client from
/// `AmberRegistry`. Transient overload/rate-limit responses (429/503/529) are retried up to
/// `MAX_ATTEMPTS`, honoring a `Retry-After` header and checking `cancel` while waiting.
pub async fn run_turn(
    client: &reqwest::Client,
    req: &ProviderRequest,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(ProviderEvent) + Send),
) -> Result<TurnResult, String> {
    let base_url = if req.base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        req.base_url.trim_end_matches('/')
    };
    let url = format!("{}/v1/messages", base_url);
    let body = build_body(req);

    let mut attempt: u32 = 0;
    let resp = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }

        let send_result = client
            .post(&url)
            .header("x-api-key", &req.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;

        match send_result {
            Ok(r) if r.status().is_success() => break r,
            Ok(r) => {
                let status = r.status();
                let retryable = matches!(status.as_u16(), 429 | 503 | 529);
                if retryable && attempt + 1 < MAX_ATTEMPTS {
                    let retry_after = r
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.trim().parse::<u64>().ok());
                    // Honor Retry-After, else exponential backoff (1s, 2s, 4s …), both capped.
                    let wait = retry_after.unwrap_or(1u64 << attempt).min(MAX_BACKOFF_SECS);
                    if sleep_cancelable(Duration::from_secs(wait), cancel).await {
                        return Err("cancelled".to_string());
                    }
                    attempt += 1;
                    continue;
                }
                let txt = r.text().await.unwrap_or_default();
                return Err(format!(
                    "Anthropic API error {}: {}",
                    status,
                    truncate(&txt, MAX_ERROR_BODY)
                ));
            }
            Err(e) => {
                // Network/timeout error: retry a couple of times before giving up.
                if attempt + 1 < MAX_ATTEMPTS {
                    if sleep_cancelable(Duration::from_secs(1u64 << attempt), cancel).await {
                        return Err("cancelled".to_string());
                    }
                    attempt += 1;
                    continue;
                }
                return Err(format!("Request failed: {}", e));
            }
        }
    };

    let mut stream = resp.bytes_stream();
    let mut decoder = SseDecoder::new();
    let mut state = AnthropicState::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let bytes = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&bytes);
        for ev in decoder.push(&text) {
            for pe in state.handle_event(&ev)? {
                emit(pe);
            }
            if state.done {
                break;
            }
        }
        if state.done {
            break;
        }
    }

    Ok(state.into_turn_result())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}…", &s[..max])
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amber::types::ToolResult;

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: Some(event.to_string()),
            data: data.to_string(),
        }
    }

    fn feed(state: &mut AnthropicState, events: &[SseEvent]) -> Vec<ProviderEvent> {
        let mut all = Vec::new();
        for e in events {
            all.extend(state.handle_event(e).unwrap());
        }
        all
    }

    #[test]
    fn accumulates_text_turn() {
        let mut s = AnthropicState::new();
        let emitted = feed(
            &mut s,
            &[
                ev("message_start", r#"{"message":{"usage":{"input_tokens":10}}}"#),
                ev("content_block_start", r#"{"index":0,"content_block":{"type":"text"}}"#),
                ev("content_block_delta", r#"{"index":0,"delta":{"type":"text_delta","text":"Hel"}}"#),
                ev("content_block_delta", r#"{"index":0,"delta":{"type":"text_delta","text":"lo"}}"#),
                ev("content_block_stop", r#"{"index":0}"#),
                ev("message_delta", r#"{"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#),
                ev("message_stop", r#"{}"#),
            ],
        );
        assert!(emitted.contains(&ProviderEvent::TextDelta("Hel".to_string())));
        let turn = s.into_turn_result();
        assert_eq!(turn.stop_reason, "end_turn");
        assert_eq!(turn.input_tokens, 10);
        assert_eq!(turn.output_tokens, 5);
        assert_eq!(turn.content, vec![ContentPart::Text { text: "Hello".to_string() }]);
    }

    #[test]
    fn accumulates_tool_call_args_by_index() {
        let mut s = AnthropicState::new();
        let emitted = feed(
            &mut s,
            &[
                ev("content_block_start", r#"{"index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"create_memory"}}"#),
                ev("content_block_delta", r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"title\":\"a"}}"#),
                ev("content_block_delta", r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"bc\"}"}}"#),
                ev("content_block_stop", r#"{"index":0}"#),
                ev("message_delta", r#"{"delta":{"stop_reason":"tool_use"}}"#),
                ev("message_stop", r#"{}"#),
            ],
        );
        assert!(emitted.iter().any(|e| matches!(e, ProviderEvent::ToolUseStart { name, .. } if name == "create_memory")));
        let turn = s.into_turn_result();
        assert_eq!(turn.stop_reason, "tool_use");
        match &turn.content[0] {
            ContentPart::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_1");
                assert_eq!(name, "create_memory");
                assert_eq!(input["title"], "abc");
            }
            other => panic!("expected tool_use, got {:?}", other),
        }
    }

    #[test]
    fn body_frames_tool_results_as_single_user_message() {
        let req = ProviderRequest {
            model: "claude-opus-4-8".to_string(),
            system: "sys".to_string(),
            messages: vec![
                AmberMessage::User { content: "hi".to_string() },
                AmberMessage::Assistant {
                    content: vec![ContentPart::ToolUse {
                        id: "t1".to_string(),
                        name: "list_files".to_string(),
                        input: json!({}),
                    }],
                },
                AmberMessage::ToolResults {
                    results: vec![
                        ToolResult { tool_use_id: "t1".to_string(), name: "list_files".to_string(), content: "ok".to_string(), is_error: false },
                    ],
                },
            ],
            tools: json!([]),
            max_tokens: 4096,
            api_key: "k".to_string(),
            base_url: String::new(),
        };
        let body = build_body(&req);
        // No temperature / thinking fields.
        assert!(body.get("temperature").is_none());
        assert!(body.get("thinking").is_none());
        assert_eq!(body["max_tokens"], 4096);
        let msgs = body["messages"].as_array().unwrap();
        // user, assistant(tool_use), user(tool_result)
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "t1");
    }
}
