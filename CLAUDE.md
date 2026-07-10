# CLAUDE.md - Saple Bridge

Guidance for Claude Code and other coding agents working in this repository.

## Project

Saple Bridge is a local-first AI development workspace. It includes terminals, Kanban tasks, markdown memory, swarm coordination, review tooling, settings, and MCP configuration support.

The app uses Tauri 2, React 19, TypeScript, Vite, Zustand, xterm.js, and Rust. It runs on Windows and macOS 11+. Windows is the primary packaging and QA target.

## Commands

```powershell
npm install
npm run dev              # Vite frontend only
npm run tauri:dev        # Tauri dev app; stages the saple-mcp sidecar first
npm run typecheck        # TypeScript check
npm test                 # Vitest suite (single run)
npm run test:watch       # Vitest in watch mode
npm run build            # TypeScript + Vite production build
npm run tauri:build      # Production bundle; stages the sidecar first
npm run prepare-sidecar  # Manually build and stage ../saple-mcp
```

Build script behavior (`scripts/tauri.mjs`):

- `npm run tauri:build` auto-bumps the patch version in `tauri.conf.json`, `package.json`, and `Cargo.toml`, then collects installers into `build/v<version>/`. Diffs in those three files (plus `Cargo.lock`) after a build are expected; do not hand-edit version numbers.
- Sidecar staging runs through `beforeDevCommand`/`beforeBuildCommand` in `src-tauri/tauri.conf.json`.
- Dev mode applies `src-tauri/tauri.dev.conf.json` as a config overlay, which re-adds the Vite dev-server origins to the CSP. The production CSP in `tauri.conf.json` does not include them.

Rust:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri
cargo test
```

`cargo check` and `cargo test` do not build the frontend. Tauri dev/build commands run the frontend build steps through the Tauri config.

## Architecture

1. The selected project is loaded by `projectStore` and backed by `.saple/*` files.
2. Terminal panes are native PTY sessions owned by Rust and streamed to React through Tauri events.
3. Kanban reads and writes `.saple/tasks.json`.
4. Memory reads and writes markdown files under `.saple/memory` or compatible memory directories.
5. Swarm state is stored in `.saple/swarm/state.json`.
6. API keys are stored in the OS keychain through `keychain.rs`.
7. Theme mode lives in `themeStore`; CSS variables are selected with `data-theme`.
8. The `saple-mcp` MCP server is a sibling project at `../saple-mcp` and is bundled as a Tauri sidecar.

Important files:

- `src/App.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/stores/projectStore.ts`
- `src/stores/terminalStore.ts`
- `src/stores/kanbanStore.ts`
- `src/stores/memoryStore.ts`
- `src/stores/swarmStore.ts`
- `src/stores/reviewStore.ts`
- `src/lib/writeQueue.ts`
- `scripts/tauri.mjs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/pty.rs`
- `src-tauri/src/project.rs`
- `src-tauri/src/memory.rs`
- `src-tauri/src/keychain.rs`

## Boundaries

- Rust owns filesystem access, PTY sessions, keychain access, process lifecycle, memory parsing, snapshots, and sidecar path resolution.
- React owns user interaction, routing, provider/project selection, rendering, and UI state.
- Project writes must stay contained inside the selected project directory.
- Secrets must not be stored in JSON, localStorage, markdown, or component state. Use the OS keychain commands.
- Frontend writes to project files should use the existing queued write helpers (`src/lib/writeQueue.ts`) when a store already follows that pattern.
- New Rust writes to project state should use existing atomic write helpers where practical.

## Storage

| Data | Location | Format |
| --- | --- | --- |
| Tasks | `.saple/tasks.json` | JSON |
| Memory | `.saple/memory/**/*.md` | Markdown + frontmatter |
| Snapshots | `.saple/snapshots/<name>/` | JSON |
| Swarm state | `.saple/swarm/state.json` | JSON |
| Agent sessions | `.saple/agents/sessions.json` | JSON |
| API keys | OS keychain account `saple_bridge_user` | Secret store |
| Theme prefs | localStorage key `saple-bridge-theme-store` | JSON |

## Agent Context Files

Before editing a scoped area, read the nearest relevant context file:

- `src/AGENTS.md` - frontend stores and views
- `src/components/AGENTS.md` - component/view layer
- `src-tauri/src/AGENTS.md` - Rust commands, PTY, filesystem, keychain, sidecar wiring

## Git Workflow

- Use focused commits.
- Prefer conventional commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Do not revert unrelated user changes.
- Verify locally before publishing changes when the relevant toolchain is available.
- Work on the current branch unless the user asks for a new branch.

## Ignore During Scans

Do not spend review or search time in:

- `node_modules/`
- `dist/`
- `target/`
- `src-tauri/target/`
- `.saple/`
- `build/`
- logs and generated installer output
