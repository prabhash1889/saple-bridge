//! Identity-bound settlement engine for Missions (Phase M4).
//!
//! Completion authority is strictly identity-bound: a report from the wrong attempt,
//! wrong pane, stale token, or unknown dispatch can never settle a task.
//!
//! Rejection taxonomy (plan section 3.3):
//! - `sender_not_assignee`: wrong capability token or pane mismatch
//! - `stale_attempt`: report for attempt N when active attempt is N+1
//! - `task_dispatch_mismatch`: task does not own the dispatch
//! - `inactive_dispatch`: dispatch is in a terminal or dead state
//! - `invalid_payload`: malformed report data
//! - `unknown_dispatch`: dispatch id not present in state

use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::{
    mailbox, record_event, scheduler, supervisor, MissionState,
};

/// Structured report submitted by a worker (via `saple_step_report` or IPC).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReport {
    pub dispatch_id: String,
    pub attempt_id: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// `progress | blocked | done | failed`
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tests: Option<Vec<String>>,
}

/// Settle outcome returned to callers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SettlementResult {
    Settled {
        task_id: String,
        status: String,
    },
    ProgressRecorded {
        task_id: String,
    },
    DuplicateIgnored {
        task_id: String,
    },
    Rejected {
        code: String,
        reason: String,
    },
}

/// Verify dispatch identity tuple against mission state (Plan section 3.3).
pub fn verify_dispatch_identity(
    state: &MissionState,
    dispatch_id: &str,
    attempt_id: &str,
    token: &str,
    pane_id: Option<&str>,
) -> Result<usize, (String, String)> {
    let idx = state
        .dispatches
        .iter()
        .position(|d| d.id == dispatch_id)
        .ok_or_else(|| {
            (
                "unknown_dispatch".to_string(),
                format!("Dispatch '{}' not found in mission", dispatch_id),
            )
        })?;

    let dispatch = &state.dispatches[idx];

    // Attempt identity check: attempt N cannot settle attempt N+1
    if dispatch.attempt_id != attempt_id {
        return Err((
            "stale_attempt".to_string(),
            format!(
                "Report attempt '{}' does not match active dispatch attempt '{}'",
                attempt_id, dispatch.attempt_id
            ),
        ));
    }

    // Capability token check
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, token.as_bytes());
    let token_hash = format!("sha256:{:x}", sha2::Digest::finalize(hasher));
    if dispatch.capability_hash != token_hash {
        return Err((
            "sender_not_assignee".to_string(),
            "Capability token hash does not match dispatch credentials".to_string(),
        ));
    }

    // Pane binding check if caller supplied pane_id and dispatch has a bound pane
    if let (Some(report_pane), Some(dispatch_pane)) = (pane_id, &dispatch.pane_id) {
        if report_pane != dispatch_pane {
            return Err((
                "sender_not_assignee".to_string(),
                format!(
                    "Report pane '{}' does not match bound dispatch pane '{}'",
                    report_pane, dispatch_pane
                ),
            ));
        }
    }

    // Inactive dispatch check
    if dispatch.status != "running" && dispatch.status != "starting" && dispatch.status != "starting_unknown" {
        if dispatch.status == "succeeded" {
            // Already settled - treated as duplicate
            return Ok(idx);
        }
        return Err((
            "inactive_dispatch".to_string(),
            format!("Cannot settle dispatch in status '{}'", dispatch.status),
        ));
    }

    Ok(idx)
}

