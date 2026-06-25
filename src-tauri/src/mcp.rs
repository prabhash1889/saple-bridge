use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use serde_json::json;

use crate::memory::{get_memory_dir, parse_markdown_memory, MemoryNode, MemoryEdge, save_memory_node_inner, delete_memory_file_inner};
use crate::project::get_project_file_path;

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
    id: serde_json::Value,
}

impl JsonRpcResponse {
    fn result(id: serde_json::Value, result: serde_json::Value) -> Self {
        JsonRpcResponse { jsonrpc: "2.0".to_string(), result: Some(result), error: None, id }
    }
    fn error(id: serde_json::Value, code: i32, message: &str) -> Self {
        JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(JsonRpcError { code, message: message.to_string() }),
            id,
        }
    }
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

fn slugify(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Build a standard MCP text tool result.
fn text_result(text: &str) -> serde_json::Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// Strip YAML frontmatter from a raw note and return the markdown body.
/// Falls back to the whole content if no closing frontmatter delimiter is found.
fn extract_body(raw: &str) -> String {
    let mut body_lines = Vec::new();
    let mut in_frontmatter = false;
    let mut fm_count = 0;
    for line in raw.lines() {
        if line.trim() == "---" {
            in_frontmatter = !in_frontmatter;
            fm_count += 1;
            continue;
        }
        if !in_frontmatter && fm_count >= 2 {
            body_lines.push(line);
        }
    }
    if fm_count < 2 {
        return raw.to_string();
    }
    body_lines.join("\n")
}

/// Extract a ~160-char snippet from `body` centered on the earliest matching term.
fn make_snippet(body: &str, terms: &[String]) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return String::new();
    }
    let flat_l = flat.to_lowercase();
    let mut byte_pos: Option<usize> = None;
    for term in terms {
        if let Some(p) = flat_l.find(term.as_str()) {
            byte_pos = Some(byte_pos.map_or(p, |cur| cur.min(p)));
        }
    }
    let chars: Vec<char> = flat.chars().collect();
    let total = chars.len();
    let match_char_idx = byte_pos.map_or(0, |bp| flat_l[..bp].chars().count());

    const WINDOW: usize = 160;
    let mut start = match_char_idx.saturating_sub(WINDOW / 2);
    let end = (start + WINDOW).min(total);
    start = end.saturating_sub(WINDOW);

    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet = format!("…{}", snippet);
    }
    if end < total {
        snippet = format!("{}…", snippet);
    }
    snippet
}

// Find a note file recursively in memory directory by its ID
fn find_note_file(memory_dir: &Path, id: &str) -> Option<(PathBuf, MemoryNode, String)> {
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

// Read all memory notes in directory
fn read_all_notes(memory_dir: &Path) -> Vec<(MemoryNode, String)> {
    let mut notes = Vec::new();
    fn walk(dir: &Path, notes: &mut Vec<(MemoryNode, String)>) {
        if dir.is_dir() {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path, notes);
                    } else if path.extension().map_or(false, |ext| ext == "md") {
                        if let Ok(content) = fs::read_to_string(&path) {
                            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            let (node, _) = parse_markdown_memory(&content, &filename);
                            notes.push((node, content));
                        }
                    }
                }
            }
        }
    }
    walk(memory_dir, &mut notes);
    notes
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

