//! Amber's builtin tools: `read_file` / `write_file` / `list_files` / `run_command`.
//!
//! All four are path-contained to the open project (reusing `project::get_project_file_path`'s
//! canonicalized-prefix guard) and cap their output before it is fed back to the model, to protect
//! the context window. `run_command` reuses `review::run_shell_with_timeout` (PowerShell on
//! Windows) with a short agent-appropriate timeout.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::project::get_project_file_path;
use crate::review::run_shell_with_timeout;

/// Cap on tool output returned to the model (chars). Smaller than the review UI's 800 KB cap —
/// this is sized for an LLM context slot, not on-screen display.
const MAX_TOOL_OUTPUT: usize = 24_000;
const RUN_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LIST_ENTRIES: usize = 400;

/// Anthropic-shaped schemas for the builtin tools (merged with the MCP catalog in `tools.rs`).
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "read_file",
            "description": "Read a UTF-8 text file from the open project. Path is relative to the project root.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Project-relative file path." } },
                "required": ["path"]
            }
        }),
        json!({
            "name": "write_file",
            "description": "Create or overwrite a UTF-8 text file in the open project. Path is relative to the project root.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Project-relative file path." },
                    "content": { "type": "string", "description": "Full new file contents." }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "list_files",
            "description": "List entries in a project directory (non-recursive). Path is relative to the project root; defaults to the root.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Project-relative directory path. Optional." } }
            }
        }),
        json!({
            "name": "run_command",
            "description": "Run a shell command in the project root (PowerShell on Windows) and return its combined stdout/stderr. Times out after 30s.",
            "input_schema": {
                "type": "object",
                "properties": { "command": { "type": "string", "description": "The command line to execute." } },
                "required": ["command"]
            }
        }),
    ]
}

pub fn is_builtin(name: &str) -> bool {
    matches!(name, "read_file" | "write_file" | "list_files" | "run_command")
}

/// Dispatch a builtin. Returns `Ok(text)` on success or `Err(message)` on failure (the caller maps
/// `Err` to an `is_error` tool result so the model can recover).
pub fn dispatch(name: &str, input: &Value, project_path: &str) -> Result<String, String> {
    match name {
        "read_file" => read_file(input, project_path),
        "write_file" => write_file(input, project_path),
        "list_files" => list_files(input, project_path),
        "run_command" => run_command(input, project_path),
        _ => Err(format!("Unknown builtin tool: {}", name)),
    }
}

fn arg_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key]
        .as_str()
        .ok_or_else(|| format!("Missing required argument '{}'", key))
}

fn read_file(input: &Value, project_path: &str) -> Result<String, String> {
    let rel = arg_str(input, "path")?;
    let full = get_project_file_path(project_path, rel)?;
    let content = fs::read_to_string(&full).map_err(|e| format!("Failed to read {}: {}", rel, e))?;
    Ok(cap(content))
}

fn write_file(input: &Value, project_path: &str) -> Result<String, String> {
    let rel = arg_str(input, "path")?;
    let content = arg_str(input, "content")?;
    let full = get_project_file_path(project_path, rel)?;
    fs::write(&full, content).map_err(|e| format!("Failed to write {}: {}", rel, e))?;
    Ok(format!("Wrote {} bytes to {}", content.len(), rel))
}

fn list_files(input: &Value, project_path: &str) -> Result<String, String> {
    let rel = input["path"].as_str().unwrap_or("").trim();
    let dir = contained_dir(project_path, rel)?;
    let mut entries: Vec<String> = Vec::new();
    let read = fs::read_dir(&dir).map_err(|e| format!("Failed to list directory: {}", e))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let suffix = if entry.path().is_dir() { "/" } else { "" };
        entries.push(format!("{}{}", name, suffix));
    }
    entries.sort();
    let total = entries.len();
    if entries.len() > MAX_LIST_ENTRIES {
        entries.truncate(MAX_LIST_ENTRIES);
        entries.push(format!("… ({} more entries omitted)", total - MAX_LIST_ENTRIES));
    }
    Ok(entries.join("\n"))
}

fn run_command(input: &Value, project_path: &str) -> Result<String, String> {
    let command = arg_str(input, "command")?;
    let (output, timed_out) = run_shell_with_timeout(project_path, command, RUN_COMMAND_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut combined = format!("{}{}", stdout, stderr);
    if timed_out {
        combined.push_str(&format!(
            "\n[command stopped after {}s timeout]",
            RUN_COMMAND_TIMEOUT.as_secs()
        ));
    }
    if combined.trim().is_empty() {
        combined = format!("(no output; exit status {})", output.status);
    }
    Ok(cap(combined))
}

/// Resolve a project-relative directory and verify it stays inside the project root. Unlike
/// `get_project_file_path` (which checks the *parent*), this canonicalizes the directory itself so
/// listing the project root (`""`/`"."`) works.
fn contained_dir(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Project path error: {}", e))?;
    let target = if rel.is_empty() || rel == "." {
        base.clone()
    } else {
        base.join(rel)
    };
    let canon = target
        .canonicalize()
        .map_err(|e| format!("Path error: {}", e))?;
    if !canon.starts_with(&base) {
        return Err("Access denied: path is outside the project workspace".to_string());
    }
    Ok(canon)
}

fn cap(mut s: String) -> String {
    if s.chars().count() > MAX_TOOL_OUTPUT {
        let truncated: String = s.chars().take(MAX_TOOL_OUTPUT).collect();
        s = format!("{}\n\n[output truncated to {} chars]", truncated, MAX_TOOL_OUTPUT);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrips_inside_project() {
        let dir = std::env::temp_dir().join(format!("amber_builtin_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pp = dir.to_string_lossy().to_string();

        let w = write_file(&json!({ "path": "note.txt", "content": "hello" }), &pp).unwrap();
        assert!(w.contains("Wrote"));
        let r = read_file(&json!({ "path": "note.txt" }), &pp).unwrap();
        assert_eq!(r, "hello");

        let listed = list_files(&json!({}), &pp).unwrap();
        assert!(listed.contains("note.txt"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_outside_project_is_rejected() {
        let dir = std::env::temp_dir().join(format!("amber_guard_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pp = dir.to_string_lossy().to_string();

        let err = write_file(
            &json!({ "path": "../escape.txt", "content": "x" }),
            &pp,
        );
        assert!(err.is_err(), "expected path-containment rejection");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_long_output() {
        let long = "a".repeat(MAX_TOOL_OUTPUT + 100);
        let capped = cap(long);
        assert!(capped.contains("[output truncated"));
    }
}
