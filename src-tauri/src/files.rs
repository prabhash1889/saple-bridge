use std::fs;
use std::path::Path;
use std::process::Command;
use serde::{Serialize, Deserialize};
use crate::process_ext::CommandNoWindow;

const MAX_FILE_ENTRIES: usize = 5_000;
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String, // Relative path from project root
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

fn is_ignored(name: &str, is_dir: bool, size: Option<u64>) -> bool {
    let lower_name = name.to_lowercase();
    if is_dir {
        matches!(
            lower_name.as_str(),
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".venv"
                | ".next"
                | ".saple"
                | ".bridgememory"
                | ".pytest_cache"
                | "__pycache__"
                | ".cache"
        )
    } else {
        // Large file (> 5MB)
        if let Some(s) = size {
            if s > 5 * 1024 * 1024 {
                return true;
            }
        }
        
        // Common binary extensions
        let ext = Path::new(&lower_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
            
        matches!(
            ext,
            "exe" | "dll" | "pdb" | "zip" | "tar" | "gz" | "rar" | "7z" | "png" | "jpg" | "jpeg" | "gif" | "ico" | "pdf" | "mp4" | "mp3" | "wav" | "woff" | "woff2" | "ttf" | "eot" | "class" | "jar"
        )
    }
}

fn list_dir_recursive(
    project_path: &str,
    current_dir: &Path,
    base_path: &Path,
    depth: usize,
    max_depth: usize,
    results: &mut Vec<FileEntry>,
) -> Result<(), String> {
    if depth > max_depth {
        return Ok(());
    }
    
    // Gracefully handle directories we do not have permission to read
    let read_dir = match fs::read_dir(current_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
        
    for entry in read_dir {
        if results.len() >= MAX_FILE_ENTRIES {
            return Ok(());
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip problematic entries
        };
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // skip entries with inaccessible metadata
        };
        let name = entry.file_name().to_string_lossy().to_string();
        
        let is_dir = metadata.is_dir();
        let size_bytes = if is_dir { None } else { Some(metadata.len()) };
        
        if is_ignored(&name, is_dir, size_bytes) {
            continue;
        }
        
        let rel_path = match path.strip_prefix(base_path) {
            Ok(p) => p.to_string_lossy().to_string().replace('\\', "/"),
            Err(_) => continue,
        };
            
        results.push(FileEntry {
            name,
            path: rel_path,
            is_dir,
            size_bytes,
        });
        
        if is_dir {
            list_dir_recursive(project_path, &path, base_path, depth + 1, max_depth, results)?;
        }
    }
    
    Ok(())
}

fn list_project_files_inner(
    project_path: String,
    root: String,
    depth: Option<usize>,
) -> Result<Vec<FileEntry>, String> {
    let base = Path::new(&project_path);
    let target = if root.is_empty() {
        base.to_path_buf()
    } else {
        base.join(&root)
    };
    
    // Safety check: ensure target path stays inside project directory
    let canonical_base = base.canonicalize().map_err(|e| format!("Base path error: {}", e))?;
    
    // Check if target directory exists before canonicalizing it
    if !target.exists() {
        return Err("Directory does not exist".to_string());
    }
    let canonical_target = target.canonicalize().map_err(|e| format!("Target path error: {}", e))?;
    
    if !canonical_target.starts_with(&canonical_base) {
        return Err("Access denied: path is outside the project workspace".to_string());
    }
    
    let max_depth = depth.unwrap_or(3);
    let mut results = Vec::new();
    
    list_dir_recursive(&project_path, &canonical_target, &canonical_base, 1, max_depth, &mut results)?;
    
    // Sort files alphabetically: folders first, then files
    results.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.path.cmp(&b.path)
        }
    });
    
    Ok(results)
}

fn read_text_file_inner(project_path: String, file_path: String) -> Result<String, String> {
    // Utilize safe file path function from project module
    let full_path = crate::project::get_project_file_path(&project_path, &file_path)?;
    if !full_path.exists() {
        return Err("File not found".to_string());
    }
    if full_path.metadata().map(|meta| meta.len() > MAX_TEXT_FILE_BYTES).unwrap_or(false) {
        return Err(format!("File is larger than {} bytes", MAX_TEXT_FILE_BYTES));
    }
    
    // Verify it's a text file and read it
    let content = fs::read(full_path).map_err(|e| e.to_string())?;
    
    // Simple UTF-8 validation
    let text = String::from_utf8(content)
        .map_err(|_| "Failed to parse file: Content is not valid UTF-8 text".to_string())?;
        
    Ok(text)
}

