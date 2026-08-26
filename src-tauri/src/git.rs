use std::collections::HashMap;
use std::process::{Command, Output, Stdio};
use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};
use crate::project_roots::get_project_file_path;
use crate::process_ext::CommandNoWindow;
use crate::project_roots::ProjectRootRegistry;

const GIT_TIMEOUT: Duration = Duration::from_secs(12);
// Network round-trips (fetch/pull/push) legitimately take far longer than local
// porcelain; a 12s cap would abort healthy pushes over slow links.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(120);
const CHECKPOINT_REF_PREFIX: &str = "refs/saple/checkpoints/";
const MAX_STATUS_FILES: usize = 500;
const MAX_DIFF_BYTES: usize = 600_000;
const MAX_UNTRACKED_BYTES: u64 = 1_000_000;
// Untracked enrichment reads every candidate file to count lines. Cap both the number of
// files enriched and the total bytes read so a huge untracked tree cannot stall status.
const MAX_UNTRACKED_ENRICHED_FILES: usize = 50;
const MAX_UNTRACKED_ENRICHED_TOTAL_BYTES: u64 = 4_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "untracked"
    pub insertions: Option<usize>,
    pub deletions: Option<usize>,
    // Whether the index (X of porcelain XY) holds this file — i.e. `git add` has been run.
    // `default` keeps review records written before this field existed deserializable.
    #[serde(default)]
    pub staged: bool,
}

/// Extract the destination path from a porcelain rename status field.
///
/// `git status --porcelain` (v1) emits renames as "ORIG -> DEST". Some tooling
/// surfaces the two paths tab-separated instead; handle that as a fallback. In
/// both encodings the destination is the trailing path, which is what the
/// downstream `git diff HEAD -- <path>` needs to resolve.
fn parse_rename_dest(field: &str) -> String {
    if let Some(pos) = field.find(" -> ") {
        field[pos + 4..].trim().to_string()
    } else if let Some(pos) = field.rfind('\t') {
        field[pos + 1..].trim().to_string()
    } else {
        field.trim().to_string()
    }
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

        // Git renames show the destination path so the downstream `git diff` resolves.
        let file_path = if status_chars.contains('R') {
            parse_rename_dest(&file_path)
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

        let index_char = status_chars.chars().next().unwrap_or(' ');
        let staged = index_char != ' ' && index_char != '?';

        files.push(GitFileStatus {
            path: file_path,
            status,
            insertions: None,
            deletions: None,
            staged,
        });
    }

    // Enrich with insertions/deletions if possible
    // git diff HEAD --numstat
    let numstat_output = run_git_with_timeout(&project_path, &["diff", "HEAD", "--numstat"], GIT_TIMEOUT);

    if let Ok(out) = numstat_output {
        if out.status.success() {
            let numstat_str = String::from_utf8_lossy(&out.stdout);
            // Path index over the status list: numstat lookup becomes O(1) per line
            // instead of a linear scan of the whole file list.
            let mut path_index: HashMap<String, usize> = HashMap::with_capacity(files.len());
            for (i, f) in files.iter().enumerate() {
                path_index.entry(f.path.clone()).or_insert(i);
            }
            for line in numstat_str.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let ins_str = parts[0];
                    let del_str = parts[1];
                    let path = parts[2..].join(" ");

                    let insertions = ins_str.parse::<usize>().ok();
                    let deletions = del_str.parse::<usize>().ok();

                    if let Some(&i) = path_index.get(path.as_str()) {
                        files[i].insertions = insertions;
                        files[i].deletions = deletions;
                    }
                }
            }
        }
    }

    enrich_untracked_files(
        &mut files,
        &project_path,
        MAX_UNTRACKED_ENRICHED_FILES,
        MAX_UNTRACKED_ENRICHED_TOTAL_BYTES,
    );

    Ok(files)
}

