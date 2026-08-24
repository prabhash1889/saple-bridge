use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Rust-owned registry of approved project roots, stored as canonical absolute paths.
///
/// A compromised renderer can pass arbitrary strings to every project command today;
/// this registry is the anchor the privileged-command trust boundary (sub-phase 1B)
/// will check against. Roots enter it only through two paths:
///   * a successful native directory selection (`select_directory` in `lib.rs`), or
///   * validated restoration of a previously approved project — an existing,
///     readable directory handed back from persisted recents.
/// Raw renderer strings are never trusted as trust anchors; everything is
/// canonicalized before it is stored or compared.
pub struct ProjectRootRegistry {
    /// Canonical root -> number of open workspace instances referencing it. The same
    /// folder can be opened multiple times as distinct instances, so a root is only
    /// removed once its last instance is closed.
    roots: Mutex<HashMap<PathBuf, usize>>,
}

impl Default for ProjectRootRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectRootRegistry {
    pub fn new() -> Self {
        Self {
            roots: Mutex::new(HashMap::new()),
        }
    }

    /// Canonicalize and register a root chosen through a native dialog. Idempotent per
    /// open workspace instance: each call adds one reference.
    pub fn register_root(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_dir(path)?;
        let mut roots = self.roots.lock().map_err(|_| REGISTRY_POISONED.to_string())?;
        *roots.entry(canonical.clone()).or_insert(0) += 1;
        Ok(canonical)
    }

    /// Validated restoration of a previously approved project (recents / cold-start
    /// restore). The directory must still exist and be accessible; otherwise the
    /// stale entry is refused instead of becoming a trust anchor.
    pub fn restore_root(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_dir(path)?;
        fs::read_dir(&canonical)
            .and_then(|mut entries| entries.next().transpose().map(|_| ()))
            .map_err(|e| format!("Project path is not accessible: {}", e))?;
        self.register_root(&canonical)
    }

    /// Whether `path` resolves inside any approved root. Non-existent targets are
    /// resolved through their nearest existing ancestor (the target may be about to
    /// be created), mirroring the containment logic in `project.rs`.
    pub fn verify_path_inside_approved_root(&self, path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        let resolved = match resolve_existing_ancestor(path) {
            Some(p) => p,
            None => return false,
        };
        let roots = match self.roots.lock() {
            Ok(r) => r,
            Err(_) => return false,
        };
        roots.keys().any(|root| path_starts_with(&resolved, root))
    }

    /// Canonical roots currently approved, sorted for stable output.
    /// Deliberately not exposed to the renderer: the approved-root list is Rust-internal
    /// trust state, so this stays available to tests and diagnostics only.
    #[cfg(test)]
    pub fn list_roots(&self) -> Vec<PathBuf> {
        self.roots
            .lock()
            .map(|r| {
                let mut keys: Vec<PathBuf> = r.keys().cloned().collect();
                keys.sort();
                keys
            })
            .unwrap_or_default()
    }

    /// Trust-boundary gate for every privileged command: `project_path` must resolve
    /// inside an approved root or the command refuses to run (fail closed). This is
    /// the single check each `*_inner` operation calls before touching the filesystem,
    /// spawning a process, or arming a watcher.
    pub fn ensure_inside_approved_root(&self, project_path: &str) -> Result<(), String> {
        if self.verify_path_inside_approved_root(Path::new(project_path)) {
            Ok(())
        } else {
            Err(format!(
                "Access denied: '{}' is not inside an approved project root. Re-open the folder in Bridge to approve it.",
                project_path
            ))
        }
    }

    /// Whether `path` resolves inside an approved root or under the user's home
    /// directory. Home is the one deliberately supported non-project location: a
    /// terminal pane may run a shell there without any project open. Only gates that
    /// must keep that intentional mode working may call this; everything else uses
    /// [`Self::ensure_inside_approved_root`].
    pub fn verify_inside_approved_root_or_home(&self, path: &Path) -> bool {
        if self.verify_path_inside_approved_root(path) {
            return true;
        }
        if !path.is_absolute() {
            return false;
        }
        let Some(resolved) = resolve_existing_ancestor(path) else {
            return false;
        };
        home_dir()
            .map(|home| path_starts_with(&resolved, &home))
            .unwrap_or(false)
    }

