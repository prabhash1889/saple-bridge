// Single source of truth for every Tauri command name the frontend may invoke.
//
// This list must stay in lockstep with the `generate_handler![...]` registration
// in `src-tauri/src/lib.rs`. Two tests enforce the contract:
//   * `ipcCommands.test.ts` (frontend) parses lib.rs and asserts exact equality
//     with this list, then asserts every `invoke(...)` call site under `src/`
//     names a command from it.
//   * a Rust unit test in `lib.rs` re-parses its own handler block and compares
//     it against the same expected set.
// Adding a command therefore requires updating this list, or a test fails.

export const IPC_COMMANDS = [
  // project roots / selection
  'select_directory',
  'register_project_root',
  'release_project_root',
  // PTY / terminals
  'spawn_pty',
  'write_pty',
  'resize_pty',
  'kill_pty',
  'get_claude_context_usage',
  // project files and config
  'read_project_file',
  'write_project_file',
  'git_current_branch',
  'ensure_workspace_dirs',
  'ensure_project_config',
  'read_project_config',
  'write_project_config',
  'get_workspace_summary',
  'install_mcp_config',
  'check_mcp_status',
  'test_mcp_tools',
  // keychain + models
  'set_api_key',
  'has_api_key',
  'delete_api_key',
  'test_provider_connection',
  'list_provider_models',
  // memory
  'get_memory_graph',
  'create_memory_snapshot',
  'restore_memory_snapshot',
  'list_memory_snapshots',
  'delete_memory_file',
  'read_memory_file',
  'save_memory_node',
  'get_unlinked_mentions',
  'search_memory_content',
  'add_memory_link',
  // git
  'git_status',
  'git_diff_file',
  'git_stage_file',
  'git_unstage_file',
  'git_commit',
  'git_tree_identity',
  'git_list_branches',
  'git_checkout_branch',
  'ensure_saple_git_excluded',
  'git_branch_sync_state',
  'git_fetch',
  'git_pull',
  'git_push',
  'git_create_checkpoint',
  'git_list_checkpoints',
  'git_checkpoint_diff',
  'git_restore_checkpoint',
  // review
  'create_review_record',
  'read_review_record',
  'submit_review_decision',
  'run_verification_command',
  'cancel_run_command',
  'set_file_viewed',
  // control plane + state integrity
  'canonical_record_write',
  'load_state_file',
  'resolve_state_corruption',
  // June control plane
  'june_control_get_enabled',
  'june_control_set_enabled',
  'june_command_result',
  'june_emit_event',
  'june_permit_terminals',
  'june_ensure_terminal_permitted',
  'june_revoke_terminal',
  // swarm
  'read_swarm_state',
  'write_swarm_state',
  'read_mailbox_file',
  'write_mailbox_file',
  'read_handoff_file',
  'write_handoff_file',
  'validate_dependency_graph',
  'run_acceptance_command',
  // filesystem helpers
  'list_project_files',
  'read_text_file',
  'write_text_file',
  'open_in_external_editor',
  'reveal_in_file_explorer',
  'create_file',
  'create_directory',
  'rename_path',
  'delete_path',
  'search_in_files',
  // diagnostics
  'run_diagnostics',
  'check_provider_cli',
  'check_provider_signin',
  'collect_diagnostics',
  // watchers
  'watch_project_files',
  'unwatch_project_files',
  'watch_swarm_dir',
  'unwatch_swarm_dir',
  // durable app log
  'log_renderer_error',
  // embedded browser + agent browser
  'browser_open_tab',
  'browser_close_tab',
  'browser_set_bounds',
  'browser_set_visible',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'agent_browser_get_enabled',
  'agent_browser_active_port',
  'agent_browser_set_enabled',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set<string>(IPC_COMMANDS);

export function isRegisteredIpcCommand(name: string): boolean {
  return COMMAND_SET.has(name);
}
