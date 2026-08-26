//! Read-only cross-project task summaries (Improvement Plan Phase 8.7).
//!
//! Given the renderer's known recent-project paths, reads each project's `.saple/tasks.json`
//! in one batched, blocking worker. Deliberately NOT wired to the approved-root registry:
//! a summary read grants no privileged access, registers no root, starts no watcher or
//! terminal, and never writes to disk (corrupt bytes are reported, never backed up or
//! flagged, because this surface stays strictly read-only across other projects).
//!
//! Outcomes reuse the Phase 2 state-load vocabulary (`missing | loaded | corrupt | locked |
//! ioError`) so the renderer can treat unknown counts fail-closed.

use serde::Serialize;
use std::path::PathBuf;

/// Cap on how many recent projects are summarized per call.
pub(crate) const MAX_SUMMARY_PROJECTS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TaskColumnCounts {
    pub backlog: u32,
    pub progress: u32,
    pub review: u32,
    pub done: u32,
}

/// Mirrors `state_load::StateLoadResult`, minus side effects: a corrupt file is reported
/// without the backup write and write-block flag the privileged loader performs.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProjectSummaryOutcome {
    Missing,
    Loaded { counts: TaskColumnCounts },
    Corrupt { error: String },
    Locked,
    IoError { error: String },
}

#[derive(Debug, Serialize)]
pub struct RecentProjectSummary {
    pub path: String,
    #[serde(flatten)]
    pub outcome: ProjectSummaryOutcome,
}

fn tasks_file_path(project_path: &str) -> Option<PathBuf> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = PathBuf::from(trimmed);
    if !base.is_absolute() {
        return None;
    }
    Some(base.join(".saple").join("tasks.json"))
}

fn count_columns(content: &str) -> Result<TaskColumnCounts, String> {
    let parsed: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("Failed to parse .saple/tasks.json as JSON: {}", e))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| ".saple/tasks.json does not contain a task array".to_string())?;
    let mut counts = TaskColumnCounts {
        backlog: 0,
        progress: 0,
        review: 0,
        done: 0,
    };
    for item in items {
        match item.get("column").and_then(|c| c.as_str()) {
            Some("backlog") => counts.backlog += 1,
            Some("progress") => counts.progress += 1,
            Some("review") => counts.review += 1,
            Some("done") => counts.done += 1,
            _ => {}
        }
    }
    Ok(counts)
}

pub(crate) fn read_project_tasks_summary(project_path: &str) -> ProjectSummaryOutcome {
    use crate::state_load::JsonText;
    let path = match tasks_file_path(project_path) {
        Some(p) => p,
        None => {
            return ProjectSummaryOutcome::IoError {
                error: format!("'{}' is not an absolute project path", project_path),
            }
        }
    };
    if !path.exists() {
        return ProjectSummaryOutcome::Missing;
    }
    if crate::fs_lock::sentinel_held_by_live_process(&path) {
        return ProjectSummaryOutcome::Locked;
    }
    let text = match crate::state_load::read_json_text(&path) {
        JsonText::Ok(t) => t,
        JsonText::Io(e) => return ProjectSummaryOutcome::IoError { error: e.to_string() },
        JsonText::Encoding(m) => return ProjectSummaryOutcome::IoError { error: m },
    };
    match count_columns(&text) {
        Ok(counts) => ProjectSummaryOutcome::Loaded { counts },
        Err(error) => ProjectSummaryOutcome::Corrupt { error },
    }
}

#[tauri::command]
pub async fn get_recent_project_summaries(
    paths: Vec<String>,
) -> Result<Vec<RecentProjectSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .into_iter()
            .take(MAX_SUMMARY_PROJECTS)
            .map(|path| RecentProjectSummary {
                outcome: read_project_tasks_summary(&path),
                path,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use ProjectSummaryOutcome as Outcome;

    struct TempProject(PathBuf);

    impl TempProject {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "saple_summary_{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(path.join(".saple")).unwrap();
            TempProject(path)
        }

        fn write_tasks(&self, content: &str) -> PathBuf {
            let file = self.0.join(".saple").join("tasks.json");
            std::fs::write(&file, content).unwrap();
            file
        }

        fn write_tasks_bytes(&self, content: &[u8]) {
            let file = self.0.join(".saple").join("tasks.json");
            std::fs::write(&file, content).unwrap();
        }

        fn summary(&self) -> Outcome {
            read_project_tasks_summary(&self.0.to_string_lossy())
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_reported_when_no_tasks_file() {
        let p = TempProject::new();
        assert!(matches!(p.summary(), Outcome::Missing));
    }

    #[test]
    fn missing_project_dir_is_missing_not_an_error() {
        let dir = std::env::temp_dir().join(format!("saple_summary_{}", uuid::Uuid::new_v4()));
        assert!(matches!(
            read_project_tasks_summary(&dir.to_string_lossy()),
            Outcome::Missing
        ));
    }

    #[test]
    fn valid_counts_per_column_ignore_unknown_fields() {
        let p = TempProject::new();
        p.write_tasks(
            r#"[
                {"id":"1","column":"progress"},
                {"id":"2","column":"progress"},
                {"id":"3","column":"review"},
                {"id":"4","column":"done"},
                {"id":"5","column":"done"},
                {"id":"6","column":"done"},
                {"id":"7","column":"backlog"},
                {"id":"8","column":"archived"},
                {"id":9}
            ]"#,
        );
        match p.summary() {
            Outcome::Loaded { counts } => assert_eq!(
                counts,
                TaskColumnCounts {
                    backlog: 1,
                    progress: 2,
                    review: 1,
                    done: 3
                }
            ),
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn corrupt_json_reports_corrupt_without_writing_anything() {
        let p = TempProject::new();
        let file = p.write_tasks("{ not json");
        let before = std::fs::read(&file).unwrap();
        match p.summary() {
            Outcome::Corrupt { error } => assert!(error.contains("parse"), "{}", error),
            other => panic!("expected corrupt, got {:?}", other),
        }
        assert_eq!(std::fs::read(&file).unwrap(), before, "bytes must be untouched");
        let saple_entries: Vec<String> = std::fs::read_dir(p.0.join(".saple"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(saple_entries, vec!["tasks.json"], "no backup or flag artifacts may appear");
    }

    #[test]
    fn wrong_shape_is_corrupt_not_loaded() {
        let p = TempProject::new();
        p.write_tasks(r#"{"tasks":[]}"#);
        assert!(matches!(p.summary(), Outcome::Corrupt { .. }));
    }

    #[test]
    fn utf16_bom_is_io_error_not_corrupt() {
        let p = TempProject::new();
        p.write_tasks_bytes(&[0xFF, 0xFE]);
        assert!(matches!(p.summary(), Outcome::IoError { .. }));
    }

    #[test]
    fn relative_path_fails_closed() {
        assert!(matches!(
            read_project_tasks_summary("relative/path"),
            Outcome::IoError { .. }
        ));
        assert!(matches!(read_project_tasks_summary(""), Outcome::IoError { .. }));
    }
}
