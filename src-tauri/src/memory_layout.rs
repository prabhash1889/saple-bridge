//! Single owner of memory layout decisions: which directories hold notes for each
//! supported `memoryMode` (`saple`, `bridge-compatible`, `both`), where snapshots
//! live, and how the mode is read from `.saple/config.json`.
//!
//! Every read, write, delete, search, graph, and snapshot operation must resolve
//! paths through this module instead of re-deriving directory names at call sites.

use std::fs;
use std::path::PathBuf;

pub const MODE_SAPLE: &str = "saple";
pub const MODE_BRIDGE_COMPATIBLE: &str = "bridge-compatible";
pub const MODE_BOTH: &str = "both";

/// Read the workspace's `memoryMode` from `.saple/config.json`. Missing config,
/// missing key, or unparseable JSON all fall back to `saple`, matching the
/// pre-layout-owner behavior.
pub fn get_memory_mode(project_path: &str) -> String {
    let config_path = std::path::Path::new(project_path).join(".saple").join("config.json");
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(config_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(mode) = config.get("memoryMode").and_then(|m| m.as_str()) {
                    return mode.to_string();
                }
            }
        }
    }
    MODE_SAPLE.to_string()
}

fn uses_bridge_storage(mode: &str) -> bool {
    mode == MODE_BRIDGE_COMPATIBLE || mode == MODE_BOTH
}

/// Saple-native memory directory: always `<project>/.saple/memory`.
pub fn saple_memory_dir(project_path: &str) -> PathBuf {
    std::path::Path::new(project_path).join(".saple").join("memory")
}

/// Bridge-compatible memory directory: always `<project>/.bridgememory`.
pub fn bridge_memory_dir(project_path: &str) -> PathBuf {
    std::path::Path::new(project_path).join(".bridgememory")
}

/// Primary memory directory for the active mode: the single directory used by
/// reads, graph walks, search, and note lookup.
pub fn get_memory_dir(project_path: &str) -> PathBuf {
    if get_memory_mode(project_path) == MODE_BRIDGE_COMPATIBLE {
        bridge_memory_dir(project_path)
    } else {
        saple_memory_dir(project_path)
    }
}

/// Every memory directory the active mode touches, in write order (saple first,
/// then bridge). Writes, deletes, and snapshot restores fan out over all of them.
pub fn write_dirs(project_path: &str) -> Vec<PathBuf> {
    match get_memory_mode(project_path).as_str() {
        MODE_BRIDGE_COMPATIBLE => vec![bridge_memory_dir(project_path)],
        MODE_BOTH => vec![saple_memory_dir(project_path), bridge_memory_dir(project_path)],
        _ => vec![saple_memory_dir(project_path)],
    }
}

/// Memory snapshot root, independent of mode: `<project>/.saple/snapshots`.
pub fn snapshots_dir(project_path: &str) -> PathBuf {
    std::path::Path::new(project_path).join(".saple").join("snapshots")
}

/// Relative directory names that must exist under the project root for the active
/// memory mode. `.saple/memory` is always included; `.bridgememory` joins when the
/// mode reads or writes it. Callers that resolve through the path-policy helper
/// (`get_project_file_path`) use these names so containment stays enforced.
pub fn required_dir_names(project_path: &str) -> Vec<&'static str> {
    let mut dirs = vec![".saple/memory"];
    if uses_bridge_storage(&get_memory_mode(project_path)) {
        dirs.push(".bridgememory");
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "saple-mem-layout-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(dir.join(".saple")).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write_mode(project: &Path, mode: &str) {
        fs::write(
            project.join(".saple").join("config.json"),
            format!("{{\"memoryMode\": \"{}\"}}", mode),
        )
        .unwrap();
    }

    #[test]
    fn missing_config_falls_back_to_saple() {
        let project = temp_project("default");
        assert_eq!(get_memory_mode(project.to_str().unwrap()), "saple");
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn mode_is_read_from_config() {
        let project = temp_project("config");
        write_mode(&project, "both");
        assert_eq!(get_memory_mode(project.to_str().unwrap()), "both");
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn primary_dir_follows_the_active_mode() {
        let saple_project = temp_project("primary-saple");
        write_mode(&saple_project, "saple");
        assert_eq!(
            get_memory_dir(saple_project.to_str().unwrap()),
            saple_project.join(".saple").join("memory")
        );

        let bridge_project = temp_project("primary-bridge");
        write_mode(&bridge_project, "bridge-compatible");
        assert_eq!(
            get_memory_dir(bridge_project.to_str().unwrap()),
            bridge_project.join(".bridgememory")
        );
        // "both" keeps the saple dir as the primary (read/lookup) target.
        write_mode(&bridge_project, "both");
        assert_eq!(
            get_memory_dir(bridge_project.to_str().unwrap()),
            bridge_project.join(".saple").join("memory")
        );

        let _ = fs::remove_dir_all(&saple_project);
        let _ = fs::remove_dir_all(&bridge_project);
    }

    #[test]
    fn write_dirs_match_each_mode() {
        let project = temp_project("writedirs");

        write_mode(&project, "saple");
        assert_eq!(write_dirs(project.to_str().unwrap()), vec![project.join(".saple").join("memory")]);

        write_mode(&project, "bridge-compatible");
        assert_eq!(write_dirs(project.to_str().unwrap()), vec![project.join(".bridgememory")]);

        write_mode(&project, "both");
        assert_eq!(
            write_dirs(project.to_str().unwrap()),
            vec![
                project.join(".saple").join("memory"),
                project.join(".bridgememory"),
            ]
        );

        // Unknown modes keep behaving like plain saple storage.
        write_mode(&project, "something-new");
        assert_eq!(write_dirs(project.to_str().unwrap()), vec![project.join(".saple").join("memory")]);

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn required_dir_names_cover_every_mode() {
        let project = temp_project("requireddirs");

        write_mode(&project, "saple");
        assert_eq!(required_dir_names(project.to_str().unwrap()), vec![".saple/memory"]);

        write_mode(&project, "bridge-compatible");
        assert_eq!(
            required_dir_names(project.to_str().unwrap()),
            vec![".saple/memory", ".bridgememory"]
        );

        write_mode(&project, "both");
        assert_eq!(
            required_dir_names(project.to_str().unwrap()),
            vec![".saple/memory", ".bridgememory"]
        );

        write_mode(&project, "unknown-mode");
        assert_eq!(required_dir_names(project.to_str().unwrap()), vec![".saple/memory"]);

        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn snapshots_dir_is_mode_independent() {
        let project = temp_project("snapshots");
        assert_eq!(
            snapshots_dir(project.to_str().unwrap()),
            project.join(".saple").join("snapshots")
        );
        let _ = fs::remove_dir_all(&project);
    }
}
