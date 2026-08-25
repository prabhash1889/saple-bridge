use std::fs;
use std::sync::Arc;
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};
use crate::project_roots::ProjectRootRegistry;

// Mirrors the frontend SwarmAgent for `validate_dependency_graph`. The TS
// SwarmAgent carries extra fields (provider, autoApprove) that serde silently
// drops here because cycle detection only reads `id`/`dependencies`. If a future
// Rust path needs one of those fields, add it here (with #[serde(default)]).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwarmAgentRust {
    pub id: String,
    pub name: String,
    pub role: String,
    pub model: String,
    pub system_prompt: String,
    pub dependencies: Vec<String>,
    pub status: String,
    pub task_id: Option<String>,
    pub terminal_id: Option<String>,
}

#[tauri::command]
pub async fn read_swarm_state(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<crate::state_load::StateLoadResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    // Structured outcome (Phase 2): missing vs corrupt vs locked are distinct, and a corrupt
    // state.json preserves its bytes + blocks writes until recovery.
    tauri::async_runtime::spawn_blocking(move || {
        crate::state_load::load_state_inner(&project_path, ".saple/swarm/state.json")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_swarm_state(
    project_path: String,
    state_json: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || write_swarm_state_inner(project_path, state_json))
        .await
        .map_err(|e| e.to_string())?
}

fn write_swarm_state_inner(project_path: String, state_json: String) -> Result<(), String> {
    let path = crate::project_roots::get_project_file_path(&project_path, ".saple/swarm/state.json")?;
    crate::fs_lock::atomic_write(&path, state_json.as_bytes())
}

#[tauri::command]
pub async fn read_mailbox_file(
    project_path: String,
    agent_id: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || read_mailbox_file_inner(project_path, agent_id))
        .await
        .map_err(|e| e.to_string())?
}

fn read_mailbox_file_inner(project_path: String, agent_id: String) -> Result<String, String> {
    let file_name = format!(".saple/swarm/mailbox/{}.md", agent_id);
    let path = crate::project_roots::get_project_file_path(&project_path, &file_name)?;
    if !path.exists() {
        return Ok(format!("# {} Mailbox\nNo messages yet.\n", agent_id));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_mailbox_file(
    project_path: String,
    agent_id: String,
    content: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || write_mailbox_file_inner(project_path, agent_id, content))
        .await
        .map_err(|e| e.to_string())?
}

fn write_mailbox_file_inner(project_path: String, agent_id: String, content: String) -> Result<(), String> {
    let file_name = format!(".saple/swarm/mailbox/{}.md", agent_id);
    let path = crate::project_roots::get_project_file_path(&project_path, &file_name)?;
    crate::fs_lock::atomic_write(&path, content.as_bytes())
}

#[tauri::command]
pub async fn read_handoff_file(
    project_path: String,
    from_agent: String,
    to_agent: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || read_handoff_file_inner(project_path, from_agent, to_agent))
        .await
        .map_err(|e| e.to_string())?
}

fn read_handoff_file_inner(project_path: String, from_agent: String, to_agent: String) -> Result<String, String> {
    let file_name = format!(".saple/swarm/handoffs/{}-to-{}.json", from_agent, to_agent);
    let path = crate::project_roots::get_project_file_path(&project_path, &file_name)?;
    if !path.exists() {
        return Err("Handoff file not found".to_string());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_handoff_file(
    project_path: String,
    from_agent: String,
    to_agent: String,
    content: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || write_handoff_file_inner(project_path, from_agent, to_agent, content))
        .await
        .map_err(|e| e.to_string())?
}

fn write_handoff_file_inner(project_path: String, from_agent: String, to_agent: String, content: String) -> Result<(), String> {
    let file_name = format!(".saple/swarm/handoffs/{}-to-{}.json", from_agent, to_agent);
    let path = crate::project_roots::get_project_file_path(&project_path, &file_name)?;
    crate::fs_lock::atomic_write(&path, content.as_bytes())
}

/// Phase 5 acceptance runner result. `exit_code` is `None` when the command timed out or was
/// killed by a signal - the frontend treats anything but `Some(0)` as a failure.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
}

/// Acceptance verifies the whole mission (full test suite / build), so it gets a longer leash
/// than the 90s per-task review verification.
const ACCEPTANCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

// T2 approval gate: SHA-256 over the command's UTF-8 bytes, lowercase hex. Mirrors
// `hashAcceptanceCommand` in src/stores/swarmStore.ts exactly - the frontend may only call this
// runner with the hash a human approved, and re-deriving it here binds that approval to these
// exact bytes (a mismatched hash is an unapproved invocation). SHA-256 is required, not a
// cheaper digest: agent-authored plans are adversarial input, so the binding must not be
// defeatable by crafting a colliding command after approval.
fn acceptance_command_hash(command: &str) -> String {
    let digest = Sha256::digest(command.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

/// TRUST BOUNDARY: `command_str` comes from the agent-written `plan.json` acceptance contract and
/// runs verbatim in the operator's shell inside `project_path` (same runner as review
/// verification). This grants the swarm no capability it doesn't already have - its agents hold
/// interactive shells in the same directory - and the mitigations mirror review verification:
/// project cwd, hard timeout, truncated output. Bridge executes it precisely so `completed` is
/// never an agent's self-reported claim. T2 additionally requires `command_hash` to be the hash
/// of a command a human explicitly approved for this swarm run; anything else is rejected before
/// a shell is ever spawned.
#[tauri::command]
pub async fn run_acceptance_command(
    project_path: String,
    command_str: String,
    command_hash: String,
    cancel_token: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<AcceptanceResult, String> {
    // An approved command must also run in an approved root: hash approval binds the
    // command bytes, this gate binds the execution directory.
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_acceptance_command_inner(project_path, command_str, command_hash, cancel_token)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_acceptance_command_inner(
    project_path: String,
    command_str: String,
    command_hash: String,
    cancel_token: Option<String>,
) -> Result<AcceptanceResult, String> {
    if acceptance_command_hash(&command_str) != command_hash {
        return Err(
            "Acceptance command hash does not match an approved command - execution refused."
                .to_string(),
        );
    }
    // A renderer-supplied token makes this run cancellable from the Swarm room; removed from
    // the registry afterwards so a stale cancel can never kill a later acceptance run.
    let cancel = cancel_token.as_deref().map(crate::review::register_cancel_token);
    let result =
        crate::review::run_shell_with_timeout("swarm", &project_path, &command_str, ACCEPTANCE_TIMEOUT, cancel);
    crate::review::take_cancel_token(cancel_token.as_deref().unwrap_or(""));
    let (output, stop) = result?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut combined = crate::review::truncate_output(format!("{}\n{}", stdout, stderr));
    let timed_out = stop != crate::review::ShellStop::Completed;
    match stop {
        crate::review::ShellStop::TimedOut => {
            combined.push_str(&format!(
                "\n[ Saple Bridge stopped acceptance after {} seconds ]\n",
                ACCEPTANCE_TIMEOUT.as_secs()
            ));
        }
        crate::review::ShellStop::Cancelled => {
            combined.push_str("\n[ Saple Bridge: acceptance cancelled by operator ]\n");
        }
        crate::review::ShellStop::Completed => {}
    }
    // A stopped/cancelled child was killed; its exit status is the kill, not the command's verdict.
    let exit_code = if timed_out { None } else { output.status.code() };
    Ok(AcceptanceResult { exit_code, output: combined, timed_out })
}

#[tauri::command]
pub async fn validate_dependency_graph(agents: Vec<SwarmAgentRust>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || validate_dependency_graph_inner(agents))
        .await
        .map_err(|e| e.to_string())?
}

fn validate_dependency_graph_inner(agents: Vec<SwarmAgentRust>) -> Result<bool, String> {
    use std::collections::HashMap;

    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for agent in &agents {
        adj.insert(agent.id.clone(), agent.dependencies.clone());
    }
    
    let mut visited = HashMap::new();
    for agent in &agents {
        visited.insert(agent.id.clone(), 0);
    }
    
    fn has_cycle(
        node: &str,
        adj: &HashMap<String, Vec<String>>,
        visited: &mut HashMap<String, i32>
    ) -> bool {
        visited.insert(node.to_string(), 1);
        
        if let Some(neighbors) = adj.get(node) {
            for neighbor in neighbors {
                let state = visited.get(neighbor).cloned().unwrap_or(0);
                // state 1 = on the current DFS path (back-edge → cycle); state 0 = unvisited,
                // so recurse and propagate a cycle found deeper.
                if state == 1 || (state == 0 && has_cycle(neighbor, adj, visited)) {
                    return true;
                }
            }
        }
        
        visited.insert(node.to_string(), 2);
        false
    }
    
    for agent in &agents {
        let state = visited.get(&agent.id).cloned().unwrap_or(0);
        if state == 0
            && has_cycle(&agent.id, &adj, &mut visited) {
                return Ok(false);
            }
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, deps: &[&str]) -> SwarmAgentRust {
        SwarmAgentRust {
            id: id.into(),
            name: id.into(),
            role: "builder".into(),
            model: "default".into(),
            system_prompt: String::new(),
            dependencies: deps.iter().map(|d| d.to_string()).collect(),
            status: "idle".into(),
            task_id: None,
            terminal_id: None,
        }
    }

    #[test]
    fn acceptance_reports_real_exit_codes() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let pass = run_acceptance_command_inner(dir.clone(), "exit 0".into(), acceptance_command_hash("exit 0"), None).unwrap();
        assert_eq!(pass.exit_code, Some(0));
        assert!(!pass.timed_out);

        let fail = run_acceptance_command_inner(dir, "exit 3".into(), acceptance_command_hash("exit 3"), None).unwrap();
        assert_eq!(fail.exit_code, Some(3));
        assert!(!fail.timed_out);
    }

    #[test]
    fn acceptance_captures_command_output() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let result = run_acceptance_command_inner(
            dir,
            "echo acceptance-ran".into(),
            acceptance_command_hash("echo acceptance-ran"),
            None,
        )
        .unwrap();
        assert!(result.output.contains("acceptance-ran"));
    }

    #[test]
    fn unapproved_hash_refuses_execution() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let err =
            run_acceptance_command_inner(dir, "exit 0".into(), "deadbeefdeadbeef".into(), None).unwrap_err();
        assert!(err.contains("refused"));
    }

    #[test]
    fn command_hash_matches_frontend_implementation() {
        // Golden SHA-256 vectors shared with the TS `hashAcceptanceCommand`.
        assert_eq!(
            acceptance_command_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            acceptance_command_hash("a"),
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
        );
        assert_eq!(acceptance_command_hash("npm test"), acceptance_command_hash("npm test"));
        assert_ne!(acceptance_command_hash("npm test"), acceptance_command_hash("npm run test"));
    }

    #[test]
    fn acyclic_graph_is_valid() {
        let agents = vec![agent("a", &[]), agent("b", &["a"]), agent("c", &["a", "b"])];
        assert_eq!(validate_dependency_graph_inner(agents), Ok(true));
    }

    #[test]
    fn direct_cycle_is_invalid() {
        let agents = vec![agent("a", &["b"]), agent("b", &["a"])];
        assert_eq!(validate_dependency_graph_inner(agents), Ok(false));
    }

    #[test]
    fn self_dependency_is_invalid() {
        assert_eq!(
            validate_dependency_graph_inner(vec![agent("a", &["a"])]),
            Ok(false)
        );
    }

    #[test]
    fn longer_cycle_behind_a_valid_prefix_is_invalid() {
        let agents = vec![
            agent("root", &[]),
            agent("a", &["root", "c"]),
            agent("b", &["a"]),
            agent("c", &["b"]),
        ];
        assert_eq!(validate_dependency_graph_inner(agents), Ok(false));
    }

    #[test]
    fn dependency_on_unknown_agent_is_not_a_cycle() {
        assert_eq!(
            validate_dependency_graph_inner(vec![agent("a", &["ghost"])]),
            Ok(true)
        );
    }

    #[test]
    fn empty_roster_is_valid() {
        assert_eq!(validate_dependency_graph_inner(vec![]), Ok(true));
    }
}
