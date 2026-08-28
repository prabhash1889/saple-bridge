//! Dispatch Supervisor for Missions (Phase M3).
//!
//! Owns the multi-stage crash-safe dispatch launch sequence, session pooling,
//! retry budget tracking, circuit breaking, honest unknown state recovery,
//! and process exit reconciliation.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::{
    doc_file_path, gates, mailbox, mission_dir, new_id, preamble, record_event, MissionDispatch, MissionState, PoolEntry,
};

pub const MAX_RETRIES: u32 = 2; // Total 3 attempts per task before circuit breaker trips

/// Details prepared for spawning the worker PTY process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDispatch {
    pub dispatch_id: String,
    pub attempt_id: String,
    pub pane_id: String,
    pub capability_token: String,
    pub prompt_file: String,
    pub provider: String,
    pub model: String,
    pub reused_session_id: Option<String>,
    pub worktree_path: Option<String>,
}

/// Compute a stable pool key for `(provider, model, worktree)`.
pub fn pool_entry_key(provider: &str, model: &str, worktree_path: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        provider.to_lowercase(),
        model.to_lowercase(),
        worktree_path.unwrap_or("shared")
    )
}

/// Look for an idle session in the mission's session pool and retain it.
pub fn find_and_retain_idle_session(
    state: &mut MissionState,
    provider: &str,
    model: &str,
    worktree_path: Option<&str>,
) -> Option<String> {
    let key = pool_entry_key(provider, model, worktree_path);
    if let Some(entry) = state.pool.iter_mut().find(|p| p.key == key && p.state == "idle") {
        entry.state = "retained".to_string();
        entry.reused_count += 1;
        Some(entry.session_id.clone())
    } else {
        None
    }
}

/// Add or return a session back to the idle pool upon clean settlement.
pub fn pool_idle_session(
    state: &mut MissionState,
    provider: &str,
    model: &str,
    worktree_path: Option<&str>,
    session_id: &str,
    task_id: &str,
) {
    let key = pool_entry_key(provider, model, worktree_path);
    if let Some(entry) = state.pool.iter_mut().find(|p| p.key == key) {
        entry.session_id = session_id.to_string();
        entry.state = "idle".to_string();
        entry.last_task_id = Some(task_id.to_string());
    } else {
        state.pool.push(PoolEntry {
            key,
            provider: provider.to_string(),
            model: model.to_string(),
            worktree_path: worktree_path.map(|s| s.to_string()),
            session_id: session_id.to_string(),
            state: "idle".to_string(),
            last_task_id: Some(task_id.to_string()),
            reused_count: 0,
        });
    }
}

/// Mark a specific pooled session as released (e.g. if follow-up turn fails).
pub fn release_pool_session(state: &mut MissionState, session_id: &str) {
    for entry in &mut state.pool {
        if entry.session_id == session_id {
            entry.state = "released".to_string();
        }
    }
}

