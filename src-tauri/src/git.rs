use std::process::{Command, Output, Stdio};
use std::fs;
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};
use crate::project::get_project_file_path;
use crate::process_ext::CommandNoWindow;
use crate::project_roots::ProjectRootRegistry;

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
}
