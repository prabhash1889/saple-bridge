# Bridge Components

This directory contains the Saple Bridge view and widget layer. Components own rendering and user interaction. Shared state lives in `../stores/`; OS integration lives in `../../src-tauri/`.

## Folder Map

| Folder | Owns | Examples |
| --- | --- | --- |
| `common/` | App-wide widgets | `CommandPalette`, `ConfirmDialog`, `ToastHost`, `ThemeToggle` |
| `layout/` | App chrome | `Sidebar`, `TopBar`, `StatusBar` |
| `project/` | Project landing and settings | `ProjectDashboard`, `ProjectSettings` |
| `terminal/` | xterm.js panes over PTY | `TerminalGrid`, `TerminalPane` |
| `kanban/` | Task board | `KanbanBoard`, `TaskCard`, dialogs |
| `memory/` | Memory list, graph, editor | `MemoryWorkspace`, `MemoryList`, `MemoryEditor`, `MemoryGraph` |
| `swarm/` | Swarm coordination | `SwarmWorkspace`, `SwarmAgentCard`, `SwarmGraph` |
| `review/` | Diff and code review | `ReviewWorkspace`, file list, actions panel |
| `editor/` | File viewing and editing | `EditorPanel`, `CodeViewer` |
| `files/` | File tree | `FileTree` |

## Contracts

- One view folder maps to an `activeView` branch in `../App.tsx`.
- `common/` singletons are mounted once near the app root.
- Components should call stores for shared state and Tauri `invoke()` for explicit IPC.
- Direct `invoke()` is acceptable for one-shot commands, but path containment belongs to Rust.
- Terminal panes write through `invoke('write_pty')` and receive output through Tauri events keyed by session id.
- Icon-only buttons need accessible labels.
- Styling should use CSS classes and theme tokens instead of inline hardcoded colors.

## Anti-Patterns

- Do not put persisted state only in component-local state.
- Do not construct trusted absolute paths in React.
- Do not mount duplicate global dialogs or toast hosts.
- Do not import from `../../src-tauri/`.
- Do not hardcode colors that bypass light and dark themes.

## Related Context

- Frontend stores and routing: `../AGENTS.md`
- Backend boundary: `../../src-tauri/src/AGENTS.md`
