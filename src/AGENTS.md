# Bridge React

Owns the AI workspace frontend: 8 views (Dashboard, Terminals, Kanban, Memory, Swarm, Review, Editor, Settings) with Zustand state management. Does NOT own filesystem access, PTY spawning, keychain, or memory parsing — those belong to `../src-tauri/src/`.

## Entry Points

- `App.tsx` — View routing and project bootstrapping (reads projectStore on mount)
- `stores/projectStore.ts` — Project selection, recent projects, sets active view
- `components/layout/Sidebar.tsx` — Navigation hub between all 6 views

## Key Invariants

- **Zustand stores read/write `.saple/*` files** via Tauri commands, never directly.
- **Terminal panes** are backed by native PTY sessions in `src-tauri/`; React renders xterm.js instances that connect via Tauri events.
- **Kanban, Memory, Swarm** data lives in `.saple/` JSON files — the store reads on mount and writes on mutation.
- **All API keys** are stored in the OS keychain (via `keychain.rs`), not in localStorage or Zustand.
- **Theming is CSS-variable driven**: `themeStore` writes a `data-theme="light|dark"` attribute onto `<html>`; components must consume `var(--*)` tokens (defined in `styles/index.css`) rather than hardcoded hex so both themes work. `App.tsx` applies the theme and tracks OS changes when in `system` mode; `index.html` re-applies it pre-paint to avoid a flash.

## Store Map

| Store | File | Backed By |
|---|---|---|
| projectStore | `stores/projectStore.ts` | localStorage (persist) — also holds `activeView` |
| terminalStore | `stores/terminalStore.ts` | Tauri events from PTY sessions; mirrors each workspace's pane layout into `terminalLayoutStore` |
| terminalLayoutStore | `stores/terminalLayoutStore.ts` | localStorage (persist) — saved pane layouts keyed by workspace path, for the "Restore previous terminals" action |
| kanbanStore | `stores/kanbanStore.ts` | `.saple/tasks.json` |
| memoryStore | `stores/memoryStore.ts` | `.saple/memory/**/*.md` |
| swarmStore | `stores/swarmStore.ts` | `.saple/swarm/state.json` |
| reviewStore | `stores/reviewStore.ts` | git/review Tauri commands |
| fileStore | `stores/fileStore.ts` | filesystem Tauri commands |
| providerStore | `stores/providerStore.ts` | keychain + provider config |
| agentSessionStore | `stores/agentSessionStore.ts` | agent session state |
| confirmStore | `stores/confirmStore.ts` | in-memory (drives `common/ConfirmDialog`) |
| notificationStore | `stores/notificationStore.ts` | in-memory (drives `common/ToastHost`) |
| themeStore | `stores/themeStore.ts` | localStorage (persist) — light/dark/system mode |
| amberStore | `stores/amberStore.ts` | Amber chat: subscribes to `amber://event`/`amber://run` (rAF-batched text deltas), persists ONLY `{provider, model, baseURL}` (never secrets/messages). Reloads the canonical log from Rust on run completion. Keys via `set_api_key`/`has_api_key` |

## Patterns

Amber (`components/amber/`) is a heavy view but **not** project-gated — it is intentionally absent
from `workspaceRooms` (Sidebar) and the `requiresProject` lists (App.tsx), so general chat works
with no folder open.

Adding a new view:
1. Add store in `stores/` if it needs persisted state
2. Create view component in `components/<view-name>/` (see `components/AGENTS.md`)
3. Register route + nav item in `App.tsx` and `Sidebar.tsx`

## Anti-patterns

- Never read/write filesystem directly — always go through `@tauri-apps/api` commands (wrapped in `../src-tauri/src/lib.rs`).
- Don't store secrets in component state or stores — use `keychain.rs` via Tauri invoke.
- Don't import from `src-tauri/` directly — only through Tauri's `invoke()` IPC.