pub(crate) fn handle_tool_call(name: &str, arguments: Option<serde_json::Value>, project_path: &str) -> Result<serde_json::Value, String> {
    let args = arguments.unwrap_or(serde_json::Value::Null);
    match name {
        "create_memory" | "update_memory" | "delete_memory" | "get_memory"
        | "list_memories" | "search_memories" | "find_backlinks"
        | "suggest_connections" | "add_link" | "remove_link"
        | "get_graph" | "get_stats" => handle_memory_tool(name, &args, project_path),

        "list_tasks" | "get_task" | "create_task" | "update_task" | "delete_task"
            => handle_task_tool(name, &args, project_path),

        "get_swarm_status" => handle_swarm_tool(name, &args, project_path),

        _ => Err(format!("Unknown tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Memory tools
// ---------------------------------------------------------------------------

fn handle_memory_tool(name: &str, args: &serde_json::Value, project_path: &str) -> Result<serde_json::Value, String> {
    let memory_dir = get_memory_dir(project_path);
    fs::create_dir_all(&memory_dir).map_err(|e| e.to_string())?;

    match name {
        "create_memory" => {
            let title = args["title"].as_str().ok_or("Missing title")?;
            let category = args["category"].as_str().ok_or("Missing category")?;
            let content = args["content"].as_str().ok_or("Missing content")?;

            let id = args["id"].as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| slugify(title));

            let tags = args["tags"].as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_else(Vec::new);

            let aliases = args["aliases"].as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_else(Vec::new);

            // Check if note already exists
            if find_note_file(&memory_dir, &id).is_some() {
                return Err(format!("Memory note with ID '{}' already exists", id));
            }

            save_memory_node_inner(
                project_path.to_string(),
                id.clone(),
                title.to_string(),
                category.to_string(),
                tags,
                aliases,
                content.to_string(),
            )?;

            Ok(text_result(&format!("Memory note '{}' (ID: {}) created successfully.", title, id)))
        }

        "update_memory" => {
            let id = args["id"].as_str().ok_or("Missing id")?;

            let (_, node, raw_content) = find_note_file(&memory_dir, id)
                .ok_or_else(|| format!("Memory note with ID '{}' not found", id))?;

            let parsed = crate::memory::parse_memory_file(&raw_content, &node.file_path);
            let mut body = parsed.body;
            if body.trim().starts_with("# ") {
                let lines: Vec<&str> = body.trim().lines().collect();
                body = lines[1..].join("\n");
            }

            let mut new_title = node.title.clone();
            if let Some(t) = args["title"].as_str() {
                new_title = t.to_string();
            }
            let mut new_category = node.category.clone();
            if let Some(c) = args["category"].as_str() {
                new_category = c.to_string();
            }
            let mut new_tags = node.tags.clone();
            if let Some(tags_val) = args["tags"].as_array() {
                new_tags = tags_val.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
            }
            let mut new_aliases = node.aliases.clone();
            if let Some(aliases_val) = args["aliases"].as_array() {
                new_aliases = aliases_val.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
            }
            let mut new_content = body;
            if let Some(c) = args["content"].as_str() {
                new_content = c.to_string();
            }

            save_memory_node_inner(
                project_path.to_string(),
                id.to_string(),
                new_title.clone(),
                new_category,
                new_tags,
                new_aliases,
                new_content,
            )?;

            Ok(text_result(&format!("Memory note '{}' (ID: {}) updated successfully.", new_title, id)))
        }

        "delete_memory" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let (_, node, _) = find_note_file(&memory_dir, id)
                .ok_or_else(|| format!("Memory note with ID '{}' not found", id))?;

            delete_memory_file_inner(project_path.to_string(), node.file_path.clone())?;

            Ok(text_result(&format!("Memory note with ID '{}' deleted successfully.", id)))
        }

        "get_memory" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let (_, node, raw_content) = find_note_file(&memory_dir, id)
                .ok_or_else(|| format!("Memory note with ID '{}' not found", id))?;

            Ok(text_result(&format!(
                "Title: {}\nID: {}\nCategory: {}\nTags: {:?}\n\n{}",
                node.title, node.id, node.category, node.tags, raw_content
            )))
        }

        "list_memories" => {
            let category_filter = args["category"].as_str();
            let tag_filter = args["tag"].as_str();

            let all = read_all_notes(&memory_dir);
            let filtered: Vec<serde_json::Value> = all.into_iter()
                .map(|(node, _)| node)
                .filter(|node| {
                    if let Some(cat) = category_filter {
                        if node.category != cat { return false; }
                    }
                    if let Some(tg) = tag_filter {
                        if !node.tags.contains(&tg.to_string()) { return false; }
                    }
                    true
                })
                .map(|node| json!({
                    "id": node.id,
                    "title": node.title,
                    "category": node.category,
                    "tags": node.tags,
                    "filePath": node.file_path
                }))
                .collect();

            Ok(text_result(&serde_json::to_string_pretty(&filtered).unwrap()))
        }

        "search_memories" => {
            let query = args["query"].as_str().ok_or("Missing query")?;
            let mode = args["mode"].as_str().unwrap_or("all");
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;

            let q_lower = query.to_lowercase();
            let terms: Vec<String> = q_lower.split_whitespace().map(|s| s.to_string()).collect();
            if terms.is_empty() {
                return Ok(text_result("[]"));
            }

            let all = read_all_notes(&memory_dir);
            let mut scored: Vec<(i64, serde_json::Value)> = Vec::new();

            for (node, content) in all {
                let title_l = node.title.to_lowercase();
                let id_l = node.id.to_lowercase();
                let tags_l: Vec<String> = node.tags.iter().map(|t| t.to_lowercase()).collect();
                let aliases_l: Vec<String> = node.aliases.iter().map(|a| a.to_lowercase()).collect();
                let body = extract_body(&content);
                let body_l = body.to_lowercase();

                let mut score: i64 = 0;
                let mut matched_terms = 0;
                for term in &terms {
                    let c_title = title_l.matches(term.as_str()).count() as i64;
                    let c_alias: i64 = aliases_l.iter().map(|a| a.matches(term.as_str()).count() as i64).sum();
                    let c_tag: i64 = tags_l.iter().map(|t| t.matches(term.as_str()).count() as i64).sum();
                    let c_id = id_l.matches(term.as_str()).count() as i64;
                    let c_body = body_l.matches(term.as_str()).count() as i64;
                    let term_score = c_title * 5 + c_alias * 4 + c_tag * 3 + c_id * 2 + c_body;
                    if term_score > 0 {
                        matched_terms += 1;
                    }
                    score += term_score;
                }

                // Bonus for an exact full-phrase match across multiple terms.
                if terms.len() > 1 {
                    if title_l.contains(&q_lower) { score += 10; }
                    if body_l.contains(&q_lower) { score += 5; }
                }

                let include = if mode == "any" {
                    matched_terms > 0
                } else {
                    matched_terms == terms.len()
                };

                if include && score > 0 {
                    let snippet = make_snippet(&body, &terms);
                    scored.push((score, json!({
                        "id": node.id,
                        "title": node.title,
                        "category": node.category,
                        "tags": node.tags,
                        "score": score,
                        "snippet": snippet
                    })));
                }
            }

            scored.sort_by(|a, b| b.0.cmp(&a.0));
            let results: Vec<serde_json::Value> = scored.into_iter().take(limit).map(|(_, v)| v).collect();

            Ok(text_result(&serde_json::to_string_pretty(&results).unwrap()))
        }

        "find_backlinks" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let search_tag = format!("[[{}]]", id);

            let all = read_all_notes(&memory_dir);
            let results: Vec<serde_json::Value> = all.into_iter()
                .filter(|(_, content)| content.contains(&search_tag))
                .map(|(node, _)| json!({
                    "id": node.id,
                    "title": node.title,
                    "category": node.category
                }))
                .collect();

            Ok(text_result(&serde_json::to_string_pretty(&results).unwrap()))
        }

        "suggest_connections" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let (_, target_node, _) = find_note_file(&memory_dir, id)
                .ok_or_else(|| format!("Memory note with ID '{}' not found", id))?;

            let all = read_all_notes(&memory_dir);
            let mut suggestions = Vec::new();

            for (node, _) in all {
                if node.id == id { continue; }

                let mut score = 0;
                // Tag overlaps
                for t in &node.tags {
                    if target_node.tags.contains(t) {
                        score += 3;
                    }
                }
                // Category similarity
                if node.category == target_node.category {
                    score += 1;
                }

                if score > 0 {
                    suggestions.push((score, json!({
                        "id": node.id,
                        "title": node.title,
                        "score": score
                    })));
                }
            }

            suggestions.sort_by(|a: &(i32, serde_json::Value), b| b.0.cmp(&a.0));
            let ranked: Vec<serde_json::Value> = suggestions.into_iter().map(|(_, v)| v).collect();

            Ok(text_result(&serde_json::to_string_pretty(&ranked).unwrap()))
        }

        "add_link" => {
            let source = args["source"].as_str().ok_or("Missing source")?;
            let target = args["target"].as_str().ok_or("Missing target")?;

            // 1. Verify target exists
            let (_, target_node, _) = find_note_file(&memory_dir, target)
                .ok_or_else(|| format!("Target memory note with ID '{}' not found", target))?;

            // 2. Find source note
            let (_, source_node, raw_content) = find_note_file(&memory_dir, source)
                .ok_or_else(|| format!("Source memory note with ID '{}' not found", source))?;

            // Check if link already exists in source
            let wikilink = format!("[[{}]]", target);
            if raw_content.contains(&wikilink) {
                return Ok(text_result(&format!("Link from '{}' to '{}' already exists.", source, target)));
            }

            let mut body = extract_body(&raw_content);
            // If body starts with title `# title`, strip it so it doesn't duplicate
            if body.trim().starts_with("# ") {
                let lines: Vec<&str> = body.trim().lines().collect();
                body = lines[1..].join("\n");
            }

            // Append link
            body = format!("{}\n\nRelated: [[{}]]", body.trim(), target_node.id);

            save_memory_node_inner(
                project_path.to_string(),
                source_node.id.clone(),
                source_node.title.clone(),
                source_node.category.clone(),
                source_node.tags.clone(),
                source_node.aliases.clone(),
                body,
            )?;

            Ok(text_result(&format!("Successfully added link from '{}' to '{}'.", source, target)))
        }

        "remove_link" => {
            let source = args["source"].as_str().ok_or("Missing source")?;
            let target = args["target"].as_str().ok_or("Missing target")?;

            // Find source note
            let (_, source_node, raw_content) = find_note_file(&memory_dir, source)
                .ok_or_else(|| format!("Source memory note with ID '{}' not found", source))?;

            let wikilink = format!("[[{}]]", target);
            if !raw_content.contains(&wikilink) {
                return Ok(text_result(&format!("Link from '{}' to '{}' does not exist.", source, target)));
            }

            let mut body = extract_body(&raw_content);
            // If body starts with title `# title`, strip it so it doesn't duplicate
            if body.trim().starts_with("# ") {
                let lines: Vec<&str> = body.trim().lines().collect();
                body = lines[1..].join("\n");
            }

            // Remove link references
            let cleaned_body = body.lines()
                .map(|line| {
                    if line.contains(&wikilink) {
                        let replaced = line.replace(&wikilink, "").trim().to_string();
                        if replaced == "Related:" || replaced == "- Related:" || replaced == "-" {
                            "".to_string()
                        } else {
                            replaced
                        }
                    } else {
                        line.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");

            save_memory_node_inner(
                project_path.to_string(),
                source_node.id.clone(),
                source_node.title.clone(),
                source_node.category.clone(),
                source_node.tags.clone(),
                source_node.aliases.clone(),
                cleaned_body,
            )?;

            Ok(text_result(&format!("Successfully removed link from '{}' to '{}'.", source, target)))
        }

        "get_graph" => {
            let mut nodes = Vec::new();
            let mut edges = Vec::new();
            let mut id_lookup = HashMap::new();
            let mut pending_links = Vec::new();

            let all = read_all_notes(&memory_dir);
            for (node, content) in all {
                id_lookup.insert(node.id.clone(), node.id.clone());

                // Parse wikilinks
                let mut wikilinks = Vec::new();
                let mut search_str = &content[..];
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

                pending_links.push((node.id.clone(), wikilinks));
                nodes.push(node);
            }

            for (source_id, links) in pending_links {
                for link in links {
                    if let Some(target_id) = id_lookup.get(&link) {
                        if !edges.iter().any(|e: &MemoryEdge| e.source == source_id && e.target == *target_id) {
                            edges.push(MemoryEdge {
                                source: source_id.clone(),
                                target: target_id.clone(),
                            });
                        }
                    }
                }
            }

            Ok(text_result(&serde_json::to_string_pretty(&json!({ "nodes": nodes, "edges": edges })).unwrap()))
        }

        "get_stats" => {
            let all = read_all_notes(&memory_dir);
            let total_memories = all.len();

            let mut category_counts = HashMap::new();
            let mut tag_set = std::collections::HashSet::new();
            let mut total_links = 0;

            for (node, content) in all {
                *category_counts.entry(node.category).or_insert(0) += 1;
                for tag in node.tags {
                    tag_set.insert(tag);
                }

                // Count links
                let mut search_str = &content[..];
                while let Some(start) = search_str.find("[[") {
                    if let Some(end) = search_str[start..].find("]]") {
                        total_links += 1;
                        search_str = &search_str[start + end + 2..];
                    } else {
                        break;
                    }
                }
            }

            Ok(text_result(&serde_json::to_string_pretty(&json!({
                "totalMemories": total_memories,
                "categoryCounts": category_counts,
                "uniqueTagsCount": tag_set.len(),
                "totalLinksCount": total_links
            })).unwrap()))
        }

        _ => Err(format!("Unknown memory tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Task tools (shared with the Kanban board via .saple/tasks.json)
// ---------------------------------------------------------------------------

fn load_tasks(project_path: &str) -> Result<Vec<serde_json::Value>, String> {
    let path = get_project_file_path(project_path, ".saple/tasks.json")?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("Failed to parse tasks.json: {}", e))? {
        serde_json::Value::Array(arr) => Ok(arr),
        _ => Err("tasks.json is not a JSON array".to_string()),
    }
}

fn save_tasks(project_path: &str, tasks: &[serde_json::Value]) -> Result<(), String> {
    let path = get_project_file_path(project_path, ".saple/tasks.json")?;
    let json = serde_json::to_string_pretty(tasks).map_err(|e| e.to_string())?;
    // Atomic write: the renderer Kanban board may write this same file concurrently while an agent
    // edits tasks through MCP. temp+rename keeps either process from reading a torn file.
    crate::fs_lock::atomic_write(&path, json.as_bytes())
}

fn task_id_matches(task: &serde_json::Value, id: &str) -> bool {
    task.get("id").and_then(|v| v.as_str()) == Some(id)
}

fn handle_task_tool(name: &str, args: &serde_json::Value, project_path: &str) -> Result<serde_json::Value, String> {
    match name {
        "list_tasks" => {
            let column_filter = args["column"].as_str();
            let label_filter = args["label"].as_str();

            let tasks = load_tasks(project_path)?;
            let filtered: Vec<serde_json::Value> = tasks.into_iter()
                .filter(|t| {
                    if let Some(c) = column_filter {
                        if t.get("column").and_then(|v| v.as_str()) != Some(c) { return false; }
                    }
                    if let Some(l) = label_filter {
                        let has = t.get("labels").and_then(|v| v.as_array())
                            .map_or(false, |arr| arr.iter().any(|x| x.as_str() == Some(l)));
                        if !has { return false; }
                    }
                    true
                })
                .map(|t| json!({
                    "id": t.get("id"),
                    "title": t.get("title"),
                    "column": t.get("column"),
                    "priority": t.get("priority"),
                    "labels": t.get("labels"),
                    "description": t.get("description")
                }))
                .collect();

            Ok(text_result(&serde_json::to_string_pretty(&filtered).unwrap()))
        }

        "get_task" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let tasks = load_tasks(project_path)?;
            let task = tasks.into_iter()
                .find(|t| task_id_matches(t, id))
                .ok_or_else(|| format!("Task with ID '{}' not found", id))?;
            Ok(text_result(&serde_json::to_string_pretty(&task).unwrap()))
        }

        "create_task" => {
            let title = args["title"].as_str().ok_or("Missing title")?;
            let now = crate::project::now_iso();
            let id = format!("task_{}", uuid::Uuid::new_v4());
            let column = args["column"].as_str().unwrap_or("backlog");
            let priority = args["priority"].as_str().unwrap_or("normal");
            let description = args["description"].as_str().unwrap_or("");
            let labels = args["labels"].as_array().cloned().unwrap_or_default();

            let mut task = json!({
                "id": id,
                "title": title,
                "description": description,
                "column": column,
                "priority": priority,
                "createdAt": now,
                "updatedAt": now,
                "labels": labels
            });
            if let Some(tf) = args.get("targetFiles") {
                if tf.is_array() { task["targetFiles"] = tf.clone(); }
            }
            if let Some(ac) = args.get("acceptanceCriteria") {
                if ac.is_array() { task["acceptanceCriteria"] = ac.clone(); }
            }

            let mut tasks = load_tasks(project_path)?;
            tasks.push(task);
            save_tasks(project_path, &tasks)?;

            Ok(text_result(&format!("Task '{}' (ID: {}) created in column '{}'.", title, id, column)))
        }

        "update_task" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let mut tasks = load_tasks(project_path)?;
            let mut found = false;

            for t in tasks.iter_mut() {
                if task_id_matches(t, id) {
                    found = true;
                    for key in ["title", "description", "column", "priority"] {
                        if let Some(v) = args.get(key) {
                            if v.is_string() { t[key] = v.clone(); }
                        }
                    }
                    for key in ["labels", "targetFiles", "acceptanceCriteria"] {
                        if let Some(v) = args.get(key) {
                            if v.is_array() { t[key] = v.clone(); }
                        }
                    }
                    t["updatedAt"] = json!(crate::project::now_iso());
                    break;
                }
            }

            if !found {
                return Err(format!("Task with ID '{}' not found", id));
            }
            save_tasks(project_path, &tasks)?;
            Ok(text_result(&format!("Task with ID '{}' updated successfully.", id)))
        }

        "delete_task" => {
            let id = args["id"].as_str().ok_or("Missing id")?;
            let mut tasks = load_tasks(project_path)?;
            let before = tasks.len();
            tasks.retain(|t| !task_id_matches(t, id));
            if tasks.len() == before {
                return Err(format!("Task with ID '{}' not found", id));
            }
            save_tasks(project_path, &tasks)?;
            Ok(text_result(&format!("Task with ID '{}' deleted successfully.", id)))
        }

        _ => Err(format!("Unknown task tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Swarm tools (read-only visibility — orchestration is owned by the UI)
// ---------------------------------------------------------------------------

fn handle_swarm_tool(name: &str, _args: &serde_json::Value, project_path: &str) -> Result<serde_json::Value, String> {
    match name {
        "get_swarm_status" => {
            let path = get_project_file_path(project_path, ".saple/swarm/state.json")?;
            if !path.exists() {
                return Ok(text_result("{\"status\":\"idle\",\"agents\":[]}"));
            }
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let state: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse swarm state: {}", e))?;

            let agents_summary: Vec<serde_json::Value> = state.get("agents")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().map(|a| json!({
                    "id": a.get("id"),
                    "name": a.get("name"),
                    "role": a.get("role"),
                    "status": a.get("status"),
                    "dependencies": a.get("dependencies")
                })).collect())
                .unwrap_or_default();

            let summary = json!({
                "swarmId": state.get("swarmId"),
                "swarmName": state.get("swarmName"),
                "mission": state.get("mission"),
                "status": state.get("status"),
                "agents": agents_summary
            });

            Ok(text_result(&serde_json::to_string_pretty(&summary).unwrap()))
        }

        _ => Err(format!("Unknown swarm tool: {}", name)),
    }
}

// ---------------------------------------------------------------------------
// Onboarding prompt
// ---------------------------------------------------------------------------

pub(crate) const SAPLE_ONBOARDING_PROMPT: &str = r#"You are connected to the **Saple** shared-context server. It is the durable memory and task hub for this project — everything you learn and decide should be captured here so future sessions (and other agents) inherit it.

## Memory (knowledge graph in .saple/memory)
- **Search before you create.** Call `search_memories` (multi-term, ranked) to check whether context already exists. The bug you are chasing may already have a note.
- Record durable knowledge with `create_memory`, choosing a category: `decision`, `architecture`, `pattern`, `bug`, `handoff`, `review`, or `general`.
- Connect related notes with `[[note-id]]` wikilinks, or use `add_link`. Explore with `find_backlinks` and `suggest_connections`.
- Use `get_graph` / `get_stats` for a birds-eye view, `list_memories` to browse, `update_memory` / `delete_memory` to maintain.

## Tasks (Kanban board in .saple/tasks.json)
- `list_tasks` to see work (columns: `backlog`, `progress`, `review`, `done`).
- `create_task` for new work, `update_task` to move a task between columns or edit it, `get_task` for full detail.

## Swarm
- `get_swarm_status` shows the current multi-agent run (read-only).

## Workflow
1. Search memory for relevant context.
2. Do the work.
3. Capture decisions, patterns, and bugs as memories, and link them.
4. Reflect progress on the task board.
"#;

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

pub(crate) fn tools_catalog() -> serde_json::Value {
    json!({
        "tools": [
            {
                "name": "create_memory",
                "description": "Create a new memory note (decision, architecture, pattern, bug, or general) to record context, decisions, or guidelines.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Optional unique slug ID (lowercase, alphanumeric and hyphens). Generated from title if omitted." },
                        "title": { "type": "string", "description": "Short descriptive title of the memory note." },
                        "category": { "type": "string", "enum": ["decision", "architecture", "pattern", "bug", "handoff", "review", "general"], "description": "The category of the memory." },
                        "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional list of tags." },
                        "aliases": { "type": "array", "items": { "type": "string" }, "description": "Optional alternate names. `[[alias]]` wikilinks resolve to this note." },
                        "content": { "type": "string", "description": "Markdown body content of the note." }
                    },
                    "required": ["title", "category", "content"]
                }
            },
            {
                "name": "update_memory",
                "description": "Update an existing memory note by ID. You can update title, category, tags, or content.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the note to update." },
                        "title": { "type": "string", "description": "Optional new title." },
                        "category": { "type": "string", "enum": ["decision", "architecture", "pattern", "bug", "handoff", "review", "general"], "description": "Optional new category." },
                        "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional new list of tags." },
                        "aliases": { "type": "array", "items": { "type": "string" }, "description": "Optional new list of alternate names. `[[alias]]` wikilinks resolve to this note." },
                        "content": { "type": "string", "description": "Optional new markdown content." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "delete_memory",
                "description": "Delete a memory note by ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the note to delete." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "get_memory",
                "description": "Retrieve a specific memory note by ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the note to fetch." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "list_memories",
                "description": "List all memory notes, optionally filtered by category or tag.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "category": { "type": "string", "description": "Optional category filter." },
                        "tag": { "type": "string", "description": "Optional tag filter." }
                    }
                }
            },
            {
                "name": "search_memories",
                "description": "Search all memory notes with ranked, multi-term keyword matching. Returns results sorted by relevance, each with a matched snippet.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search terms (space-separated). Matches across title, aliases, tags, id and body." },
                        "mode": { "type": "string", "enum": ["all", "any"], "description": "`all` (default) requires every term to appear; `any` matches notes containing at least one term." },
                        "limit": { "type": "integer", "description": "Maximum number of results to return (default 20)." }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "find_backlinks",
                "description": "Find all memories that reference a given memory note by ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "ID of the target memory note." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "suggest_connections",
                "description": "Suggest potential links between a given memory note and other memories based on tags or category similarity, ranked by score.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "ID of the note to find suggestions for." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "add_link",
                "description": "Create a reference link from a source memory to a target memory. Inserts [[target]] in the source note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "source": { "type": "string", "description": "ID of source note." },
                        "target": { "type": "string", "description": "ID of target note to link to." }
                    },
                    "required": ["source", "target"]
                }
            },
            {
                "name": "remove_link",
                "description": "Remove a reference link [[target]] from a source memory note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "source": { "type": "string", "description": "ID of source note." },
                        "target": { "type": "string", "description": "ID of target note to remove link to." }
                    },
                    "required": ["source", "target"]
                }
            },
            {
                "name": "get_graph",
                "description": "Get the complete knowledge graph structure (all nodes and edges/links).",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "get_stats",
                "description": "Get statistics about the memory graph (count of memories, categories, tags, links).",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "list_tasks",
                "description": "List tasks from the project Kanban board, optionally filtered by column or label.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "column": { "type": "string", "enum": ["backlog", "progress", "review", "done"], "description": "Optional column filter." },
                        "label": { "type": "string", "description": "Optional label filter." }
                    }
                }
            },
            {
                "name": "get_task",
                "description": "Retrieve full details for a single task by ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the task." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "create_task",
                "description": "Create a new task on the project Kanban board.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Task title." },
                        "description": { "type": "string", "description": "Optional task description." },
                        "column": { "type": "string", "enum": ["backlog", "progress", "review", "done"], "description": "Starting column (default: backlog)." },
                        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"], "description": "Priority (default: normal)." },
                        "labels": { "type": "array", "items": { "type": "string" }, "description": "Optional labels." },
                        "targetFiles": { "type": "array", "items": { "type": "string" }, "description": "Optional list of files this task targets." },
                        "acceptanceCriteria": { "type": "array", "items": { "type": "string" }, "description": "Optional acceptance criteria." }
                    },
                    "required": ["title"]
                }
            },
            {
                "name": "update_task",
                "description": "Update a task by ID. Move it between columns or edit its fields.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the task to update." },
                        "title": { "type": "string", "description": "Optional new title." },
                        "description": { "type": "string", "description": "Optional new description." },
                        "column": { "type": "string", "enum": ["backlog", "progress", "review", "done"], "description": "Optional new column (status)." },
                        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"], "description": "Optional new priority." },
                        "labels": { "type": "array", "items": { "type": "string" }, "description": "Optional new labels." },
                        "targetFiles": { "type": "array", "items": { "type": "string" }, "description": "Optional new target files." },
                        "acceptanceCriteria": { "type": "array", "items": { "type": "string" }, "description": "Optional new acceptance criteria." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "delete_task",
                "description": "Delete a task by ID.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Unique ID of the task to delete." }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "get_swarm_status",
                "description": "Get the current swarm orchestration status (mission, overall status, and each agent's role/status). Read-only.",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            }
        ]
    })
}

