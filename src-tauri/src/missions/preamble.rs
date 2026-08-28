//! Dispatch preamble generation for Missions (Phase M2).
//!
//! Builds the worker's instruction block injected as the prompt file:
//! - Identity ("You are a dispatched worker for Saple mission `<id>`")
//! - `task_id`, `dispatch_id`, `attempt_id`, capability token rules
//! - MCP tools instructions (`saple_step_report`, `saple_artifact_publish`), with markers as fallback
//! - Heartbeat rule (5 min interval)
//! - Worktree rules (branch name, do not touch main checkout)
//! - Raw task spec + links to `mission.md` and relevant artifacts

use std::fs;
use std::path::PathBuf;

use crate::project_roots::canonical_base;

/// Inputs required to assemble a mission worker's dispatch preamble prompt.
#[derive(Debug, Clone)]
pub struct PreambleInput {
    pub mission_id: String,
    pub task_id: String,
    pub dispatch_id: String,
    pub attempt_id: String,
    pub capability_token: String,
    pub supports_mcp: bool,
    pub worktree_branch: Option<String>,
    pub worktree_path: Option<PathBuf>,
    pub task_title: String,
    pub task_kind: String, // "implement" | "review" | "verify"
    pub task_spec: String,
    pub mission_doc_path: PathBuf,
    pub artifact_paths: Vec<PathBuf>,
    pub upstream_summaries: Vec<(String, String)>, // (task_title, summary)
}

/// Generate the prompt instructions markdown block for a dispatched worker.
pub fn generate_preamble(input: &PreambleInput) -> String {
    let mut out = String::new();

    out.push_str(&format!(
        "# Mission Worker Briefing\n\nYou are a dispatched worker for Saple mission `{}`.\n\n",
        input.mission_id
    ));

    out.push_str("## Identity & Dispatch Credentials\n");
    out.push_str(&format!("- **Task ID**: `{}`\n", input.task_id));
    out.push_str(&format!("- **Task Title**: {}\n", input.task_title));
    out.push_str(&format!("- **Task Kind**: `{}`\n", input.task_kind));
    out.push_str(&format!("- **Dispatch ID**: `{}`\n", input.dispatch_id));
    out.push_str(&format!("- **Attempt ID**: `{}`\n\n", input.attempt_id));

    out.push_str("## Reporting & Completion Protocol\n");
    if input.supports_mcp {
        out.push_str("You are connected to the `saple-mcp` sidecar connector.\n");
        out.push_str("Your dispatch capability token is supplied in the environment variable `SAPLE_DISPATCH_TOKEN`.\n");
        out.push_str("When you finish your work or report status, call the `saple_step_report` tool:\n");
        out.push_str("```json\n{\n");
        out.push_str(&format!("  \"dispatch_id\": \"{}\",\n", input.dispatch_id));
        out.push_str(&format!("  \"attempt_id\": \"{}\",\n", input.attempt_id));
        out.push_str("  \"token\": \"<value of env var SAPLE_DISPATCH_TOKEN>\",\n");
        out.push_str("  \"status\": \"done\", // or \"progress\", \"blocked\", \"failed\"\n");
        out.push_str("  \"summary\": \"Concise summary of work performed and results\",\n");
        out.push_str("  \"changed_files\": [\"path/to/changed_file\"]\n");
        out.push_str("}\n```\n\n");
        out.push_str("If you generate reports, specifications, or large outputs, publish them with `saple_artifact_publish`:\n");
        out.push_str("```json\n{\n");
        out.push_str(&format!("  \"dispatch_id\": \"{}\",\n", input.dispatch_id));
        out.push_str("  \"kind\": \"report\",\n");
        out.push_str("  \"path\": \"artifacts/summary.md\",\n");
        out.push_str("  \"label\": \"Final Summary\"\n");
        out.push_str("}\n```\n\n");
        out.push_str("### Heartbeat\n");
        out.push_str(&format!(
            "Your tool calls act as the heartbeat. If executing long operations without tool calls, emit `[SAPLE_HEARTBEAT:{}]` every 5 minutes.\n\n",
            input.dispatch_id
        ));
    } else {
        let token_prefix = if input.capability_token.len() >= 8 {
            &input.capability_token[..8]
        } else {
            &input.capability_token
        };
        out.push_str("This harness runs in marker fallback mode.\n");
        out.push_str("When complete, emit the completion marker in your final output:\n");
        out.push_str(&format!(
            "`[SAPLE_DONE:{}:{}]`\n\n",
            input.dispatch_id, token_prefix
        ));
        out.push_str("If the task fails and cannot proceed, emit:\n");
        out.push_str(&format!(
            "`[SAPLE_FAILED:{}:{}]`\n\n",
            input.dispatch_id, token_prefix
        ));
        out.push_str("### Heartbeat\n");
        out.push_str(&format!(
            "If running long operations, output `[SAPLE_HEARTBEAT:{}]` every 5 minutes.\n\n",
            input.dispatch_id
        ));
    }

    out.push_str("## Workspace & Worktree Rules\n");
    if let Some(branch) = &input.worktree_branch {
        out.push_str(&format!(
            "- You are working in an isolated git worktree on branch `{}`.\n",
            branch
        ));
        if let Some(path) = &input.worktree_path {
            out.push_str(&format!("- Working directory: `{}`\n", path.display()));
        }
        out.push_str("- Do not touch the main repository checkout directly. Stage all changes in your assigned worktree.\n");
    } else {
        out.push_str("- Working in shared workspace mode. Keep all edits scoped to the task requirements.\n");
    }

    if input.task_kind == "review" {
        out.push_str("\n> **REVIEW-ONLY TASK**: You are authorized for code/diff review only. Inspect dependencies and diffs. Findings settle this task; you are NEVER authorized to edit code files.\n");
    } else if input.task_kind == "verify" {
        out.push_str("\n> **VERIFICATION TASK**: Execute test and verification suites. Report all test results and exit codes.\n");
    }
    out.push('\n');

    out.push_str("## Mission Context\n");
    out.push_str(&format!(
        "- Mission Document: [`mission.md`]({})\n",
        input.mission_doc_path.display()
    ));
    if !input.artifact_paths.is_empty() {
        out.push_str("### Available Artifacts:\n");
        for path in &input.artifact_paths {
            let filename = path
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            out.push_str(&format!("- [`{}`]({})\n", filename, path.display()));
        }
    }
    out.push('\n');

    if !input.upstream_summaries.is_empty() {
        out.push_str("## Upstream Dependency Summaries\n");
        for (dep_title, summary) in &input.upstream_summaries {
            out.push_str(&format!("### {}\n{}\n\n", dep_title, summary));
        }
    }

    out.push_str("## Task Specification\n");
    out.push_str(&input.task_spec);
    out.push('\n');

    out
}

