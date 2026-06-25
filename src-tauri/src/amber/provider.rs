//! Provider abstraction shared by every LLM backend.
//!
//! `run_turn` dispatches one streamed assistant turn to the selected provider. Streaming
//! increments are delivered through the `emit` callback (so the agent loop can forward Tauri
//! events live); the fully-assembled assistant message comes back as a `TurnResult`. This avoids
//! threading a `BoxStream` through the loop while keeping the per-provider SSE accumulation
//! testable in isolation (see `anthropic::AnthropicState`).

use std::sync::atomic::AtomicBool;

use serde_json::Value;

use super::anthropic;
use super::types::{AmberMessage, ContentPart};

/// Which API to call. A different axis from the CLI-agent `providerStore` on the React side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    /// OpenAI-compatible (Groq / OpenAI / custom base URL) — deferred to the fast-follow.
    OpenAiCompatible,
}

impl Provider {
    pub fn parse(s: &str) -> Provider {
        match s {
            "openai" | "groq" | "custom" => Provider::OpenAiCompatible,
            _ => Provider::Anthropic,
        }
    }
}

/// Everything one provider call needs. `api_key` is read in Rust and never leaves it.
pub struct ProviderRequest {
    pub model: String,
    pub system: String,
    pub messages: Vec<AmberMessage>,
    /// Tool schemas in Anthropic shape: `[{name, description, input_schema}]`.
    pub tools: Value,
    pub max_tokens: u32,
    pub api_key: String,
    pub base_url: String,
}

/// A streaming increment forwarded to the UI as it arrives.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderEvent {
    TextDelta(String),
    ToolUseStart { id: String, name: String },
    Usage { input_tokens: u32, output_tokens: u32 },
}

/// The fully-assembled assistant turn once the stream completes.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnResult {
    pub content: Vec<ContentPart>,
    /// `tool_use` means the loop should dispatch tools and continue; anything else ends the loop.
    pub stop_reason: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// Run one assistant turn. `cancel` is checked between stream chunks; setting it aborts the
/// in-flight HTTP connection by dropping the stream. `client` is the shared, timeout-bounded
/// `reqwest::Client` owned by `AmberRegistry`.
pub async fn run_turn(
    provider: Provider,
    client: &reqwest::Client,
    req: &ProviderRequest,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(ProviderEvent) + Send),
) -> Result<TurnResult, String> {
    match provider {
        Provider::Anthropic => anthropic::run_turn(client, req, cancel, emit).await,
        Provider::OpenAiCompatible => {
            Err("OpenAI-compatible provider is not yet implemented in this build.".to_string())
        }
    }
}
