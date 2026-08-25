use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use serde::{Serialize, Deserialize};
use crate::error_code::CodedError;
use crate::memory_layout;
use crate::project_roots::ProjectRootRegistry;

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryNode {
    pub id: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryEdge {
    pub source: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryGraph {
    pub nodes: Vec<MemoryNode>,
    pub edges: Vec<MemoryEdge>,
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Verify a freshly created snapshot actually captured every file under `src`:
/// each source file must exist in the snapshot and be byte-for-byte identical.
/// This proves a valid backup exists before any destructive step runs.
fn verify_snapshot_copies_source(src: &Path, snapshot: &Path) -> Result<(), String> {
    fn walk(src: &Path, snap: &Path, rel: &Path) -> Result<(), String> {
        for entry in fs::read_dir(src).map_err(|e| format!("reading {}: {}", src.display(), e))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let child_rel = rel.join(entry.file_name());
            if path.is_dir() {
                walk(&path, &snap.join(entry.file_name()), &child_rel)?;
            } else {
                let snap_path = snap.join(entry.file_name());
                let expected = fs::read(&path)
                    .map_err(|e| format!("reading source {}: {}", path.display(), e))?;
                let actual = fs::read(&snap_path).map_err(|e| {
                    format!(
                        "reading snapshot copy {} of {}: {}",
                        snap_path.display(),
                        child_rel.display(),
                        e
                    )
                })?;
                if actual != expected {
                    return Err(format!(
                        "snapshot copy of {} does not match the source file",
                        child_rel.display()
                    ));
                }
            }
        }
        Ok(())
    }

    walk(src, snapshot, Path::new(""))
}

/// True if `dir` (recursively) contains at least one regular file.
fn dir_contains_any_file(dir: &Path) -> bool {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if dir_contains_any_file(&path) {
                    return true;
                }
            } else {
                return true;
            }
        }
    }
    false
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;
    
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let months_days = if (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1usize;
    for &md in &months_days {
        if remaining < md { break; }
        remaining -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, remaining + 1, hours, minutes, seconds)
}

/// Emit `s` as a double-quoted YAML scalar so a value containing `:`, `#`, a newline, or quotes
/// can't break out of the frontmatter block — i.e. a memory note's title/tag/alias can't inject
/// extra YAML keys (or terminate the `---` block early). Always quotes, for simplicity.
fn yaml_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Inverse of [`yaml_quote`]: strip surrounding double quotes and unescape. Plain (unquoted)
/// values — including every memory file written before quoting was introduced — pass through
/// unchanged, so this is backward compatible.
fn yaml_unquote(s: &str) -> String {
    let t = s.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let inner = &t[1..t.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => out.push(other),
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        t.to_string()
    }
}

#[allow(dead_code)]
pub struct ParsedMemory {
    pub id: String,
    pub category: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub title: String,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub unknown_frontmatter: HashMap<String, String>,
    pub body: String,
}

pub fn parse_memory_file(content: &str, relative_path: &str) -> ParsedMemory {
    let mut id = String::new();
    let mut category = "general".to_string();
    let mut tags = Vec::new();
    let mut aliases = Vec::new();
    let mut created = None;
    let mut updated = None;
    let mut unknown_frontmatter = HashMap::new();
    let mut body_lines = Vec::new();

    let mut in_frontmatter = false;
    let mut frontmatter_count = 0;

    // When a `key:` with no inline value introduces a YAML list, this points at the
    // vec receiving the `- item` continuation lines ("tags" or "aliases").
    let mut current_list: Option<&'static str> = None;

    // Parse a `key: [a, b]` / `key: a, b` inline list into trimmed, non-empty parts. Each element
    // is unquoted so a list written as `["a, b", c]` round-trips through quoting cleanly.
    fn parse_inline_list(val: &str) -> Vec<String> {
        val.trim_matches(|c| c == '[' || c == ']')
            .split(',')
            .map(yaml_unquote)
            .filter(|s| !s.is_empty())
            .collect()
    }

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            frontmatter_count += 1;
            current_list = None;
            continue;
        }

        if in_frontmatter && frontmatter_count == 1 {
            if let Some(list_key) = current_list {
                let item = if let Some(rest) = trimmed.strip_prefix("- ") {
                    Some(yaml_unquote(rest))
                } else {
                    trimmed.strip_prefix("  - ").map(yaml_unquote)
                };
                if let Some(item) = item {
                    if list_key == "tags" { tags.push(item); } else { aliases.push(item); }
                    continue;
                } else if trimmed.contains(':') {
                    current_list = None; // list ended; fall through to parse this key
                } else {
                    continue;
                }
            }

            if let Some(pos) = trimmed.find(':') {
                let key = trimmed[..pos].trim();
                let val = trimmed[pos + 1..].trim();

                match key {
                    "id" => id = yaml_unquote(val),
                    "category" => category = yaml_unquote(val),
                    "created" => created = Some(yaml_unquote(val)),
                    "updated" => updated = Some(yaml_unquote(val)),
                    "tags" => {
                        if val.is_empty() {
                            current_list = Some("tags");
                        } else {
                            tags = parse_inline_list(val);
                        }
                    }
                    "aliases" => {
                        if val.is_empty() {
                            current_list = Some("aliases");
                        } else {
                            aliases = parse_inline_list(val);
                        }
                    }
                    _ => {
                        unknown_frontmatter.insert(key.to_string(), yaml_unquote(val));
                    }
                }
            }
        } else {
            body_lines.push(line);
        }
    }
    
    let body = body_lines.join("\n");
    let mut first_h1 = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            first_h1 = rest.trim().to_string();
            break;
        }
    }
    
    if id.is_empty() {
        let path = Path::new(relative_path);
        id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    }
    
    let title = if !first_h1.is_empty() {
        first_h1
    } else {
        id.clone()
    };
    
    ParsedMemory {
        id,
        category,
        tags,
        aliases,
        title,
        created,
        updated,
        unknown_frontmatter,
        body,
    }
}

