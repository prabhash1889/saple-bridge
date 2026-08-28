//! Scheduler core for Missions (Phase M3).
//!
//! Owns DAG task readiness promotion, gate re-blocking, concurrency caps,
//! burst guard (one dispatch per tick), and mission terminal state determination.

use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};

use super::{liveness, record_event, MissionState};

/// Outcome of running a single scheduler tick over a mission's state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerTickOutcome {
    pub promoted_task_ids: Vec<String>,
    pub blocked_task_ids: Vec<String>,
    pub next_task_to_dispatch: Option<String>,
    pub terminal_status: Option<String>,
}

/// Promote pending tasks whose dependencies have all reached `completed`.
/// Transitions them `pending -> ready` and records `task_ready` events.
pub fn promote_ready_tasks(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
) -> Result<Vec<String>, String> {
    let completed_ids: HashSet<String> = state
        .tasks
        .iter()
        .filter(|t| t.status == "completed")
        .map(|t| t.id.clone())
        .collect();

    let mut promoted = Vec::new();

    for task in &mut state.tasks {
        if task.status == "pending" && task.deps.iter().all(|dep| completed_ids.contains(dep)) {
            task.status = "ready".to_string();
            promoted.push(task.id.clone());
        }
    }

    for task_id in &promoted {
        record_event(
            project_path,
            mission_id,
            state,
            "task_ready",
            serde_json::json!({ "taskId": task_id }),
        )?;
    }

    Ok(promoted)
}

/// Tasks with pending gates must stay blocked until the gate is resolved.
/// Reblocks any ready or pending tasks that have unresolved gates.
pub fn reblock_tasks_with_pending_gates(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
) -> Result<Vec<String>, String> {
    let pending_gate_task_ids: HashSet<String> = state
        .gates
        .iter()
        .filter(|g| g.status == "pending")
        .map(|g| g.task_id.clone())
        .collect();

    let mut blocked = Vec::new();

    for task in &mut state.tasks {
        if pending_gate_task_ids.contains(&task.id) && task.status != "blocked" && task.status != "completed" {
            task.status = "blocked".to_string();
            blocked.push(task.id.clone());
        }
    }

    for task_id in &blocked {
        record_event(
            project_path,
            mission_id,
            state,
            "task_blocked_by_gate",
            serde_json::json!({ "taskId": task_id }),
        )?;
    }

    Ok(blocked)
}

/// Deadlock & terminal failure propagation:
/// If a dependency is in a terminal non-completed state (`circuit_broken`, `failed`),
/// dependent tasks can never be satisfied, so mark them `blocked`.
pub fn propagate_deadlocks(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
) -> Result<Vec<String>, String> {
    let dead_task_ids: HashSet<String> = state
        .tasks
        .iter()
        .filter(|t| t.status == "circuit_broken" || (t.status == "failed" && !has_active_dispatch(state, &t.id)))
        .map(|t| t.id.clone())
        .collect();

    let mut deadlocked = Vec::new();

    for task in &mut state.tasks {
        if (task.status == "pending" || task.status == "ready")
            && task.deps.iter().any(|dep| dead_task_ids.contains(dep))
        {
            task.status = "blocked".to_string();
            deadlocked.push(task.id.clone());
        }
    }

    for task_id in &deadlocked {
        record_event(
            project_path,
            mission_id,
            state,
            "task_deadlocked",
            serde_json::json!({ "taskId": task_id }),
        )?;
    }

    Ok(deadlocked)
}

fn has_active_dispatch(state: &MissionState, task_id: &str) -> bool {
    state.dispatches.iter().any(|d| {
        d.task_id == task_id && (d.status == "starting" || d.status == "running" || d.status == "pending")
    })
}

