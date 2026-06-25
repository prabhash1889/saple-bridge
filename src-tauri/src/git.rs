use std::process::{Command, Output, Stdio};
use std::fs;
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};
use crate::project::get_project_file_path;
use crate::process_ext::CommandNoWindow;

const GIT_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_STATUS_FILES: usize = 500;
const MAX_DIFF_BYTES: usize = 600_000;
const MAX_UNTRACKED_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "untracked"
    pub insertions: Option<usize>,
    pub deletions: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSummary {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub total_insertions: usize,
    pub total_deletions: usize,
}

fn run_git_with_timeout(project_path: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))?;

    let started = Instant::now();
    // Adaptive backoff: poll quickly at first so fast git commands (the common case)
    // return with sub-millisecond latency, then back off to avoid busy-spinning on
    // long-running commands. Caps at 25ms.
    let mut backoff = Duration::from_millis(1);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return child.wait_with_output().map_err(|e| e.to_string());
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("git {} timed out after {}s", args.join(" "), timeout.as_secs()));
        }

        std::thread::sleep(backoff);
        if backoff < Duration::from_millis(25) {
            backoff = (backoff * 2).min(Duration::from_millis(25));
        }
    }
}

pub fn git_status_inner(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    // Run git status --porcelain
    let output = run_git_with_timeout(&project_path, &["status", "--porcelain"], GIT_TIMEOUT)?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout_str.lines().take(MAX_STATUS_FILES) {
        if line.len() < 4 {
            continue;
        }
        let (status_chars, file_path_raw) = line.split_at(3);
        let file_path = file_path_raw.trim().to_string();
        
        // Git rename shows as "R  old -> new", parse it
        let file_path = if status_chars.contains('R') {
            if let Some(pos) = file_path.find(" -> ") {
                file_path[pos + 4..].to_string()
            } else {
                file_path
            }
        } else {
            file_path
        };

        let status = if status_chars.starts_with("??") {
            "untracked".to_string()
        } else if status_chars.contains('A') {
            "added".to_string()
        } else if status_chars.contains('D') {
            "deleted".to_string()
        } else {
            "modified".to_string()
        };

        files.push(GitFileStatus {
            path: file_path,
            status,
            insertions: None,
            deletions: None,
        });
    }

    // Enrich with insertions/deletions if possible
    // git diff HEAD --numstat
    let numstat_output = run_git_with_timeout(&project_path, &["diff", "HEAD", "--numstat"], GIT_TIMEOUT);

    if let Ok(out) = numstat_output {
        if out.status.success() {
            let numstat_str = String::from_utf8_lossy(&out.stdout);
            for line in numstat_str.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let ins_str = parts[0];
                    let del_str = parts[1];
                    let path = parts[2..].join(" ");
                    
                    let insertions = ins_str.parse::<usize>().ok();
                    let deletions = del_str.parse::<usize>().ok();

                    if let Some(file) = files.iter_mut().find(|f| f.path == path) {
                        file.insertions = insertions;
                        file.deletions = deletions;
                    }
                }
            }
        }
    }

    // Enrich untracked files line count as insertions
    for file in &mut files {
        if file.status == "untracked" {
            if let Ok(full_path) = get_project_file_path(&project_path, &file.path) {
                if full_path.metadata().map(|meta| meta.len() > MAX_UNTRACKED_BYTES).unwrap_or(true) {
                    file.insertions = Some(0);
                    file.deletions = Some(0);
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&full_path) {
                    let lines_count = content.lines().count();
                    file.insertions = Some(lines_count);
                    file.deletions = Some(0);
                }
            }
        }
    }

    Ok(files)
}

pub fn git_diff_summary_inner(project_path: String) -> Result<GitDiffSummary, String> {
    let branch_output = run_git_with_timeout(&project_path, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT);
    
    let branch = if let Ok(out) = branch_output {
        if out.status.success() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            "unknown".to_string()
        }
    } else {
        "unknown".to_string()
    };

    let files = git_status_inner(project_path)?;
    let mut total_insertions = 0;
    let mut total_deletions = 0;

    for f in &files {
        total_insertions += f.insertions.unwrap_or(0);
        total_deletions += f.deletions.unwrap_or(0);
    }

    Ok(GitDiffSummary {
        branch,
        files,
        total_insertions,
        total_deletions,
    })
}

pub fn git_diff_file_inner(project_path: String, file_path: String) -> Result<String, String> {
    // Validate path containment first
    let full_path = get_project_file_path(&project_path, &file_path)?;

    // Check if it's untracked
    let status_output = run_git_with_timeout(&project_path, &["status", "--porcelain", &file_path], GIT_TIMEOUT);

    let is_untracked = if let Ok(out) = status_output {
        let stdout_str = String::from_utf8_lossy(&out.stdout);
        stdout_str.starts_with("??")
    } else {
        false
    };

    if is_untracked {
        if full_path.metadata().map(|meta| meta.len() > MAX_UNTRACKED_BYTES).unwrap_or(false) {
            return Ok(format!(
                "--- /dev/null\n+++ b/{}\n@@ file omitted: untracked file is larger than {} bytes @@\n",
                file_path, MAX_UNTRACKED_BYTES
            ));
        }

        if let Ok(content) = fs::read_to_string(&full_path) {
            let mut diff = String::new();
            diff.push_str(&format!("--- /dev/null\n+++ b/{}\n", file_path));
            let lines: Vec<&str> = content.lines().collect();
            diff.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
            for line in lines {
                diff.push_str(&format!("+{}\n", line));
                if diff.len() >= MAX_DIFF_BYTES {
                    diff.push_str("\n@@ diff truncated by Saple Bridge @@\n");
                    break;
                }
            }
            return Ok(diff);
        }
    }

    let output = run_git_with_timeout(&project_path, &["diff", "HEAD", "--", &file_path], GIT_TIMEOUT)?;

    if output.status.success() {
        let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
        if diff.len() > MAX_DIFF_BYTES {
            diff.truncate(MAX_DIFF_BYTES);
            diff.push_str("\n@@ diff truncated by Saple Bridge @@\n");
        }
        Ok(diff)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_summary(project_path: String) -> Result<GitDiffSummary, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_summary_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_file(project_path: String, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}
