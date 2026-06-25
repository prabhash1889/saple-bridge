//! Conversation persistence.
//!
//! When a project is open, conversations live under `.saple/amber/conversations/<id>.json` (written
//! directly via `project::get_project_file_path` + `fs::write` — NOT through the edit-mode-gated
//! file commands, since this is internal app state). With no project open, they fall back to the
//! Tauri app-data dir so general chat still survives a restart.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::types::{Conversation, ConversationSummary};
use crate::project::get_project_file_path;

/// Resolve (and create) the conversations directory for the given context.
fn conversations_dir(app: &AppHandle, project_path: Option<&str>) -> Result<PathBuf, String> {
    let dir = match project_path {
        Some(pp) => get_project_file_path(pp, ".saple/amber/conversations")?,
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("App-data dir error: {}", e))?
            .join("amber")
            .join("conversations"),
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create conversations dir: {}", e))?;
    Ok(dir)
}

pub fn save(app: &AppHandle, project_path: Option<&str>, convo: &Conversation) -> Result<(), String> {
    let dir = conversations_dir(app, project_path)?;
    let path = dir.join(format!("{}.json", sanitize_id(&convo.id)));
    let json = serde_json::to_string_pretty(convo).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to save conversation: {}", e))
}

pub fn load(app: &AppHandle, project_path: Option<&str>, id: &str) -> Result<Conversation, String> {
    let dir = conversations_dir(app, project_path)?;
    let path = dir.join(format!("{}.json", sanitize_id(id)));
    let content = fs::read_to_string(&path).map_err(|e| format!("Conversation not found: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse conversation: {}", e))
}

pub fn delete(app: &AppHandle, project_path: Option<&str>, id: &str) -> Result<(), String> {
    let dir = conversations_dir(app, project_path)?;
    let path = dir.join(format!("{}.json", sanitize_id(id)));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete conversation: {}", e))?;
    }
    Ok(())
}

pub fn list(app: &AppHandle, project_path: Option<&str>) -> Result<Vec<ConversationSummary>, String> {
    let dir = conversations_dir(app, project_path)?;
    let mut out: Vec<ConversationSummary> = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(convo) = serde_json::from_str::<Conversation>(&content) {
                out.push(ConversationSummary {
                    id: convo.id,
                    title: convo.title,
                    provider: convo.provider,
                    model: convo.model,
                    updated_at: convo.updated_at,
                });
            }
        }
    }
    // Newest first.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// Guard against an `id` escaping the conversations dir (it forms a filename).
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