/// Select at most ONE ready task to dispatch (Orca's burst guard).
/// Respects `max_parallel` and per-provider concurrency limits.
pub fn select_next_dispatchable_task(
    state: &MissionState,
    per_provider_caps: &HashMap<String, usize>,
) -> Option<String> {
    if state.status != "running" {
        return None;
    }

    // Count currently running/starting dispatches
    let running_count = state
        .dispatches
        .iter()
        .filter(|d| d.status == "running" || d.status == "starting")
        .count();

    let max_parallel = (state.spec.max_parallel as usize).clamp(1, 8);
    if running_count >= max_parallel {
        return None;
    }

    // Provider usage counts
    let mut provider_usage: HashMap<String, usize> = HashMap::new();
    for d in state.dispatches.iter().filter(|d| d.status == "running" || d.status == "starting") {
        *provider_usage.entry(d.provider.clone()).or_insert(0) += 1;
    }

    let default_provider = state
        .spec
        .coordinator
        .as_ref()
        .map(|c| c.provider.clone())
        .unwrap_or_else(|| "codex".to_string());

    // Pick FIFO from ready tasks
    for task in &state.tasks {
        if task.status == "ready" {
            // Check provider cap
            let provider = &default_provider;
            let current = provider_usage.get(provider).copied().unwrap_or(0);
            let cap = per_provider_caps.get(provider).copied().unwrap_or(4);
            if current < cap {
                return Some(task.id.clone());
            }
        }
    }

    None
}

/// Check if the mission has reached a terminal status (`completed` or `failed`).
/// If terminal, releases all pool entries and records completion/failure events.
pub fn evaluate_mission_terminal_status(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
) -> Result<Option<String>, String> {
    if state.status != "running" {
        return Ok(None);
    }

    if state.tasks.is_empty() {
        return Ok(None);
    }

    let all_completed = state.tasks.iter().all(|t| t.status == "completed");
    if all_completed {
        state.status = "completed".to_string();
        for entry in &mut state.pool {
            entry.state = "released".to_string();
        }
        record_event(
            project_path,
            mission_id,
            state,
            "mission_completed",
            serde_json::json!({}),
        )?;
        return Ok(Some("completed".to_string()));
    }

    let active_dispatches = state
        .dispatches
        .iter()
        .filter(|d| d.status == "running" || d.status == "starting" || d.status == "pending")
        .count();

    let has_ready = state.tasks.iter().any(|t| t.status == "ready");

    // If no active dispatches, no ready tasks, and not all completed -> mission failed
    if active_dispatches == 0 && !has_ready {
        state.status = "failed".to_string();
        for entry in &mut state.pool {
            entry.state = "released".to_string();
        }
        record_event(
            project_path,
            mission_id,
            state,
            "mission_failed",
            serde_json::json!({
                "reason": "All runnable tasks exhausted without full completion",
            }),
        )?;
        return Ok(Some("failed".to_string()));
    }

    Ok(None)
}