// ---------------------------------------------------------------------------
// JSON-RPC request handling
// ---------------------------------------------------------------------------

fn handle_mcp_request(method: String, params: Option<serde_json::Value>, project_path: &str) -> Result<serde_json::Value, String> {
    match method.as_str() {
        "initialize" => {
            Ok(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {},
                    "prompts": {},
                    "resources": {}
                },
                "serverInfo": {
                    "name": "saple-memory-server",
                    "version": "0.2.0"
                }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_catalog()),
        "tools/call" => {
            let name = params.as_ref()
                .and_then(|p| p["name"].as_str())
                .ok_or("Missing tool name in tools/call")?;

            let args = params.as_ref()
                .and_then(|p| p.get("arguments").cloned());

            // Tool execution failures are reported as a result with `isError: true`
            // (per the MCP spec), not as a protocol-level JSON-RPC error.
            match handle_tool_call(name, args, project_path) {
                Ok(result) => Ok(result),
                Err(msg) => Ok(json!({
                    "content": [{ "type": "text", "text": format!("Error: {}", msg) }],
                    "isError": true
                })),
            }
        }
        "prompts/list" => {
            Ok(json!({
                "prompts": [{
                    "name": "saple_onboarding",
                    "description": "How to use the Saple memory + task tools effectively to build durable shared context.",
                    "arguments": []
                }]
            }))
        }
        "prompts/get" => {
            let name = params.as_ref()
                .and_then(|p| p["name"].as_str())
                .ok_or("Missing prompt name")?;
            if name != "saple_onboarding" {
                return Err(format!("Unknown prompt: {}", name));
            }
            Ok(json!({
                "description": "Saple shared-context onboarding",
                "messages": [{
                    "role": "user",
                    "content": { "type": "text", "text": SAPLE_ONBOARDING_PROMPT }
                }]
            }))
        }
        "resources/list" => {
            let memory_dir = get_memory_dir(project_path);
            let all = read_all_notes(&memory_dir);
            let resources: Vec<serde_json::Value> = all.into_iter()
                .map(|(node, _)| json!({
                    "uri": format!("saple-memory://{}", node.id),
                    "name": node.title,
                    "description": format!("{} note", node.category),
                    "mimeType": "text/markdown"
                }))
                .collect();
            Ok(json!({ "resources": resources }))
        }
        "resources/read" => {
            let uri = params.as_ref()
                .and_then(|p| p["uri"].as_str())
                .ok_or("Missing uri")?;
            let id = uri.strip_prefix("saple-memory://")
                .ok_or_else(|| format!("Unsupported resource uri: {}", uri))?;
            let memory_dir = get_memory_dir(project_path);
            let (_, _, raw_content) = find_note_file(&memory_dir, id)
                .ok_or_else(|| format!("Resource not found: {}", uri))?;
            Ok(json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "text/markdown",
                    "text": raw_content
                }]
            }))
        }
        _ => Err(format!("Method not supported: {}", method)),
    }
}

