mod browser;
mod claude_context;
mod error_code;
mod pty;
mod project;
mod keychain;
mod models;
mod memory;
mod memory_layout;
mod git;
mod review;
mod control_plane;
mod june_control;
mod swarm;
mod missions;
mod files;
mod diagnostics;
mod providers;
mod process_ext;
mod proc_tree;
mod fs_lock;
mod project_roots;
mod project_summary;
mod sidecar;
mod state_load;
mod watcher;
mod app_log;
mod audit;
mod diag_report;

use project_roots::ProjectRootRegistry;

#[tauri::command]
fn select_directory(registry: tauri::State<std::sync::Arc<ProjectRootRegistry>>) -> Option<String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select Project Directory")
        .pick_folder();

    // The native dialog is one of only two ways a root becomes trusted. Register
    // canonically before handing the path back to the renderer; on any registration
    // failure the selection is treated as cancelled rather than returned untrusted.
    folder.and_then(|path| {
        registry
            .register_root(&path)
            .ok()
            .map(|_| path.to_string_lossy().to_string())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before any webview is built: WebView2's environment (and its remote-debugging
    // args) is fixed at first-webview creation. No-op unless the user opted in. See browser.rs.
    browser::apply_agent_browser_port();

    let mut builder = tauri::Builder::default();

    // The single-instance plugin must be registered FIRST. When a second launch is
    // attempted, this callback runs in the already-running process: unminimize and focus
    // the existing window instead of spawning a duplicate.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
        // In-app updater + the process plugin its restart-after-update needs. The plugin
        // requires a valid `plugins.updater` config (a missing key deserializes as null and
        // panics at startup), so the feed + pubkey live in the base tauri.conf.json; only
        // updater-artifact signing is release-only via the tauri.release.conf.json overlay.
        // Store builds (`--features ms-store`) compile the updater out entirely: the Store owns
        // updates for MSIX installs, and a dormant updater is still a policy liability.
        builder = builder.plugin(tauri_plugin_process::init());
        #[cfg(not(feature = "ms-store"))]
        {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    builder
        .setup(|app| {
            use tauri::Manager;
            // Durable logs (Phase 4): app log + privileged-action audit live under the OS
            // application log directory. Best-effort: if resolution or creation fails, logging
            // degrades to a silent no-op rather than blocking startup.
            if let Ok(dir) = app.path().app_log_dir() {
                app_log::init(dir);
            }
            // Stage the sidecar to its stable per-user path before any project opens, so
            // `.mcp.json` never has to reference the (versioned, ACL-restricted on MSIX)
            // install directory. Release only: dev resolves the repo-local staging path.
            #[cfg(not(debug_assertions))]
            sidecar::ensure_stable_sidecar();
            // June control endpoint: a per-process token, then start the loopback server only if the
            // user opted in (default off, no open port). See june_control.rs.
            app.manage(june_control::JuneControl::new(uuid::Uuid::new_v4().to_string()));
            // Panes June spawned and may drive with terminal actions; everything else is refused.
            app.manage(june_control::JuneTerminalScopes::default());
            // Registry of approved project roots (canonical absolute paths). Lives only in
            // Rust memory: roots are added by native directory selection or validated
            // restoration, and every privileged command verifies against it before touching
            // the filesystem or spawning a process (sub-phase 1B). Arc-shared so commands can
            // move a handle into their blocking workers.
            app.manage(std::sync::Arc::new(project_roots::ProjectRootRegistry::new()));
            june_control::start(app.handle().clone());
            Ok(())
        })
        .manage(pty::PtyRegistry::new())
        .manage(watcher::WatcherState::new())
        .manage(watcher::SwarmWatcherState::new())
        // Restore the window's last size/position/maximized state on launch and save it on exit.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Clipboard reads AND writes go through this plugin (not navigator.clipboard): the
        // WebView2 clipboard permission is only auto-granted when the window is built
        // with enable_clipboard_access(), which config-defined windows never are — the async
        // web API would hang on a permission prompt or be denied. Used by the terminal's
        // Ctrl+V paste and Ctrl+C/Ctrl+Shift+C copy handlers (see useXtermSession.ts).
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            // Closing the window must kill every PTY child (and join its reader/emitter threads),
            // otherwise agent CLIs keep running as orphaned processes after the app exits.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                use tauri::Manager;
                window.state::<pty::PtyRegistry>().shutdown();
                // Drop the discovery record so June rejects this dead endpoint immediately.
                june_control::remove_discovery_record();
            }
        })
        .invoke_handler(tauri::generate_handler![
            select_directory,
            project_roots::register_project_root,
            project_roots::release_project_root,
            pty::spawn_pty,
            claude_context::get_claude_context_usage,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            project::read_project_file,
            project::write_project_file,
            project::git_current_branch,
            project::ensure_workspace_dirs,
            project::ensure_project_config,
            project::read_project_config,
            project::write_project_config,
            project::get_workspace_summary,
            project::install_mcp_config,
            project::check_mcp_status,
            sidecar::test_mcp_tools,
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
            keychain::test_provider_connection,
            models::list_provider_models,
            memory::get_memory_graph,
            memory::create_memory_snapshot,
            memory::restore_memory_snapshot,
            memory::list_memory_snapshots,
            memory::delete_memory_file,
            memory::read_memory_file,
            memory::save_memory_node,
            memory::get_unlinked_mentions,
            memory::search_memory_content,
            memory::add_memory_link,
            git::git_status,
            git::git_diff_file,
            git::git_stage_file,
            git::git_unstage_file,
            git::git_commit,
            git::git_tree_identity,
            git::git_list_branches,
            git::git_checkout_branch,
            git::ensure_saple_git_excluded,
            git::git_branch_sync_state,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_create_checkpoint,
            git::git_list_checkpoints,
            git::git_checkpoint_diff,
            git::git_restore_checkpoint,
            review::create_review_record,
            review::read_review_record,
            review::submit_review_decision,
            review::run_verification_command,
            review::cancel_run_command,
            review::set_file_viewed,
            control_plane::canonical_record_write,
            state_load::load_state_file,
            state_load::resolve_state_corruption,
            project_summary::get_recent_project_summaries,
            june_control::june_control_get_enabled,
            june_control::june_control_set_enabled,
            june_control::june_command_result,
            june_control::june_emit_event,
            june_control::june_permit_terminals,
            june_control::june_ensure_terminal_permitted,
            june_control::june_revoke_terminal,
            swarm::read_swarm_state,
            swarm::write_swarm_state,
            swarm::read_mailbox_file,
            swarm::write_mailbox_file,
            swarm::read_handoff_file,
            swarm::write_handoff_file,
            swarm::validate_dependency_graph,
            swarm::run_acceptance_command,
            missions::mission_create,
            missions::mission_list,
            missions::mission_read,
            missions::mission_update_doc,
            missions::mission_set_tasks,
            missions::mission_command,
            missions::mission_dispatch_task,
            missions::mission_record_dispatch_result,
            missions::mission_tick,
            missions::mission_recover,
            files::list_project_files,
            files::read_text_file,
            files::write_text_file,
            files::open_in_external_editor,
            files::reveal_in_file_explorer,
            files::create_file,
            files::create_directory,
            files::rename_path,
            files::delete_path,
            files::search_in_files,
            diagnostics::run_diagnostics,
            providers::check_provider_cli,
            providers::check_provider_signin,
            providers::get_provider_adapters,
            watcher::watch_project_files,
            watcher::unwatch_project_files,
            watcher::watch_swarm_dir,
            watcher::unwatch_swarm_dir,
            app_log::log_renderer_error,
            diag_report::collect_diagnostics,
            browser::browser_open_tab,
            browser::browser_close_tab,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::agent_browser_get_enabled,
            browser::agent_browser_active_port,
            browser::agent_browser_set_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// The expected set of Tauri command wire names. Must stay identical to
    /// `IPC_COMMANDS` in `src/lib/ipcCommands.ts` (the frontend test asserts
    /// exact equality against this same lib.rs source, so drift on either side
    /// fails a test).
    const EXPECTED_COMMANDS: &[&str] = &[
        "select_directory",
        "register_project_root",
        "release_project_root",
        "spawn_pty",
        "write_pty",
        "resize_pty",
        "kill_pty",
        "get_claude_context_usage",
        "read_project_file",
        "write_project_file",
        "git_current_branch",
        "ensure_workspace_dirs",
        "ensure_project_config",
        "read_project_config",
        "write_project_config",
        "get_workspace_summary",
        "install_mcp_config",
        "check_mcp_status",
        "test_mcp_tools",
        "set_api_key",
        "has_api_key",
        "delete_api_key",
        "test_provider_connection",
        "list_provider_models",
        "get_memory_graph",
        "create_memory_snapshot",
        "restore_memory_snapshot",
        "list_memory_snapshots",
        "delete_memory_file",
        "read_memory_file",
        "save_memory_node",
        "get_unlinked_mentions",
        "search_memory_content",
        "add_memory_link",
        "git_status",
        "git_diff_file",
        "git_stage_file",
        "git_unstage_file",
        "git_commit",
        "git_tree_identity",
        "git_list_branches",
        "git_checkout_branch",
        "ensure_saple_git_excluded",
        "git_branch_sync_state",
        "git_fetch",
        "git_pull",
        "git_push",
        "git_create_checkpoint",
        "git_list_checkpoints",
        "git_checkpoint_diff",
        "git_restore_checkpoint",
        "create_review_record",
        "read_review_record",
        "submit_review_decision",
        "run_verification_command",
        "cancel_run_command",
        "set_file_viewed",
        "canonical_record_write",
        "load_state_file",
        "resolve_state_corruption",
        "get_recent_project_summaries",
        "june_control_get_enabled",
        "june_control_set_enabled",
        "june_command_result",
        "june_emit_event",
        "june_permit_terminals",
        "june_ensure_terminal_permitted",
        "june_revoke_terminal",
        "read_swarm_state",
        "write_swarm_state",
        "read_mailbox_file",
        "write_mailbox_file",
        "read_handoff_file",
        "write_handoff_file",
        "validate_dependency_graph",
        "run_acceptance_command",
        "mission_create",
        "mission_list",
        "mission_read",
        "mission_update_doc",
        "mission_set_tasks",
        "mission_command",
        "mission_dispatch_task",
        "mission_record_dispatch_result",
        "mission_tick",
        "mission_recover",
        "list_project_files",
        "read_text_file",
        "write_text_file",
        "open_in_external_editor",
        "reveal_in_file_explorer",
        "create_file",
        "create_directory",
        "rename_path",
        "delete_path",
        "search_in_files",
        "run_diagnostics",
        "check_provider_cli",
        "check_provider_signin",
        "get_provider_adapters",
        "collect_diagnostics",
        "watch_project_files",
        "unwatch_project_files",
        "watch_swarm_dir",
        "unwatch_swarm_dir",
        "log_renderer_error",
        "browser_open_tab",
        "browser_close_tab",
        "browser_set_bounds",
        "browser_set_visible",
        "browser_navigate",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "agent_browser_get_enabled",
        "agent_browser_active_port",
        "agent_browser_set_enabled",
    ];

    fn registered_handler_names() -> Vec<String> {
        let source = include_str!("lib.rs");
        let marker = "generate_handler![";
        let start = source.find(marker).expect("generate_handler![ block must exist");
        let bytes = source.as_bytes();
        let mut depth = 1usize;
        let mut i = start + marker.len();
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let block = &source[start + marker.len()..i];
        block
            .split(',')
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
            // Entries may be module-qualified (`pty::spawn_pty`); the wire name is the identifier.
            .map(|entry| {
                entry
                    .rsplit("::")
                    .next()
                    .expect("non-empty split always yields a segment")
                    .trim()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn every_registered_handler_is_a_known_command() {
        let expected: std::collections::HashSet<&str> = EXPECTED_COMMANDS.iter().copied().collect();
        for name in registered_handler_names() {
            assert!(
                expected.contains(name.as_str()),
                "command `{}` is registered but missing from EXPECTED_COMMANDS (and from src/lib/ipcCommands.ts)",
                name
            );
        }
    }

    #[test]
    fn expected_commands_and_registration_agree_exactly() {
        let mut registered = registered_handler_names();
        registered.sort();
        let mut expected: Vec<&str> = EXPECTED_COMMANDS.to_vec();
        expected.sort();
        assert_eq!(expected, registered, "EXPECTED_COMMANDS and generate_handler! drifted apart");
    }
}
