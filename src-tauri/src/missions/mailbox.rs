//! Durable threaded mission mailbox (Phase M4).
//!
//! Owns inter-participant communication (tasks, coordinator, operator).
//! Enforces:
//! - Threading and reply tracking (`expects_reply` answered exactly once)
//! - 16 KiB message body limit
//! - 200 message ceiling in `state.json` with archival to `messages.log`
//! - Durable worker inbox fetch/ack
//! - Stalled receiver notices on task exit/settlement without reply

use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};

use super::{mission_dir, new_id, record_event, MissionMessage, MissionState};

pub const MAX_MESSAGE_BODY_BYTES: usize = 16 * 1024; // 16 KiB
pub const MESSAGE_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    pub from: String,
    pub to: String,
    /// `message | ask | reply | notice`
    #[serde(default = "default_message_kind")]
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub expects_reply: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
}

fn default_message_kind() -> String {
    "message".to_string()
}

/// Append pre-rendered lines to `messages.log`.
fn append_messages_log(path: &Path, lines: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    file.write_all(lines.as_bytes())
        .map_err(|e| format!("Failed to append to {}: {}", path.display(), e))
}

/// Send a message and append to mission state mailbox, archiving overflow to `messages.log`.
pub fn send_message(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    input: SendMessageInput,
) -> Result<MissionMessage, String> {
    if input.body.len() > MAX_MESSAGE_BODY_BYTES {
        return Err(format!(
            "Message body exceeds 16 KiB limit ({} bytes)",
            input.body.len()
        ));
    }

    let msg_id = new_id("msg");
    let thread_id = input.thread_id.unwrap_or_else(|| new_id("thr"));
    let now = crate::project::now_iso();

    // If this is a reply to another message, mark the original as answered
    if let Some(parent_id) = &input.in_reply_to {
        if let Some(parent) = state.messages.iter_mut().find(|m| m.id == *parent_id) {
            parent.answered_by = Some(msg_id.clone());
            parent.read = true;
        }
    }

    let msg = MissionMessage {
        id: msg_id.clone(),
        thread_id: thread_id.clone(),
        from: input.from.clone(),
        to: input.to.clone(),
        kind: input.kind.clone(),
        body: input.body,
        expects_reply: input.expects_reply,
        in_reply_to: input.in_reply_to,
        answered_by: None,
        read: false,
        acked: false,
        created_at: now.clone(),
    };

    state.messages.push(msg.clone());

    // Prune overflow beyond MESSAGE_CAP
    if state.messages.len() > MESSAGE_CAP {
        let overflow: Vec<MissionMessage> = state
            .messages
            .drain(..state.messages.len() - MESSAGE_CAP)
            .collect();
        let mut lines = String::new();
        for m in overflow {
            if let Ok(serialized) = serde_json::to_string(&m) {
                lines.push_str(&format!("{}\n", serialized));
            }
        }
        let log_path = mission_dir(project_path, mission_id)?.join("messages.log");
        let _ = append_messages_log(&log_path, &lines);
    }

    record_event(
        project_path,
        mission_id,
        state,
        "message_sent",
        serde_json::json!({
            "messageId": msg_id,
            "threadId": thread_id,
            "from": input.from,
            "to": input.to,
            "kind": input.kind,
            "expectsReply": input.expects_reply,
        }),
    )?;

    Ok(msg)
}

/// Fetch unacked messages for a recipient (e.g. `task_<id>`, `coordinator`, `operator`).
pub fn inbox_fetch(
    state: &MissionState,
    recipient: &str,
) -> Vec<MissionMessage> {
    state
        .messages
        .iter()
        .filter(|m| !m.acked && (m.to == recipient || m.to == "all" || m.to == "*"))
        .cloned()
        .collect()
}

/// Acknowledge delivery of messages by IDs so they won't be re-delivered.
pub fn inbox_ack(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    message_ids: &[String],
) -> Result<usize, String> {
    let mut acked_count = 0;
    for m in &mut state.messages {
        if message_ids.contains(&m.id) {
            m.acked = true;
            m.read = true;
            acked_count += 1;
        }
    }

    if acked_count > 0 {
        record_event(
            project_path,
            mission_id,
            state,
            "inbox_acked",
            serde_json::json!({
                "messageIds": message_ids,
                "count": acked_count,
            }),
        )?;
    }

    Ok(acked_count)
}