/// Prepare a task dispatch and record the `starting` stage on disk (crash-safe stage 1).
pub fn prepare_dispatch_launch(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    task_id: &str,
    provider: &str,
    model: Option<String>,
) -> Result<PreparedDispatch, String> {
    if !crate::providers::is_mission_eligible(provider) {
        return Err(format!(
            "Provider '{}' is not eligible for mission dispatches",
            provider
        ));
    }

    let task_idx = state
        .tasks
        .iter()
        .position(|t| t.id == task_id)
        .ok_or_else(|| format!("Task '{}' not found in mission '{}'", task_id, mission_id))?;

    let (task_title, task_kind, task_spec, task_deps, task_allow_stale_base) = {
        let task = &state.tasks[task_idx];
        if task.status != "ready" && task.status != "pending" && task.status != "failed" {
            return Err(format!(
                "Cannot dispatch task '{}' in status '{}'",
                task_id, task.status
            ));
        }
        (
            task.title.clone(),
            task.kind.clone(),
            task.spec.clone(),
            task.deps.clone(),
            task.allow_stale_base,
        )
    };

    // Determine worktree path & branch if worktree isolation is active
    let (worktree_path_str, worktree_branch_str) = match state.spec.worktree_mode.as_str() {
        "per-task" => {
            let wt_dir = super::worktrees::get_worktree_dir(project_path, mission_id, Some(task_id));
            let wt_str = wt_dir.to_string_lossy().to_string();
            let branch = super::worktrees::get_worktree_branch(mission_id, Some(task_id));
            // Check stale base
            if let Ok(Some(behind)) = super::worktrees::check_stale_base(project_path, &wt_str, None, super::worktrees::STALE_BASE_THRESHOLD) {
                if !task_allow_stale_base {
                    return Err(format!(
                        "stale_base_refused: Task worktree is {} commits behind upstream base. Dispatch refused without burning retry budget.",
                        behind
                    ));
                }
            }
            (Some(wt_str), Some(branch))
        }
        "per-mission" => {
            let wt_dir = super::worktrees::get_worktree_dir(project_path, mission_id, None);
            let wt_str = wt_dir.to_string_lossy().to_string();
            let branch = super::worktrees::get_worktree_branch(mission_id, None);
            // Check stale base
            if let Ok(Some(behind)) = super::worktrees::check_stale_base(project_path, &wt_str, None, super::worktrees::STALE_BASE_THRESHOLD) {
                if !task_allow_stale_base {
                    return Err(format!(
                        "stale_base_refused: Mission worktree is {} commits behind upstream base. Dispatch refused without burning retry budget.",
                        behind
                    ));
                }
            }
            (Some(wt_str), Some(branch))
        }
        _ => (None, None),
    };

    // Determine if this is a retry of a previous dispatch
    let retry_of = state
        .dispatches
        .iter()
        .rfind(|d| d.task_id == task_id && (d.status == "failed" || d.status == "stop_unknown" || d.status == "starting_unknown" || d.status == "abandoned"))
        .map(|d| d.id.clone());

    let failure_count = state
        .dispatches
        .iter()
        .filter(|d| d.task_id == task_id && (d.status == "failed" || d.status == "stop_unknown" || d.status == "starting_unknown"))
        .count() as u32;

    let dispatch_id = new_id("dsp");
    let attempt_id = new_id("att");
    let pane_id = format!("pane_{}", &attempt_id["att_".len()..]);

    let capability_token = format!(
        "{:x}{:x}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, capability_token.as_bytes());
    let capability_hash = format!("sha256:{:x}", sha2::Digest::finalize(hasher));

    let effective_model = model.unwrap_or_else(|| "default".to_string());

    // Check session pool for an idle session to reuse
    let reused_session_id = find_and_retain_idle_session(state, provider, &effective_model, worktree_path_str.as_deref());

    let ad = crate::providers::adapter(provider);
    let supports_mcp = ad.map(|a| a.supports_mcp).unwrap_or(false);

    let mut upstream_summaries = Vec::new();
    for dep_id in &task_deps {
        if let Some(dep_task) = state.tasks.iter().find(|t| t.id == *dep_id) {
            if let Some(res) = &dep_task.result {
                let summary_str = res
                    .get("summary")
                    .or_else(|| res.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !summary_str.is_empty() {
                    upstream_summaries.push((dep_task.title.clone(), summary_str.to_string()));
                }
            }
        }
    }

    let dir = mission_dir(project_path, mission_id)?;
    let artifacts_dir = dir.join("artifacts");
    let mut artifact_paths = Vec::new();
    if artifacts_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&artifacts_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_file() {
                    artifact_paths.push(p);
                }
            }
        }
    }

    let resolved_gates = gates::get_resolved_gates_for_task(state, task_id);
    let undelivered_mail = mailbox::get_undelivered_mail_for_task(state, task_id);

    let preamble_input = preamble::PreambleInput {
        mission_id: mission_id.to_string(),
        task_id: task_id.to_string(),
        dispatch_id: dispatch_id.clone(),
        attempt_id: attempt_id.clone(),
        capability_token: capability_token.clone(),
        supports_mcp,
        worktree_branch: worktree_branch_str,
        worktree_path: worktree_path_str.as_ref().map(std::path::PathBuf::from),
        task_title,
        task_kind,
        task_spec,
        mission_doc_path: doc_file_path(project_path, mission_id)?,
        artifact_paths,
        upstream_summaries,
        resolved_gates,
        undelivered_mail,
    };

    let preamble_content = preamble::generate_preamble(&preamble_input);
    preamble::write_preamble_file(
        project_path,
        mission_id,
        &attempt_id,
        &preamble_content,
    )?;

    let now = crate::project::now_iso();
    let dispatch = MissionDispatch {
        id: dispatch_id.clone(),
        task_id: task_id.to_string(),
        attempt_id: attempt_id.clone(),
        retry_of,
        provider: provider.to_string(),
        model: effective_model.clone(),
        worktree_path: worktree_path_str.clone(),
        pane_id: Some(pane_id.clone()),
        capability_hash,
        status: "starting".to_string(),
        failure_count,
        last_heartbeat_at: Some(now.clone()),
        started_at: Some(now),
        finished_at: None,
        termination_reason: None,
        output_log_path: Some(format!(
            ".saple/missions/{}/logs/{}.log",
            mission_id, attempt_id
        )),
        result: None,
    };

    state.tasks[task_idx].status = "dispatched".to_string();
    state.dispatches.push(dispatch);

    let rel_prompt_file = format!(".saple/missions/{}/prompts/{}.md", mission_id, attempt_id);

    Ok(PreparedDispatch {
        dispatch_id,
        attempt_id,
        pane_id,
        capability_token,
        prompt_file: rel_prompt_file,
        provider: provider.to_string(),
        model: effective_model,
        reused_session_id,
        worktree_path: worktree_path_str,
    })
}