/// Process one JSON-RPC line. Returns `None` for notifications (no `id`),
/// which per spec must not receive a response.
fn process_request(req_str: &str, project_path: &str) -> Option<JsonRpcResponse> {
    let req: JsonRpcRequest = match serde_json::from_str(req_str) {
        Ok(r) => r,
        Err(_) => return Some(JsonRpcResponse::error(serde_json::Value::Null, -32700, "Parse error")),
    };

    // Notifications carry no id and expect no reply.
    let id = match req.id {
        Some(id) => id,
        None => return None,
    };

    match handle_mcp_request(req.method, req.params, project_path) {
        Ok(result) => Some(JsonRpcResponse::result(id, result)),
        Err(err_msg) => Some(JsonRpcResponse::error(id, -32603, &err_msg)),
    }
}

pub fn run_mcp_server(project_path: String) {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout_lock = stdout.lock();

    for line in stdin.lock().lines() {
        let req_str = match line {
            Ok(s) => s,
            Err(_) => continue,
        };
        if req_str.trim().is_empty() {
            continue;
        }

        if let Some(resp) = process_request(&req_str, &project_path) {
            let _ = serde_json::to_writer(&mut stdout_lock, &resp);
            let _ = stdout_lock.write_all(b"\n");
            let _ = stdout_lock.flush();
        }
    }
}