/// Extract `[[wikilink]]` targets from a markdown body, skipping fenced code blocks (```` ``` ````
/// / `~~~`) and inline code spans (`` `...` ``). This mirrors the AST-based skip in
/// `remarkWikilinks.ts`, so a `[[x]]` written inside a code sample doesn't create a spurious graph
/// edge. `[[target|label]]` keeps only `target` for resolution.
pub fn extract_wikilinks(body: &str) -> Vec<String> {
    let mut wikilinks = Vec::new();
    let mut fence: Option<char> = None;

    for line in body.lines() {
        let trimmed = line.trim_start();
        // Toggle fenced code blocks on a ``` / ~~~ delimiter line.
        let delim = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(marker) = delim {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }

        // Drop inline code spans before scanning: segments between backticks are code. Splitting on
        // '`' yields outside-code at even indices and inside-code at odd indices.
        let scan: String = line
            .split('`')
            .enumerate()
            .filter(|(i, _)| i % 2 == 0)
            .map(|(_, s)| s)
            .collect::<Vec<_>>()
            .join(" ");

        let mut rest = scan.as_str();
        while let Some(start) = rest.find("[[") {
            if let Some(end) = rest[start..].find("]]") {
                let link = rest[start + 2..start + end].trim();
                // [[target|label]] — only the target participates in edge resolution.
                let target = link.split('|').next().unwrap_or(link).trim();
                if !target.is_empty() {
                    wikilinks.push(target.to_string());
                }
                rest = &rest[start + end + 2..];
            } else {
                break;
            }
        }
    }

    wikilinks
}

pub fn parse_markdown_memory(content: &str, relative_path: &str) -> (MemoryNode, Vec<String>) {
    let parsed = parse_memory_file(content, relative_path);

    let wikilinks = extract_wikilinks(&parsed.body);

    (
        MemoryNode {
            id: parsed.id,
            title: parsed.title,
            category: parsed.category,
            tags: parsed.tags,
            aliases: parsed.aliases,
            file_path: relative_path.to_string(),
        },
        wikilinks
    )
}

#[tauri::command]
pub async fn get_memory_graph(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MemoryGraph, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || get_memory_graph_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_memory_graph_inner(project_path: String) -> Result<MemoryGraph, String> {
    let memory_dir = memory_layout::get_memory_dir(&project_path);
    if !memory_dir.exists() {
        return Ok(MemoryGraph { nodes: vec![], edges: vec![] });
    }
    
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    
    // Maps filename/id -> node_id to resolve link targets
    let mut id_lookup = HashMap::new();
    
    // Vector to store temporary links to resolve after all nodes are loaded
    let mut pending_links: Vec<(String, Vec<String>)> = Vec::new();
    
    // Walk directory recursively
    fn walk_dir(dir: &Path, base_dir: &Path, nodes: &mut Vec<MemoryNode>, pending_links: &mut Vec<(String, Vec<String>)>, id_lookup: &mut HashMap<String, String>) -> Result<(), String> {
        if dir.is_dir() {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_dir() {
                    walk_dir(&path, base_dir, nodes, pending_links, id_lookup)?;
                } else if path.extension().is_some_and(|ext| ext == "md") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        let relative_path = path.strip_prefix(base_dir).unwrap_or(&path).to_string_lossy().to_string();
                        let (node, links) = parse_markdown_memory(&content, &relative_path);
                        
                        // Register in lookups
                        id_lookup.insert(node.id.clone(), node.id.clone());
                        let file_stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                        id_lookup.insert(file_stem, node.id.clone());
                        // Aliases also resolve `[[alias]]` wikilinks to this node.
                        for alias in &node.aliases {
                            id_lookup.entry(alias.clone()).or_insert_with(|| node.id.clone());
                        }

                        pending_links.push((node.id.clone(), links));
                        nodes.push(node);
                    }
                }
            }
        }
        Ok(())
    }
    
    walk_dir(&memory_dir, &memory_dir, &mut nodes, &mut pending_links, &mut id_lookup)?;
    
    // Resolve edges from pending links.
    // Use a HashSet to dedupe in O(1) instead of an O(E) linear scan per edge (was O(E^2) overall).
    let mut seen_edges: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for (source_id, links) in pending_links {
        for link in links {
            if let Some(target_id) = id_lookup.get(&link) {
                if seen_edges.insert((source_id.clone(), target_id.clone())) {
                    edges.push(MemoryEdge {
                        source: source_id.clone(),
                        target: target_id.clone(),
                    });
                }
            }
        }
    }
    
    Ok(MemoryGraph { nodes, edges })
}

