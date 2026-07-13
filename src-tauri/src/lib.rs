mod claude_context;
mod pty;
mod project;
mod keychain;
mod models;
mod memory;
mod git;
mod review;
mod control_plane;
mod swarm;
mod files;
mod diagnostics;
mod process_ext;
mod fs_lock;
mod watcher;

#[tauri::command]
fn select_directory() -> Option<String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select Project Directory")
        .pick_folder();
        
    folder.map(|path| path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .setup(|_app| {
            // Stage the sidecar to its stable per-user path before any project opens, so
            // `.mcp.json` never has to reference the (versioned, ACL-restricted on MSIX)
            // install directory. Release only: dev resolves the repo-local staging path.
            #[cfg(not(debug_assertions))]
            project::ensure_stable_sidecar();
            Ok(())
        })
        .manage(pty::PtyRegistry::new())
        .manage(watcher::WatcherState::new())
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
            }
        })
        .invoke_handler(tauri::generate_handler![
            select_directory,
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
            project::test_mcp_tools,
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
            git::git_list_branches,
            git::git_checkout_branch,
            review::create_review_record,
            review::read_review_record,
            review::submit_review_decision,
            review::run_verification_command,
            review::set_file_viewed,
            control_plane::canonical_record_write,
            swarm::read_swarm_state,
            swarm::write_swarm_state,
            swarm::read_mailbox_file,
            swarm::write_mailbox_file,
            swarm::read_handoff_file,
            swarm::write_handoff_file,
            swarm::validate_dependency_graph,
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
            diagnostics::check_provider_cli,
            diagnostics::check_provider_signin,
            watcher::watch_project_files,
            watcher::unwatch_project_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
