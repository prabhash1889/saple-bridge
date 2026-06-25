use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};

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

pub fn get_memory_mode(project_path: &str) -> String {
    let config_path = Path::new(project_path).join(".saple").join("config.json");
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(config_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(mode) = config.get("memoryMode").and_then(|m| m.as_str()) {
                    return mode.to_string();
                }
            }
        }
    }
    "saple".to_string()
}

pub fn get_memory_dir(project_path: &str) -> PathBuf {
    let mode = get_memory_mode(project_path);
    if mode == "bridge-compatible" {
        Path::new(project_path).join(".bridgememory")
    } else {
        Path::new(project_path).join(".saple").join("memory")
    }
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
            .map(|s| yaml_unquote(s))
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
                let item = if trimmed.starts_with("- ") {
                    Some(yaml_unquote(&trimmed[2..]))
                } else if trimmed.starts_with("  - ") {
                    Some(yaml_unquote(&trimmed[4..]))
                } else {
                    None
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
        if trimmed.starts_with("# ") {
            first_h1 = trimmed[2..].trim().to_string();
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

pub fn parse_markdown_memory(content: &str, relative_path: &str) -> (MemoryNode, Vec<String>) {
    let parsed = parse_memory_file(content, relative_path);
    
    let mut wikilinks = Vec::new();
    let mut search_str = &parsed.body[..];
    while let Some(start) = search_str.find("[[") {
        if let Some(end) = search_str[start..].find("]]") {
            let link = search_str[start + 2..start + end].trim().to_string();
            if !link.is_empty() {
                wikilinks.push(link);
            }
            search_str = &search_str[start + end + 2..];
        } else {
            break;
        }
    }
    
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
pub async fn get_memory_graph(project_path: String) -> Result<MemoryGraph, String> {
    tauri::async_runtime::spawn_blocking(move || get_memory_graph_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_memory_graph_inner(project_path: String) -> Result<MemoryGraph, String> {
    let memory_dir = get_memory_dir(&project_path);
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
                } else if path.extension().map_or(false, |ext| ext == "md") {
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
pub async fn create_memory_snapshot(project_path: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_memory_snapshot_inner(project_path, name))
        .await
        .map_err(|e| e.to_string())?
}

fn create_memory_snapshot_inner(project_path: String, name: String) -> Result<(), String> {
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("Snapshot name must contain only alphanumeric characters, dashes, or underscores".to_string());
    }

    let memory_dir = get_memory_dir(&project_path);
    if !memory_dir.exists() {
        return Err("No memories found to snapshot".to_string());
    }
    
    let snapshot_dir = Path::new(&project_path).join(".saple").join("snapshots").join(&name);
    if snapshot_dir.exists() {
        fs::remove_dir_all(&snapshot_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&snapshot_dir).map_err(|e| e.to_string())?;
    
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
    
    copy_dir_all(&memory_dir, &snapshot_dir)
}

#[tauri::command]
pub async fn restore_memory_snapshot(project_path: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_memory_snapshot_inner(project_path, name))
        .await
        .map_err(|e| e.to_string())?
}

fn restore_memory_snapshot_inner(project_path: String, name: String) -> Result<(), String> {
    let snapshot_dir = Path::new(&project_path).join(".saple").join("snapshots").join(&name);
    if !snapshot_dir.exists() {
        return Err(format!("Snapshot {} not found", name));
    }
    
    let memory_dir = get_memory_dir(&project_path);
    if memory_dir.exists() {
        if let Ok(mut entries) = fs::read_dir(&memory_dir) {
            if entries.next().is_some() {
                let backup_name = format!("pre-restore-{}", now_iso().replace(':', "-"));
                let _ = create_memory_snapshot_inner(project_path.clone(), backup_name);
            }
        }
    }
    
    let mode = get_memory_mode(&project_path);
    let write_dirs = if mode == "bridge-compatible" {
        vec![Path::new(&project_path).join(".bridgememory")]
    } else if mode == "both" {
        vec![
            Path::new(&project_path).join(".saple").join("memory"),
            Path::new(&project_path).join(".bridgememory"),
        ]
    } else {
        vec![Path::new(&project_path).join(".saple").join("memory")]
    };
    
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
    
    for dir in write_dirs {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        copy_dir_all(&snapshot_dir, &dir)?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn list_memory_snapshots(project_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_memory_snapshots_inner(project_path))
        .await
        .map_err(|e| e.to_string())?
}

fn list_memory_snapshots_inner(project_path: String) -> Result<Vec<String>, String> {
    let snapshots_dir = Path::new(&project_path).join(".saple").join("snapshots");
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
pub async fn delete_memory_file(project_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_memory_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn delete_memory_file_inner(project_path: String, file_path: String) -> Result<(), String> {
    let mode = get_memory_mode(&project_path);
    let delete_dirs = if mode == "bridge-compatible" {
        vec![Path::new(&project_path).join(".bridgememory")]
    } else if mode == "both" {
        vec![
            Path::new(&project_path).join(".saple").join("memory"),
            Path::new(&project_path).join(".bridgememory"),
        ]
    } else {
        vec![Path::new(&project_path).join(".saple").join("memory")]
    };
    
    let canonical_base = Path::new(&project_path).canonicalize().map_err(|e| e.to_string())?;
    
    for dir in delete_dirs {
        let full_path = dir.join(&file_path);
        if full_path.exists() {
            let canonical_target = full_path.canonicalize().map_err(|e| e.to_string())?;
            if !canonical_target.starts_with(&canonical_base) {
                return Err("Access denied: path is outside the project workspace".to_string());
            }
            fs::remove_file(full_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_memory_file(project_path: String, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_memory_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_memory_file_inner(project_path: String, file_path: String) -> Result<String, String> {
    let memory_dir = get_memory_dir(&project_path);
    let full_path = memory_dir.join(&file_path);
    
    let canonical_base = Path::new(&project_path).canonicalize().map_err(|e| e.to_string())?;
    
    if full_path.exists() {
        let canonical_target = full_path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("Access denied: path is outside the project workspace".to_string());
        }
        fs::read_to_string(full_path).map_err(|e| e.to_string())
    } else {
        Err("File not found".to_string())
    }
}

#[tauri::command]
pub async fn save_memory_node(
    project_path: String,
    id: String,
    title: String,
    category: String,
    tags: Vec<String>,
    aliases: Vec<String>,
    content: String,
) -> Result<MemoryNode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_memory_node_inner(project_path, id, title, category, tags, aliases, content)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn save_memory_node_inner(
    project_path: String,
    id: String,
    title: String,
    category: String,
    tags: Vec<String>,
    aliases: Vec<String>,
    content: String,
) -> Result<MemoryNode, String> {
    let mode = get_memory_mode(&project_path);
    
    let clean_category = category.trim().to_lowercase().replace(' ', "-");
    let clean_id = id.trim().to_lowercase().replace(' ', "-");
    let relative_path = format!("{}/{}.md", clean_category, clean_id);
    
    let read_dir = if mode == "bridge-compatible" {
        Path::new(&project_path).join(".bridgememory")
    } else {
        Path::new(&project_path).join(".saple").join("memory")
    };
    
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
    
    let write_dirs = if mode == "bridge-compatible" {
        vec![Path::new(&project_path).join(".bridgememory")]
    } else if mode == "both" {
        vec![
            Path::new(&project_path).join(".saple").join("memory"),
            Path::new(&project_path).join(".bridgememory"),
        ]
    } else {
        vec![Path::new(&project_path).join(".saple").join("memory")]
    };
    
    let canonical_base = Path::new(&project_path).canonicalize().map_err(|e| e.to_string())?;
    
    for dir in &write_dirs {
        let full_path = dir.join(&relative_path);
        if let Some(parent) = full_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err("Access denied: path is outside the project workspace".to_string());
            }
        }
        crate::fs_lock::atomic_write(&full_path, full_content.as_bytes())?;
    }
    
    if let Some(old_rel) = old_relative_path {
        if old_rel != relative_path {
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
                    } else if path.extension().map_or(false, |ext| ext == "md") {
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
            } else if path.extension().map_or(false, |e| e == "md") {
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

/// Notes whose body mentions this note's title/alias as plain text without a
/// `[[link]]` — Obsidian's "unlinked mentions". One entry per source note.
#[tauri::command]
pub async fn get_unlinked_mentions(
    project_path: String,
    id: String,
) -> Result<Vec<UnlinkedMention>, String> {
    tauri::async_runtime::spawn_blocking(move || get_unlinked_mentions_inner(project_path, id))
        .await
        .map_err(|e| e.to_string())?
}

fn get_unlinked_mentions_inner(project_path: String, id: String) -> Result<Vec<UnlinkedMention>, String> {
    let memory_dir = get_memory_dir(&project_path);
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
                if best.map_or(true, |(b, _)| pos < b) {
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
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || add_memory_link_inner(project_path, source, target))
        .await
        .map_err(|e| e.to_string())?
}

fn add_memory_link_inner(project_path: String, source: String, target: String) -> Result<(), String> {
    let memory_dir = get_memory_dir(&project_path);
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
    fn mask_wikilinks_blanks_links_preserving_length() {
        let body = "see [[jwt]] here";
        let masked = mask_wikilinks(body);
        assert_eq!(masked.chars().count(), body.chars().count());
        assert!(!masked.contains("jwt"));
        assert!(masked.contains("see"));
        assert!(masked.contains("here"));
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
}
