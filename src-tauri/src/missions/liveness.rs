//! Lease-based liveness and warn-only staleness tracking (Phase M4).
//!
//! Posture (Decision D5):
//! - Tool traffic and ask/mailbox interaction refreshes dispatch leases.
//! - Expired lease (default 10 min silence): warn-only status + probe event.
//! - Second silent window (default 20 min silence): dispatch transitions to `failed`
//!   with termination reason `lease_expired` and evaluates the retry policy.
//! - Active worker `ask` question keeps lease warm (intentionally blocked, not hung).

use serde::{Deserialize, Serialize};

use super::{record_event, supervisor, MissionState};

pub const DEFAULT_LEASE_DURATION_SECS: u64 = 600; // 10 minutes

/// Result of evaluating dispatch leases during a scheduler / reconcile tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivenessTickOutcome {
    pub warned_dispatch_ids: Vec<String>,
    pub expired_dispatch_ids: Vec<String>,
}

/// Check if a dispatch is intentionally blocked waiting on an unanswered `ask`.
pub fn is_dispatch_waiting_for_ask(state: &MissionState, task_id: &str) -> Option<String> {
    let from_tag = format!("task_{}", task_id);
    state.messages.iter().find_map(|m| {
        if m.from == from_tag && m.kind == "ask" && m.expects_reply && m.answered_by.is_none() {
            Some(m.thread_id.clone())
        } else {
            None
        }
    })
}

/// Parse ISO 8601 string to epoch seconds.
#[allow(clippy::manual_is_multiple_of)]
pub fn iso_to_epoch_secs(iso: &str) -> Option<u64> {
    let clean = iso.trim();
    if clean.len() < 19 {
        return None;
    }
    let year: u64 = clean.get(0..4)?.parse().ok()?;
    let month: u64 = clean.get(5..7)?.parse().ok()?;
    let day: u64 = clean.get(8..10)?.parse().ok()?;
    let hour: u64 = clean.get(11..13)?.parse().ok()?;
    let min: u64 = clean.get(14..16)?.parse().ok()?;
    let sec: u64 = clean.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut total_days = 0u64;
    for y in 1970..year {
        total_days += if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
            366
        } else {
            365
        };
    }
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_months = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    for m in 1..month {
        total_days += days_in_months[(m - 1) as usize];
    }
    total_days += day - 1;

    Some(total_days * 86400 + hour * 3600 + min * 60 + sec)
}

