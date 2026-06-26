mod pty;
mod project;
mod keychain;
mod memory;
mod mcp;
mod git;
mod review;
mod swarm;
mod files;
mod diagnostics;
mod process_ext;
mod fs_lock;

pub fn run_mcp(project_path: String) {
    mcp::run_mcp_server(project_path);
}

#[tauri::command]
fn select_directory() -> Option<String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select Project Directory")
        .pick_folder();
        
    folder.map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_app_binary_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyRegistry::new())
        .plugin(tauri_plugin_opener::init())
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
            get_app_binary_path,
            pty::spawn_pty,
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
            keychain::set_api_key,
            keychain::has_api_key,
            keychain::delete_api_key,
            keychain::test_provider_connection,
            memory::get_memory_graph,
            memory::create_memory_snapshot,
            memory::restore_memory_snapshot,
            memory::list_memory_snapshots,
            memory::delete_memory_file,
            memory::read_memory_file,
            memory::save_memory_node,
            memory::get_unlinked_mentions,
            memory::add_memory_link,
            mcp::test_mcp_tools,
            git::git_status,
            git::git_diff_summary,
            git::git_diff_file,
            review::create_review_record,
            review::read_review_record,
            review::submit_review_decision,
            review::run_verification_command,
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
            diagnostics::run_diagnostics,
            diagnostics::check_provider_cli,
            diagnostics::check_provider_signin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
