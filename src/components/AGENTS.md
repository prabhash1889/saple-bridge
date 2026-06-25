# Bridge Components

View and widget layer for the Bridge frontend — one folder per view domain plus shared `common/` widgets. Owns rendering and user interaction; state lives in `../stores/`, OS access lives in `../../src-tauri/`. Does NOT own routing (that's `../App.tsx`) or persistence.

## Folder Map

| Folder | Owns | Key files |
|---|---|---|
| `common/` | App-wide singletons + shared widgets | `CommandPalette`, `ConfirmDialog`, `ToastHost`, `ThemeToggle` |
| `layout/` | Chrome around views | `Sidebar` (nav), `TopBar`, `StatusBar` |
| `project/` | Project landing + config | `ProjectDashboard`, `ProjectSettings` |
| `terminal/` | xterm.js panes over PTY | `TerminalGrid`, `TerminalPane` |
| `kanban/` | Task board | `KanbanBoard`, `KanbanColumn`, `TaskCard`, `TaskDialog`, `TaskDetailDrawer` |
| `memory/` | Memory graph + editor | `MemoryWorkspace`, `MemoryList`, `MemoryEditor`, `MemoryGraph` |
| `swarm/` | Agent swarm | `SwarmWorkspace`, `SwarmAgentCard`, `SwarmGraph`, `SwarmTemplateEditor` |
| `review/` | Diff/code review | `ReviewWorkspace` |
| `editor/` | File viewing/editing | `EditorPanel`, `CodeViewer` |
| `files/` | File tree | `FileTree` |

## Contracts & Invariants

- **One folder per view** maps to a `case` in `../App.tsx`'s `activeView` switch (`dashboard, terminals, kanban, memory, swarm, review, editor, settings`).
- **`common/` widgets are singletons** mounted once near the app root, driven by stores: `ConfirmDialog`+`ToastHost` render from `confirmStore`/`notificationStore`; `CommandPalette` reads `projectStore` for navigation. Don't mount a second instance per view.
- **Most components read/write through `../stores/`** (Zustand hooks) — but `terminal/`, `project/`, `review/`, and `files/` call `invoke()` directly for streaming/one-shot Tauri commands. Direct `invoke()` is acceptable for IPC; it is NOT for guessing filesystem paths (Rust validates containment).
- **`TerminalPane`** binds an xterm.js instance to a native PTY: writes via `invoke('write_pty')`, receives output via Tauri event listeners keyed by session id from `terminalStore`.
- **`ThemeToggle`** (in `common/`) flips `themeStore` between light/dark; it's mounted in `layout/TopBar`. Style with `var(--*)` tokens so components track the active `data-theme` — see "Theming" in `../AGENTS.md`.

## Patterns

Adding a widget to an existing view: create it under that view's folder, wire it to the view's store; no `App.tsx` change. Adding a whole new view: see "Adding a new view" in `../AGENTS.md` (store + folder + `App.tsx`/`Sidebar.tsx` registration).

## Anti-patterns

- Don't put persisted state in component state — lift it to the matching store in `../stores/`.
- Don't construct absolute filesystem paths and pass them to Tauri blindly; pass project-relative inputs and let Rust validate containment.
- Don't import from `../../src-tauri/` — cross the boundary only via `invoke()`.
- Don't hardcode hex colors in component CSS — use `var(--*)` tokens so both light and dark `data-theme` render correctly.

## Related Context

- State + store map: `../AGENTS.md`
- OS / PTY / filesystem backend: `../../src-tauri/src/AGENTS.md`