/// Settle a worker report atomically with DAG promotion and event emission.
pub fn settle_step_report(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    report: &StepReport,
) -> Result<SettlementResult, String> {
    let dispatch_idx = match verify_dispatch_identity(
        state,
        &report.dispatch_id,
        &report.attempt_id,
        &report.token,
        report.pane_id.as_deref(),
    ) {
        Ok(idx) => idx,
        Err((code, reason)) => {
            // Audit rejection
            record_event(
                project_path,
                mission_id,
                state,
                "settlement_rejected",
                serde_json::json!({
                    "dispatchId": report.dispatch_id,
                    "attemptId": report.attempt_id,
                    "code": code,
                    "reason": reason,
                }),
            )?;
            return Ok(SettlementResult::Rejected { code, reason });
        }
    };

    let dispatch = &state.dispatches[dispatch_idx];
    let task_id = dispatch.task_id.clone();
    let provider = dispatch.provider.clone();
    let model = dispatch.model.clone();
    let now = crate::project::now_iso();

    // Idempotent duplicate check
    if dispatch.status == "succeeded" {
        return Ok(SettlementResult::DuplicateIgnored { task_id });
    }

    match report.status.as_str() {
        "done" => {
            let result_val = serde_json::json!({
                "summary": report.summary,
                "changedFiles": report.changed_files,
                "tests": report.tests,
                "settledBy": "step_report",
            });

            state.dispatches[dispatch_idx].status = "succeeded".to_string();
            state.dispatches[dispatch_idx].finished_at = Some(now.clone());
            state.dispatches[dispatch_idx].last_heartbeat_at = Some(now.clone());
            state.dispatches[dispatch_idx].result = Some(result_val.clone());

            if let Some(task_idx) = state.tasks.iter().position(|t| t.id == task_id) {
                state.tasks[task_idx].status = "completed".to_string();
                state.tasks[task_idx].result = Some(result_val);
            }

            // Pool session if provider supports resume
            let ad = crate::providers::adapter(&provider);
            if ad.map(|a| a.resume.is_some()).unwrap_or(false) {
                supervisor::pool_idle_session(
                    state,
                    &provider,
                    &model,
                    None,
                    &report.attempt_id,
                    &task_id,
                );
            }

            // Sweep any unanswered messages addressed to this task
            mailbox::sweep_stalled_receivers(state, project_path, mission_id, &task_id)?;

            // Promote ready dependents
            scheduler::promote_ready_tasks(state, project_path, mission_id)?;
            scheduler::evaluate_mission_terminal_status(state, project_path, mission_id)?;

            record_event(
                project_path,
                mission_id,
                state,
                "dispatch_settled",
                serde_json::json!({
                    "dispatchId": report.dispatch_id,
                    "attemptId": report.attempt_id,
                    "taskId": task_id,
                    "status": "succeeded",
                    "summary": report.summary,
                }),
            )?;

            record_event(
                project_path,
                mission_id,
                state,
                "task_completed",
                serde_json::json!({
                    "taskId": task_id,
                    "dispatchId": report.dispatch_id,
                }),
            )?;

            Ok(SettlementResult::Settled {
                task_id,
                status: "succeeded".to_string(),
            })
        }
        "failed" => {
            let result_val = serde_json::json!({
                "summary": report.summary,
                "changedFiles": report.changed_files,
                "tests": report.tests,
                "settledBy": "step_report_failure",
            });

            // Sweep any unanswered messages
            mailbox::sweep_stalled_receivers(state, project_path, mission_id, &task_id)?;

            supervisor::handle_dispatch_failure(
                state,
                project_path,
                mission_id,
                &report.dispatch_id,
                Some("worker_reported_failure".to_string()),
                Some(result_val),
            )?;

            scheduler::propagate_deadlocks(state, project_path, mission_id)?;
            scheduler::evaluate_mission_terminal_status(state, project_path, mission_id)?;

            Ok(SettlementResult::Settled {
                task_id,
                status: "failed".to_string(),
            })
        }
        "progress" => {
            state.dispatches[dispatch_idx].last_heartbeat_at = Some(now);
            record_event(
                project_path,
                mission_id,
                state,
                "dispatch_progress",
                serde_json::json!({
                    "dispatchId": report.dispatch_id,
                    "attemptId": report.attempt_id,
                    "taskId": task_id,
                    "summary": report.summary,
                }),
            )?;
            Ok(SettlementResult::ProgressRecorded { task_id })
        }
        "blocked" => {
            state.dispatches[dispatch_idx].last_heartbeat_at = Some(now);
            record_event(
                project_path,
                mission_id,
                state,
                "dispatch_blocked",
                serde_json::json!({
                    "dispatchId": report.dispatch_id,
                    "attemptId": report.attempt_id,
                    "taskId": task_id,
                    "summary": report.summary,
                }),
            )?;
            Ok(SettlementResult::ProgressRecorded { task_id })
        }
        other => Err(format!("Invalid step report status '{}'", other)),
    }
}
