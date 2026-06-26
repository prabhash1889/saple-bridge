# Bridge Rust

Owns all OS-level integration for the Bridge app: filesystem access (contained within the selected project), native PTY sessions, OS keychain secrets, and memory graph parsing/snapshots. Does NOT own UI rendering, state management, or view routing — those belong to `../src/`.

The `saple-memory` MCP server is no longer hosted in this crate. It lives in the standalone **`../../saple-mcp`** repo and ships as a Tauri **sidecar** binary (`bundle.externalBin` in `tauri.conf.json`). Bridge stages it via `scripts/prepare-sidecar.mjs` (run `npm run prepare-sidecar` before `tauri dev`), resolves its on-disk path with `sidecar_binary_path()` in `project.rs`, and writes that path into each project's `.mcp.json` so external clients (Claude Code) launch it directly. `test_mcp_tools` previews the catalog by spawning the sidecar and sending one `tools/list`.

## Entry Points

- `lib.rs` — Tauri command registration (all commands the React frontend can `invoke()`)
- `main.rs` — Application entrypoint (thin — delegates to lib.rs)

## Module Map

| Module | File | Responsibility |
|---|---|---|
| PTY | `pty.rs` | Spawn, write, resize, kill native PTY sessions; stream output via Tauri events. Shell is `powershell.exe` on Windows, login `$SHELL` on Unix/macOS; sets `TERM`/`COLORTERM` |
| Project | `project.rs` | Contained filesystem reads/writes (path-validated against selected project dir) |
| Memory | `memory.rs` | Parse `.saple/memory/**/*.md` with YAML frontmatter + `[[wikilink]]` graph; snapshot management |
| MCP wiring | `project.rs` | `sidecar_binary_path()` + `install_mcp_config` (writes `.mcp.json`/`mcp_config.json` pointing at the `saple-mcp` sidecar) + `check_mcp_status` + `test_mcp_tools` (spawns the sidecar for a `tools/list` preview). The server itself is in `../../saple-mcp` |
| Keychain | `keychain.rs` | OS keychain wrappers via `keyring` crate (user keyring `saple_bridge_user`) — Credential Manager on Windows, login Keychain on macOS. `has_api_key` reports presence as a bool without returning the secret |

## Contracts & Invariants

- **All filesystem paths are validated** against a base project directory — writes are rejected if they escape containment.
- **PTY session lifecycle** is fully owned by Rust: React sends commands (spawn, write, resize, kill), Rust streams output via Tauri events.
- **Keychain access** uses the `keyring` crate under user `saple_bridge_user` — never fall back to plaintext.
- **Memory graph parsing** is done in Rust — React receives structured nodes and edges, not raw markdown.

## Anti-patterns

- Never store credentials in files or pass them through to React — keychain only.
- Don't bypass project path containment for reads/writes.
- Don't spawn PTY sessions from React — all PTY lifecycle must go through `pty.rs`.