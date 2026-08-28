//! Decision Gates for Missions (Phase M4).
//!
//! Human and coordinator decision gates block tasks until resolved.
//! Invariant: The engine never auto-resolves gates.
//! Resolved gates are audited and replayed into the task's future attempt preambles.

use serde::{Deserialize, Serialize};

use super::{new_id, record_event, MissionGate, MissionState};

/// Input for requesting a new gate (worker-initiated).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateRequestInput {
    pub dispatch_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
}

/// Request a new decision gate, blocking the associated task.
pub fn request_gate(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    dispatch_id: &str,
    question: String,
    options: Vec<String>,
) -> Result<String, String> {
    let dispatch_idx = state
        .dispatches
        .iter()
        .position(|d| d.id == dispatch_id)
        .ok_or_else(|| format!("Dispatch '{}' not found in mission '{}'", dispatch_id, mission_id))?;

    let task_id = state.dispatches[dispatch_idx].task_id.clone();
    let gate_id = new_id("gate");

    let effective_options = if options.is_empty() {
        vec!["approve".to_string(), "reject".to_string()]
    } else {
        options
    };

    let gate = MissionGate {
        id: gate_id.clone(),
        task_id: task_id.clone(),
        question: question.clone(),
        options: effective_options.clone(),
        status: "pending".to_string(),
        resolution: None,
    };

    state.gates.push(gate);

    if let Some(task) = state.tasks.iter_mut().find(|t| t.id == task_id) {
        task.status = "blocked".to_string();
        task.gate_id = Some(gate_id.clone());
    }

    record_event(
        project_path,
        mission_id,
        state,
        "gate_requested",
        serde_json::json!({
            "gateId": gate_id,
            "taskId": task_id,
            "dispatchId": dispatch_id,
            "question": question,
            "options": effective_options,
        }),
    )?;

    Ok(gate_id)
}

/// Resolve a pending gate with a human or coordinator decision.
pub fn resolve_gate(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    gate_id: &str,
    resolution: &str,
    authority: &str,
) -> Result<(), String> {
    let gate_idx = state
        .gates
        .iter()
        .position(|g| g.id == gate_id)
        .ok_or_else(|| format!("Gate '{}' not found in mission '{}'", gate_id, mission_id))?;

    if state.gates[gate_idx].status != "pending" {
        return Err(format!(
            "Gate '{}' is already in status '{}'",
            gate_id, state.gates[gate_idx].status
        ));
    }

    state.gates[gate_idx].status = "resolved".to_string();
    state.gates[gate_idx].resolution = Some(resolution.to_string());

    let task_id = state.gates[gate_idx].task_id.clone();

    // Check if task has any other pending gates
    let other_pending_gates = state
        .gates
        .iter()
        .any(|g| g.task_id == task_id && g.id != gate_id && g.status == "pending");

    if !other_pending_gates {
        let completed_ids: std::collections::HashSet<String> = state
            .tasks
            .iter()
            .filter(|t| t.status == "completed")
            .map(|t| t.id.clone())
            .collect();

        if let Some(task) = state.tasks.iter_mut().find(|t| t.id == task_id) {
            task.gate_id = None;
            if task.deps.iter().all(|dep| completed_ids.contains(dep)) {
                task.status = "ready".to_string();
            } else {
                task.status = "pending".to_string();
            }
        }
    }

    record_event(
        project_path,
        mission_id,
        state,
        "gate_resolved",
        serde_json::json!({
            "gateId": gate_id,
            "taskId": task_id,
            "resolution": resolution,
            "authority": authority,
        }),
    )?;

    Ok(())
}

/// Retrieve all resolved gates for a given task, used for preamble replay.
pub fn get_resolved_gates_for_task(
    state: &MissionState,
    task_id: &str,
) -> Vec<(String, String)> {
    state
        .gates
        .iter()
        .filter(|g| g.task_id == task_id && g.status == "resolved" && g.resolution.is_some())
        .map(|g| (g.question.clone(), g.resolution.clone().unwrap_or_default()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::{MissionDispatch, MissionSpec, MissionTask};

    fn make_test_state() -> MissionState {
        MissionState {
            id: "msn_gates01".to_string(),
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
                title: "Schema Migration".to_string(),
                kind: "implement".to_string(),
                spec: "Migrate users table".to_string(),
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
        }
    }

    #[test]
    fn request_and_resolve_gate_flow() {
        let mut state = make_test_state();

        // 1. Worker requests gate
        let gate_id = request_gate(
            &mut state,
            "/tmp",
            "msn_gates01",
            "dsp_1",
            "Allow dropping column 'legacy_token'?".to_string(),
            vec!["allow".to_string(), "deny".to_string()],
        )
        .unwrap();

        assert_eq!(state.gates.len(), 1);
        assert_eq!(state.gates[0].id, gate_id);
        assert_eq!(state.gates[0].status, "pending");
        assert_eq!(state.tasks[0].status, "blocked");
        assert_eq!(state.tasks[0].gate_id, Some(gate_id.clone()));

        // 2. Operator resolves gate
        resolve_gate(
            &mut state,
            "/tmp",
            "msn_gates01",
            &gate_id,
            "allow",
            "human",
        )
        .unwrap();

        assert_eq!(state.gates[0].status, "resolved");
        assert_eq!(state.gates[0].resolution, Some("allow".to_string()));
        assert_eq!(state.tasks[0].status, "ready");
        assert_eq!(state.tasks[0].gate_id, None);

        // 3. Resolved gates replay list
        let resolved = get_resolved_gates_for_task(&state, "task_1");
        assert_eq!(resolved.len(), 1);
        assert_eq!(
            resolved[0],
            (
                "Allow dropping column 'legacy_token'?".to_string(),
                "allow".to_string()
            )
        );
    }
}
