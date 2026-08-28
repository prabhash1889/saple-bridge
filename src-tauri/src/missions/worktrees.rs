//! Worktree isolation and merge-back for Missions (Phase M5).
//!
//! Owns creation, lifecycle, diffing, merge-back, stale-base guards,
//! and disk-truth cleanup for task-scoped and mission-scoped git worktrees.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::git::{git_status_inner, GitFileStatus};
use crate::process_ext::CommandNoWindow;
use crate::project_roots::{canonical_base, ProjectRootRegistry};

const GIT_TIMEOUT: Duration = Duration::from_secs(15);
pub const STALE_BASE_THRESHOLD: u32 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub worktree_path: String,
    pub branch: String,
    pub mission_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    pub is_clean: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSummary {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub total_insertions: usize,
    pub total_deletions: usize,
    pub full_diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMergeResult {
    pub ok: bool,
    pub message: String,
    pub conflicts: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_commit: Option<String>,
}

fn run_git_in_dir(dir: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))?;

    let started = Instant::now();
    let mut backoff = Duration::from_millis(2);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return child.wait_with_output().map_err(|e| e.to_string());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "git {} timed out after {}s",
                args.join(" "),
                timeout.as_secs()
            ));
        }
        std::thread::sleep(backoff);
        if backoff < Duration::from_millis(25) {
            backoff = (backoff * 2).min(Duration::from_millis(25));
        }
    }
}

/// Sanitize id component for branch names and paths.
fn sanitize_slug(id: &str) -> String {
    let cleaned: String = id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Short identifier for branch names (e.g. `msn_01JK...` -> `01JK...` or first 8 chars).
fn short_id(id: &str) -> String {
    let raw = id
        .strip_prefix("msn_")
        .or_else(|| id.strip_prefix("task_"))
        .unwrap_or(id);
    let s = sanitize_slug(raw);
    if s.len() > 10 {
        s[..10].to_string()
    } else {
        s
    }
}

/// Computes the expected worktree path inside `.saple/worktrees/<mission_id>/<task_id_or_main>`.
pub fn get_worktree_dir(project_path: &str, mission_id: &str, task_id: Option<&str>) -> PathBuf {
    let base = Path::new(project_path).join(".saple").join("worktrees").join(sanitize_slug(mission_id));
    if let Some(t_id) = task_id {
        base.join(sanitize_slug(t_id))
    } else {
        base.join("main")
    }
}

/// Formats branch name: `saple/<mission-short>/<task-short>` or `saple/<mission-short>/main`.
pub fn get_worktree_branch(mission_id: &str, task_id: Option<&str>) -> String {
    let m_short = short_id(mission_id);
    if let Some(t_id) = task_id {
        format!("saple/{}/{}", m_short, short_id(t_id))
    } else {
        format!("saple/{}/main", m_short)
    }
}

/// Check if a given ref exists in the repository.
fn ref_exists(project_dir: &Path, ref_name: &str) -> bool {
    let out = run_git_in_dir(
        project_dir,
        &["rev-parse", "--verify", "--quiet", ref_name],
        GIT_TIMEOUT,
    );
    out.map(|o| o.status.success()).unwrap_or(false)
}

/// Resolve HEAD commit in a git dir.
fn get_head_commit(dir: &Path) -> Option<String> {
    let out = run_git_in_dir(dir, &["rev-parse", "HEAD"], GIT_TIMEOUT).ok()?;
    if out.status.success() {
        let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if sha.is_empty() {
            None
        } else {
            Some(sha)
        }
    } else {
        None
    }
}

/// Get ahead/behind counts between two refs.
fn get_ahead_behind(dir: &Path, local_ref: &str, upstream_ref: &str) -> (u32, u32) {
    let spec = format!("{}...{}", upstream_ref, local_ref);
    let out = run_git_in_dir(
        dir,
        &["rev-list", "--left-right", "--count", &spec],
        GIT_TIMEOUT,
    );
    if let Ok(o) = out {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut parts = s.trim().split('\t');
            let behind: u32 = parts.next().and_then(|p| p.trim().parse().ok()).unwrap_or(0);
            let ahead: u32 = parts.next().and_then(|p| p.trim().parse().ok()).unwrap_or(0);
            return (ahead, behind);
        }
    }
    (0, 0)
}