    /// Fail-closed variant of [`Self::verify_inside_approved_root_or_home`].
    pub fn ensure_inside_approved_root_or_home(&self, project_path: &str) -> Result<(), String> {
        if self.verify_inside_approved_root_or_home(Path::new(project_path)) {
            Ok(())
        } else {
            Err(format!(
                "Access denied: '{}' is not inside an approved project root or the home directory.",
                project_path
            ))
        }
    }

    /// Drop one reference held by a closing workspace instance. The root is removed
    /// when its last instance closes; releasing an unknown path is an error so a
    /// misbehaving renderer cannot probe the registry by guessing.
    pub fn release_root(&self, path: &Path) -> Result<(), String> {
        let canonical = canonical_dir(path)?;
        let mut roots = self.roots.lock().map_err(|_| REGISTRY_POISONED.to_string())?;
        match roots.get_mut(&canonical) {
            None => Err("Project root is not registered".to_string()),
            Some(count) => {
                if *count <= 1 {
                    roots.remove(&canonical);
                } else {
                    *count -= 1;
                }
                Ok(())
            }
        }
    }
}

const REGISTRY_POISONED: &str = "Project root registry lock poisoned";

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid project path {}: {}", path.display(), e))?;
    if !canonical.is_dir() {
        return Err(format!("Project path {} is not a directory", canonical.display()));
    }
    Ok(canonical)
}

/// The user's home directory (canonicalized), or `None` when it cannot be determined.
fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
}

fn resolve_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if let Ok(canonical) = current.canonicalize() {
            return Some(canonical);
        }
        current = current.parent()?.to_path_buf();
    }
}

/// Separator-aware prefix check that tolerates Windows case-insensitivity
/// (`starts_with` on `Path` compares components case-sensitively, which would let
/// a differently-cased path slip past on NTFS where both spellings are the same dir).
fn path_starts_with(path: &Path, base: &Path) -> bool {
    let mut path_iter = path.components();
    let mut base_iter = base.components();
    loop {
        match base_iter.next() {
            None => return true,
            Some(b) => match path_iter.next() {
                Some(p) => {
                    let matches = if cfg!(windows) {
                        p.as_os_str().eq_ignore_ascii_case(b.as_os_str())
                    } else {
                        p.as_os_str() == b.as_os_str()
                    };
                    if !matches {
                        return false;
                    }
                }
                None => return false,
            },
        }
    }
}

