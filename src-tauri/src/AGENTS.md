# Bridge Rust

This directory owns the OS-level integration for Saple Bridge: contained filesystem access, native PTY sessions, process cleanup, OS keychain access, memory parsing, snapshots, git helpers, diagnostics, and MCP sidecar wiring.

UI rendering, view routing, and frontend state live in `../../src/`.

## Sidecar MCP Server

The `saple-memory` MCP server is not hosted by this crate. It lives in the sibling `../../saple-mcp` repository and is bundled as a Tauri sidecar binary through `bundle.externalBin`.

Bridge stages the sidecar with `scripts/prepare-sidecar.mjs`, resolves the bundled path in `project.rs`, and writes `.mcp.json` or `mcp_config.json` for external clients.

## Entry Points

- `lib.rs` - Tauri command registration.
- `main.rs` - application entrypoint.

## Module Map

| Module | File | Responsibility |
| --- | --- | --- |
| PTY | `pty.rs` | Spawn, write, resize, and kill native PTY sessions; stream output to React |
| Project | `project.rs` | Contained project file access and MCP config wiring |
| Memory | `memory.rs` | Parse memory markdown, graph wikilinks, manage snapshots |
| Keychain | `keychain.rs` | OS keychain wrapper through the `keyring` crate |
| Git | `git.rs` | Git status, diff, staging, and commit helpers |
| Review | `review.rs` | Review records and verification command support |
| Swarm | `swarm.rs` | Swarm state, mailbox, and handoff file commands |
| Files | `files.rs` | File tree and text-file helpers |
| Diagnostics | `diagnostics.rs` | Environment and provider diagnostics |
| Locking | `fs_lock.rs` | Serialized and atomic file writes |

## Contracts

- Validate project paths against the selected project directory before reading or writing.
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
