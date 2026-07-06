# Agent Skills and Repository Rules - Saple Bridge

This file describes repository-wide agent behavior for Saple Bridge. App-specific context lives in the child `AGENTS.md` files listed below.

## Installed Skills

| Skill | When to use |
| --- | --- |
| `frontend-design` | UI/UX design, visual polish, layout, and styling decisions |
| `web-design-guidelines` | Accessibility audits and interface review |
| `playwright-cli` | Browser automation and UI checks |
| `screenshot` | Desktop or OS-level screenshots |
| `next-best-practices` | Next.js projects only; do not use for this Vite/Tauri app |

Runtime-provided skills may also be available. Use the most specific relevant skill and avoid loading unrelated references.

## Working Rules

- Read `CLAUDE.md` and the scoped `AGENTS.md` file for the area being changed.
- Do not scan `node_modules`, `dist`, `target`, `src-tauri/target`, `.saple`, `build`, logs, or generated installer output.
- Do not revert unrelated user changes.
- Keep edits scoped and verifiable.
- Bridge project writes must stay contained inside the selected project directory.
- Cloud API keys live in the OS keychain and must not be written to JSON, markdown, localStorage, or renderer state.
- This app is Vite plus Tauri; do not apply Next.js rules to app code.

## App Context

- `src/AGENTS.md` - frontend stores and views.
- `src/components/AGENTS.md` - component and widget layer.
- `src-tauri/src/AGENTS.md` - Rust commands, PTY, filesystem, keychain, and sidecar wiring.
