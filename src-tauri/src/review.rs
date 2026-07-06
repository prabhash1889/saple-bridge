use std::fs;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};
use crate::project::{get_project_file_path, now_iso};
use crate::git::{git_status_inner, GitFileStatus};
use crate::process_ext::CommandNoWindow;

const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_VERIFICATION_OUTPUT_BYTES: usize = 800_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub task_id: String,
    pub session_id: String,
    pub title: String,
    pub status: String, // "pending", "approved", "rejected"
    pub provider: String,
    pub model: String,
    pub role: String,
    pub changed_files: Vec<GitFileStatus>,
    /// Paths the reviewer has marked as viewed. `default` keeps records written
    /// before this field existed deserializable.
    #[serde(default)]
    pub viewed_files: Vec<String>,
    pub test_output: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// Struct to deserialize sessions.json
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    task_id: Option<String>,
    provider: String,
    model: String,
    role: String,
    name: String,
    artifacts: Vec<SessionArtifact>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionArtifact {
    id: String,
    #[serde(rename = "type")]
    artifact_type: String,
    title: String,
    path: Option<String>,
    content: Option<String>,
}

// Struct to deserialize tasks.json
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    id: String,
    title: String,
    column: String,
    session_id: Option<String>,
}

fn create_review_record_inner(
    project_path: String,
    task_id: String,
    session_id: String,
) -> Result<ReviewRecord, String> {
    let review_dir = get_project_file_path(&project_path, ".saple/review")?;
    if !review_dir.exists() {
        fs::create_dir_all(&review_dir).map_err(|e| format!("Failed to create review dir: {}", e))?;
    }

    let review_file_path = get_project_file_path(&project_path, &format!(".saple/review/{}.json", task_id))?;

    // Try to load existing review
    if review_file_path.exists() {
        let content = fs::read_to_string(&review_file_path).map_err(|e| e.to_string())?;
        if let Ok(mut record) = serde_json::from_str::<ReviewRecord>(&content) {
            // Update files lists
            if let Ok(files) = git_status_inner(project_path.clone()) {
                record.changed_files = files;
            }
            record.updated_at = now_iso();
            let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
            crate::fs_lock::atomic_write(&review_file_path, json.as_bytes())?;
            return Ok(record);
        }
    }

    // Otherwise, create a new one
    // 1. Read task details from tasks.json
    let tasks_file = get_project_file_path(&project_path, ".saple/tasks.json")?;
    let mut title = format!("Review for task {}", task_id);
    if tasks_file.exists() {
        if let Ok(content) = fs::read_to_string(&tasks_file) {
            if let Ok(tasks) = serde_json::from_str::<Vec<TaskSummary>>(&content) {
                if let Some(task) = tasks.iter().find(|t| t.id == task_id) {
                    title = task.title.clone();
                }
            }
        }
    }

    // 2. Read session details from agents/sessions.json
    let sessions_file = get_project_file_path(&project_path, ".saple/agents/sessions.json")?;
    let mut provider = "codex".to_string();
    let mut model = "default".to_string();
    let mut role = "builder".to_string();
    let mut test_output = None;

    if sessions_file.exists() {
        if let Ok(content) = fs::read_to_string(&sessions_file) {
            if let Ok(sessions) = serde_json::from_str::<Vec<SessionSummary>>(&content) {
                if let Some(sess) = sessions.iter().find(|s| s.id == session_id) {
                    provider = sess.provider.clone();
                    model = sess.model.clone();
                    role = sess.role.clone();
                    
                    // Look for test_result artifact
                    if let Some(artifact) = sess.artifacts.iter().find(|a| a.artifact_type == "test_result") {
                        if let Some(ref content) = artifact.content {
                            test_output = Some(content.clone());
                        } else if let Some(ref path) = artifact.path {
                            // Read artifact file
                            if let Ok(full_art_path) = get_project_file_path(&project_path, path) {
                                if let Ok(content) = fs::read_to_string(full_art_path) {
                                    test_output = Some(content);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Get changed files
    let changed_files = git_status_inner(project_path.clone()).unwrap_or_default();
    
    let now = now_iso();
    let record = ReviewRecord {
        task_id,
        session_id,
        title,
        status: "pending".to_string(),
        provider,
        model,
        role,
        changed_files,
        viewed_files: Vec::new(),
        test_output,
        notes: None,
        created_at: now.clone(),
        updated_at: now,
    };

    let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    crate::fs_lock::atomic_write(&review_file_path, json.as_bytes())?;

    Ok(record)
}

fn read_review_record_inner(project_path: String, task_id: String) -> Result<ReviewRecord, String> {
    let review_file_path = get_project_file_path(&project_path, &format!(".saple/review/{}.json", task_id))?;
    if !review_file_path.exists() {
        return Err("Review record not found".to_string());
    }
    let content = fs::read_to_string(&review_file_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse review record: {}", e))
}

fn submit_review_decision_inner(
    project_path: String,
    task_id: String,
    decision: String, // "approve" or "reject"
    notes: Option<String>,
) -> Result<(), String> {
    // Reject anything that isn't an explicit approve/reject so a malformed `decision` can't be
    // treated as "reject" by the `else` branches below (which move the task back to progress and
    // fail the session).
    if decision != "approve" && decision != "reject" {
        return Err(format!(
            "Invalid review decision '{}': expected 'approve' or 'reject'",
            decision
        ));
    }

    // 1. Read and update the review record
    let review_file_path = get_project_file_path(&project_path, &format!(".saple/review/{}.json", task_id))?;
    if !review_file_path.exists() {
        return Err("Review record not found".to_string());
    }

    let record_content = fs::read_to_string(&review_file_path).map_err(|e| e.to_string())?;
    let mut record: ReviewRecord = serde_json::from_str(&record_content).map_err(|e| e.to_string())?;

    let session_id = record.session_id.clone();
    record.status = if decision == "approve" { "approved" } else { "rejected" }.to_string();
    record.notes = notes.clone();
    record.updated_at = now_iso();

    let record_json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    crate::fs_lock::atomic_write(&review_file_path, record_json.as_bytes())?;

    // 2. Update task in tasks.json
    let tasks_file = get_project_file_path(&project_path, ".saple/tasks.json")?;
    if tasks_file.exists() {
        let content = fs::read_to_string(&tasks_file).map_err(|e| e.to_string())?;
        if let Ok(mut tasks) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
            let next_column = if decision == "approve" { "done" } else { "progress" };
            let mut updated = false;
            for t in &mut tasks {
                if t.get("id").and_then(|id| id.as_str()) == Some(&task_id) {
                    t["column"] = serde_json::json!(next_column);
                    t["updatedAt"] = serde_json::json!(now_iso());
                    updated = true;
                }
            }
            if updated {
                let json = serde_json::to_string_pretty(&tasks).map_err(|e| e.to_string())?;
                crate::fs_lock::atomic_write(&tasks_file, json.as_bytes())?;
            }
        }
    }

    // 3. Update session in sessions.json
    let sessions_file = get_project_file_path(&project_path, ".saple/agents/sessions.json")?;
    if sessions_file.exists() {
        let content = fs::read_to_string(&sessions_file).map_err(|e| e.to_string())?;
        if let Ok(mut sessions) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
            let next_status = if decision == "approve" { "done" } else { "failed" };
            let mut updated = false;
            for s in &mut sessions {
                if s.get("id").and_then(|id| id.as_str()) == Some(&session_id) {
                    s["status"] = serde_json::json!(next_status);
                    s["updatedAt"] = serde_json::json!(now_iso());
                    if decision == "approve" {
                        s["completedAt"] = serde_json::json!(now_iso());
                    }
                    updated = true;
                }
            }
            if updated {
                let json = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
                crate::fs_lock::atomic_write(&sessions_file, json.as_bytes())?;
            }
        }
    }

    Ok(())
}

/// Run a shell command in `project_path`, capturing stdout/stderr, killing it after `timeout`.
/// Returns `(output, timed_out)`. On Windows this uses PowerShell (matching the interactive
/// terminal panes in `pty.rs`) rather than `cmd.exe`, so commands behave the same whether the
/// user types them or review verification issues them.
pub(crate) fn run_shell_with_timeout(
    project_path: &str,
    command_str: &str,
    timeout: Duration,
) -> Result<(Output, bool), String> {
    let mut child = if cfg!(target_os = "windows") {
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", command_str])
            .current_dir(project_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    } else {
        Command::new("sh")
            .args(["-c", command_str])
            .current_dir(project_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
    }.map_err(|e| format!("Failed to run command: {}", e))?;

    let started = Instant::now();
    // Adaptive backoff: poll quickly at first so fast verification commands return
    // promptly, then back off to avoid busy-spinning on long-running ones. Caps at 50ms.
    let mut backoff = Duration::from_millis(2);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return child.wait_with_output().map(|output| (output, false)).map_err(|e| e.to_string());
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            return Ok((output, true));
        }

        std::thread::sleep(backoff);
        if backoff < Duration::from_millis(50) {
            backoff = (backoff * 2).min(Duration::from_millis(50));
        }
    }
}

fn truncate_output(mut output: String) -> String {
    if output.len() > MAX_VERIFICATION_OUTPUT_BYTES {
        output.truncate(MAX_VERIFICATION_OUTPUT_BYTES);
        output.push_str("\n\n[Saple Bridge truncated verification output]\n");
    }
    output
}

/// TRUST BOUNDARY: `command_str` is executed verbatim in the operator's shell
/// (`run_shell_with_timeout`) within `project_path`. This is *intentional* — review verification
/// runs the user's own build/test commands (e.g. `npm test`, `cargo check`), so an allowlist would
/// break the core dev-tool use case. There is no sandbox here.
///
/// The contained risk: a malicious project could ship a tasks/review record whose suggested
/// verification command runs arbitrary code if the operator clicks "Run". Mitigations: the command
/// is operator-initiated (never auto-run), the working dir is the project, and execution is
/// time-boxed (`VERIFICATION_TIMEOUT`) with truncated output. The review UI surfaces the exact
/// command before it runs so the operator can inspect it — keep that affordance.
fn run_verification_command_inner(
    project_path: String,
    task_id: String,
    command_str: String,
) -> Result<String, String> {
    let (output, timed_out) = run_shell_with_timeout(&project_path, &command_str, VERIFICATION_TIMEOUT)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut combined = truncate_output(format!("{}\n{}", stdout, stderr));
    if timed_out {
        combined.push_str(&format!(
            "\n[ Saple Bridge stopped verification after {} seconds ]\n",
            VERIFICATION_TIMEOUT.as_secs()
        ));
    }

    // Update the review record with test output!
    let review_file_path = get_project_file_path(&project_path, &format!(".saple/review/{}.json", task_id))?;
    if review_file_path.exists() {
        if let Ok(content) = fs::read_to_string(&review_file_path) {
            if let Ok(mut record) = serde_json::from_str::<ReviewRecord>(&content) {
                record.test_output = Some(combined.clone());
                record.updated_at = now_iso();
                if let Ok(json) = serde_json::to_string_pretty(&record) {
                    let _ = crate::fs_lock::atomic_write(&review_file_path, json.as_bytes());
                }
            }
        }
    }

    Ok(combined)
}

/// Persist the reviewer's per-file viewed checkmark on the review record.
fn set_file_viewed_inner(
    project_path: String,
    task_id: String,
    file_path: String,
    viewed: bool,
) -> Result<(), String> {
    let review_file_path = get_project_file_path(&project_path, &format!(".saple/review/{}.json", task_id))?;
    if !review_file_path.exists() {
        return Err("Review record not found".to_string());
    }
    let content = fs::read_to_string(&review_file_path).map_err(|e| e.to_string())?;
    let mut record: ReviewRecord = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    record.viewed_files.retain(|p| p != &file_path);
    if viewed {
        record.viewed_files.push(file_path);
    }
    record.updated_at = now_iso();

    let json = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    crate::fs_lock::atomic_write(&review_file_path, json.as_bytes())
}

#[tauri::command]
pub async fn set_file_viewed(
    project_path: String,
    task_id: String,
    file_path: String,
    viewed: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_file_viewed_inner(project_path, task_id, file_path, viewed))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_review_record(
    project_path: String,
    task_id: String,
    session_id: String,
) -> Result<ReviewRecord, String> {
    tauri::async_runtime::spawn_blocking(move || create_review_record_inner(project_path, task_id, session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_review_record(project_path: String, task_id: String) -> Result<ReviewRecord, String> {
    tauri::async_runtime::spawn_blocking(move || read_review_record_inner(project_path, task_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn submit_review_decision(
    project_path: String,
    task_id: String,
    decision: String,
    notes: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || submit_review_decision_inner(project_path, task_id, decision, notes))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_verification_command(
    project_path: String,
    task_id: String,
    command_str: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_verification_command_inner(project_path, task_id, command_str))
        .await
        .map_err(|e| e.to_string())?
}