/// Sweep stalled receivers when a task settles or exits:
/// Emits a `notice` of kind `stalled` for any unanswered message with `expects_reply == true`.
pub fn sweep_stalled_receivers(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    task_id: &str,
) -> Result<Vec<String>, String> {
    let recipient = format!("task_{}", task_id);
    let mut notices = Vec::new();
    let now = crate::project::now_iso();

    let unanswered: Vec<(String, String, String)> = state
        .messages
        .iter()
        .filter(|m| {
            m.to == recipient
                && m.expects_reply
                && m.answered_by.is_none()
                && m.kind != "notice"
        })
        .map(|m| (m.id.clone(), m.thread_id.clone(), m.from.clone()))
        .collect();

    for (parent_id, thread_id, original_sender) in unanswered {
        let notice_id = new_id("msg");
        let notice = MissionMessage {
            id: notice_id.clone(),
            thread_id: thread_id.clone(),
            from: "system".to_string(),
            to: original_sender.clone(),
            kind: "notice".to_string(),
            body: format!(
                "Receiver task '{}' finished without replying to question in thread '{}'",
                task_id, thread_id
            ),
            expects_reply: false,
            in_reply_to: Some(parent_id.clone()),
            answered_by: None,
            read: false,
            acked: false,
            created_at: now.clone(),
        };

        if let Some(parent) = state.messages.iter_mut().find(|m| m.id == parent_id) {
            parent.answered_by = Some(notice_id.clone());
        }

        state.messages.push(notice);
        notices.push(notice_id.clone());

        record_event(
            project_path,
            mission_id,
            state,
            "stalled_receiver_notice",
            serde_json::json!({
                "parentMessageId": parent_id,
                "threadId": thread_id,
                "receiver": recipient,
                "sender": original_sender,
            }),
        )?;
    }

    Ok(notices)
}

/// Retrieve undelivered unacked messages addressed to a task for preamble injection.
pub fn get_undelivered_mail_for_task(
    state: &MissionState,
    task_id: &str,
) -> Vec<MissionMessage> {
    let recipient = format!("task_{}", task_id);
    state
        .messages
        .iter()
        .filter(|m| !m.acked && (m.to == recipient || m.to == "all"))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::{MissionSpec, MissionTask};

    fn make_test_state() -> MissionState {
        MissionState {
            id: "msn_mail01".to_string(),
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
            dispatches: vec![],
            gates: vec![],
            messages: vec![],
            pool: vec![],
            events: vec![],
            idempotency: std::collections::BTreeMap::new(),
            created_at: "2026-08-28T00:00:00Z".to_string(),
            updated_at: "2026-08-28T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn send_fetch_and_ack_mailbox_flow() {
        let mut state = make_test_state();

        // 1. Send message to task_1
        let msg = send_message(
            &mut state,
            "/tmp",
            "msn_mail01",
            SendMessageInput {
                from: "operator".to_string(),
                to: "task_task_1".to_string(),
                kind: "message".to_string(),
                body: "Please use argon2 for password hashing".to_string(),
                expects_reply: false,
                thread_id: None,
                in_reply_to: None,
            },
        )
        .unwrap();

        assert_eq!(state.messages.len(), 1);
        assert_eq!(msg.to, "task_task_1");
        assert!(!msg.acked);

        // 2. Fetch inbox for task_task_1
        let unacked = inbox_fetch(&state, "task_task_1");
        assert_eq!(unacked.len(), 1);
        assert_eq!(unacked[0].id, msg.id);

        // 3. Ack inbox
        let count = inbox_ack(&mut state, "/tmp", "msn_mail01", std::slice::from_ref(&msg.id)).unwrap();
        assert_eq!(count, 1);
        assert!(state.messages[0].acked);

        // 4. Subsequent fetch returns empty
        let unacked_after = inbox_fetch(&state, "task_task_1");
        assert!(unacked_after.is_empty());
    }

    #[test]
    fn stalled_receiver_notice_sweep() {
        let mut state = make_test_state();

        // Send a question expecting reply to task_1
        let msg = send_message(
            &mut state,
            "/tmp",
            "msn_mail01",
            SendMessageInput {
                from: "coordinator".to_string(),
                to: "task_task_1".to_string(),
                kind: "ask".to_string(),
                body: "Do we need backward compatibility?".to_string(),
                expects_reply: true,
                thread_id: None,
                in_reply_to: None,
            },
        )
        .unwrap();

        assert_eq!(state.messages[0].answered_by, None);

        // Receiver task_1 exits without replying
        let notices = sweep_stalled_receivers(&mut state, "/tmp", "msn_mail01", "task_1").unwrap();
        assert_eq!(notices.len(), 1);

        // Stalled notice created for coordinator
        assert_eq!(state.messages.len(), 2);
        let notice = &state.messages[1];
        assert_eq!(notice.to, "coordinator");
        assert_eq!(notice.kind, "notice");
        assert_eq!(notice.in_reply_to, Some(msg.id.clone()));
        assert_eq!(state.messages[0].answered_by, Some(notice.id.clone()));
    }

    #[test]
    fn message_body_size_limit_enforced() {
        let mut state = make_test_state();
        let big_body = "x".repeat(MAX_MESSAGE_BODY_BYTES + 1);

        let err = send_message(
            &mut state,
            "/tmp",
            "msn_mail01",
            SendMessageInput {
                from: "operator".to_string(),
                to: "task_1".to_string(),
                kind: "message".to_string(),
                body: big_body,
                expects_reply: false,
                thread_id: None,
                in_reply_to: None,
            },
        )
        .unwrap_err();

        assert!(err.contains("16 KiB limit"));
    }
}