/// Fill in line counts for untracked files, bounded by `max_files` entries and
/// `max_total_bytes` read. Files beyond either cap keep their un-enriched values;
/// individual oversized files are reported with zero lines without being read.
fn enrich_untracked_files(
    files: &mut [GitFileStatus],
    project_path: &str,
    max_files: usize,
    max_total_bytes: u64,
) {
    let mut enriched = 0usize;
    let mut total_bytes = 0u64;
    for file in files.iter_mut() {
        if file.status != "untracked" {
            continue;
        }
        if enriched >= max_files || total_bytes >= max_total_bytes {
            break;
        }
        if let Ok(full_path) = get_project_file_path(project_path, &file.path) {
            match full_path.metadata() {
                Ok(meta) => {
                    if meta.len() > MAX_UNTRACKED_BYTES {
                        // Individually oversized: report zero lines without a read.
                        file.insertions = Some(0);
                        file.deletions = Some(0);
                    } else if total_bytes + meta.len() > max_total_bytes {
                        // Aggregate budget exhausted: leave the rest un-enriched.
                        break;
                    } else if let Ok(content) = fs::read_to_string(&full_path) {
                        file.insertions = Some(content.lines().count());
                        file.deletions = Some(0);
                        enriched += 1;
                        total_bytes += meta.len();
                    }
                }
                Err(_) => {
                    file.insertions = Some(0);
                    file.deletions = Some(0);
                }
            }
        }
    }
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

/// Captured identity of the repository state a review certified (Phase 3). A review approval
/// must identify exactly what was reviewed: the HEAD commit it sat on, when that commit was made,
/// and a digest over the full working-tree/index status at capture time. Any later change to the
/// HEAD or to the staged/unstaged set produces a different identity, so stale approvals are
/// refused instead of certifying unseen work.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitTreeIdentity {
    /// Current HEAD commit id, or `null` on a repo with no commits yet.
    pub head_commit: Option<String>,
    /// Committer timestamp of HEAD (ISO-8601), or `null` with no HEAD.
    pub committed_at: Option<String>,
    /// SHA-256 hex over `git status --porcelain` output - the staged plus unstaged change set.
    pub status_hash: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

pub fn git_tree_identity_inner(project_path: String) -> Result<GitTreeIdentity, String> {
    // HEAD: absent on a fresh repo before the first commit - that is a legitimate state, not an
    // error, so both probes degrade to `None` instead of failing the capture.
    let head_output = run_git_with_timeout(
        &project_path,
        &["rev-parse", "HEAD"],
        GIT_TIMEOUT,
    );
    let head_commit = match head_output {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        _ => None,
    };
    let committed_at = match run_git_with_timeout(
        &project_path,
        &["log", "-1", "--format=%cI"],
        GIT_TIMEOUT,
    ) {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        _ => None,
    };

    let status_output = run_git_with_timeout(&project_path, &["status", "--porcelain"], GIT_TIMEOUT)?;
    if !status_output.status.success() {
        return Err(String::from_utf8_lossy(&status_output.stderr).trim().to_string());
    }

    Ok(GitTreeIdentity {
        head_commit,
        committed_at,
        status_hash: sha256_hex(&status_output.stdout),
    })
}

#[tauri::command]
pub async fn git_tree_identity(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitTreeIdentity, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_tree_identity_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<GitFileStatus>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_status_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_diff_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Stage (`git add`) or unstage (`git reset`) one file. The path is containment-validated and
/// always passed after `--`, so it is a pathspec and can never be parsed as a git option.
/// No shell is involved (argv exec), so no quoting/injection concerns.
pub(crate) fn git_stage_file_inner(project_path: String, file_path: String, stage: bool) -> Result<(), String> {
    get_project_file_path(&project_path, &file_path)?;

    let args: &[&str] = if stage {
        &["add", "--", &file_path]
    } else {
        &["reset", "--", &file_path]
    };
    let output = run_git_with_timeout(&project_path, args, GIT_TIMEOUT)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn git_stage_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_stage_file_inner(project_path, file_path, true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_stage_file_inner(project_path, file_path, false))
        .await
        .map_err(|e| e.to_string())?
}

/// Commit staged work. When `expected_paths` is `Some`, the index must contain exactly that
/// path set: every requested path must be staged, and any staged path outside the reviewed set
/// refuses the commit outright (Phase 3 - a review certifies a specific file set, so an agent
/// sneaking an extra file into the index between review and commit must fail closed).
pub(crate) fn git_commit_inner(project_path: String, message: String, expected_paths: Option<Vec<String>>) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("Commit message must not be empty".to_string());
    }

    // Pathspec for the scoped commit. Built from validated relative paths (containment-checked)
    // and passed after `--` so they can never parse as options.
    let mut args: Vec<&str> = vec!["commit", "-m", &msg];

    if let Some(ref paths) = expected_paths {
        if paths.is_empty() {
            return Err("No reviewed files were staged; nothing to commit".to_string());
        }
        let status = git_status_inner(project_path.clone())?;
        let staged: std::collections::HashSet<&str> = status
            .iter()
            .filter(|f| f.staged)
            .map(|f| f.path.as_str())
            .collect();

        // Refuse unexpected staged files BEFORE committing anything.
        let unexpected: Vec<&str> = staged
            .iter()
            .copied()
            .filter(|p| !paths.iter().any(|e| e == p))
            .collect();
        if !unexpected.is_empty() {
            return Err(format!(
                "Refusing to commit: the index contains file(s) outside the reviewed set: {}",
                unexpected.join(", ")
            ));
        }

        for p in paths {
            get_project_file_path(&project_path, p)?;
            if !staged.contains(p.as_str()) {
                return Err(format!("Refusing to commit: '{}' is not staged", p));
            }
        }
        args.push("--");
        for p in paths {
            args.push(p);
        }
    }

    // `-m <msg>` goes through argv, never a shell, so arbitrary message content is safe.
    let output = run_git_with_timeout(&project_path, &args, GIT_TIMEOUT)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        // git prints "nothing to commit" style failures on stdout, real errors on stderr.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    paths: Option<Vec<String>>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_commit_inner(project_path, message, paths))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

// ---------------------------------------------------------------------------
// Git remote round-trip (Phase 8.1)
// ---------------------------------------------------------------------------

/// Ahead/behind of the current branch relative to its upstream. `upstream` is
/// `None` when no upstream is configured (or the repo has no remotes); ahead
/// and behind are then both zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchSyncState {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// Outcome of a fetch/pull/push attempt. Git-level failures come back as
/// `ok: false` with git's own message rather than an IPC error, so the renderer
/// can show them inline; `conflicts` marks a divergence or rejection that needs
/// human resolution, which Bridge defers to the terminal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteResult {
    pub ok: bool,
    pub conflicts: bool,
    pub message: String,
}