/// Execute a full scheduler cycle on the given mission state.
pub fn scheduler_tick(
    state: &mut MissionState,
    project_path: &str,
    mission_id: &str,
    per_provider_caps: &HashMap<String, usize>,
) -> Result<SchedulerTickOutcome, String> {
    let _ = liveness::evaluate_dispatch_leases(
        state,
        project_path,
        mission_id,
        &crate::project::now_iso(),
        liveness::DEFAULT_LEASE_DURATION_SECS,
    );

    let promoted = promote_ready_tasks(state, project_path, mission_id)?;
    let blocked = reblock_tasks_with_pending_gates(state, project_path, mission_id)?;
    let deadlocked = propagate_deadlocks(state, project_path, mission_id)?;
    let mut all_blocked = blocked;
    all_blocked.extend(deadlocked);

    let terminal = evaluate_mission_terminal_status(state, project_path, mission_id)?;
    let next_task = if terminal.is_none() {
        select_next_dispatchable_task(state, per_provider_caps)
    } else {
        None
    };

    Ok(SchedulerTickOutcome {
        promoted_task_ids: promoted,
        blocked_task_ids: all_blocked,
        next_task_to_dispatch: next_task,
        terminal_status: terminal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::missions::{MissionSpec, MissionTask, MissionGate};

    fn make_test_state() -> MissionState {
        MissionState {
            id: "msn_test01".to_string(),
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
            tasks: vec![
                MissionTask {
                    id: "task_1".to_string(),
                    title: "T1".to_string(),
                    kind: "implement".to_string(),
                    spec: "s".to_string(),
                    deps: vec![],
                    fanout: 1,
                    allow_stale_base: false,
                    status: "ready".to_string(),
                    result: None,
                    gate_id: None,
                },
                MissionTask {
                    id: "task_2".to_string(),
                    title: "T2".to_string(),
                    kind: "implement".to_string(),
                    spec: "s".to_string(),
                    deps: vec!["task_1".to_string()],
                    fanout: 1,
                    allow_stale_base: false,
                    status: "pending".to_string(),
                    result: None,
                    gate_id: None,
                },
                MissionTask {
                    id: "task_3".to_string(),
                    title: "T3".to_string(),
                    kind: "verify".to_string(),
                    spec: "s".to_string(),
                    deps: vec!["task_2".to_string()],
                    fanout: 1,
                    allow_stale_base: false,
                    status: "pending".to_string(),
                    result: None,
                    gate_id: None,
                },
            ],
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
    fn readiness_promotion_cascades_on_task_completion() {
        let mut state = make_test_state();
        let caps = HashMap::new();

        // Initially T1 is ready, T2 and T3 are pending
        let tick1 = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        assert_eq!(tick1.next_task_to_dispatch, Some("task_1".to_string()));
        assert_eq!(state.tasks[1].status, "pending");

        // Complete T1
        state.tasks[0].status = "completed".to_string();
        let tick2 = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        assert_eq!(tick2.promoted_task_ids, vec!["task_2".to_string()]);
        assert_eq!(state.tasks[1].status, "ready");
        assert_eq!(state.tasks[2].status, "pending");
        assert_eq!(tick2.next_task_to_dispatch, Some("task_2".to_string()));

        // Complete T2 -> T3 becomes ready
        state.tasks[1].status = "completed".to_string();
        let tick3 = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        assert_eq!(tick3.promoted_task_ids, vec!["task_3".to_string()]);
        assert_eq!(state.tasks[2].status, "ready");

        // Complete T3 -> mission completed!
        state.tasks[2].status = "completed".to_string();
        let tick4 = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        assert_eq!(tick4.terminal_status, Some("completed".to_string()));
        assert_eq!(state.status, "completed");
    }

    #[test]
    fn gate_reblocking_blocks_task() {
        let mut state = make_test_state();
        state.gates.push(MissionGate {
            id: "gate_1".to_string(),
            task_id: "task_1".to_string(),
            question: "Approve migration?".to_string(),
            options: vec!["yes".to_string(), "no".to_string()],
            status: "pending".to_string(),
            resolution: None,
        });

        let caps = HashMap::new();
        let tick = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        assert_eq!(state.tasks[0].status, "blocked");
        assert_eq!(tick.blocked_task_ids, vec!["task_1".to_string()]);
        // Since T1 is blocked, no task can be dispatched
        assert_eq!(tick.next_task_to_dispatch, None);
    }

    #[test]
    fn burst_guard_returns_one_task_per_tick() {
        let mut state = make_test_state();
        // Make both T1 and T2 ready
        state.tasks[1].deps.clear();
        state.tasks[1].status = "ready".to_string();

        let caps = HashMap::new();
        let tick = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        // Even though both are ready, only T1 is picked this tick (burst guard)
        assert_eq!(tick.next_task_to_dispatch, Some("task_1".to_string()));
    }

    #[test]
    fn circuit_breaker_failure_blocks_dependents_and_fails_mission() {
        let mut state = make_test_state();
        // T1 circuit breaks
        state.tasks[0].status = "circuit_broken".to_string();

        let caps = HashMap::new();
        let tick = scheduler_tick(&mut state, "/tmp", "msn_test01", &caps).unwrap();
        // T2 is blocked by T1's circuit_broken state
        assert_eq!(state.tasks[1].status, "blocked");
        // Mission terminates as failed because no work can proceed
        assert_eq!(tick.terminal_status, Some("failed".to_string()));
        assert_eq!(state.status, "failed");
    }
}
