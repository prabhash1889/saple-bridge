# Agent Skills & Cross-Cutting Rules — Saple Bridge

## Purpose

Catalog of installed skills and repo-wide agent behavior for this standalone Saple Bridge repo.
App-specific context lives in the child `AGENTS.md` files (see App Context).

## Installed Skills (`.agents/skills/`)

| Skill | When to Use |
|-------|-------------|
| `frontend-design` | UI/UX design, visual polish, layout/styling decisions |
| `web-design-guidelines` | Accessibility audits, UX review, web interface standards |
| `playwright-cli` | Browser automation, UI interaction checks |
| `screenshot` | Desktop/OS-level screenshots |
| `next-best-practices` | Next.js only — **not** used (this app is Vite/Tauri) |

Also use runtime-provided skills whose triggers match (`tauri-development`, `code-review`,
`security-review`, `verify`, `run`). Prefer the most specific skill that covers the request.

## Working Rules

- Read `CLAUDE.md` and only the docs relevant to the task.
- Do not scan `node_modules`, `dist`, `target`, `.saple`, build output, logs, or generated schemas.
- Do not revert user changes; keep edits scoped and verifiable.
- **Bridge project writes stay contained inside the selected project directory** (Rust-validated).
- Cloud keys live in the OS keychain, proxied through Rust — never in JSON or the renderer.
- Don't use `next-best-practices` for Vite/Tauri code.

## App Context

- Bridge React: `src/AGENTS.md`
- Bridge Components: `src/components/AGENTS.md`
- Amber components: `src/components/amber/AGENTS.md`
- Bridge Rust: `src-tauri/src/AGENTS.md`
