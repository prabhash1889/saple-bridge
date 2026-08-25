# Bridge Rust

This directory owns the OS-level integration for Saple Bridge: contained filesystem access, native PTY sessions, process cleanup, OS keychain access, memory parsing, snapshots, git helpers, diagnostics, and MCP sidecar wiring.

UI rendering, view routing, and frontend state live in `../../src/`.

## Sidecar MCP Server

The `saple-memory` MCP server is not hosted by this crate. It lives in the sibling `../../saple-mcp` repository and is bundled as a Tauri sidecar binary through `bundle.externalBin`.

Bridge stages the sidecar with `scripts/prepare-sidecar.mjs`; `sidecar.rs` owns the sidecar binary (path resolution, per-user staging, stale-config healing, tool-catalog probe), while `project.rs` writes `.mcp.json` or `mcp_config.json` for external clients.

## Entry Points

- `lib.rs` - Tauri command registration.
- `main.rs` - application entrypoint.

## Module Map

| Module | File | Responsibility |
| --- | --- | --- |
| PTY | `pty.rs` | Spawn, write, resize, and kill native PTY sessions; stream output to React |
| Proc tree | `proc_tree.rs` | Whole-process-tree termination: Windows Job Objects, Unix process-group kill |
| Project | `project.rs` | Workspace config, workspace summary, and MCP config install/status |
| Sidecar | `sidecar.rs` | `saple-mcp` sidecar binary: path resolution, per-user staging, stale `.mcp.json` healing, and the one-shot tool-catalog probe |
| Path policy | `project_roots.rs` | Approved-root registry plus the single contained-path policy: containment resolution, protected writer paths (`.git/**`), destructive-target rules |
| Error codes | `error_code.rs` | Small serializable `CodedError` (`{ code, message }`) with stable snake_case codes for path-policy failures; string surfaces flatten it to its message |
| Memory | `memory.rs` | Parse memory markdown, graph wikilinks, manage snapshots |
| Memory layout | `memory_layout.rs` | Single owner of memory layout: mode resolution from `.saple/config.json`, note directories per mode (`saple`, `bridge-compatible`, `both`), snapshot root |
| Keychain | `keychain.rs` | OS keychain wrapper through the `keyring` crate |
| Git | `git.rs` | Git status, diff, staging, and commit helpers |
| Review | `review.rs` | Review records and verification command support |
| Swarm | `swarm.rs` | Swarm state, mailbox, and handoff file commands |
| Files | `files.rs` | File tree and text-file helpers |
| Diagnostics | `diagnostics.rs` | Environment and provider diagnostics |
| Locking | `fs_lock.rs` | Serialized and atomic file writes |
| App log | `app_log.rs` | Durable size-capped application log with secret redaction; `log_renderer_error` command |
| Audit | `audit.rs` | Privileged-action audit trail (shell runs, PTY spawns, destructive file ops) |

## Contracts

- Validate project paths against the selected project directory before reading or writing.
- All path-policy decisions (containment, protected paths, destructive targets) flow through `project_roots.rs`; do not re-implement containment checks in command modules.
- Path-policy failures return `error_code::CodedError` (`root_not_approved`, `path_outside_root`, `protected_path`, `destructive_target`, `invalid_path`, `internal`); surfaces still carrying plain strings flatten it via the provided `From` impls.
- Coded IPC error surfaces: path policy (`project_roots.rs`, `files.rs`, `project.rs`), PTY lifecycle (`pty.rs`: duplicate ids are `already_exists`, unregistered sessions `pty_not_found`), memory snapshots (`memory.rs`: unconfirmed overwrite is `already_exists`), and the sidecar probe (`sidecar.rs`). Extend the vocabulary only when a caller can branch on the code; otherwise keep plain strings and let the renderer's `parseIpcError` treat them as uncoded.
- Keep PTY process lifecycle in Rust.
- Store credentials only through the OS keychain account `saple_bridge_user`.
- Return structured data to React; do not rely on the renderer to validate sensitive paths.
- Use atomic writes for project state where torn writes would corrupt user data.
- Treat command execution helpers as an explicit trust boundary.

## Anti-Patterns

- Do not store credentials in files.
- Do not bypass path containment for project reads or writes.
- Do not let React spawn shell processes directly.
- Do not add new unvalidated string interpolation into shell commands.