#[tauri::command]
pub fn register_project_root(
    path: String,
    registry: tauri::State<std::sync::Arc<ProjectRootRegistry>>,
) -> Result<String, String> {
    // Renderer-initiated registration is always the validated-restoration path: the
    // directory must still exist and be accessible before it becomes trusted.
    registry
        .restore_root(Path::new(&path))
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn release_project_root(
    path: String,
    registry: tauri::State<std::sync::Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry.release_root(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "saple-roots-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn registers_canonical_absolute_path() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();

        // Trailing dot-segment and redundant separators must collapse to the canonical form.
        let messy = dir.join(".").join("sub");
        fs::create_dir_all(&messy).unwrap();
        let registered = registry.register_root(dir.join("sub").join(".").as_path()).unwrap();
        assert_eq!(registered, dir.join("sub"));
        assert!(registered.is_absolute());
        assert_eq!(registry.list_roots(), vec![dir.join("sub")]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_nonexistent_or_file_roots() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();

        let err = registry.register_root(&dir.join("does-not-exist")).unwrap_err();
        assert!(err.contains("Invalid project path"), "got: {}", err);

        let file = dir.join("file.txt");
        fs::write(&file, "x").unwrap();
        let err = registry.register_root(&file).unwrap_err();
        assert!(err.contains("not a directory"), "got: {}", err);

        assert!(registry.list_roots().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_missing_directory_but_accepts_existing() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();

        assert!(registry.restore_root(Path::new(dir.join("gone").to_str().unwrap())).is_err());

        registry.restore_root(Path::new(dir.to_str().unwrap())).expect("existing dir restores");
        assert_eq!(registry.list_roots(), vec![dir.clone()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn containment_table() {
        struct Case {
            name: &'static str,
            rel_target: PathBuf,
            create: bool,
            expected: bool,
        }
        let cases = [
            Case { name: "root itself", rel_target: PathBuf::from(""), create: false, expected: true },
            Case { name: "direct child", rel_target: PathBuf::from("child.txt"), create: true, expected: true },
            Case { name: "grandchild", rel_target: PathBuf::from("a/b/c.txt"), create: true, expected: true },
            Case { name: "dot-path child", rel_target: PathBuf::from("./a/./b.txt"), create: true, expected: true },
            Case { name: "traversal then back in", rel_target: PathBuf::from("a/../a/b.txt"), create: true, expected: true },
            Case { name: "sibling", rel_target: PathBuf::from("../sibling.txt"), create: true, expected: false },
            Case { name: "parent traversal escape", rel_target: PathBuf::from("../../escape.txt"), create: false, expected: false },
            Case { name: "nonexistent child of root", rel_target: PathBuf::from("not-yet/new.txt"), create: false, expected: true },
            Case { name: "nonexistent escape via missing dirs", rel_target: PathBuf::from("../nope/deep.txt"), create: false, expected: false },
        ];

        let registry = ProjectRootRegistry::new();
        let dir = temp_project();
        registry.register_root(&dir).unwrap();

        for case in &cases {
            let target = dir.join(&case.rel_target);
            if case.create {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&target, "x").unwrap();
            }
            let got = registry.verify_path_inside_approved_root(&target);
            assert_eq!(got, case.expected, "case '{}' ({})", case.name, target.display());
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_paths_outside_any_registered_root() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();
        registry.register_root(&dir).unwrap();

        // Sibling directory that exists.
        let sibling = dir.parent().unwrap().join(format!("sibling-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&sibling).unwrap();
        assert!(!registry.verify_path_inside_approved_root(&sibling));

        // Parent of the root.
        assert!(!registry.verify_path_inside_approved_root(dir.parent().unwrap()));

        // Relative paths are rejected outright: they would resolve against the process cwd.
        assert!(!registry.verify_path_inside_approved_root(Path::new("relative/path")));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[cfg(windows)]
    #[test]
    fn containment_is_case_insensitive_on_windows() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();
        let upper = dir.to_string_lossy().to_uppercase();
        registry.register_root(&dir).unwrap();
        assert!(
            registry.verify_path_inside_approved_root(Path::new(&upper).join("kid.txt").as_path()),
            "differently-cased spelling of the root must be contained"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_registration_refcounts_and_release_removes_at_zero() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();

        registry.register_root(&dir).unwrap();
        registry.register_root(&dir).unwrap(); // second instance of the same folder
        assert_eq!(registry.list_roots().len(), 1);

        // Still approved while one instance remains open.
        registry.release_root(&dir).expect("first close");
        assert!(registry.verify_path_inside_approved_root(&dir.join("still-open.txt")));

        registry.release_root(&dir).expect("last close");
        assert!(registry.list_roots().is_empty());
        assert!(!registry.verify_path_inside_approved_root(&dir));

        // Releasing an unregistered root must fail loudly.
        let err = registry.release_root(&dir).unwrap_err();
        assert!(err.contains("not registered"), "got: {}", err);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn home_mode_allows_home_but_not_arbitrary_roots() {
        let registry = ProjectRootRegistry::new();
        let Some(home) = home_dir() else {
            return; // environment without a resolvable home: nothing to assert
        };

        // The intentional home-shell mode passes even with zero approved roots.
        assert!(registry.verify_inside_approved_root_or_home(&home));
        assert!(registry.ensure_inside_approved_root_or_home(&home.to_string_lossy()).is_ok());

        // A directory outside the home tree still fails closed. (temp_dir sits under
        // the user profile on Windows, so the home's own parent is the out-of-home fixture.)
        if let Some(outside) = home.parent() {
            assert!(!registry.verify_inside_approved_root_or_home(outside));
            let err = registry
                .ensure_inside_approved_root_or_home(&outside.to_string_lossy())
                .unwrap_err();
            assert!(err.contains("Access denied"), "got: {}", err);
        }
    }

    #[test]
    fn removal_stops_verification_immediately() {
        let registry = ProjectRootRegistry::new();
        let dir = temp_project();
        registry.register_root(&dir).unwrap();
        assert!(registry.verify_path_inside_approved_root(&dir));
        registry.release_root(&dir).unwrap();
        let child = dir.join("anything.txt");
        fs::write(&child, "x").unwrap();
        assert!(!registry.verify_path_inside_approved_root(&child));
        let _ = fs::remove_dir_all(&dir);
    }
}
