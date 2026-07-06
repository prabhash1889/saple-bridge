# Bridge React

This directory owns the Saple Bridge frontend: dashboard, terminals, Kanban, memory, swarm, review, editor, settings, and shared state management.

Filesystem access, PTY spawning, keychain access, and memory parsing belong to `../src-tauri/src/`.

## Entry Points

- `App.tsx` - view routing and project bootstrapping.
- `stores/projectStore.ts` - project selection, recent projects, and active view state.
- `components/layout/Sidebar.tsx` - primary navigation.

## Key Invariants

- Zustand stores read and write `.saple/*` files through Tauri commands.
- React does not directly access the filesystem.
- Terminal panes render xterm.js instances backed by native PTY sessions in Rust.
- Kanban, memory, swarm, review, and session data belong to the selected workspace.
- API keys live in the OS keychain and must not be persisted in frontend state.
- Theming is CSS-variable driven through `data-theme="light|dark"` on `<html>`.
- Components should use `var(--*)` tokens instead of hardcoded colors.

## Store Map

| Store | File | Backing |
| --- | --- | --- |
| projectStore | `stores/projectStore.ts` | localStorage plus active project state |
| terminalStore | `stores/terminalStore.ts` | Tauri PTY events and commands |
| terminalLayoutStore | `stores/terminalLayoutStore.ts` | localStorage pane layouts by workspace path |
| kanbanStore | `stores/kanbanStore.ts` | `.saple/tasks.json` |
| memoryStore | `stores/memoryStore.ts` | workspace memory markdown |
| swarmStore | `stores/swarmStore.ts` | `.saple/swarm/state.json` |
| reviewStore | `stores/reviewStore.ts` | git and review Tauri commands |
| fileStore | `stores/fileStore.ts` | filesystem Tauri commands |
| providerStore | `stores/providerStore.ts` | provider config and keychain status |
| agentSessionStore | `stores/agentSessionStore.ts` | agent session state |
| confirmStore | `stores/confirmStore.ts` | in-memory confirm dialog state |
| notificationStore | `stores/notificationStore.ts` | in-memory toast state |
| themeStore | `stores/themeStore.ts` | localStorage theme preference |

## Patterns

To add a new view:

1. Add a store in `stores/` if the view needs shared or persisted state.
2. Create the view under `components/<view-name>/`.
3. Register routing in `App.tsx`.
4. Add navigation in `components/layout/Sidebar.tsx`.

## Anti-Patterns

- Do not read or write files directly from React.
- Do not store secrets in localStorage, Zustand, component state, or markdown.
- Do not import Rust modules from `src-tauri/`.
- Do not bypass existing store write queues where they are already used.
