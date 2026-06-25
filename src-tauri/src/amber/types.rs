//! Provider-neutral message log for Amber.
//!
//! One log + one tool schema drives every provider. Each provider module serializes this log
//! to its own wire shape (Anthropic = one user message with N `tool_result` blocks; OpenAI = N
//! `role:"tool"` messages), so a conversation can switch providers mid-session and persistence
//! stays stable against wire-format drift.

use serde::{Deserialize, Serialize};

/// One turn in the conversation. The `role` tag matches what the React store sends/receives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum AmberMessage {
    /// A user message — plain text.
    User { content: String },
    /// An assistant turn — ordered text + tool-use blocks.
    Assistant { content: Vec<ContentPart> },
    /// The results of dispatching the tools requested by the preceding assistant turn.
    ToolResults { results: Vec<ToolResult> },
}

/// A piece of an assistant turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
}

/// The outcome of dispatching a single tool. `is_error` lets the model recover from failures.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_use_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// A persisted conversation (`.saple/amber/conversations/<id>.json` or app-data fallback).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub messages: Vec<AmberMessage>,
    pub created_at: String,
    pub updated_at: String,
    /// `claude` CLI session id for the "Claude Code" (subscription) provider, used to `--resume`
    /// the conversation. Absent for API-key providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
}

/// Lightweight row for the conversation list (no message bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub updated_at: String,
}