fn write_text_file_inner(
    project_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    // Check if editing is enabled in the workspace configuration
    let config = crate::project::read_project_config_inner(project_path.clone())?;
    if !config.enable_edit_mode {
        return Err("Access denied: Editing files is disabled for this workspace. Enable it in Settings.".to_string());
    }
    
    let full_path = crate::project::get_project_file_path(&project_path, &file_path)?;
    crate::fs_lock::atomic_write(&full_path, content.as_bytes())
}

fn open_in_external_editor_inner(project_path: String, file_path: String) -> Result<(), String> {
    let full_path = crate::project::get_project_file_path(&project_path, &file_path)?;
    if !full_path.exists() {
        return Err("File not found".to_string());
    }
    
    // Open with the platform's default handler for the file's type.
    let path_str = full_path.to_string_lossy().to_string();
    let mut cmd = if cfg!(target_os = "windows") {
        // `start` is a cmd builtin; the empty "" is the (ignored) window title.
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &path_str]);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(&path_str);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&path_str);
        c
    };
    cmd.no_window()
        .spawn()
        .map_err(|e| format!("Failed to open file in external editor: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn list_project_files(
    project_path: String,
    root: String,
    depth: Option<usize>,
) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_project_files_inner(project_path, root, depth))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_text_file(project_path: String, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_text_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_text_file(
    project_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_text_file_inner(project_path, file_path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn reveal_in_file_explorer_inner(project_path: String, file_path: String) -> Result<(), String> {
    // An empty `file_path` targets the workspace root itself (used by the
    // sidebar workspace rows); otherwise resolve a contained relative path
    // (used by the file tree's subfolders).
    let full_path = if file_path.is_empty() {
        Path::new(&project_path).to_path_buf()
    } else {
        crate::project::get_project_file_path(&project_path, &file_path)?
    };
    if !full_path.exists() {
        return Err("Path not found".to_string());
    }

    let is_dir = full_path.is_dir();
    let path_str = full_path.to_string_lossy().to_string();

    // Open a directory directly in the OS file manager; for a file, reveal it
    // by selecting it inside its parent folder.
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("explorer");
        if is_dir {
            c.arg(&path_str);
        } else {
            // `/select,<path>` must be a single argument.
            c.arg(format!("/select,{}", path_str));
        }
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        if is_dir {
            c.arg(&path_str);
        } else {
            c.args(["-R", &path_str]);
        }
        c
    } else {
        // Linux: xdg-open targets a directory; for a file, open its parent.
        let target = if is_dir {
            path_str.clone()
        } else {
            full_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone())
        };
        let mut c = Command::new("xdg-open");
        c.arg(target);
        c
    };

    // Note: explorer.exe returns a non-zero exit code even on success; we only
    // spawn (never wait), so a successful spawn is treated as success.
    cmd.no_window()
        .spawn()
        .map_err(|e| format!("Failed to open file explorer: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn open_in_external_editor(project_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_in_external_editor_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reveal_in_file_explorer(project_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_in_file_explorer_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

// --- File management (create / rename / delete) ------------------------------
// All paths route through `get_project_file_path`, which rejects traversal and
// proves containment against the workspace root, so these can never touch a path
// outside the selected project.

fn create_file_inner(project_path: String, file_path: String) -> Result<(), String> {
    let full_path = crate::project::get_project_file_path(&project_path, &file_path)?;
    if full_path.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    // create_new so a race can't clobber a file that appeared after the check.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(())
}

fn create_directory_inner(project_path: String, dir_path: String) -> Result<(), String> {
    let full_path = crate::project::get_project_file_path(&project_path, &dir_path)?;
    if full_path.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    fs::create_dir_all(&full_path).map_err(|e| format!("Failed to create folder: {}", e))
}

fn rename_path_inner(project_path: String, from_path: String, to_path: String) -> Result<(), String> {
    let from = crate::project::get_project_file_path(&project_path, &from_path)?;
    if !from.exists() {
        return Err("Source path no longer exists".to_string());
    }
    // Validate the destination for containment even though it doesn't exist yet.
    let to = crate::project::get_project_file_path(&project_path, &to_path)?;
    if to.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    fs::rename(&from, &to).map_err(|e| format!("Failed to rename: {}", e))
}

fn delete_path_inner(project_path: String, file_path: String) -> Result<(), String> {
    let full_path = crate::project::get_project_file_path(&project_path, &file_path)?;
    if !full_path.exists() {
        return Err("Path no longer exists".to_string());
    }
    // Recycle bin rather than permanent delete, so an accidental removal is recoverable.
    trash::delete(&full_path).map_err(|e| format!("Failed to move to trash: {}", e))
}

#[tauri::command]
pub async fn create_file(project_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_file_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_directory(project_path: String, dir_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_directory_inner(project_path, dir_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_path(project_path: String, from_path: String, to_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_path_inner(project_path, from_path, to_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_path(project_path: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_path_inner(project_path, file_path))
        .await
        .map_err(|e| e.to_string())?
}

// --- Workspace text search ----------------------------------------------------

const MAX_SEARCH_HITS: usize = 500;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,      // Relative path from project root
    pub line: usize,       // 1-based line number
    pub column: usize,     // 1-based column of the match start
    pub line_text: String, // The matching line (trimmed of trailing newline), capped
}

fn search_dir_recursive(
    current_dir: &Path,
    base_path: &Path,
    needle_lower: &str,
    results: &mut Vec<SearchHit>,
    truncated: &mut bool,
) {
    if results.len() >= MAX_SEARCH_HITS {
        *truncated = true;
        return;
    }
    let read_dir = match fs::read_dir(current_dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir {
        if results.len() >= MAX_SEARCH_HITS {
            *truncated = true;
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();
        let size_bytes = if is_dir { None } else { Some(metadata.len()) };
        if is_ignored(&name, is_dir, size_bytes) {
            continue;
        }
        if is_dir {
            search_dir_recursive(&path, base_path, needle_lower, results, truncated);
        } else {
            if metadata.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let content = match fs::read(&path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => continue, // skip binary / non-UTF-8
                },
                Err(_) => continue,
            };
            let rel_path = match path.strip_prefix(base_path) {
                Ok(p) => p.to_string_lossy().to_string().replace('\\', "/"),
                Err(_) => continue,
            };
            for (idx, line) in content.lines().enumerate() {
                if let Some(col) = line.to_lowercase().find(needle_lower) {
                    let snippet: String = line.chars().take(400).collect();
                    results.push(SearchHit {
                        path: rel_path.clone(),
                        line: idx + 1,
                        column: col + 1,
                        line_text: snippet,
                    });
                    if results.len() >= MAX_SEARCH_HITS {
                        *truncated = true;
                        return;
                    }
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

fn search_in_files_inner(project_path: String, query: String) -> Result<SearchResult, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(SearchResult { hits: Vec::new(), truncated: false });
    }
    let base = Path::new(&project_path);
    let canonical_base = base.canonicalize().map_err(|e| format!("Base path error: {}", e))?;
    let needle_lower = needle.to_lowercase();
    let mut results = Vec::new();
    let mut truncated = false;
    search_dir_recursive(&canonical_base, &canonical_base, &needle_lower, &mut results, &mut truncated);
    Ok(SearchResult { hits: results, truncated })
}

#[tauri::command]
pub async fn search_in_files(project_path: String, query: String) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search_in_files_inner(project_path, query))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_files() {
        // Use the crate dir (always present, cross-platform) as the project root.
        let project_path = env!("CARGO_MANIFEST_DIR").to_string();
        let results = list_project_files_inner(project_path, "".to_string(), Some(8));
        match &results {
            Ok(files) => {
                println!("SUCCESS: found {} files", files.len());
                for f in files.iter().take(10) {
                    println!("  - {} (dir={})", f.path, f.is_dir);
                }
            }
            Err(e) => {
                println!("ERROR: {}", e);
            }
        }
        assert!(results.is_ok());
        let files = results.unwrap();
        assert!(!files.is_empty());
    }

    #[test]
    fn create_file_rejects_traversal() {
        let project_path = env!("CARGO_MANIFEST_DIR").to_string();
        let err = create_file_inner(project_path, "../escapes.txt".to_string());
        assert!(err.is_err());
    }

    #[test]
    fn rename_rejects_absolute_dest() {
        let project_path = env!("CARGO_MANIFEST_DIR").to_string();
        let abs = if cfg!(windows) { "C:/Windows/x.txt" } else { "/tmp/x.txt" };
        let err = rename_path_inner(project_path, "Cargo.toml".to_string(), abs.to_string());
        assert!(err.is_err());
    }

    #[test]
    fn search_finds_known_token() {
        // Cargo.toml in the crate root always contains the package name "saple-bridge".
        let project_path = env!("CARGO_MANIFEST_DIR").to_string();
        let res = search_in_files_inner(project_path, "saple-bridge".to_string()).unwrap();
        assert!(res.hits.iter().any(|h| h.path == "Cargo.toml"));
    }

    #[test]
    fn search_empty_query_returns_nothing() {
        let project_path = env!("CARGO_MANIFEST_DIR").to_string();
        let res = search_in_files_inner(project_path, "   ".to_string()).unwrap();
        assert!(res.hits.is_empty());
    }
}
