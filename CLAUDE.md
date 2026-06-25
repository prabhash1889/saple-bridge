# CLAUDE.md — Saple Bridge

Guidance for Claude Code when working in this repository.

## Project

Saple Bridge is the **AI workspace**: terminals, kanban, memory, swarm, review, **Amber agent
chat**, settings, and an embedded MCP server. **Tauri 2 + React 19.** Builds and runs on Windows
and **macOS 11+** — the PTY layer uses `powershell.exe` on Windows and the user's login shell
(`$SHELL`) on Unix/macOS; CI produces a signed (ad-hoc) `.dmg` on macOS.

## Commands

```powershell
npm install
npm run tauri dev                 # Tauri dev
npm run build                     # tsc + vite
npm run tauri build               # installer

cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri; cargo test
```

> Local builds work here (Smart App Control disabled) — run `cargo`/`npm` checks before pushing.

## Key Architecture

1. Open project → `projectStore.ts` loads from `.saple/*` files.
2. Terminals spawn native PTY sessions (`pty.rs`), stream via events.
3. Kanban reads/writes `.saple/tasks.json`; Memory reads/writes `.saple/memory/**/*.md`.
4. Swarm reads/writes `.saple/swarm/state.json`.
5. API keys in OS keychain (`keychain.rs` via `keyring`).
6. Bridge exposes the `saple-memory` stdio MCP server (`mcp.rs`, registered via
   `mcp_config.json` / `.mcp.json`): memory-graph tools, Kanban task tools, read-only swarm
   status, plus MCP `prompts` (onboarding) and `resources` (notes as `saple-memory://<id>`).
7. Theme (light/dark/system) lives in `themeStore.ts`; a `data-theme` attribute switches CSS
   variables, with a pre-paint script in `index.html` to avoid FOUC.
8. **Amber** is an in-app AI agent (`src-tauri/src/amber/`): the agent loop runs in Rust, streams
   via `amber://event`/`amber://run` Tauri events, and calls the in-process `mcp::handle_tool_call`
   tools plus file/command builtins. Multi-provider seam (Anthropic implemented). A separate
   **`claude-code` provider** (`amber/claude_code.rs`) delegates the whole turn to the user's
   logged-in `claude` CLI on a Max/Pro subscription. Conversations persist to
   `.saple/amber/conversations/` (app-data fallback with no project open).

Key files: `src/App.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/amber/*`,
`src/stores/{projectStore,terminalStore,amberStore,kanbanStore,memoryStore,swarmStore,themeStore}.ts`,
`src-tauri/src/{lib,pty,project,memory,mcp,keychain}.rs`, `src-tauri/src/amber/`.

## Rules

- **Bridge Rust** owns filesystem access, PTY sessions, keychain, memory graph, snapshots, MCP
  server. **React** owns user interaction, view routing, provider/project selection, UI state.
- **Project writes are path-contained** — Rust validates all paths are within the project dir.
- Cloud API keys live in the OS keychain (`saple_bridge_user`, `saple_amber_<provider>_api_key`)
  and are proxied through Rust — never persisted in JSON or held in the renderer.
- No scanning `node_modules`, `dist`, `target`, `.saple`, logs, build output, or generated schemas.

## Storage

| What | Where | Format |
|------|-------|--------|
| Tasks | `.saple/tasks.json` | JSON |
| Memory | `.saple/memory/**/*.md` | Markdown + frontmatter |
| Snapshots | `.saple/snapshots/<name>/` | JSON |
| Swarm state | `.saple/swarm/state.json` | JSON |
| API keys | OS keychain (`saple_bridge_user`) | — |
| Amber conversations | `.saple/amber/conversations/<id>.json` (app-data fallback) | JSON |
| Amber provider keys | OS keychain (`saple_amber_<provider>_api_key`) | — |
| Amber `claude-code` provider | No key — uses the `claude` CLI login; CLI `session_id` in conversation JSON | — |
| Amber / theme prefs | localStorage (`saple-bridge-amber-store`, `saple-bridge-theme-store`) | JSON |

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- **Verify locally before pushing:** `npm run build`, `cargo check`, `cd src-tauri; cargo test`.
- Branch from the default branch; keep commits focused.

## Intent Layer

Before modifying code, read the local `AGENTS.md`:
- `src/AGENTS.md` — AI workspace frontend (views, Zustand stores).
- `src/components/AGENTS.md` — View + widget layer.
- `src/components/amber/AGENTS.md` — Amber agent components.
- `src-tauri/src/AGENTS.md` — PTY sessions, filesystem, keychain, MCP server.

> Split out of the Saple monorepo (`apps/saple-bridge`). This repo owns the `saple-memory` MCP
> server consumed by Bridge itself.