/// Write the generated dispatch preamble to `.saple/missions/<mission_id>/prompts/<attempt_id>.md`.
pub fn write_preamble_file(
    project_path: &str,
    mission_id: &str,
    attempt_id: &str,
    content: &str,
) -> Result<PathBuf, String> {
    let base = canonical_base(project_path).map_err(|e| e.to_string())?;
    let prompts_dir = crate::project_roots::contained_target(
        &base,
        &format!(".saple/missions/{}/prompts", mission_id),
    )
    .map_err(|e| e.to_string())?;

    fs::create_dir_all(&prompts_dir)
        .map_err(|e| format!("Failed to create prompts directory: {}", e))?;

    let prompt_file = prompts_dir.join(format!("{}.md", attempt_id));
    fs::write(&prompt_file, content)
        .map_err(|e| format!("Failed to write preamble prompt file: {}", e))?;

    Ok(prompt_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_mcp_hides_secret_token_from_markdown() {
        let input = PreambleInput {
            mission_id: "msn_01JTEST".to_string(),
            task_id: "task_01JTEST".to_string(),
            dispatch_id: "dsp_01JTEST".to_string(),
            attempt_id: "att_01JTEST".to_string(),
            capability_token: "super_secret_token_1234567890".to_string(),
            supports_mcp: true,
            worktree_branch: Some("saple/msn_test/task_test".to_string()),
            worktree_path: Some(PathBuf::from("/repo/.saple/worktrees/task1")),
            task_title: "Implement auth token refresh".to_string(),
            task_kind: "implement".to_string(),
            task_spec: "Create auth refresh endpoint with jwt".to_string(),
            mission_doc_path: PathBuf::from("/repo/.saple/missions/msn_01JTEST/mission.md"),
            artifact_paths: vec![PathBuf::from("/repo/.saple/missions/msn_01JTEST/artifacts/spec.md")],
            upstream_summaries: vec![("Database Migration".to_string(), "Applied users table migration.".to_string())],
        };

        let rendered = generate_preamble(&input);
        // Assert token value is NOT in the prompt markdown
        assert!(!rendered.contains("super_secret_token_1234567890"));
        // Assert env var reference IS in prompt markdown
        assert!(rendered.contains("SAPLE_DISPATCH_TOKEN"));
        assert!(rendered.contains("dsp_01JTEST"));
        assert!(rendered.contains("att_01JTEST"));
        assert!(rendered.contains("saple_step_report"));
        assert!(rendered.contains("saple_artifact_publish"));
        assert!(rendered.contains("saple/msn_test/task_test"));
        assert!(rendered.contains("Database Migration"));
        assert!(rendered.contains("Create auth refresh endpoint with jwt"));
    }

    #[test]
    fn preamble_marker_fallback_includes_token_prefix() {
        let input = PreambleInput {
            mission_id: "msn_01JTEST".to_string(),
            task_id: "task_01JTEST".to_string(),
            dispatch_id: "dsp_01JTEST".to_string(),
            attempt_id: "att_01JTEST".to_string(),
            capability_token: "abcdef123456".to_string(),
            supports_mcp: false,
            worktree_branch: None,
            worktree_path: None,
            task_title: "Review diff".to_string(),
            task_kind: "review".to_string(),
            task_spec: "Inspect security implications".to_string(),
            mission_doc_path: PathBuf::from("/repo/.saple/missions/msn_01JTEST/mission.md"),
            artifact_paths: Vec::new(),
            upstream_summaries: Vec::new(),
        };

        let rendered = generate_preamble(&input);
        assert!(rendered.contains("[SAPLE_DONE:dsp_01JTEST:abcdef12]"));
        assert!(rendered.contains("[SAPLE_FAILED:dsp_01JTEST:abcdef12]"));
        assert!(rendered.contains("REVIEW-ONLY TASK"));
    }

    #[test]
    fn write_preamble_file_creates_file_in_prompts_dir() {
        let temp_dir = std::env::temp_dir().join(format!("saple_preamble_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();

        let prompt_path = write_preamble_file(
            &temp_dir.to_string_lossy(),
            "msn_01JTEST",
            "att_01JTEST",
            "Test preamble content",
        )
        .unwrap();

        assert!(prompt_path.exists());
        assert_eq!(
            fs::read_to_string(&prompt_path).unwrap(),
            "Test preamble content"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