#[tauri::command]
pub async fn create_memory_snapshot(
    project_path: String,
    name: String,
    overwrite: Option<bool>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        create_memory_snapshot_inner(project_path, name, overwrite.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transactional snapshot creation (Phase 2): copy into a temporary sibling, verify the copy
/// byte-for-byte, and only then atomically swap it into place. An existing snapshot is never
/// overwritten unless the caller explicitly confirms (`overwrite = true`, backed by a UI
/// confirmation), and any failure leaves the previous snapshot untouched.
fn create_memory_snapshot_inner(project_path: String, name: String, overwrite: bool) -> Result<(), CodedError> {
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(CodedError::invalid_path(
            "Snapshot name must contain only alphanumeric characters, dashes, or underscores",
        ));
    }

    let memory_dir = memory_layout::get_memory_dir(&project_path);
    if !memory_dir.exists() {
        return Err(CodedError::internal("No memories found to snapshot"));
    }

    let snapshots_dir = memory_layout::snapshots_dir(&project_path);
    let snapshot_dir = snapshots_dir.join(&name);

    // Stage into a temporary sibling so a failed or partial copy never replaces an existing
    // snapshot (and no half-built directory ever appears under the real name).
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp_dir = snapshots_dir.join(format!(".{}.tmp-{}-{}", name, std::process::id(), unique));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&snapshots_dir).map_err(|e| e.to_string())?;

    let staged: Result<(), CodedError> = (|| {
        copy_dir_all(&memory_dir, &tmp_dir)?;
        verify_snapshot_copies_source(&memory_dir, &tmp_dir)?;
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    // Swap only after validation. Refuse to clobber an existing snapshot without confirmation.
    if snapshot_dir.exists() {
        if !overwrite {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(CodedError::already_exists(format!(
                "Snapshot {} already exists. Confirm overwrite to replace it.",
                name
            )));
        }
        fs::remove_dir_all(&snapshot_dir).map_err(|e| {
            let _ = fs::remove_dir_all(&tmp_dir);
            CodedError::from(e.to_string())
        })?;
    }
    if let Err(e) = crate::fs_lock::rename_with_retry(&tmp_dir, &snapshot_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e.into());
    }

    Ok(())
}

#[tauri::command]
pub async fn restore_memory_snapshot(
    project_path: String,
    name: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), CodedError> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || restore_memory_snapshot_inner(project_path, name))
        .await
        .map_err(|e| e.to_string())?
        .map_err(CodedError::from)
}