#[tauri::command]
pub fn test_mcp_tools(project_path: String) -> Result<serde_json::Value, String> {
    handle_mcp_request("tools/list".to_string(), None, &project_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempProject {
        path: PathBuf,
    }

    impl TempProject {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("saple_mcp_test_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join(".saple").join("memory")).unwrap();
            TempProject { path }
        }
        fn path_str(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn call(name: &str, args: serde_json::Value, project: &str) -> serde_json::Value {
        handle_tool_call(name, Some(args), project).expect("tool call failed")
    }

    /// Pull the text payload out of a tool result.
    fn result_text(v: &serde_json::Value) -> String {
        v["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn search_ranks_title_matches_above_body_and_includes_snippet() {
        let p = TempProject::new();
        let proj = p.path_str();

        call("create_memory", json!({
            "title": "JWT Authentication",
            "category": "architecture",
            "content": "We use JSON web tokens for the login flow.",
            "tags": ["auth"]
        }), &proj);
        call("create_memory", json!({
            "title": "Caching layer",
            "category": "architecture",
            "content": "Some unrelated note that mentions authentication once in passing.",
            "tags": ["perf"]
        }), &proj);

        let res = call("search_memories", json!({ "query": "authentication" }), &proj);
        let parsed: serde_json::Value = serde_json::from_str(&result_text(&res)).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 2, "both notes mention the term");
        // Title match should outrank the in-body-only mention.
        assert_eq!(arr[0]["id"].as_str().unwrap(), "jwt-authentication");
        assert!(arr[0]["score"].as_i64().unwrap() > arr[1]["score"].as_i64().unwrap());
        assert!(arr[0].get("snippet").is_some());
    }

    #[test]
    fn search_mode_all_requires_every_term() {
        let p = TempProject::new();
        let proj = p.path_str();

        call("create_memory", json!({
            "title": "JWT auth decision",
            "category": "decision",
            "content": "tokens and sessions"
        }), &proj);
        call("create_memory", json!({
            "title": "Logging",
            "category": "general",
            "content": "structured logging only"
        }), &proj);

        // "all" (default): only the note containing both terms.
        let res = call("search_memories", json!({ "query": "jwt tokens" }), &proj);
        let parsed: serde_json::Value = serde_json::from_str(&result_text(&res)).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 1);

        // "any": both notes share no term here, so still 1.
        let res_any = call("search_memories", json!({ "query": "jwt logging", "mode": "any" }), &proj);
        let parsed_any: serde_json::Value = serde_json::from_str(&result_text(&res_any)).unwrap();
        assert_eq!(parsed_any.as_array().unwrap().len(), 2);
    }

    #[test]
    fn task_create_list_update_delete_roundtrip() {
        let p = TempProject::new();
        let proj = p.path_str();

        let created = call("create_task", json!({
            "title": "Wire up MCP",
            "priority": "high",
            "labels": ["mcp"]
        }), &proj);
        let created_text = result_text(&created);
        // Extract the id from the message "(ID: task_...)".
        let id = created_text.split("ID: ").nth(1).unwrap().split(')').next().unwrap().to_string();

        // list_tasks finds it
        let listed = call("list_tasks", json!({}), &proj);
        let arr: serde_json::Value = serde_json::from_str(&result_text(&listed)).unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(arr[0]["column"].as_str().unwrap(), "backlog");

        // update moves column
        call("update_task", json!({ "id": id, "column": "progress" }), &proj);
        let got = call("get_task", json!({ "id": id }), &proj);
        let task: serde_json::Value = serde_json::from_str(&result_text(&got)).unwrap();
        assert_eq!(task["column"].as_str().unwrap(), "progress");
        assert_eq!(task["priority"].as_str().unwrap(), "high");

        // filter by column
        let filtered = call("list_tasks", json!({ "column": "done" }), &proj);
        let farr: serde_json::Value = serde_json::from_str(&result_text(&filtered)).unwrap();
        assert_eq!(farr.as_array().unwrap().len(), 0);

        // delete
        call("delete_task", json!({ "id": id }), &proj);
        let after = call("list_tasks", json!({}), &proj);
        let aarr: serde_json::Value = serde_json::from_str(&result_text(&after)).unwrap();
        assert_eq!(aarr.as_array().unwrap().len(), 0);
    }

    #[test]
    fn notification_produces_no_response() {
        let p = TempProject::new();
        let proj = p.path_str();
        let out = process_request("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", &proj);
        assert!(out.is_none());
    }

    #[test]
    fn tool_error_is_reported_as_iserror_result() {
        let p = TempProject::new();
        let proj = p.path_str();
        // Missing required `id` for get_memory → isError result, not a JSON-RPC error.
        let out = process_request(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_memory\",\"arguments\":{}}}",
            &proj,
        ).unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert!(v["error"].is_null(), "should not be a protocol error");
        assert_eq!(v["result"]["isError"].as_bool(), Some(true));
    }

    #[test]
    fn prompts_and_resources_are_listed() {
        let p = TempProject::new();
        let proj = p.path_str();
        call("create_memory", json!({
            "title": "Resource note",
            "category": "general",
            "content": "body"
        }), &proj);

        let prompts = handle_mcp_request("prompts/list".to_string(), None, &proj).unwrap();
        assert_eq!(prompts["prompts"][0]["name"].as_str().unwrap(), "saple_onboarding");

        let resources = handle_mcp_request("resources/list".to_string(), None, &proj).unwrap();
        let arr = resources["resources"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["uri"].as_str().unwrap(), "saple-memory://resource-note");

        let read = handle_mcp_request(
            "resources/read".to_string(),
            Some(json!({ "uri": "saple-memory://resource-note" })),
            &proj,
        ).unwrap();
        assert!(read["contents"][0]["text"].as_str().unwrap().contains("body"));
    }
}