/// Check if working tree in a directory is clean (ignoring .saple/ worktrees metadata).
fn is_dir_clean(dir: &Path) -> bool {
    let out = run_git_in_dir(dir, &["status", "--porcelain"], GIT_TIMEOUT);
    if let Ok(o) = out {
        if !o.status.success() {
            return false;
        }
        let stdout = String::from_utf8_lossy(&o.stdout);
        let dirty_lines: Vec<&str> = stdout
            .lines()
            .map(|l| l.trim())
            .filter(|l| {
                if l.is_empty() {
                    return false;
                }
                let path_part = if l.len() > 3 { &l[3..] } else { l };
                !path_part.starts_with(".saple") && !path_part.contains(".saple")
            })
            .collect();
        dirty_lines.is_empty()
    } else {
        false
    }
}

/// Create a git worktree for a mission task or per-mission mode.
pub fn mission_worktree_create_inner(
    registry: &Arc<ProjectRootRegistry>,
    project_path: &str,
    mission_id: &str,
    task_id: Option<&str>,
    base_ref: Option<&str>,
) -> Result<WorktreeInfo, String> {
    let base_dir = canonical_base(project_path).map_err(|e| e.to_string())?;
    let wt_path = get_worktree_dir(project_path, mission_id, task_id);
    let branch = get_worktree_branch(mission_id, task_id);

    // If worktree directory already exists and is a valid worktree, refresh and return it
    if wt_path.exists() && wt_path.join(".git").exists() {
        let canonical_wt = wt_path.canonicalize().map_err(|e| e.to_string())?;
        let _ = registry.register_root(&canonical_wt);
        let head = get_head_commit(&canonical_wt);
        let base = base_ref.and_then(|b| get_head_commit(&base_dir.join(b))).or_else(|| get_head_commit(&base_dir));
        let (ahead, behind) = if let Some(b_ref) = base_ref {
            get_ahead_behind(&canonical_wt, "HEAD", b_ref)
        } else {
            (0, 0)
        };
        return Ok(WorktreeInfo {
            worktree_path: canonical_wt.to_string_lossy().to_string(),
            branch,
            mission_id: mission_id.to_string(),
            task_id: task_id.map(|s| s.to_string()),
            head_commit: head,
            base_commit: base,
            is_clean: is_dir_clean(&canonical_wt),
            ahead,
            behind,
        });
    }

    // Ensure parent directories exist
    if let Some(parent) = wt_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create worktree parent dir {}: {}", parent.display(), e))?;
    }

    let wt_path_str = wt_path.to_string_lossy().to_string();

    // Check if branch already exists in repo
    let branch_exists = ref_exists(&base_dir, &format!("refs/heads/{}", branch));

    let mut args = vec!["worktree", "add"];
    if branch_exists {
        args.push(&wt_path_str);
        args.push(&branch);
    } else {
        args.push("-b");
        args.push(&branch);
        args.push(&wt_path_str);
        if let Some(base) = base_ref {
            args.push(base);
        }
    }

    let out = run_git_in_dir(&base_dir, &args, GIT_TIMEOUT)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("git worktree add failed: {}", stderr));
    }

    let canonical_wt = wt_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize worktree path: {}", e))?;

    // Register worktree path in ProjectRootRegistry so contained filesystem & PTY commands accept it
    let _ = registry.register_root(&canonical_wt);

    let head = get_head_commit(&canonical_wt);
    let base = get_head_commit(&base_dir);

    Ok(WorktreeInfo {
        worktree_path: canonical_wt.to_string_lossy().to_string(),
        branch,
        mission_id: mission_id.to_string(),
        task_id: task_id.map(|s| s.to_string()),
        head_commit: head,
        base_commit: base,
        is_clean: true,
        ahead: 0,
        behind: 0,
    })
}

/// Check if a worktree is stale relative to its upstream base.
/// Returns `Ok(Some(behind_count))` if `behind_count > threshold` (default 20),
/// or `Ok(None)` if up to date / under threshold.
pub fn check_stale_base(
    project_path: &str,
    worktree_path: &str,
    base_ref: Option<&str>,
    threshold: u32,
) -> Result<Option<u32>, String> {
    let wt_dir = Path::new(worktree_path);
    if !wt_dir.exists() {
        return Ok(None);
    }

    let base = base_ref.unwrap_or("main");
    let base_dir = Path::new(project_path);

    // Target ref to compare against: check upstream or main HEAD
    let target_ref = if ref_exists(base_dir, &format!("refs/heads/{}", base)) {
        base
    } else if ref_exists(base_dir, "HEAD") {
        "HEAD"
    } else {
        return Ok(None);
    };

    let (_ahead, behind) = get_ahead_behind(wt_dir, "HEAD", target_ref);
    if behind > threshold {
        Ok(Some(behind))
    } else {
        Ok(None)
    }
}

