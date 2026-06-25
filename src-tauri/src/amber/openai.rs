//! OpenAI-compatible (`/chat/completions`) provider — stub for the fast-follow.
//!
//! The seam is wired (`Provider::OpenAiCompatible` routes here via `provider::run_turn`) but the
//! SSE / tool-call accumulator is intentionally not implemented in this iteration. When built out,
//! the differences from Anthropic to handle are: `Authorization: Bearer` auth, tool args streamed
//! as `delta.tool_calls[i].function.arguments` keyed by index, a literal `data: [DONE]` stream
//! terminator, `finish_reason:"tool_calls"`, and tool results sent back as N separate
//! `role:"tool"` messages (each with `tool_call_id`).