/// Finalize dispatch transition to `running` once the PTY process has spawned.
#[allow(dead_code)]
pub fn finalize_dispatch_running(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    dispatch_id: &str,
) -> Result<(), String> {
    let dispatch_idx = state
        .dispatches
        .iter()
        .position(|d| d.id == dispatch_id)
        .ok_or_else(|| format!("Dispatch '{}' not found in mission '{}'", dispatch_id, mission_id))?;

    let now = crate::project::now_iso();
    state.dispatches[dispatch_idx].status = "running".to_string();
    state.dispatches[dispatch_idx].started_at = Some(now);

    let task_id = state.dispatches[dispatch_idx].task_id.clone();
    let provider = state.dispatches[dispatch_idx].provider.clone();

    record_event(
        project_path,
        mission_id,
        state,
        "task_dispatched",
        serde_json::json!({
            "taskId": task_id,
            "dispatchId": dispatch_id,
            "provider": provider,
        }),
    )?;

    Ok(())
}

/// Handle non-zero exit or runtime failure of a dispatch: records failure, evaluates retry budget.
pub fn handle_dispatch_failure(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    dispatch_id: &str,
    termination_reason: Option<String>,
    parsed_result: Option<serde_json::Value>,
) -> Result<(), String> {
    let dispatch_idx = state
        .dispatches
        .iter()
        .position(|d| d.id == dispatch_id)
        .ok_or_else(|| format!("Dispatch '{}' not found in mission '{}'", dispatch_id, mission_id))?;

    let now = crate::project::now_iso();
    let task_id = state.dispatches[dispatch_idx].task_id.clone();
    let failure_count = state.dispatches[dispatch_idx].failure_count + 1;

    state.dispatches[dispatch_idx].status = "failed".to_string();
    state.dispatches[dispatch_idx].finished_at = Some(now);
    state.dispatches[dispatch_idx].failure_count = failure_count;
    state.dispatches[dispatch_idx].termination_reason = termination_reason.clone();
    state.dispatches[dispatch_idx].result = parsed_result.clone();

    // If a pooled session was used, release it so future attempts fresh-spawn
    if let Some(res) = &parsed_result {
        if let Some(session_id) = res.get("sessionId").and_then(|v| v.as_str()) {
            release_pool_session(state, session_id);
        }
    }

    // Sweep any unanswered messages expecting reply for this task
    let _ = mailbox::sweep_stalled_receivers(state, project_path, mission_id, &task_id);

    let is_operator_close = termination_reason.as_deref() == Some("operator_close");

    if let Some(task_idx) = state.tasks.iter().position(|t| t.id == task_id) {
        if failure_count <= MAX_RETRIES {
            // Under budget -> return task to ready for next attempt
            state.tasks[task_idx].status = "ready".to_string();
            state.tasks[task_idx].result = parsed_result;

            record_event(
                project_path,
                mission_id,
                state,
                if is_operator_close { "dispatch_closed" } else { "task_retry_scheduled" },
                serde_json::json!({
                    "dispatchId": dispatch_id,
                    "taskId": task_id,
                    "failureCount": failure_count,
                    "terminationReason": termination_reason,
                }),
            )?;
        } else {
            // Reached budget limit -> circuit breaker trips!
            state.tasks[task_idx].status = "circuit_broken".to_string();
            state.tasks[task_idx].result = parsed_result;

            record_event(
                project_path,
                mission_id,
                state,
                "task_circuit_broken",
                serde_json::json!({
                    "dispatchId": dispatch_id,
                    "taskId": task_id,
                    "failureCount": failure_count,
                    "terminationReason": termination_reason,
                }),
            )?;
        }
    }

    Ok(())
}