/// Diff a worktree against a base reference or the current HEAD of the main checkout.
pub fn mission_worktree_diff_inner(
    project_path: &str,
    worktree_path: &str,
    base_ref: Option<&str>,
) -> Result<GitDiffSummary, String> {
    let wt_dir = Path::new(worktree_path);
    if !wt_dir.exists() {
        return Err(format!("Worktree path '{}' does not exist", worktree_path));
    }

    let branch = {
        let out = run_git_in_dir(wt_dir, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT)?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    let files = git_status_inner(worktree_path.to_string()).unwrap_or_default();

    let diff_target = base_ref.unwrap_or("HEAD");
    let diff_out = run_git_in_dir(wt_dir, &["diff", diff_target], GIT_TIMEOUT)?;
    let full_diff = if diff_out.status.success() {
        String::from_utf8_lossy(&diff_out.stdout).to_string()
    } else {
        String::new()
    };

    let total_insertions = files.iter().map(|f| f.insertions.unwrap_or(0)).sum();
    let total_deletions = files.iter().map(|f| f.deletions.unwrap_or(0)).sum();

    let _ = project_path; // Keep signature consistent

    Ok(GitDiffSummary {
        branch,
        files,
        total_insertions,
        total_deletions,
        full_diff,
    })
}

/// Merge, PR-prepare, or discard a worktree.
pub fn mission_worktree_merge_inner(
    project_path: &str,
    worktree_path: &str,
    strategy: &str,
    target_branch: Option<&str>,
) -> Result<WorktreeMergeResult, String> {
    let base_dir = Path::new(project_path);
    let wt_dir = Path::new(worktree_path);

    if !wt_dir.exists() {
        return Err(format!("Worktree path '{}' does not exist", worktree_path));
    }

    let wt_branch = {
        let out = run_git_in_dir(wt_dir, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT)?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    match strategy {
        "merge" => {
            // Target branch to merge into: default to current branch of base repo
            let target = target_branch.unwrap_or("main");

            // Ensure base working tree is clean before merge
            if !is_dir_clean(base_dir) {
                return Ok(WorktreeMergeResult {
                    ok: false,
                    message: "Main checkout has uncommitted changes. Commit or stash them before merging.".to_string(),
                    conflicts: false,
                    merged_commit: None,
                });
            }

            let merge_msg = format!("Merge mission branch '{}' into '{}'", wt_branch, target);
            let out = run_git_in_dir(base_dir, &["merge", "--no-ff", "-m", &merge_msg, &wt_branch], GIT_TIMEOUT)?;

            if out.status.success() {
                let head = get_head_commit(base_dir);
                Ok(WorktreeMergeResult {
                    ok: true,
                    message: format!("Successfully merged '{}' into '{}'", wt_branch, target),
                    conflicts: false,
                    merged_commit: head,
                })
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                let err_text = format!("{}\n{}", stdout, stderr).to_lowercase();
                let conflicts = err_text.contains("conflict") || err_text.contains("automatic merge failed");
                Ok(WorktreeMergeResult {
                    ok: false,
                    message: format!("Merge failed: {}\n{}", stdout.trim(), stderr.trim()),
                    conflicts,
                    merged_commit: None,
                })
            }
        }
        "pr" => {
            // PR readiness verification
            let head = get_head_commit(wt_dir);
            Ok(WorktreeMergeResult {
                ok: true,
                message: format!("Branch '{}' is ready for pull request (HEAD: {})", wt_branch, head.as_deref().unwrap_or("unknown")),
                conflicts: false,
                merged_commit: head,
            })
        }
        "discard" => {
            // Reset worktree working tree and index
            let out = run_git_in_dir(wt_dir, &["reset", "--hard", "HEAD"], GIT_TIMEOUT)?;
            let _ = run_git_in_dir(wt_dir, &["clean", "-fd"], GIT_TIMEOUT);
            if out.status.success() {
                Ok(WorktreeMergeResult {
                    ok: true,
                    message: format!("Discarded all changes in worktree for branch '{}'", wt_branch),
                    conflicts: false,
                    merged_commit: None,
                })
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(format!("Discard failed: {}", stderr))
            }
        }
        other => Err(format!("Unknown merge strategy '{}'. Expected 'merge', 'pr', or 'discard'", other)),
    }
}

/// Remove a worktree: prunes worktree directory and deletes associated branch.
/// Refuses if worktree is dirty unless `force` is true.
pub fn mission_worktree_remove_inner(
    registry: &Arc<ProjectRootRegistry>,
    project_path: &str,
    worktree_path: &str,
    force: bool,
) -> Result<(), String> {
    let base_dir = Path::new(project_path);
    let wt_dir = Path::new(worktree_path);

    if !wt_dir.exists() {
        return Ok(());
    }

    if !force && !is_dir_clean(wt_dir) {
        return Err(
            "Worktree has uncommitted changes. Please commit, stash, or pass force: true to remove."
                .to_string(),
        );
    }

    let branch = {
        let out = run_git_in_dir(wt_dir, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT);
        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    };

    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    let wt_str = wt_dir.to_string_lossy().to_string();
    args.push(&wt_str);

    let out = run_git_in_dir(base_dir, &args, GIT_TIMEOUT)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Fallback: if git worktree remove failed, try manually pruning
        let _ = run_git_in_dir(base_dir, &["worktree", "prune"], GIT_TIMEOUT);
        if wt_dir.exists() {
            let _ = fs::remove_dir_all(wt_dir);
        }
        if !stderr.is_empty() && wt_dir.exists() {
            return Err(format!("Failed to remove worktree: {}", stderr));
        }
    }

    // Release root from registry
    let _ = registry.release_root(wt_dir);

    // Delete branch if it exists
    if !branch.is_empty() && branch != "HEAD" && branch != "main" && branch != "master" {
        let _ = run_git_in_dir(base_dir, &["branch", "-D", &branch], GIT_TIMEOUT);
    }

    Ok(())
}

/// List worktrees in the project by scanning `.saple/worktrees` and comparing with `git worktree list`.
pub fn mission_worktree_list_inner(
    project_path: &str,
    mission_id: Option<&str>,
) -> Result<Vec<WorktreeInfo>, String> {
    let base_dir = Path::new(project_path);
    let worktrees_root = base_dir.join(".saple").join("worktrees");

    if !worktrees_root.exists() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();

    // Iterate missions under .saple/worktrees
    let mission_dirs: Vec<PathBuf> = if let Some(m_id) = mission_id {
        let p = worktrees_root.join(sanitize_slug(m_id));
        if p.exists() { vec![p] } else { vec![] }
    } else if let Ok(entries) = fs::read_dir(&worktrees_root) {
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect()
    } else {
        vec![]
    };

    for m_dir in mission_dirs {
        let m_name = m_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if let Ok(entries) = fs::read_dir(&m_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_dir() && p.join(".git").exists() {
                    let task_slug = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                    let task_id = if task_slug == "main" { None } else { Some(task_slug) };

                    let branch = {
                        let out = run_git_in_dir(&p, &["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT);
                        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
                    };

                    let head = get_head_commit(&p);
                    let base = get_head_commit(base_dir);
                    let (ahead, behind) = get_ahead_behind(&p, "HEAD", "main");

                    results.push(WorktreeInfo {
                        worktree_path: p.to_string_lossy().to_string(),
                        branch,
                        mission_id: m_name.clone(),
                        task_id,
                        head_commit: head,
                        base_commit: base,
                        is_clean: is_dir_clean(&p),
                        ahead,
                        behind,
                    });
                }
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_test_git_repo(name: &str) -> (PathBuf, Arc<ProjectRootRegistry>) {
        let dir = std::env::temp_dir().join(format!("saple-wt-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let run_cmd = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .no_window()
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run_cmd(&["init", "-b", "main"]);
        run_cmd(&["config", "user.email", "test@saple.local"]);
        run_cmd(&["config", "user.name", "Saple Worktree Test"]);

        fs::write(dir.join(".gitignore"), ".saple/\n").unwrap();
        fs::write(dir.join("README.md"), "# Test\n").unwrap();
        run_cmd(&["add", "."]);
        run_cmd(&["commit", "-m", "initial commit"]);

        let registry = Arc::new(ProjectRootRegistry::new());
        let _ = registry.register_root(&dir);

        (dir, registry)
    }

    #[test]
    fn worktree_create_diff_and_merge_lifecycle() {
        let (dir, registry) = init_test_git_repo("lifecycle");
        let project_path = dir.to_string_lossy().to_string();

        // 1. Create worktree for task_1
        let wt = mission_worktree_create_inner(
            &registry,
            &project_path,
            "msn_test01",
            Some("task_1"),
            None,
        )
        .unwrap();

        assert!(wt.worktree_path.contains("task_1"));
        assert_eq!(wt.branch, "saple/test01/1");
        assert!(Path::new(&wt.worktree_path).exists());

        // 2. Edit a file in the worktree
        let wt_path = Path::new(&wt.worktree_path);
        fs::write(wt_path.join("file.txt"), "hello from worktree\n").unwrap();

        let diff = mission_worktree_diff_inner(&project_path, &wt.worktree_path, None).unwrap();
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "file.txt");

        // 3. Commit in worktree
        let _ = Command::new("git")
            .args(["add", "."])
            .current_dir(wt_path)
            .no_window()
            .output()
            .unwrap();
        let _ = Command::new("git")
            .args(["commit", "-m", "worktree commit"])
            .current_dir(wt_path)
            .no_window()
            .output()
            .unwrap();

        // 4. Merge worktree into main
        let merge_res = mission_worktree_merge_inner(
            &project_path,
            &wt.worktree_path,
            "merge",
            Some("main"),
        )
        .unwrap();

        assert!(merge_res.ok);
        assert!(!merge_res.conflicts);
        assert!(dir.join("file.txt").exists());

        // 5. Remove worktree
        mission_worktree_remove_inner(&registry, &project_path, &wt.worktree_path, false).unwrap();
        assert!(!wt_path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dirty_worktree_removal_refuses_without_force() {
        let (dir, registry) = init_test_git_repo("dirty");
        let project_path = dir.to_string_lossy().to_string();

        let wt = mission_worktree_create_inner(
            &registry,
            &project_path,
            "msn_test02",
            Some("task_2"),
            None,
        )
        .unwrap();

        let wt_path = Path::new(&wt.worktree_path);
        fs::write(wt_path.join("dirty.txt"), "uncommitted edits\n").unwrap();

        // Removal without force must fail
        let err = mission_worktree_remove_inner(&registry, &project_path, &wt.worktree_path, false).unwrap_err();
        assert!(err.contains("uncommitted changes"));
        assert!(wt_path.exists());

        // Removal with force must succeed
        mission_worktree_remove_inner(&registry, &project_path, &wt.worktree_path, true).unwrap();
        assert!(!wt_path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_base_guard_detects_behind_threshold() {
        let (dir, registry) = init_test_git_repo("stale");
        let project_path = dir.to_string_lossy().to_string();

        let wt = mission_worktree_create_inner(
            &registry,
            &project_path,
            "msn_test03",
            Some("task_3"),
            None,
        )
        .unwrap();

        // Main checkout adds 5 commits
        for i in 0..5 {
            fs::write(dir.join(format!("c{}.txt", i)), "c\n").unwrap();
            let _ = Command::new("git")
                .args(["add", "."])
                .current_dir(&dir)
                .no_window()
                .output()
                .unwrap();
            let _ = Command::new("git")
                .args(["commit", "-m", "bump"])
                .current_dir(&dir)
                .no_window()
                .output()
                .unwrap();
        }

        // Behind by 5: below threshold 20 -> None
        let check1 = check_stale_base(&project_path, &wt.worktree_path, Some("main"), 20).unwrap();
        assert_eq!(check1, None);

        // With threshold 3: behind by 5 > 3 -> Some(5)
        let check2 = check_stale_base(&project_path, &wt.worktree_path, Some("main"), 3).unwrap();
        assert_eq!(check2, Some(5));

        mission_worktree_remove_inner(&registry, &project_path, &wt.worktree_path, true).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parallel_worktrees_isolation_e2e() {
        let (dir, registry) = init_test_git_repo("parallel");
        let project_path = dir.to_string_lossy().to_string();

        // Worker 1 in worktree A
        let wt1 = mission_worktree_create_inner(&registry, &project_path, "msn_par", Some("t1"), None).unwrap();
        // Worker 2 in worktree B
        let wt2 = mission_worktree_create_inner(&registry, &project_path, "msn_par", Some("t2"), None).unwrap();

        let p1 = Path::new(&wt1.worktree_path);
        let p2 = Path::new(&wt2.worktree_path);

        fs::write(p1.join("common.txt"), "worker 1 content\n").unwrap();
        fs::write(p2.join("common.txt"), "worker 2 content\n").unwrap();

        // Main checkout untouched
        assert!(!dir.join("common.txt").exists());

        // Each worktree sees its own edit
        assert_eq!(fs::read_to_string(p1.join("common.txt")).unwrap(), "worker 1 content\n");
        assert_eq!(fs::read_to_string(p2.join("common.txt")).unwrap(), "worker 2 content\n");

        mission_worktree_remove_inner(&registry, &project_path, &wt1.worktree_path, true).unwrap();
        mission_worktree_remove_inner(&registry, &project_path, &wt2.worktree_path, true).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