fn restore_memory_snapshot_inner(project_path: String, name: String) -> Result<(), String> {
    // Validate the name the same way `create_memory_snapshot_inner` does so a crafted `name`
    // (e.g. `../../etc`) can't make the join escape the snapshots dir.
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("Snapshot name must contain only alphanumeric characters, dashes, or underscores".to_string());
    }

    let snapshot_dir = memory_layout::snapshots_dir(&project_path).join(&name);
    if !snapshot_dir.exists() {
        return Err(format!("Snapshot {} not found", name));
    }

    let memory_dir = memory_layout::get_memory_dir(&project_path);
    if memory_dir.exists() && dir_contains_any_file(&memory_dir) {
        // Safety snapshot FIRST. Live memory must not be touched until a verified
        // valid backup exists; any failure here aborts the whole restore.
        let backup_name = format!("pre-restore-{}", now_iso().replace(':', "-"));
        create_memory_snapshot_inner(project_path.clone(), backup_name.clone(), false).map_err(|e| {
            format!(
                "Restore aborted: pre-restore safety snapshot failed ({}). Live memory was left untouched.",
                e
            )
        })?;
        let backup_dir = memory_layout::snapshots_dir(&project_path).join(&backup_name);
        verify_snapshot_copies_source(&memory_dir, &backup_dir).map_err(|e| {
            format!(
                "Restore aborted: pre-restore safety snapshot could not be verified ({}). Live memory was left untouched.",
                e
            )
        })?;
    }

    let write_dirs = memory_layout::write_dirs(&project_path);

    // Restore transactionally per target directory (Phase 2): stage the snapshot copy in a
    // temporary sibling, verify it byte-for-byte against the snapshot, and only then swap it
    // into place. A failed restore can no longer leave live memory half-deleted.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for dir in write_dirs {
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        let parent = dir.parent().ok_or_else(|| "Invalid memory directory".to_string())?;
        let dir_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "memory".to_string());
        let staged_dir = parent.join(format!(".{}.restore-{}-{}", dir_name, std::process::id(), unique));

        let staged = copy_dir_all(&snapshot_dir, &staged_dir)
            .and_then(|_| verify_snapshot_copies_source(&snapshot_dir, &staged_dir).map_err(|e| e.to_string()));
        if let Err(e) = staged {
            let _ = fs::remove_dir_all(&staged_dir);
            return Err(e);
        }

        // Swap: move the old live dir aside, put the staged copy in place, then drop the old.
        let old_dir = parent.join(format!(".{}.old-{}-{}", dir_name, std::process::id(), unique));
        let _ = fs::remove_dir_all(&old_dir);
        let swapped = if dir.exists() {
            crate::fs_lock::rename_with_retry(&dir, &old_dir)
                .and_then(|_| crate::fs_lock::rename_with_retry(&staged_dir, &dir))
        } else {
            crate::fs_lock::rename_with_retry(&staged_dir, &dir)
        };
        match swapped {
            Ok(()) => {
                let _ = fs::remove_dir_all(&old_dir);
            }
            Err(e) => {
                // Roll the live directory back into place; nothing was lost.
                let _ = fs::remove_dir_all(&staged_dir);
                if old_dir.exists() && !dir.exists() {
                    let _ = crate::fs_lock::rename_with_retry(&old_dir, &dir);
                }
                return Err(e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn list_memory_snapshots(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<String>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || list_memory_snapshots_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_memory_snapshots_inner(project_path: String) -> Result<Vec<String>, String> {
    let snapshots_dir = memory_layout::snapshots_dir(&project_path);
    if !snapshots_dir.exists() {
        return Ok(vec![]);
    }
    
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(snapshots_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name() {
                snapshots.push(name.to_string_lossy().to_string());
            }
        }
    }
    
    Ok(snapshots)
}

#[tauri::command]
pub async fn delete_memory_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || delete_memory_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn delete_memory_file_inner(project_path: String, file_path: String) -> Result<(), String> {
    let delete_dirs = memory_layout::write_dirs(&project_path);

    for dir in delete_dirs {
        let full_path = dir.join(&file_path);
        if full_path.exists() {
            // Contain to the *memory dir* (not the project root): a crafted `file_path` like
            // `../tasks.json` must not be able to delete other project files.
            let canonical_base = dir.canonicalize().map_err(|e| e.to_string())?;
            let canonical_target = full_path.canonicalize().map_err(|e| e.to_string())?;
            if !canonical_target.starts_with(&canonical_base) {
                return Err("Access denied: path is outside the memory directory".to_string());
            }
            fs::remove_file(full_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_memory_file(
    project_path: String,
    file_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || read_memory_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_memory_file_inner(project_path: String, file_path: String) -> Result<String, String> {
    let memory_dir = memory_layout::get_memory_dir(&project_path);
    let full_path = memory_dir.join(&file_path);

    if full_path.exists() {
        // Contain to the *memory dir* (not the project root): a crafted `file_path` like
        // `../tasks.json` must not be able to read other project files.
        let canonical_base = memory_dir.canonicalize().map_err(|e| e.to_string())?;
        let canonical_target = full_path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("Access denied: path is outside the memory directory".to_string());
        }
        fs::read_to_string(full_path).map_err(|e| e.to_string())
    } else {
        Err("File not found".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn save_memory_node(
    project_path: String,
    id: String,
    title: String,
    category: String,
    tags: Vec<String>,
    aliases: Vec<String>,
    content: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MemoryNode, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_memory_node_inner(project_path, id, title, category, tags, aliases, content)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Category and id become single path components of the note file. Reject anything that could
/// traverse out of the memory dir (separators, `..`, drive colons) instead of trying to
/// sanitize it away — `clean_*` only normalizes spaces/case, it is not a security boundary.
fn validate_note_path_component(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.contains(':')
        || value.contains('\0')
    {
        return Err(format!(
            "Invalid {} '{}': must not be empty or contain path separators / traversal sequences",
            what, value
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_memory_node_inner(
    project_path: String,
    id: String,
    title: String,
    category: String,
    tags: Vec<String>,
    aliases: Vec<String>,
    content: String,
) -> Result<MemoryNode, String> {
    let clean_category = category.trim().to_lowercase().replace(' ', "-");
    let clean_id = id.trim().to_lowercase().replace(' ', "-");
    validate_note_path_component(&clean_category, "category")?;
    validate_note_path_component(&clean_id, "id")?;
    let relative_path = format!("{}/{}.md", clean_category, clean_id);
    
    let read_dir = memory_layout::get_memory_dir(&project_path);

    let mut created_time = now_iso();
    let mut unknown_fields = HashMap::new();
    
    let mut old_relative_path = None;
    if let Some((_, node, _)) = find_note_file_inner(&read_dir, &clean_id) {
        let old_rel = format!("{}/{}.md", node.category, clean_id);
        old_relative_path = Some(old_rel.clone());
        let old_full_path = read_dir.join(&old_rel);
        if old_full_path.exists() {
            if let Ok(content_str) = fs::read_to_string(&old_full_path) {
                let parsed = parse_memory_file(&content_str, &old_rel);
                if let Some(c) = parsed.created {
                    created_time = c;
                }
                unknown_fields = parsed.unknown_frontmatter;
            }
        }
    }
    
    // All user-controlled scalars are double-quoted so a title/tag/alias containing `:`, `#`, a
    // newline, or quotes can't inject extra frontmatter keys or terminate the `---` block.
    let quoted_tags = tags.iter().map(|t| yaml_quote(t)).collect::<Vec<_>>().join(", ");
    let mut frontmatter = format!(
        "---\nid: {}\ncategory: {}\ntags: [{}]\ncreated: {}\nupdated: {}\n",
        yaml_quote(&clean_id),
        yaml_quote(&clean_category),
        quoted_tags,
        created_time,
        now_iso()
    );

    // Only emit `aliases` when present, keeping files clean for the common case.
    if !aliases.is_empty() {
        let quoted_aliases = aliases.iter().map(|a| yaml_quote(a)).collect::<Vec<_>>().join(", ");
        frontmatter.push_str(&format!("aliases: [{}]\n", quoted_aliases));
    }

    for (k, v) in &unknown_fields {
        frontmatter.push_str(&format!("{}: {}\n", k, yaml_quote(v)));
    }
    frontmatter.push_str("---\n\n");
    
    let body_trimmed = content.trim();
    let full_content = if body_trimmed.starts_with("# ") {
        format!("{}{}", frontmatter, body_trimmed)
    } else {
        format!("{}# {}\n\n{}", frontmatter, title, body_trimmed)
    };
    
    let write_dirs = memory_layout::write_dirs(&project_path);

    for dir in &write_dirs {
        // Contain to the *memory dir* (not the project root), mirroring the delete/read paths.
        // The component validation above already blocks traversal; the canonicalize check stays
        // as defense-in-depth (e.g. against symlinked category dirs).
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
        let full_path = dir.join(&relative_path);
        if let Some(parent) = full_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
            if !canonical_parent.starts_with(&canonical_dir) {
                return Err("Access denied: path is outside the memory directory".to_string());
            }
        }
        crate::fs_lock::atomic_write(&full_path, full_content.as_bytes())?;
    }

    if let Some(old_rel) = old_relative_path {
        // `old_rel`'s category component comes from the old file's frontmatter — validate it too
        // so a crafted note can't steer the cleanup `remove_file` outside the memory dir.
        if old_rel != relative_path
            && old_rel
                .split('/')
                .all(|part| validate_note_path_component(part, "path").is_ok())
        {
            for dir in &write_dirs {
                let old_path = dir.join(&old_rel);
                if old_path.exists() {
                    let _ = fs::remove_file(old_path);
                }
            }
        }
    }
    
    Ok(MemoryNode {
        id: clean_id,
        title,
        category: clean_category,
        tags,
        aliases,
        file_path: relative_path,
    })
}

fn find_note_file_inner(memory_dir: &Path, id: &str) -> Option<(PathBuf, MemoryNode, String)> {
    fn walk(dir: &Path, id: &str) -> Option<(PathBuf, MemoryNode, String)> {
        if dir.is_dir() {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        if let Some(res) = walk(&path, id) {
                            return Some(res);
                        }
                    } else if path.extension().is_some_and(|ext| ext == "md") {
                        if let Ok(content) = fs::read_to_string(&path) {
                            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            let (node, _) = parse_markdown_memory(&content, &filename);
                            if node.id == id {
                                return Some((path, node, content));
                            }
                        }
                    }
                }
            }
        }
        None
    }
    walk(memory_dir, id)
}

#[derive(Serialize, Clone)]
pub struct UnlinkedMention {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub snippet: String,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Replace every `[[...]]` span with spaces of equal char-length, so already-linked
/// text isn't reported as an unlinked mention while character indices stay aligned
/// with the original body (for snippet extraction).
fn mask_wikilinks(body: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '[' && chars[i + 1] == '[' {
            let mut j = i + 2;
            let mut close = None;
            while j + 1 < chars.len() {
                if chars[j] == ']' && chars[j + 1] == ']' {
                    close = Some(j + 1);
                    break;
                }
                j += 1;
            }
            if let Some(end) = close {
                for _ in i..=end {
                    out.push(' ');
                }
                i = end + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// First index where `needle` occurs in `haystack` on word boundaries, else None.
fn find_whole_word(haystack: &[char], needle: &[char]) -> Option<usize> {
    let n = needle.len();
    if n == 0 || n > haystack.len() {
        return None;
    }
    let mut i = 0;
    while i + n <= haystack.len() {
        if haystack[i..i + n] == needle[..] {
            let before_ok = i == 0 || !is_word_char(haystack[i - 1]);
            let after_ok = i + n == haystack.len() || !is_word_char(haystack[i + n]);
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn collect_notes(dir: &Path, base: &Path, out: &mut Vec<(MemoryNode, String, Vec<String>)>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_notes(&path, base, out);
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(content) = fs::read_to_string(&path) {
                    let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
                    let (node, links) = parse_markdown_memory(&content, &rel);
                    let parsed = parse_memory_file(&content, &rel);
                    out.push((node, parsed.body, links));
                }
            }
        }
    }
}

/// Case-insensitive full-text search over note titles and bodies. Returns matching note ids;
/// the Memory list uses them to widen its instant title/tag filter to note content.
#[tauri::command]
pub async fn search_memory_content(
    project_path: String,
    query: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<String>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || search_memory_content_inner(project_path, query))
        .await
        .map_err(|e| e.to_string())?
}

fn search_memory_content_inner(project_path: String, query: String) -> Result<Vec<String>, String> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let memory_dir = memory_layout::get_memory_dir(&project_path);
    if !memory_dir.exists() {
        return Ok(vec![]);
    }

    let mut notes = Vec::new();
    collect_notes(&memory_dir, &memory_dir, &mut notes);

    let mut ids: Vec<String> = notes
        .into_iter()
        .filter(|(node, body, _)| {
            node.title.to_lowercase().contains(&q) || body.to_lowercase().contains(&q)
        })
        .map(|(node, _, _)| node.id)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Notes whose body mentions this note's title/alias as plain text without a
/// `[[link]]` — Obsidian's "unlinked mentions". One entry per source note.
#[tauri::command]
pub async fn get_unlinked_mentions(
    project_path: String,
    id: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<UnlinkedMention>, String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || get_unlinked_mentions_inner(project_path, id))
        .await
        .map_err(|e| e.to_string())?
}

fn get_unlinked_mentions_inner(project_path: String, id: String) -> Result<Vec<UnlinkedMention>, String> {
    let memory_dir = memory_layout::get_memory_dir(&project_path);
    if !memory_dir.exists() {
        return Ok(vec![]);
    }

    // The target's matchable names: its title plus any aliases (min 3 chars to
    // avoid noisy matches on short words).
    let target = match find_note_file_inner(&memory_dir, &id) {
        Some((_, node, _)) => node,
        None => return Ok(vec![]),
    };
    let mut target_names: Vec<String> = vec![target.title.clone()];
    target_names.extend(target.aliases.iter().cloned());
    let target_names: Vec<String> = target_names
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| s.chars().count() >= 3)
        .collect();
    if target_names.is_empty() {
        return Ok(vec![]);
    }
    // ASCII-lowercase keeps a 1:1 char mapping so match indices stay aligned with
    // the original (non-lowercased) body for snippet slicing.
    let names_lower: Vec<Vec<char>> = target_names
        .iter()
        .map(|s| s.chars().map(|c| c.to_ascii_lowercase()).collect())
        .collect();

    let mut entries: Vec<(MemoryNode, String, Vec<String>)> = Vec::new();
    collect_notes(&memory_dir, &memory_dir, &mut entries);

    let mut mentions = Vec::new();
    for (node, body, links) in entries {
        if node.id == id {
            continue;
        }
        // Skip if the source already links to the target (by id or any name).
        let already_linked = links.iter().any(|l| {
            let ll = l.trim();
            ll == id || target_names.iter().any(|n| n.eq_ignore_ascii_case(ll))
        });
        if already_linked {
            continue;
        }

        let orig: Vec<char> = body.chars().collect();
        let masked_lower: Vec<char> = mask_wikilinks(&body)
            .chars()
            .map(|c| c.to_ascii_lowercase())
            .collect();

        // Earliest whole-word match across all names.
        let mut best: Option<(usize, usize)> = None;
        for name in &names_lower {
            if let Some(pos) = find_whole_word(&masked_lower, name) {
                if best.is_none_or(|(b, _)| pos < b) {
                    best = Some((pos, name.len()));
                }
            }
        }

        if let Some((pos, nlen)) = best {
            let start = pos.saturating_sub(40);
            let end = (pos + nlen + 40).min(orig.len());
            let mut snippet: String = orig[start..end].iter().collect();
            snippet = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
            if start > 0 {
                snippet = format!("…{}", snippet);
            }
            if end < orig.len() {
                snippet = format!("{}…", snippet);
            }
            mentions.push(UnlinkedMention {
                source_id: node.id,
                source_title: node.title,
                snippet,
            });
        }
    }

    Ok(mentions)
}

/// Append a `[[target]]` reference to the source note's body (idempotent).
#[tauri::command]
pub async fn add_memory_link(
    project_path: String,
    source: String,
    target: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.ensure_inside_approved_root(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || add_memory_link_inner(project_path, source, target))
        .await
        .map_err(|e| e.to_string())?
}

fn add_memory_link_inner(project_path: String, source: String, target: String) -> Result<(), String> {
    let memory_dir = memory_layout::get_memory_dir(&project_path);
    let (_, node, content) = find_note_file_inner(&memory_dir, &source)
        .ok_or_else(|| format!("Source note '{}' not found", source))?;

    let link_tag = format!("[[{}]]", target);
    if content.contains(&link_tag) {
        return Ok(()); // already linked — no-op
    }

    // Body without frontmatter + leading H1 (save re-adds the H1 from the title).
    let parsed = parse_memory_file(&content, &node.file_path);
    let mut body = parsed.body;
    if body.trim_start().starts_with("# ") {
        let lines: Vec<&str> = body.trim_start().lines().collect();
        body = lines[1..].join("\n");
    }

    let new_body = format!("{}\n\nRelated: [[{}]]", body.trim(), target);
    save_memory_node_inner(
        project_path,
        node.id,
        node.title,
        node.category,
        node.tags,
        node.aliases,
        new_body,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inline_aliases() {
        let md = "---\nid: jwt\ncategory: decision\naliases: [JSON Web Token, token auth]\n---\n# JWT\n";
        let parsed = parse_memory_file(md, "decision/jwt.md");
        assert_eq!(parsed.aliases, vec!["JSON Web Token", "token auth"]);
    }

    #[test]
    fn yaml_quote_unquote_round_trips_injection_attempt() {
        // A title crafted to break out of the frontmatter and inject a fake `category`.
        let nasty = "evil\ncategory: decision\ninjected: yes";
        let quoted = yaml_quote(nasty);
        assert!(!quoted.contains('\n'), "newline must be escaped, got: {}", quoted);
        assert_eq!(yaml_unquote(&quoted), nasty);
    }

    #[test]
    fn yaml_unquote_passes_through_plain_values() {
        // Legacy unquoted files stay readable.
        assert_eq!(yaml_unquote("decision"), "decision");
        assert_eq!(yaml_unquote("JSON Web Token"), "JSON Web Token");
    }

    #[test]
    fn save_then_parse_preserves_injection_safe_title() {
        let dir = std::env::temp_dir().join(format!("saple-mem-test-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let project = dir.canonicalize().unwrap();

        let node = save_memory_node_inner(
            project.to_string_lossy().to_string(),
            "test-note".to_string(),
            "Title".to_string(),
            "decision".to_string(),
            vec!["tag: with colon".to_string()],
            vec![],
            "evil\ncategory: pwned\n# Heading\nbody".to_string(),
        )
        .unwrap();

        let saved = fs::read_to_string(project.join(".saple/memory").join(&node.file_path)).unwrap();
        let parsed = parse_memory_file(&saved, &node.file_path);
        // The injected `category: pwned` lived in the body, not the frontmatter.
        assert_eq!(parsed.category, "decision");
        assert_eq!(parsed.tags, vec!["tag: with colon"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_yaml_list_aliases_and_tags() {
        let md = "---\nid: jwt\ncategory: decision\ntags:\n  - auth\n  - jwt\naliases:\n  - JSON Web Token\n---\n# JWT\n";
        let parsed = parse_memory_file(md, "decision/jwt.md");
        assert_eq!(parsed.tags, vec!["auth", "jwt"]);
        assert_eq!(parsed.aliases, vec!["JSON Web Token"]);
    }

    #[test]
    fn extract_wikilinks_skips_code_and_strips_labels() {
        let body = "\
See [[real-note]] and [[other|Other label]].

```
let x = \"[[fenced-code]]\";
```

Inline `[[inline-code]]` should not count either.

~~~
[[tilde-fence]]
~~~
";
        let links = extract_wikilinks(body);
        // Real links resolve; the `|label` part is dropped from the target.
        assert!(links.contains(&"real-note".to_string()));
        assert!(links.contains(&"other".to_string()));
        // Links inside fenced / inline code must not produce edges.
        assert!(!links.contains(&"fenced-code".to_string()));
        assert!(!links.contains(&"inline-code".to_string()));
        assert!(!links.contains(&"tilde-fence".to_string()));
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn extract_wikilinks_fenced_block_only_yields_no_edge() {
        // Mirrors the plan's required case: a single `[[x]]` inside a fenced block → no edge.
        let body = "```\n[[x]]\n```\n";
        assert!(extract_wikilinks(body).is_empty());
    }

    #[test]
    fn mask_wikilinks_blanks_links_preserving_length() {
        let body = "see [[jwt]] here";
        let masked = mask_wikilinks(body);
        assert_eq!(masked.chars().count(), body.chars().count());
        assert!(!masked.contains("jwt"));
        assert!(masked.contains("see"));
        assert!(masked.contains("here"));
    }

    #[test]
    fn read_memory_file_rejects_traversal_outside_memory_dir() {
        let dir = std::env::temp_dir().join(format!("saple-mem-trav-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let project = dir.canonicalize().unwrap_or(dir.clone());
        fs::create_dir_all(project.join(".saple").join("memory")).unwrap();
        // A secret living at the project root, *outside* the memory dir.
        fs::write(project.join("secret.txt"), "top secret").unwrap();

        let err = read_memory_file_inner(
            project.to_string_lossy().to_string(),
            "../../secret.txt".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("Access denied"), "got: {}", err);

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn delete_memory_file_rejects_traversal_outside_memory_dir() {
        let dir = std::env::temp_dir().join(format!("saple-mem-deltrav-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let project = dir.canonicalize().unwrap_or(dir.clone());
        fs::create_dir_all(project.join(".saple").join("memory")).unwrap();
        let secret = project.join("secret.txt");
        fs::write(&secret, "top secret").unwrap();

        let err = delete_memory_file_inner(
            project.to_string_lossy().to_string(),
            "../../secret.txt".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("Access denied"), "got: {}", err);
        // The file outside the memory dir must survive.
        assert!(secret.exists(), "traversal delete must not remove files outside the memory dir");

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn save_memory_node_rejects_traversal_in_category_and_id() {
        let dir = std::env::temp_dir().join(format!("saple-mem-savetrav-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".saple").join("memory")).unwrap();
        let project = dir.canonicalize().unwrap();
        let save = |category: &str, id: &str| {
            save_memory_node_inner(
                project.to_string_lossy().to_string(),
                id.to_string(),
                "Title".to_string(),
                category.to_string(),
                vec![],
                vec![],
                "body".to_string(),
            )
        };

        for (category, id) in [
            ("a/../../.saple", "x"),      // escapes memory dir, stays inside project
            ("../../outside", "x"),        // escapes project entirely
            ("..", "x"),
            ("general", "../tasks"),
            ("gen\\eral", "x"),
            ("c:evil", "x"),
            ("", "x"),
            ("general", ""),
        ] {
            let err = save(category, id).err().expect("save should be rejected");
            assert!(err.contains("Invalid"), "({category:?}, {id:?}) got: {err}");
        }

        // A normal save still works and lands inside the memory dir.
        let node = save("General Notes", "My Note").unwrap();
        assert_eq!(node.file_path, "general-notes/my-note.md");
        assert!(project.join(".saple/memory/general-notes/my-note.md").is_file());
        // Nothing was created outside the memory dir by the rejected attempts.
        assert!(!project.join(".saple/a").exists());

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn find_whole_word_respects_boundaries() {
        let hay: Vec<char> = "the json web token spec".chars().collect();
        let needle: Vec<char> = "json web token".chars().collect();
        assert_eq!(find_whole_word(&hay, &needle), Some(4));

        // Substring inside a larger word must not match.
        let hay2: Vec<char> = "subtokenization".chars().collect();
        let needle2: Vec<char> = "token".chars().collect();
        assert_eq!(find_whole_word(&hay2, &needle2), None);
    }

    fn setup_restore_project(tag: &str) -> (PathBuf, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "saple-mem-restore-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let memory_dir = dir.join(".saple").join("memory").join("general");
        fs::create_dir_all(&memory_dir).unwrap();
        let note_path = memory_dir.join("note.md");
        fs::write(&note_path, b"").unwrap();
        let project_str = dir.canonicalize().unwrap().to_string_lossy().to_string();
        (dir.join(".saple/memory/general/note.md"), dir, project_str)
    }

    #[test]
    fn restore_aborts_and_keeps_live_memory_when_backup_fails() {
        let (note_path, project, project_str) = setup_restore_project("failbackup");

        // Seed live memory and snapshot it as the restore target.
        fs::write(&note_path, "snapshot content v1").unwrap();
        create_memory_snapshot_inner(project_str.clone(), "target".to_string(), false).unwrap();

        // Change live memory after the snapshot so we can prove it survives untouched.
        fs::write(&note_path, "live content v2 - must survive").unwrap();

        // Simulate an un-copyable file so the safety snapshot fails:
        // on Windows, hold the note open with no sharing flags -> fs::copy hits a
        // sharing violation. On Unix, make the source unreadable.
        #[cfg(windows)]
        let _lock = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&note_path)
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&note_path).unwrap().permissions();
            perms.set_mode(0o000);
            fs::set_permissions(&note_path, perms).unwrap();
        }

        let result =
            restore_memory_snapshot_inner(project_str.clone(), "target".to_string());

        #[cfg(windows)]
        drop(_lock);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&note_path).unwrap().permissions();
            perms.set_mode(0o644);
            fs::set_permissions(&note_path, perms).unwrap();
        }

        let err = result.expect_err("restore must abort when the pre-restore backup fails");
        assert!(
            err.contains("pre-restore safety snapshot failed"),
            "got: {}",
            err
        );
        // Live memory is completely untouched.
        let live = fs::read_to_string(&note_path).unwrap();
        assert_eq!(live, "live content v2 - must survive");

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn restore_succeeds_after_valid_backup_end_to_end() {
        let (note_path, project, project_str) = setup_restore_project("happybackup");

        // Live state that will be snapshotted as the restore target.
        fs::write(&note_path, "snapshot content v1").unwrap();
        create_memory_snapshot_inner(project_str.clone(), "target".to_string(), false).unwrap();

        // Diverge live memory; restore must bring back v1 and keep v2 in a pre-restore backup.
        fs::write(&note_path, "live content v2").unwrap();

        restore_memory_snapshot_inner(project_str, "target".to_string())
            .expect("restore should succeed after a valid pre-restore backup");

        let restored = fs::read_to_string(&note_path).unwrap();
        assert_eq!(restored, "snapshot content v1");

        // A verified pre-restore backup of the diverged live state exists.
        let snapshots_dir = project.join(".saple").join("snapshots");
        let backups: Vec<PathBuf> = fs::read_dir(&snapshots_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("pre-restore-"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(backups.len(), 1, "expected exactly one pre-restore backup");
        let backed_up = fs::read_to_string(backups[0].join("general").join("note.md")).unwrap();
        assert_eq!(backed_up, "live content v2");

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn snapshot_refuses_overwrite_without_confirmation() {
        let (note_path, project, project_str) = setup_restore_project("overwrite");

        fs::write(&note_path, "v1").unwrap();
        create_memory_snapshot_inner(project_str.clone(), "target".to_string(), false).unwrap();

        // Live memory moves on; re-snapshotting the same name without confirmation must fail
        // and leave the original snapshot untouched.
        fs::write(&note_path, "v2").unwrap();
        let err = create_memory_snapshot_inner(project_str.clone(), "target".to_string(), false)
            .expect_err("unconfirmed overwrite must be refused");
        assert_eq!(err.code, crate::error_code::ErrorCode::AlreadyExists);
        assert!(err.message.contains("already exists"), "got: {}", err.message);
        let kept = fs::read_to_string(project.join(".saple/snapshots/target/general/note.md")).unwrap();
        assert_eq!(kept, "v1", "existing snapshot must not be clobbered");

        // Explicit confirmation replaces it.
        create_memory_snapshot_inner(project_str.clone(), "target".to_string(), true).unwrap();
        let replaced = fs::read_to_string(project.join(".saple/snapshots/target/general/note.md")).unwrap();
        assert_eq!(replaced, "v2");

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn failed_snapshot_leaves_existing_snapshot_and_no_staging_dirs_behind() {
        let (note_path, project, project_str) = setup_restore_project("failedsnap");

        fs::write(&note_path, "good v1").unwrap();
        create_memory_snapshot_inner(project_str.clone(), "target".to_string(), false).unwrap();

        // Make the source unreadable so the staged copy fails partway.
        #[cfg(windows)]
        let _lock = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&note_path)
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&note_path).unwrap().permissions();
            perms.set_mode(0o000);
            fs::set_permissions(&note_path, perms).unwrap();
        }

        let result = create_memory_snapshot_inner(project_str.clone(), "other".to_string(), false);

        #[cfg(windows)]
        drop(_lock);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&note_path).unwrap().permissions();
            perms.set_mode(0o644);
            fs::set_permissions(&note_path, perms).unwrap();
        }

        assert!(result.is_err(), "snapshot over an unreadable source must fail");
        // The previous snapshot survives byte-for-byte...
        let kept = fs::read_to_string(project.join(".saple/snapshots/target/general/note.md")).unwrap();
        assert_eq!(kept, "good v1");
        // ...and no half-built snapshot or staging directory was left behind.
        assert!(!project.join(".saple/snapshots/other").exists());
        let strays: Vec<PathBuf> = fs::read_dir(project.join(".saple").join("snapshots"))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().contains(".tmp-"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(strays.is_empty(), "staging dirs must be cleaned up: {:?}", strays);

        let _ = fs::remove_dir_all(&project);
    }
}
