# Bridge Rust

Owns all OS-level integration for the Bridge app: filesystem access (contained within the selected project), native PTY sessions, OS keychain secrets, memory graph parsing/snapshots, and a stdio JSON-RPC MCP memory server. Does NOT own UI rendering, state management, or view routing — those belong to `../src/`.

## Entry Points

- `lib.rs` — Tauri command registration (all commands the React frontend can `invoke()`)
- `main.rs` — Application entrypoint (thin — delegates to lib.rs)

## Module Map

| Module | File | Responsibility |
|---|---|---|
| PTY | `pty.rs` | Spawn, write, resize, kill native PTY sessions; stream output via Tauri events. Shell is `powershell.exe` on Windows, login `$SHELL` on Unix/macOS; sets `TERM`/`COLORTERM` |
| Project | `project.rs` | Contained filesystem reads/writes (path-validated against selected project dir) |
| Memory | `memory.rs` | Parse `.saple/memory/**/*.md` with YAML frontmatter + `[[wikilink]]` graph; snapshot management |
| MCP | `mcp.rs` | `saple-memory` stdio JSON-RPC MCP server: memory-graph tools + Kanban task tools (`.saple/tasks.json`) + read-only swarm status, plus MCP `prompts` (onboarding) and `resources` (notes as `saple-memory://<id>`). Tool failures return `isError` results; notifications get no reply |
| Keychain | `keychain.rs` | OS keychain wrappers via `keyring` crate (user keyring `saple_bridge_user`) — Credential Manager on Windows, login Keychain on macOS. `has_api_key` reports presence as a bool without returning the secret (used by Amber) |
| Amber | `amber/` | In-app AI agent. `mod.rs` runs the agent loop (one task per send, `AmberRegistry` cancel flags) and the `amber_*` commands; streams via `amber://event`/`amber://run`. Reuses `mcp::handle_tool_call` (18 tools) + `builtins.rs` (read/write/list/run, path-contained, output-capped) for tools, `keychain::get_api_key_inner` for keys (never returned to the renderer), `review::run_shell_with_timeout` for `run_command`. Anthropic provider implemented (`anthropic.rs`/`sse.rs`); OpenAI-compat is a stubbed seam. **`claude-code` provider** (`claude_code.rs`) is a separate path: when `provider == "claude-code"`, `run_agent` skips the keychain read + HTTP loop and spawns the user's `claude` CLI headless (`-p --output-format stream-json`) on their Max/Pro subscription — `ANTHROPIC_API_KEY` is stripped from the child env (or it bills the API key), the CLI's NDJSON is parsed into `AmberMessage`s + live events, and the CLI `session_id` is persisted (`Conversation.claude_session_id`) for `--resume`. `amber_claude_code_status` probes the CLI for settings. Conversations persist via `persist.rs` (`.saple/amber/` or app-data) |

## Contracts & Invariants

- **All filesystem paths are validated** against a base project directory — writes are rejected if they escape containment.
- **PTY session lifecycle** is fully owned by Rust: React sends commands (spawn, write, resize, kill), Rust streams output via Tauri events.
- **Keychain access** uses the `keyring` crate under user `saple_bridge_user` — never fall back to plaintext.
- **Memory graph parsing** is done in Rust — React receives structured nodes and edges, not raw markdown.

## Anti-patterns

- Never store credentials in files or pass them through to React — keychain only.
- Don't bypass project path containment for reads/writes.
- Don't spawn PTY sessions from React — all PTY lifecycle must go through `pty.rs`.