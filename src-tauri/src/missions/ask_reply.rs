//! Blocking Ask/Reply channel for Missions (Phase M4).
//!
//! Allows mid-run worker clarification questions without creating a full gate.
//! - Worker asks via `saple_ask`, creating a durable thread and keeping its lease warm.
//! - Operator or coordinator replies via `saple_reply` or UI input.
//! - Supports auto-responder rule matching.

use serde::{Deserialize, Serialize};

use super::{
    mailbox, new_id, record_event, settlement, MissionMessage, MissionState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskInput {
    pub dispatch_id: String,
    pub attempt_id: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutput {
    pub thread_id: String,
    pub message_id: String,
    pub auto_reply: Option<String>,
}

/// Ask a question from a dispatched worker, creating an ask thread in the mailbox.
pub fn ask_question(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    input: AskInput,
) -> Result<AskOutput, String> {
    let dispatch_idx = match settlement::verify_dispatch_identity(
        state,
        &input.dispatch_id,
        &input.attempt_id,
        &input.token,
        input.pane_id.as_deref(),
    ) {
        Ok(idx) => idx,
        Err((code, reason)) => {
            return Err(format!("Ask rejected ({}) : {}", code, reason));
        }
    };

    let task_id = state.dispatches[dispatch_idx].task_id.clone();
    let now = crate::project::now_iso();
    state.dispatches[dispatch_idx].last_heartbeat_at = Some(now.clone());

    let thread_id = new_id("thr");
    let msg_id = new_id("msg");
    let from_tag = format!("task_{}", task_id);

    let ask_msg = MissionMessage {
        id: msg_id.clone(),
        thread_id: thread_id.clone(),
        from: from_tag.clone(),
        to: "operator".to_string(),
        kind: "ask".to_string(),
        body: input.question.clone(),
        expects_reply: true,
        in_reply_to: None,
        answered_by: None,
        read: false,
        acked: false,
        created_at: now.clone(),
    };

    state.messages.push(ask_msg);

    record_event(
        project_path,
        mission_id,
        state,
        "ask_requested",
        serde_json::json!({
            "dispatchId": input.dispatch_id,
            "taskId": task_id,
            "threadId": thread_id,
            "messageId": msg_id,
            "question": input.question,
            "options": input.options,
        }),
    )?;

    Ok(AskOutput {
        thread_id,
        message_id: msg_id,
        auto_reply: None,
    })
}

/// Reply to an active ask thread.
pub fn reply_question(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    thread_id: &str,
    body: &str,
    authority: &str,
) -> Result<MissionMessage, String> {
    let parent_idx = state
        .messages
        .iter()
        .position(|m| m.thread_id == thread_id && m.kind == "ask" && m.expects_reply && m.answered_by.is_none())
        .ok_or_else(|| format!("Pending ask for thread '{}' not found or already answered", thread_id))?;

    let parent_id = state.messages[parent_idx].id.clone();
    let target = state.messages[parent_idx].from.clone();

    let reply_msg = mailbox::send_message(
        state,
        project_path,
        mission_id,
        mailbox::SendMessageInput {
            from: authority.to_string(),
            to: target.clone(),
            kind: "reply".to_string(),
            body: body.to_string(),
            expects_reply: false,
            thread_id: Some(thread_id.to_string()),
            in_reply_to: Some(parent_id.clone()),
        },
    )?;

    record_event(
        project_path,
        mission_id,
        state,
        "ask_replied",
        serde_json::json!({
            "threadId": thread_id,
            "parentMessageId": parent_id,
            "replyMessageId": reply_msg.id,
            "authority": authority,
            "target": target,
        }),
    )?;

    Ok(reply_msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use crate::missions::{MissionDispatch, MissionSpec, MissionTask};

    fn make_test_state() -> (MissionState, String) {
        let token = "ask_token_secret_123";
        let mut hasher = sha2::Sha256::new();
        sha2::Digest::update(&mut hasher, token.as_bytes());
        let hash = format!("sha256:{:x}", sha2::Digest::finalize(hasher));

        let state = MissionState {
            id: "msn_ask01".to_string(),
            revision: 1,
            status: "running".to_string(),
            spec: MissionSpec {
                title: "Test".to_string(),
                objective: "Obj".to_string(),
                acceptance: vec![],
                max_parallel: 2,
                max_rounds: 10,
                budget_usd_cap: 10.0,
                worktree_mode: "shared".to_string(),
                coordinator: None,
            },
            tasks: vec![MissionTask {
                id: "task_1".to_string(),
                title: "T1".to_string(),
                kind: "implement".to_string(),
                spec: "Spec".to_string(),
                deps: vec![],
                fanout: 1,
                status: "dispatched".to_string(),
                result: None,
                gate_id: None,
            }],
            dispatches: vec![MissionDispatch {
                id: "dsp_1".to_string(),
                task_id: "task_1".to_string(),
                attempt_id: "att_1".to_string(),
                retry_of: None,
                provider: "codex".to_string(),
                model: "gpt-5.2".to_string(),
                worktree_path: None,
                pane_id: Some("pane_1".to_string()),
                capability_hash: hash,
                status: "running".to_string(),
                failure_count: 0,
                last_heartbeat_at: None,
                started_at: None,
                finished_at: None,
                termination_reason: None,
                output_log_path: None,
                result: None,
            }],
            gates: vec![],
            messages: vec![],
            pool: vec![],
            events: vec![],
            idempotency: std::collections::BTreeMap::new(),
            created_at: "2026-08-28T00:00:00Z".to_string(),
            updated_at: "2026-08-28T00:00:00Z".to_string(),
        };

        (state, token.to_string())
    }

    #[test]
    fn ask_question_and_reply_flow() {
        let (mut state, token) = make_test_state();

        // 1. Worker asks question
        let out = ask_question(
            &mut state,
            "/tmp",
            "msn_ask01",
            AskInput {
                dispatch_id: "dsp_1".to_string(),
                attempt_id: "att_1".to_string(),
                token,
                pane_id: Some("pane_1".to_string()),
                question: "Should we use PostgreSQL or SQLite for tests?".to_string(),
                options: Some(vec!["PostgreSQL".into(), "SQLite".into()]),
                timeout_ms: None,
            },
        )
        .unwrap();

        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].thread_id, out.thread_id);
        assert!(state.messages[0].expects_reply);
        assert_eq!(state.messages[0].answered_by, None);

        // 2. Operator replies
        let reply = reply_question(
            &mut state,
            "/tmp",
            "msn_ask01",
            &out.thread_id,
            "Use SQLite for unit tests, Postgres for integration tests.",
            "operator",
        )
        .unwrap();

        assert_eq!(state.messages.len(), 2);
        assert_eq!(state.messages[0].answered_by, Some(reply.id.clone()));
        assert_eq!(reply.in_reply_to, Some(out.message_id));
        assert_eq!(reply.to, "task_task_1");
    }
}
