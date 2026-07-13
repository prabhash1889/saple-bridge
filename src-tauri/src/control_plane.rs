//! Canonical control-plane collection writes (Improvement Plan P0).
//!
//! Bridge is the runtime executor, but the durable agent/run/artifact records are the same
//! canonical `.saple/*.json` files the saple-mcp sidecar owns — so Review, the sidecar, and any MCP
//! reader see one source of truth (no second store). Bridge writes them directly through this Rust
//! layer; it is deliberately *not* an MCP client.
//!
//! Every write is a read-modify-write held under [`fs_lock::with_path_lock`], which nests the
//! cross-process sentinel lock. That is what keeps a concurrent sidecar write (each agent CLI spawns
//! its own `saple-mcp` stdio server) from clobbering a record Bridge just appended.
//!
//! The command is intentionally generic (write one record by `id`, create-or-merge). The record
//! *shapes* live in the frontend (`agentSessionStore` / `controlPlane.ts`) so there is one
//! definition per writer; this layer only enforces containment, the file whitelist, and locking.

use serde_json::Value;

use crate::project::{get_project_file_path, now_iso};

/// The only files this generic writer may touch — the canonical control-plane collections. Without
/// this whitelist a "write arbitrary JSON by id" command would be a way to clobber `tasks.json`,
/// `swarm/state.json`, etc.
const CANONICAL_FILES: &[&str] = &[
    ".saple/agents.json",
    ".saple/runs.json",
    ".saple/artifacts.json",
    ".saple/run-events.json",
];

fn ensure_canonical(file_path: &str) -> Result<(), String> {
    if CANONICAL_FILES.contains(&file_path) {
        Ok(())
    } else {
        Err(format!("'{}' is not a canonical control-plane file", file_path))
    }
}

fn load_array(path: &std::path::Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<Value>(&content).map_err(|e| format!("parse {:?}: {}", path, e))? {
        Value::Array(arr) => Ok(arr),
        _ => Err(format!("{:?} is not a JSON array", path)),
    }
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

/// Shared read-modify-write body behind the [`canonical_record_write`] command. `pub(crate)` so
/// other Rust modules (e.g. `review.rs` closing out a run on a review decision) write the canonical
/// collections through the same locked path instead of re-implementing it.
pub(crate) fn canonical_write_inner(
    project_path: String,
    file_path: String,
    id: String,
    patch: Value,
    create: bool,
) -> Result<Value, String> {
    ensure_canonical(&file_path)?;
    let patch_obj = patch
        .as_object()
        .ok_or_else(|| "patch must be a JSON object".to_string())?
        .clone();

    let path = get_project_file_path(&project_path, &file_path)?;

    crate::fs_lock::with_path_lock(&path, || {
        let mut items = load_array(&path)?;
        let now = now_iso();

        let record = match items.iter_mut().find(|it| id_of(it) == Some(&id)) {
            // Existing record: shallow-merge the patch keys, then bump updatedAt. Callers pass only
            // the changed fields (e.g. a run's {status, finishedAt, summary}) so an update never has
            // to re-read and re-send the whole record — which is exactly where a lost update hides.
            Some(existing) => {
                if let Some(obj) = existing.as_object_mut() {
                    for (k, v) in &patch_obj {
                        obj.insert(k.clone(), v.clone());
                    }
                    obj.insert("updatedAt".to_string(), Value::String(now));
                }
                existing.clone()
            }
            None => {
                if !create {
                    return Err(format!("Record '{}' not found in {}", id, file_path));
                }
                let mut obj = patch_obj.clone();
                obj.insert("id".to_string(), Value::String(id.clone()));
                obj.entry("createdAt")
                    .or_insert_with(|| Value::String(now.clone()));
                obj.insert("updatedAt".to_string(), Value::String(now));
                let record = Value::Object(obj);
                items.push(record.clone());
                record
            }
        };

        let json = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
        crate::fs_lock::write_unlocked(&path, json.as_bytes())?;
        Ok(record)
    })
}

/// Create or update a single record (by `id`) in a canonical control-plane collection.
///
/// - `create = true`: insert `patch` (with `id`) if no record has that id, else merge.
/// - `create = false`: merge into the existing record, or error if it doesn't exist.
///
/// Returns the resulting record. The whole load → merge → save runs under the cross-process lock.
#[tauri::command]
pub async fn canonical_record_write(
    project_path: String,
    file_path: String,
    id: String,
    patch: Value,
    create: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        canonical_write_inner(project_path, file_path, id, patch, create)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempProject {
        path: std::path::PathBuf,
    }
    impl TempProject {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("saple_cp_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join(".saple")).unwrap();
            TempProject { path }
        }
        fn project(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }
    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn create_then_merge_does_not_duplicate() {
        let p = TempProject::new();
        let proj = p.project();

        canonical_write_inner(
            proj.clone(),
            ".saple/runs.json".into(),
            "run_1".into(),
            json!({ "status": "running", "agentId": "agent_1" }),
            true,
        )
        .unwrap();

        // A status change merges into the same record rather than appending a duplicate.
        let updated = canonical_write_inner(
            proj.clone(),
            ".saple/runs.json".into(),
            "run_1".into(),
            json!({ "status": "succeeded", "summary": "done" }),
            false,
        )
        .unwrap();
        assert_eq!(updated["status"], "succeeded");
        assert_eq!(updated["agentId"], "agent_1", "merge keeps existing fields");

        let path = get_project_file_path(&proj, ".saple/runs.json").unwrap();
        let arr = load_array(&path).unwrap();
        assert_eq!(arr.len(), 1, "update must not duplicate the id");
    }

    #[test]
    fn merge_missing_without_create_errors() {
        let p = TempProject::new();
        let err = canonical_write_inner(
            p.project(),
            ".saple/runs.json".into(),
            "nope".into(),
            json!({ "status": "x" }),
            false,
        )
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn rejects_non_canonical_file() {
        let p = TempProject::new();
        let err = canonical_write_inner(
            p.project(),
            ".saple/tasks.json".into(),
            "t".into(),
            json!({}),
            true,
        )
        .unwrap_err();
        assert!(err.contains("canonical"));
    }
}