/// Reconcile orphan dispatches across a mission (e.g. after app restart or engine crash).
/// Maps stranded `starting` dispatches to `starting_unknown` and dead `running` dispatches to `stop_unknown`.
pub fn reconcile_orphan_dispatches(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    live_pane_ids: &HashSet<String>,
) -> Result<bool, String> {
    let now = crate::project::now_iso();
    let mut recoveries = Vec::new();

    for d in &mut state.dispatches {
        if d.status == "starting" {
            let pane_live = d.pane_id.as_ref().map(|p| live_pane_ids.contains(p)).unwrap_or(false);
            if !pane_live {
                d.status = "starting_unknown".to_string();
                d.finished_at = Some(now.clone());
                d.termination_reason = Some("crash_during_startup".to_string());
                recoveries.push((d.id.clone(), d.task_id.clone(), "starting", "starting_unknown"));
            }
        } else if d.status == "running" {
            let pane_live = d.pane_id.as_ref().map(|p| live_pane_ids.contains(p)).unwrap_or(false);
            if !pane_live {
                d.status = "stop_unknown".to_string();
                d.finished_at = Some(now.clone());
                d.termination_reason = Some("orphaned_on_restart".to_string());
                recoveries.push((d.id.clone(), d.task_id.clone(), "running", "stop_unknown"));
            }
        }
    }

    if recoveries.is_empty() {
        return Ok(false);
    }

    for (dispatch_id, task_id, from_status, to_status) in recoveries {
        if let Some(task) = state.tasks.iter_mut().find(|t| t.id == task_id) {
            task.status = "failed".to_string();
        }
        record_event(
            project_path,
            mission_id,
            state,
            "dispatch_recovery",
            serde_json::json!({
                "dispatchId": dispatch_id,
                "taskId": task_id,
                "from": from_status,
                "to": to_status,
            }),
        )?;
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::MissionTask;

    fn make_test_state() -> MissionState {
        MissionState {
            id: "msn_sup01".to_string(),
            revision: 1,
            status: "running".to_string(),
            spec: crate::missions::MissionSpec {
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
                spec: "Do something".to_string(),
                deps: vec![],
                fanout: 1,
                allow_stale_base: false,
                status: "ready".to_string(),
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
    fn session_pooling_lifecycle_and_reuse() {
        let mut state = make_test_state();

        // 1. Pool an idle session for codex
        pool_idle_session(&mut state, "codex", "gpt-5.2", None, "sess_123", "task_1");
        assert_eq!(state.pool.len(), 1);
        assert_eq!(state.pool[0].state, "idle");
        assert_eq!(state.pool[0].session_id, "sess_123");
        assert_eq!(state.pool[0].reused_count, 0);

        // 2. Retain the idle session on next dispatch
        let reused = find_and_retain_idle_session(&mut state, "codex", "gpt-5.2", None);
        assert_eq!(reused, Some("sess_123".to_string()));
        assert_eq!(state.pool[0].state, "retained");
        assert_eq!(state.pool[0].reused_count, 1);

        // 3. Attempting to retain again returns None because it's retained
        let second = find_and_retain_idle_session(&mut state, "codex", "gpt-5.2", None);
        assert_eq!(second, None);

        // 4. Return to idle upon settlement
        pool_idle_session(&mut state, "codex", "gpt-5.2", None, "sess_123", "task_2");
        assert_eq!(state.pool[0].state, "idle");
        assert_eq!(state.pool[0].last_task_id, Some("task_2".to_string()));

        // 5. Release session
        release_pool_session(&mut state, "sess_123");
        assert_eq!(state.pool[0].state, "released");
        assert_eq!(find_and_retain_idle_session(&mut state, "codex", "gpt-5.2", None), None);
    }

    #[test]
    fn retry_budget_and_circuit_breaker() {
        let mut state = make_test_state();
        let dsp1_id = "dsp_1".to_string();

        state.dispatches.push(MissionDispatch {
            id: dsp1_id.clone(),
            task_id: "task_1".to_string(),
            attempt_id: "att_1".to_string(),
            retry_of: None,
            provider: "codex".to_string(),
            model: "default".to_string(),
            worktree_path: None,
            pane_id: Some("pane_1".to_string()),
            capability_hash: "sha256:abc".to_string(),
            status: "running".to_string(),
            failure_count: 0,
            last_heartbeat_at: None,
            started_at: None,
            finished_at: None,
            termination_reason: None,
            output_log_path: None,
            result: None,
        });

        // 1st failure (attempt 1): task returns to ready for retry
        handle_dispatch_failure(&mut state, "/tmp", "msn_sup01", &dsp1_id, Some("crash".into()), None).unwrap();
        assert_eq!(state.tasks[0].status, "ready");
        assert_eq!(state.dispatches[0].status, "failed");
        assert_eq!(state.dispatches[0].failure_count, 1);

        // 2nd failure (attempt 2): task returns to ready for retry
        let dsp2_id = "dsp_2".to_string();
        state.dispatches.push(MissionDispatch {
            id: dsp2_id.clone(),
            task_id: "task_1".to_string(),
            attempt_id: "att_2".to_string(),
            retry_of: Some(dsp1_id),
            provider: "codex".to_string(),
            model: "default".to_string(),
            worktree_path: None,
            pane_id: Some("pane_2".to_string()),
            capability_hash: "sha256:abc".to_string(),
            status: "running".to_string(),
            failure_count: 1,
            last_heartbeat_at: None,
            started_at: None,
            finished_at: None,
            termination_reason: None,
            output_log_path: None,
            result: None,
        });
        handle_dispatch_failure(&mut state, "/tmp", "msn_sup01", &dsp2_id, Some("crash".into()), None).unwrap();
        assert_eq!(state.tasks[0].status, "ready");
        assert_eq!(state.dispatches[1].failure_count, 2);

        // 3rd failure (attempt 3): trips circuit breaker!
        let dsp3_id = "dsp_3".to_string();
        state.dispatches.push(MissionDispatch {
            id: dsp3_id.clone(),
            task_id: "task_1".to_string(),
            attempt_id: "att_3".to_string(),
            retry_of: Some(dsp2_id),
            provider: "codex".to_string(),
            model: "default".to_string(),
            worktree_path: None,
            pane_id: Some("pane_3".to_string()),
            capability_hash: "sha256:abc".to_string(),
            status: "running".to_string(),
            failure_count: 2,
            last_heartbeat_at: None,
            started_at: None,
            finished_at: None,
            termination_reason: None,
            output_log_path: None,
            result: None,
        });
        handle_dispatch_failure(&mut state, "/tmp", "msn_sup01", &dsp3_id, Some("crash".into()), None).unwrap();
        assert_eq!(state.tasks[0].status, "circuit_broken");
        assert_eq!(state.dispatches[2].failure_count, 3);
    }

    #[test]
    fn crash_recovery_matrix_honest_unknown_states() {
        let mut state = make_test_state();
        state.dispatches.push(MissionDispatch {
            id: "dsp_start".to_string(),
            task_id: "task_1".to_string(),
            attempt_id: "att_s".to_string(),
            retry_of: None,
            provider: "codex".to_string(),
            model: "default".to_string(),
            worktree_path: None,
            pane_id: Some("pane_s".to_string()),
            capability_hash: "sha256:abc".to_string(),
            status: "starting".to_string(),
            failure_count: 0,
            last_heartbeat_at: None,
            started_at: None,
            finished_at: None,
            termination_reason: None,
            output_log_path: None,
            result: None,
        });
        state.dispatches.push(MissionDispatch {
            id: "dsp_run".to_string(),
            task_id: "task_1".to_string(),
            attempt_id: "att_r".to_string(),
            retry_of: None,
            provider: "claude".to_string(),
            model: "default".to_string(),
            worktree_path: None,
            pane_id: Some("pane_r".to_string()),
            capability_hash: "sha256:def".to_string(),
            status: "running".to_string(),
            failure_count: 0,
            last_heartbeat_at: None,
            started_at: None,
            finished_at: None,
            termination_reason: None,
            output_log_path: None,
            result: None,
        });

        // No live panes
        let live_panes = HashSet::new();
        let changed = reconcile_orphan_dispatches(&mut state, "/tmp", "msn_sup01", &live_panes).unwrap();
        assert!(changed);
        assert_eq!(state.dispatches[0].status, "starting_unknown");
        assert_eq!(state.dispatches[1].status, "stop_unknown");
        assert_eq!(state.tasks[0].status, "failed");
    }
}