/// Evaluate all running dispatch leases against silence thresholds.
pub fn evaluate_dispatch_leases(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    now_iso: &str,
    lease_duration_secs: u64,
) -> Result<LivenessTickOutcome, String> {
    let now_epoch = iso_to_epoch_secs(now_iso).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    });
    let mut warned = Vec::new();
    let mut expired = Vec::new();

    let mut actions: Vec<(String, String, &'static str)> = Vec::new();

    for d in &state.dispatches {
        if d.status != "running" && d.status != "starting" {
            continue;
        }

        // If dispatch is waiting on an active ask, its lease is kept warm
        if is_dispatch_waiting_for_ask(state, &d.task_id).is_some() {
            continue;
        }

        let ref_time_str = d.last_heartbeat_at.as_deref().or(d.started_at.as_deref());
        let Some(ref_iso) = ref_time_str else {
            continue;
        };

        let Some(ref_epoch) = iso_to_epoch_secs(ref_iso) else {
            continue;
        };

        let elapsed_secs = now_epoch.saturating_sub(ref_epoch);

        if elapsed_secs >= 2 * lease_duration_secs {
            // Second silent window -> expire & fail
            actions.push((d.id.clone(), d.task_id.clone(), "expire"));
        } else if elapsed_secs >= lease_duration_secs {
            // First silent window -> warn only
            actions.push((d.id.clone(), d.task_id.clone(), "warn"));
        }
    }

    for (dispatch_id, task_id, action) in actions {
        if action == "expire" {
            expired.push(dispatch_id.clone());
            supervisor::handle_dispatch_failure(
                state,
                project_path,
                mission_id,
                &dispatch_id,
                Some("lease_expired".to_string()),
                None,
            )?;
            record_event(
                project_path,
                mission_id,
                state,
                "dispatch_lease_expired",
                serde_json::json!({
                    "dispatchId": dispatch_id,
                    "taskId": task_id,
                }),
            )?;
        } else if action == "warn" {
            warned.push(dispatch_id.clone());
            record_event(
                project_path,
                mission_id,
                state,
                "dispatch_lease_warning",
                serde_json::json!({
                    "dispatchId": dispatch_id,
                    "taskId": task_id,
                }),
            )?;
        }
    }

    Ok(LivenessTickOutcome {
        warned_dispatch_ids: warned,
        expired_dispatch_ids: expired,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::{MissionDispatch, MissionMessage, MissionSpec, MissionTask};

    fn make_test_state() -> MissionState {
        MissionState {
            id: "msn_live01".to_string(),
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
                allow_stale_base: false,
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
                capability_hash: "sha256:abc".to_string(),
                status: "running".to_string(),
                failure_count: 0,
                last_heartbeat_at: Some("2026-08-28T12:00:00Z".to_string()),
                started_at: Some("2026-08-28T12:00:00Z".to_string()),
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
        }
    }

    #[test]
    fn warn_only_on_first_silent_window_then_fail_on_second() {
        let mut state = make_test_state();
        let lease_duration = 600; // 10 minutes

        // 1. After 5 minutes (300s): running healthy
        let outcome1 = evaluate_dispatch_leases(
            &mut state,
            "/tmp",
            "msn_live01",
            "2026-08-28T12:05:00Z",
            lease_duration,
        )
        .unwrap();
        assert!(outcome1.warned_dispatch_ids.is_empty());
        assert!(outcome1.expired_dispatch_ids.is_empty());
        assert_eq!(state.dispatches[0].status, "running");

        // 2. After 12 minutes (720s): first timeout window -> warn-only
        let outcome2 = evaluate_dispatch_leases(
            &mut state,
            "/tmp",
            "msn_live01",
            "2026-08-28T12:12:00Z",
            lease_duration,
        )
        .unwrap();
        assert_eq!(outcome2.warned_dispatch_ids, vec!["dsp_1".to_string()]);
        assert!(outcome2.expired_dispatch_ids.is_empty());
        assert_eq!(state.dispatches[0].status, "running");

        // 3. After 22 minutes (1320s): second timeout window -> expired & failed
        let outcome3 = evaluate_dispatch_leases(
            &mut state,
            "/tmp",
            "msn_live01",
            "2026-08-28T12:22:00Z",
            lease_duration,
        )
        .unwrap();
        assert_eq!(outcome3.expired_dispatch_ids, vec!["dsp_1".to_string()]);
        assert_eq!(state.dispatches[0].status, "failed");
        assert_eq!(state.dispatches[0].termination_reason, Some("lease_expired".to_string()));
    }

    #[test]
    fn pending_ask_protects_lease_from_expiration() {
        let mut state = make_test_state();
        let lease_duration = 600;

        // Dispatch has a pending unanswered ask
        state.messages.push(MissionMessage {
            id: "msg_ask1".to_string(),
            thread_id: "thr_ask1".to_string(),
            from: "task_task_1".to_string(),
            to: "operator".to_string(),
            kind: "ask".to_string(),
            body: "Which API version?".to_string(),
            expects_reply: true,
            in_reply_to: None,
            answered_by: None,
            read: false,
            acked: false,
            created_at: "2026-08-28T12:00:00Z".to_string(),
        });

        // Even after 30 minutes, lease evaluation does not warn or expire
        let outcome = evaluate_dispatch_leases(
            &mut state,
            "/tmp",
            "msn_live01",
            "2026-08-28T12:30:00Z",
            lease_duration,
        )
        .unwrap();
        assert!(outcome.warned_dispatch_ids.is_empty());
        assert!(outcome.expired_dispatch_ids.is_empty());
        assert_eq!(state.dispatches[0].status, "running");
    }
}