fn current_branch_name(project_path: &str) -> Result<String, String> {
    let output = run_git_with_timeout(project_path, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Parse `rev-list --left-right --count A...B` ("left<TAB>right") where left
/// counts commits only in A. With A = upstream that left value is "behind".
fn parse_rev_list_count(stdout: &str) -> Option<(u32, u32)> {
    let mut parts = stdout.trim().split('\t');
    let behind: u32 = parts.next()?.trim().parse().ok()?;
    let ahead: u32 = parts.next()?.trim().parse().ok()?;
    Some((behind, ahead))
}

fn upstream_of(project_path: &str) -> Option<String> {
    let output = run_git_with_timeout(
        project_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        GIT_TIMEOUT,
    );
    match output {
        Ok(out) if out.status.success() => {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if name.is_empty() { None } else { Some(name) }
        }
        _ => None,
    }
}

pub fn git_branch_sync_state_inner(project_path: String) -> Result<GitBranchSyncState, String> {
    let branch = current_branch_name(&project_path)?;
    if branch == "HEAD" {
        return Err("Detached HEAD state: no branch to compare against an upstream".to_string());
    }
    let upstream = upstream_of(&project_path);
    let (ahead, behind) = match &upstream {
        Some(up) => {
            let spec = format!("{}...HEAD", up);
            let output = run_git_with_timeout(
                &project_path,
                &["rev-list", "--left-right", "--count", &spec],
                GIT_TIMEOUT,
            )?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            let (behind, ahead) = parse_rev_list_count(&String::from_utf8_lossy(&output.stdout))
                .ok_or_else(|| format!("Unexpected rev-list output: {}", String::from_utf8_lossy(&output.stdout)))?;
            (ahead, behind)
        }
        None => (0, 0),
    };
    Ok(GitBranchSyncState { branch, upstream, ahead, behind })
}

/// Heuristic over git's stderr: does this failure represent divergence/conflict
/// territory (rather than e.g. auth or network trouble)?
fn classify_conflict(stderr_lower: &str) -> bool {
    [
        "conflict",
        "divergent",
        "diverged",
        "not possible to fast-forward",
        "non-fast-forward",
        "rejected",
        "fetch first",
    ]
    .iter()
    .any(|needle| stderr_lower.contains(needle))
}

const CONFLICT_GUIDANCE: &str = "Bridge does not resolve conflicts automatically. Open a terminal in this workspace to resolve manually, then retry.";

#[tauri::command]
pub async fn git_branch_sync_state(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitBranchSyncState, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_branch_sync_state_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn remote_result_from_output(output: Output, success_message: &str) -> GitRemoteResult {
    if output.status.success() {
        GitRemoteResult { ok: true, conflicts: false, message: success_message.to_string() }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let raw = if stderr.is_empty() { stdout } else { stderr };
        let conflicts = classify_conflict(&raw.to_lowercase());
        let message = if conflicts && !raw.contains("terminal") {
            format!("{}\n{}", raw, CONFLICT_GUIDANCE)
        } else {
            raw
        };
        GitRemoteResult { ok: false, conflicts, message }
    }
}

fn git_fetch_inner(project_path: String) -> Result<GitRemoteResult, String> {
    let output = run_git_with_timeout(&project_path, &["fetch", "--all", "--prune"], REMOTE_TIMEOUT)?;
    Ok(remote_result_from_output(output, "Fetched from all remotes"))
}

fn git_pull_inner(project_path: String) -> Result<GitRemoteResult, String> {
    // --ff-only never leaves a half-merged working tree: when branches diverge,
    // pull fails cleanly instead of writing conflict markers, so conflict
    // resolution stays in the terminal as designed.
    let output = run_git_with_timeout(&project_path, &["pull", "--ff-only"], REMOTE_TIMEOUT)?;
    Ok(remote_result_from_output(output, "Already up to date"))
}

fn git_push_inner(project_path: String) -> Result<GitRemoteResult, String> {
    let branch = current_branch_name(&project_path)?;
    if branch == "HEAD" {
        return Err("Detached HEAD state: nothing to push".to_string());
    }
    // First push of an untracked local branch publishes it and sets upstream;
    // afterwards a plain push keeps working.
    let args: Vec<&str> = if upstream_of(&project_path).is_some() {
        vec!["push"]
    } else {
        vec!["push", "-u", "origin", &branch]
    };
    let output = run_git_with_timeout(&project_path, &args, REMOTE_TIMEOUT)?;
    Ok(remote_result_from_output(
        output,
        &format!("Pushed {}", branch),
    ))
}

#[tauri::command]
pub async fn git_fetch(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitRemoteResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_fetch_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitRemoteResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_pull_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitRemoteResult, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_push_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Per-agent-run checkpoints (Phase 8.2)
//
// A checkpoint is a hidden ref (`refs/saple/checkpoints/<run-id>`) capturing
// the repository state right before an agent run starts. Hidden refs never
// appear in `git log`, are not pushed or cloned by default, and leave the
// worktree alone - no worktree isolation.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpoint {
    pub id: String,
    pub commit: String,
}

/// Reduce a renderer-supplied run id to a safe ref-name component: only ASCII
/// alphanumerics plus `-_.` survive, everything else collapses to `_`.
fn sanitize_checkpoint_id(run_id: &str) -> String {
    let cleaned: String = run_id
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() { "_".to_string() } else { trimmed }
}

fn head_commit_of(project_path: &str) -> Result<Option<String>, String> {
    let output = run_git_with_timeout(project_path, &["rev-parse", "HEAD"], GIT_TIMEOUT);
    match output {
        Ok(out) if out.status.success() => {
            Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
        }
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    }
}

fn working_tree_is_clean(project_path: &str) -> Result<bool, String> {
    let output = run_git_with_timeout(project_path, &["status", "--porcelain"], GIT_TIMEOUT)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn checkpoint_ref(id: &str) -> String {
    format!("{}{}", CHECKPOINT_REF_PREFIX, id)
}

fn verify_checkpoint_exists(project_path: &str, id: &str) -> Result<(), String> {
    let reference = checkpoint_ref(id);
    let verify = run_git_with_timeout(
        project_path,
        &["rev-parse", "--verify", "--quiet", &reference],
        GIT_TIMEOUT,
    )?;
    if !verify.status.success() {
        return Err(format!("Checkpoint '{}' does not exist", id));
    }
    Ok(())
}

fn parse_checkpoints(stdout: &str) -> Vec<GitCheckpoint> {
    stdout
        .lines()
        .filter_map(|line| {
            let (refname, commit) = line.split_once('\t')?;
            let id = refname.strip_prefix(CHECKPOINT_REF_PREFIX)?;
            Some(GitCheckpoint { id: id.to_string(), commit: commit.trim().to_string() })
        })
        .collect()
}

pub fn git_create_checkpoint_inner(project_path: String, run_id: String) -> Result<GitCheckpoint, String> {
    let id = sanitize_checkpoint_id(&run_id);
    if id.is_empty() {
        return Err("A non-empty run id is required for a checkpoint".to_string());
    }

    // Capture committed state plus tracked uncommitted changes without touching
    // the worktree or index: `git stash create` records index + worktree into
    // dangling commits and only prints their hash. Untracked files stay outside
    // the capture; restoring keeps files created after the checkpoint.
    let no_commit = "Repository has no commits yet; nothing to checkpoint".to_string();
    let capture = if working_tree_is_clean(&project_path)? {
        head_commit_of(&project_path)?.ok_or(no_commit)?
    } else {
        let message = format!("saple checkpoint {}", id);
        let output = run_git_with_timeout(&project_path, &["stash", "create", &message], GIT_TIMEOUT)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if sha.is_empty() {
            head_commit_of(&project_path)?.ok_or(no_commit)?
        } else {
            sha
        }
    };

    let reference = checkpoint_ref(&id);
    let output = run_git_with_timeout(&project_path, &["update-ref", &reference, &capture], GIT_TIMEOUT)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(GitCheckpoint { id, commit: capture })
}

pub fn git_list_checkpoints_inner(project_path: String) -> Result<Vec<GitCheckpoint>, String> {
    let output = run_git_with_timeout(
        &project_path,
        &["for-each-ref", "--format=%(refname)\t%(objectname)", CHECKPOINT_REF_PREFIX],
        GIT_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_checkpoints(&String::from_utf8_lossy(&output.stdout)))
}

pub fn git_checkpoint_diff_inner(
    project_path: String,
    run_id: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let id = sanitize_checkpoint_id(&run_id);
    verify_checkpoint_exists(&project_path, &id)?;

    let reference = checkpoint_ref(&id);
    let diff_args: Vec<&str> = match &file_path {
        Some(fp) => {
            get_project_file_path(&project_path, fp)?;
            vec!["diff", &reference, "--", fp]
        }
        None => vec!["diff", &reference],
    };
    let output = run_git_with_timeout(&project_path, &diff_args, GIT_TIMEOUT)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
    if diff.trim().is_empty() {
        return Ok("No tracked-file changes since this checkpoint.".to_string());
    }
    if diff.len() > MAX_DIFF_BYTES {
        diff.truncate(MAX_DIFF_BYTES);
        diff.push_str("\n@@ diff truncated by Saple Bridge @@\n");
    }
    Ok(diff)
}

pub fn git_restore_checkpoint_inner(project_path: String, run_id: String, confirmed: bool) -> Result<(), String> {
    if !confirmed {
        // Restore overwrites index and worktree content of every file the
        // checkpoint tracks; the renderer must gate it behind an explicit
        // confirm dialog and pass the flag through.
        return Err("Restore refused without explicit confirmation".to_string());
    }
    let id = sanitize_checkpoint_id(&run_id);
    verify_checkpoint_exists(&project_path, &id)?;

    let reference = checkpoint_ref(&id);
    let output = run_git_with_timeout(
        &project_path,
        &["restore", "--source", &reference, "--staged", "--worktree", "--", "."],
        GIT_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_checkpoint(
    project_path: String,
    run_id: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<GitCheckpoint, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_create_checkpoint_inner(project_path, run_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_list_checkpoints(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<GitCheckpoint>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_list_checkpoints_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkpoint_diff(
    project_path: String,
    run_id: String,
    file_path: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_checkpoint_diff_inner(project_path, run_id, file_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_restore_checkpoint(
    project_path: String,
    run_id: String,
    confirmed: bool,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_restore_checkpoint_inner(project_path, run_id, confirmed))
        .await
        .map_err(|e| e.to_string())?
}


fn git_list_branches_inner(project_path: String) -> Result<Vec<GitBranch>, String> {
    // for-each-ref emits clean names (no "* " marker parsing, no detached-HEAD line).
    let output = run_git_with_timeout(
        &project_path,
        &["for-each-ref", "--format=%(HEAD)%(refname:short)", "refs/heads"],
        GIT_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_branch_list(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_branch_list(stdout: &str) -> Vec<GitBranch> {
    stdout
        .lines()
        .filter_map(|line| {
            let current = line.starts_with('*');
            let name = line.trim_start_matches(['*', ' ']).trim();
            if name.is_empty() {
                None
            } else {
                Some(GitBranch { name: name.to_string(), current })
            }
        })
        .collect()
}

/// Switch branches, refusing when the working tree or index is dirty so a checkout
/// can never clobber or entangle un-reviewed agent changes.
fn git_checkout_branch_inner(project_path: String, branch: String) -> Result<(), String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch.starts_with('-') {
        return Err(format!("Invalid branch name '{}'", branch));
    }

    let dirty = git_status_inner(project_path.clone())?;
    if !dirty.is_empty() {
        return Err(format!(
            "Working tree has {} uncommitted change(s). Commit or stash them before switching branches.",
            dirty.len()
        ));
    }

    let output = run_git_with_timeout(&project_path, &["checkout", &branch], GIT_TIMEOUT)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn git_list_branches(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<GitBranch>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_list_branches_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout_branch(
    project_path: String,
    branch: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || git_checkout_branch_inner(project_path, branch))
        .await
        .map_err(|e| e.to_string())?
}

/// Ensure `.saple/` is listed in the repository's local `.git/info/exclude` (Phase 2). This keeps
/// workspace state out of `git status` without touching any tracked file like `.gitignore`, and
/// stays entirely inside the repo's private metadata. Returns whether the exclude file was
/// modified, so the renderer can disclose the change to the user.
#[tauri::command]
pub async fn ensure_saple_git_excluded(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<bool, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || ensure_saple_git_excluded_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn ensure_saple_git_excluded_inner(project_path: String) -> Result<bool, String> {
    let git_dir = std::path::Path::new(&project_path).join(".git");
    if !git_dir.is_dir() {
        return Ok(false); // not a git worktree; nothing to exclude from
    }
    let info_dir = git_dir.join("info");
    fs::create_dir_all(&info_dir).map_err(|e| format!("Failed to create .git/info: {}", e))?;
    let exclude = info_dir.join("exclude");

    let existing = if exclude.exists() {
        fs::read_to_string(&exclude).unwrap_or_default()
    } else {
        String::new()
    };
    // Match an exact `.saple/` line (trimmed) so we never append duplicates.
    let already_excluded = existing
        .lines()
        .any(|l| l.trim() == ".saple/" || l.trim() == ".saple");
    if already_excluded {
        return Ok(false);
    }

    let mut updated = existing.clone();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str("# Added by Saple Bridge: keep local workspace state out of git\n.saple/\n");
    fs::write(&exclude, updated).map_err(|e| format!("Failed to update .git/info/exclude: {}", e))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_arrow_rename() {
        // The path field after stripping the 3-char "R  " XY-status prefix.
        assert_eq!(parse_rename_dest("old.txt -> new.txt"), "new.txt");
        assert_eq!(parse_rename_dest("src/a.rs -> src/b.rs"), "src/b.rs");
    }

    #[test]
    fn parses_tab_separated_rename() {
        assert_eq!(parse_rename_dest("old.txt\tnew.txt"), "new.txt");
    }

    #[test]
    fn passes_through_plain_path() {
        assert_eq!(parse_rename_dest("plain.txt"), "plain.txt");
    }

    #[test]
    fn parses_branch_list_with_current_marker() {
        let branches = parse_branch_list("*main\n feature/x\n release-1.0\n");
        assert_eq!(branches.len(), 3);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
        assert_eq!(branches[1].name, "feature/x");
        assert!(!branches[1].current);
        assert_eq!(branches[2].name, "release-1.0");
    }

    fn untracked(path: &str) -> GitFileStatus {
        GitFileStatus {
            path: path.to_string(),
            status: "untracked".to_string(),
            insertions: None,
            deletions: None,
            staged: false,
        }
    }

    #[test]
    fn untracked_enrichment_caps_by_file_count() {
        let dir = std::env::temp_dir().join(format!("saple-git-untracked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let mut files: Vec<GitFileStatus> = (0..4)
            .map(|i| untracked(&format!("f{}.txt", i)))
            .collect();
        for i in 0..4 {
            fs::write(dir.join(format!("f{}.txt", i)), "a\nb\nc\n").unwrap();
        }

        enrich_untracked_files(&mut files, &dir.to_string_lossy(), 2, u64::MAX);

        let enriched: Vec<Option<usize>> = files.iter().map(|f| f.insertions).collect();
        assert_eq!(enriched, vec![Some(3), Some(3), None, None], "only the first max_files entries are enriched");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_enrichment_caps_by_aggregate_bytes_and_marks_oversize_zero() {
        let dir = std::env::temp_dir().join(format!("saple-git-untracked-bytes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // big.txt exceeds the per-file limit (MAX_UNTRACKED_BYTES) -> reported zero
        // without being read.
        fs::write(dir.join("big.txt"), "x".repeat((MAX_UNTRACKED_BYTES + 1) as usize)).unwrap();
        fs::write(dir.join("small.txt"), "line\n").unwrap();
        fs::write(dir.join("tiny.txt"), "l\n").unwrap();

        let mut files = vec![untracked("big.txt"), untracked("small.txt"), untracked("tiny.txt")];
        // Budget of 6 bytes: big.txt is individually oversized (zeroed), small.txt (5 bytes)
        // fits, tiny.txt (2 bytes) would exceed the aggregate budget and stays un-enriched.
        enrich_untracked_files(&mut files, &dir.to_string_lossy(), 10, 6);

        assert_eq!(files[0].insertions, Some(0), "oversized file is zeroed without a read");
        assert_eq!(files[1].insertions, Some(1));
        assert_eq!(files[2].insertions, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_option_like_branch_names() {
        let err = git_checkout_branch_inner(".".to_string(), "--force".to_string()).unwrap_err();
        assert!(err.contains("Invalid branch name"));
        let err = git_checkout_branch_inner(".".to_string(), "  ".to_string()).unwrap_err();
        assert!(err.contains("Invalid branch name"));
    }

    #[test]
    fn stage_and_unstage_remain_functional() {
        // Intentional git.rs operations write through real git commands, not the generic
        // file writers, so the `.git/**` writer block must leave them untouched.
        let dir = std::env::temp_dir().join(format!("saple-git-stage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@saple.local"]);
        git(&["config", "user.name", "Saple Test"]);

        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_stage_file_inner(path.clone(), "a.txt".to_string(), true).unwrap();

        let staged = git_status_inner(path.clone()).unwrap();
        let entry = staged.iter().find(|f| f.path == "a.txt").expect("a.txt in status");
        assert!(entry.staged, "a.txt must be staged after git add");

        git_stage_file_inner(path.clone(), "a.txt".to_string(), false).unwrap();
        let unstaged = git_status_inner(path.clone()).unwrap();
        let entry = unstaged.iter().find(|f| f.path == "a.txt").expect("a.txt in status");
        assert!(!entry.staged, "a.txt must be unstaged after git reset");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn checkout_refuses_dirty_tree() {
        let dir = std::env::temp_dir().join(format!("saple-git-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@saple.local"]);
        git(&["config", "user.name", "Saple Test"]);
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        git(&["branch", "other"]);

        // Clean tree: listing works and checkout succeeds.
        let branches = git_list_branches_inner(path.clone()).unwrap();
        assert!(branches.iter().any(|b| b.name == "main" && b.current));
        assert!(branches.iter().any(|b| b.name == "other" && !b.current));
        git_checkout_branch_inner(path.clone(), "other".to_string()).unwrap();

        // Dirty tree: checkout must refuse.
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        let err = git_checkout_branch_inner(path.clone(), "main".to_string()).unwrap_err();
        assert!(err.contains("uncommitted"), "unexpected error: {}", err);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saple_git_exclude_is_idempotent_and_discloses_changes() {
        // Non-git directory: no-op.
        let dir = std::env::temp_dir().join(format!("saple-git-excl-nogit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!ensure_saple_git_excluded_inner(dir.to_string_lossy().to_string()).unwrap());

        // Git repo without the entry: first call adds it (disclosed), second is a no-op.
        let dir = std::env::temp_dir().join(format!("saple-git-excl-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed", args);
        };
        git(&["init"]);

        let path = dir.to_string_lossy().to_string();
        assert!(ensure_saple_git_excluded_inner(path.clone()).unwrap(), "first run must modify");
        let contents = fs::read_to_string(dir.join(".git").join("info").join("exclude")).unwrap();
        assert!(contents.lines().any(|l| l.trim() == ".saple/"));
        assert!(
            !ensure_saple_git_excluded_inner(path).unwrap(),
            "second run must be a no-op (no duplicate lines)"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn numstat_enrichment_lands_on_the_right_paths() {
        let dir = std::env::temp_dir().join(format!("saple-git-numstat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@saple.local"]);
        git(&["config", "user.name", "Saple Test"]);

        // Two committed files, then diverging edits: modified, deleted, and one new file.
        fs::write(dir.join("keep.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(dir.join("gone.txt"), "one\ntwo\n").unwrap();
        fs::write(dir.join("new.txt"), "fresh\nlines\nhere\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);

        fs::write(dir.join("keep.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::remove_file(dir.join("gone.txt")).unwrap();

        let status = git_status_inner(path.clone()).unwrap();

        let keep = status.iter().find(|f| f.path == "keep.txt").expect("keep.txt in status");
        assert_eq!(keep.insertions, Some(1));
        assert_eq!(keep.deletions, Some(0));

        let gone = status.iter().find(|f| f.path == "gone.txt").expect("gone.txt in status");
        assert_eq!(gone.insertions, Some(0));
        assert_eq!(gone.deletions, Some(2));

        let _ = fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------
    // Phase 8.1: remote round-trip
    // ------------------------------------------------------------------

    #[test]
    fn rev_list_count_parses_left_right_pairs() {
        assert_eq!(parse_rev_list_count("2\t3"), Some((2, 3)));
        assert_eq!(parse_rev_list_count("  0\t1 \n"), Some((0, 1)));
        assert_eq!(parse_rev_list_count(""), None);
        assert_eq!(parse_rev_list_count("x\ty"), None);
        assert_eq!(parse_rev_list_count("1"), None);
    }

    #[test]
    fn conflict_classifier_flags_divergence_and_rejection() {
        assert!(classify_conflict("your branch has diverged from the remote".into()));
        assert!(classify_conflict("error: could not apply; conflict in a.txt".into()));
        assert!(classify_conflict("! [rejected] main -> main (fetch first)".into()));
        assert!(!classify_conflict("fatal: could not read Username for 'https://'".into()));
        assert!(!classify_conflict("connection timed out".into()));
    }

    fn init_test_repo(name: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
            out
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@saple.local"]);
        git(&["config", "user.name", "Saple Test"]);
        (dir, path)
    }

    #[test]
    fn sync_state_computes_ahead_behind_against_a_fake_upstream() {
        let (dir, path) = init_test_repo("saple-git-sync");

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
            out
        };
        let commit = |msg: &str| {
            git(&["add", "."]);
            git(&["commit", "-m", msg]);
        };
        let rev_parse = |spec: &str| -> String {
            let out = git(&["rev-parse", spec]);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        fs::write(dir.join("a.txt"), "one\n").unwrap();
        commit("c1");
        let c1 = rev_parse("HEAD");
        fs::write(dir.join("a.txt"), "two\n").unwrap();
        commit("c2");
        let c2 = rev_parse("HEAD");

        // No upstream configured yet.
        let state = git_branch_sync_state_inner(path.clone()).unwrap();
        assert_eq!(state.branch, "main");
        assert_eq!(state.upstream, None);
        assert_eq!((state.ahead, state.behind), (0, 0));

        // Fake an origin upstream at c1: main is now ahead by one. A configured
        // remote is required for @{upstream} to resolve even though we only
        // point its tracking ref by hand.
        git(&["remote", "add", "origin", "."]);
        git(&["update-ref", "refs/remotes/origin/main", &c1]);
        git(&["config", "branch.main.remote", "origin"]);
        git(&["config", "branch.main.merge", "refs/heads/main"]);
        let state = git_branch_sync_state_inner(path.clone()).unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (1, 0));

        // Diverge: move the fake upstream to a sibling commit built from c1,
        // so main is simultaneously ahead and behind.
        git(&["checkout", "-q", "-b", "remote-side", &c1]);
        fs::write(dir.join("a.txt"), "remote\n").unwrap();
        commit("remote-c");
        let remote_c = rev_parse("HEAD");
        git(&["checkout", "-q", "main"]);
        git(&["update-ref", "refs/remotes/origin/main", &remote_c]);

        let state = git_branch_sync_state_inner(path.clone()).unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!(state.ahead, 1, "main holds only c2 beyond the merge base");
        assert_eq!(state.behind, 1, "upstream holds remote-c that main lacks");
        let _ = c2;

        let _ = fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------
    // Phase 8.2: checkpoints
    // ------------------------------------------------------------------

    #[test]
    fn checkpoint_ids_are_reduced_to_ref_safe_components() {
        assert_eq!(sanitize_checkpoint_id("run-123"), "run-123");
        assert_eq!(sanitize_checkpoint_id("../evil/ref:name"), "_evil_ref_name");
        assert_eq!(sanitize_checkpoint_id("  "), "_");
        assert_eq!(sanitize_checkpoint_id(""), "_");
        // Leading dots are trimmed so the component can never read like a path.
        assert_eq!(sanitize_checkpoint_id("..hidden"), "hidden");
    }

    #[test]
    fn checkpoint_captures_dirty_tree_diff_shows_changes_restore_recovers() {
        let (dir, path) = init_test_repo("saple-git-checkpoint");

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
            out
        };
        fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);

        // Agent-style uncommitted edits exist when the run starts.
        fs::write(dir.join("a.txt"), "agent was here\n").unwrap();

        let cp = git_create_checkpoint_inner(path.clone(), "run-abc".to_string()).unwrap();
        assert_eq!(cp.id, "run-abc");

        // The hidden ref exists and is listed.
        let listed = git_list_checkpoints_inner(path.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "run-abc");
        assert_eq!(listed[0].commit, cp.commit);

        // Nothing has changed since the capture itself.
        let unchanged = git_checkpoint_diff_inner(path.clone(), "run-abc".to_string(), None).unwrap();
        assert!(unchanged.contains("No tracked-file changes"));

        // The run keeps editing after its checkpoint was taken...
        fs::write(dir.join("a.txt"), "agent continued\n").unwrap();

        // ...so the diff against the checkpoint shows those changes.
        let diff = git_checkpoint_diff_inner(path.clone(), "run-abc".to_string(), None).unwrap();
        assert!(diff.contains("-agent was here"), "expected removal of pre-checkpoint content:\n{}", diff);
        assert!(diff.contains("+agent continued"));

        // ...and per-file scoping works.
        let scoped = git_checkpoint_diff_inner(
            path.clone(),
            "run-abc".to_string(),
            Some("a.txt".to_string()),
        )
        .unwrap();
        assert!(scoped.contains("+agent continued"));

        // Restore rolls index + worktree back to the captured content.
        git_restore_checkpoint_inner(path.clone(), "run-abc".to_string(), true).unwrap();
        let normalized = fs::read_to_string(dir.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(
            normalized,
            "agent was here\n",
            "restore must return the tracked file to its checkpointed content"
        );
        // After restore there is nothing left to diff against the checkpoint.
        let clean = git_checkpoint_diff_inner(path.clone(), "run-abc".to_string(), None).unwrap();
        assert!(clean.contains("No tracked-file changes"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_tree_checkpoints_head_and_restore_requires_confirmation() {
        let (dir, path) = init_test_repo("saple-git-checkpoint-clean");

        let git = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(&dir).no_window().output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
            out
        };
        fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "base"]);
        let head = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();

        // Clean tree: the checkpoint points at HEAD itself.
        let cp = git_create_checkpoint_inner(path.clone(), "run-clean".to_string()).unwrap();
        assert_eq!(cp.commit, head);

        // New commits after the checkpoint are rolled back on restore.
        fs::write(dir.join("a.txt"), "v2\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "later work"]);

        // Without confirmation the restore is refused outright.
        let err = git_restore_checkpoint_inner(path.clone(), "run-clean".to_string(), false)
            .unwrap_err();
        assert!(err.contains("confirmation"), "unexpected error: {}", err);

        // A file staged after the checkpoint is rolled back out of index and
        // worktree; a purely untracked file (never added) survives untouched.
        fs::write(dir.join("staged-later.txt"), "rollback me\n").unwrap();
        fs::write(dir.join("untracked-later.txt"), "keep me\n").unwrap();
        git(&["add", "staged-later.txt"]);
        git_restore_checkpoint_inner(path.clone(), "run-clean".to_string(), true).unwrap();
        let normalized = fs::read_to_string(dir.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(normalized, "v1\n");
        assert!(
            !dir.join("staged-later.txt").exists(),
            "files staged after the checkpoint must be rolled back"
        );
        assert!(
            dir.join("untracked-later.txt").exists(),
            "purely untracked files must survive"
        );

        // Unknown checkpoints fail with a clear message instead of git noise.
        let err =
            git_checkpoint_diff_inner(path.clone(), "missing-run".to_string(), None).unwrap_err();
        assert!(err.contains("does not exist"), "unexpected error: {}", err);

        let _ = fs::remove_dir_all(&dir);
    }
}
