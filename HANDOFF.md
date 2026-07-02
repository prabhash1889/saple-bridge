# Saple Bridge — Improvement Plan Handoff (2026-07-02)

Paste this into a fresh Claude Code session started in `saple-bridge/` to continue the
improvement plan. Read `CLAUDE.md` and the `AGENTS.md` files first, as usual.

## Context

A four-phase improvement plan (security → performance/health → features → UI polish) was
executed against this repo on 2026-07-02. **Phases A (security/stability, all 16 plan.md
Phase-7 findings), B1/B2, and C1/C2/C3/C5 are DONE and committed.** This handoff covers what
remains: **B3, B4, C4, C6, and D1–D4.**

### ⚠️ Branch situation (resolve first)

All of this work was committed to **`debug/terminal-webgl-artifacts`** (the repo was left on
that branch by an earlier debugging session; it also carries 3 prior WebGL-debugging commits:
`177657b`, `b1434f1`, `b763a6c`). Nothing has been pushed. Before continuing, decide with the
user: merge the branch to `master`, or keep working on it. CLAUDE.md says work lands on the
default branch, so a merge to `master` is probably the right first move.

### What was completed (for orientation, all verified: typecheck 0, build OK, cargo test 30/30, vitest 11/11)

- **A (plan.md Phase 7, all 16 findings)** — shell-injection fix in `pty.rs` (provider
  allowlist + `is_safe_model` + `validate_prompt_file`), keychain service-name validation,
  memory save path-traversal fix, swarm scan re-entry guard (`runAgentScan` + module-level
  `agentScanInFlight`), enqueueWrite/atomic_write consistency, PTY duplicate-id rejection,
  dev/prod CSP split (`tauri.dev.conf.json`), stale-response guards, swarm `partialize`,
  `outputListeners` cleanup, version-drift + build-script fixes, React nits. `plan.md` Phase 7
  is marked ✅ with commit hashes.
- **B1** — MemoryGraph physics now mutates a ref + writes DOM transforms directly
  (`simNodesRef`, `nodeElsRef`, `edgeElsRef`, `applyDomPositions`), pauses when the view is
  CSS-hidden.
- **B2** — Vitest harness (`npm test`), 11 tests: `src/lib/writeQueue.test.ts`,
  `src/lib/id.test.ts`, `src/stores/notificationStore.test.ts`, `src/stores/memoryStore.test.ts`
  (Tauri IPC mocked with `vi.mock('@tauri-apps/api/core')`).
- **C1** — Ctrl/Cmd+F terminal search (`@xterm/addon-search`, overlay in `TerminalPane.tsx`,
  CSS `.terminal-search-overlay`).
- **C2** — Command palette global search (tasks + memory notes appear from 2 chars;
  `CommandPalette.tsx`; memory graph warmed on palette open).
- **C3** — Stage/unstage checkboxes + commit bar in Review
  (`git.rs`: `git_stage_file`/`git_unstage_file`/`git_commit`, `GitFileStatus.staged`
  with `#[serde(default)]`; `reviewStore.setFileStaged`/`commitStaged`; UI in
  `ReviewWorkspace.tsx`, CSS `.review-commit-bar`).
- **C5** — Memory full-text search (`memory.rs: search_memory_content` reusing
  `collect_notes`; `memoryStore.searchContent` + `contentMatchIds`; 250ms debounce in
  `MemoryList.tsx`).

## Conventions (apply to all remaining work)

- Verify before each commit: `npm run typecheck && npm run build`, `npm test`,
  `cargo check --manifest-path src-tauri/Cargo.toml`, `cd src-tauri; cargo test`.
- Conventional commits, one focused commit per item, `Co-Authored-By: Claude` trailer.
- CSS: only `var(--*)` tokens (both `data-theme`s must work). No secrets outside keychain.
  All renderer→Rust inputs validated in Rust. New file writes to `.saple/*` go through
  `fs_lock::atomic_write` (Rust) / `enqueueWrite` (TS, `src/lib/writeQueue.ts`).
- Path containment: use `crate::project::get_project_file_path` for project paths, contain
  memory ops to the memory dir.

---

## Remaining work

### B3 — Split god components (mechanical, no behavior change)

1. `src/components/project/ProjectSettings.tsx` (~1,130 lines) → one file per settings tab
   under `src/components/project/settings/` (KeychainTab, ProvidersTab, WorkspaceTab, McpTab,
   MemoryTab, SessionsTab, DiagnosticsTab). The tab switch is a `SettingsTab` union +
   `tabs` array at the top; shared state (e.g. `providerKeys`) mostly belongs to one tab each.
   Note: a `pendingSettingsTab` consumption effect was added near the top — keep it in the
   shell component.
2. `src/components/terminal/TerminalPane.tsx` (~1,250 lines) → extract:
   - `useXtermSession` hook (the giant mount effect: xterm init, addons, replay, PTY wiring),
   - `TerminalPaneTitlebar` (title, badges, branch/maximize/close buttons),
   - keep WebGL budget logic (`webglHolders`, `MAX_WEBGL_CONTEXTS`) in its own module.
   The Ctrl+F search overlay added in C1 can move out too (`TerminalSearchBar`).
3. `src/components/review/ReviewWorkspace.tsx` (~900 lines) → extract `VirtualizedTextViewer`
   (already a standalone component at the top of the file), the file list + commit bar, and
   the right-hand actions panel.

### B4 — CSS modularization (pure move)

Split `src/styles/index.css` (~5,650 lines) into `styles/tokens.css` (the `:root` /
`[data-theme]` variable blocks) plus per-view files (`layout.css`, `terminal.css`,
`kanban.css`, `memory.css`, `swarm.css`, `review.css`, `settings.css`, `common.css`),
`@import`ed from `index.css` in that order. No selector changes — verify by diffing computed
styles on a few screens or just visual smoke.

### C4 — Swarm/agent completion notifications

- Add `tauri-plugin-notification` (cargo add in `src-tauri`, `npm i @tauri-apps/plugin-notification`,
  register plugin in `lib.rs` builder, add `notification:default` to
  `src-tauri/capabilities/` (check the existing capabilities file name)).
- Trigger points: `swarmStore.updateAgentStatus` when `effectiveStatus` becomes
  `done`/`failed`, and wherever a task lands in the `review` column
  (`terminalStore` review-gate path — grep `reviewPanes` / `resolveReview`).
- Behavior: if the window is focused, use the existing `notificationStore` toast instead;
  OS notification only when unfocused (`document.hasFocus()`).

### C6 — Auto-updater (needs user decisions; don't start without them)

- `tauri-plugin-updater` + GitHub Releases. Requires: signing keypair
  (`tauri signer generate`), `updater` config in `tauri.conf.json` (endpoint + pubkey),
  release pipeline that uploads `latest.json`. Ask the user for the repo/release setup
  before implementing. 7.12's version bump now includes Cargo.toml, so versions stay in sync.

### D1 — Inline-style consolidation (~190 `style={{}}` usages)

Worst offenders: `ProjectSettings.tsx` (~70, easier after B3), `ReviewWorkspace.tsx` (~40),
swarm wizard files (`wizardStyles.ts` is a start — it already centralizes some). Convert to
classes in the (post-B4) per-view CSS files using `var(--*)` tokens. Mechanical; do after
B3/B4 to avoid conflicts.

### D2 — Accessibility pass

- Focus trap + Esc-to-close in `TaskDialog`, `TaskDetailDrawer`, `SwarmWizard`,
  `CommandPalette` (palette already handles Esc; check focus trap).
- `aria-label` on icon-only buttons (Sidebar nav, TerminalPane titlebar — some already have
  them, audit the rest; kanban card buttons).
- Keyboard alternative for kanban drag-and-drop (a "Move to column" menu on the card).
- Visible `:focus-visible` ring via a token (`--focus-ring`), applied to buttons/inputs.

### D3 — Empty states & onboarding

- First-run dashboard walkthrough (open project → terminal → tasks) on `ProjectDashboard`
  when `workspaceHistory` is empty.
- Audit per-view empty states for a consistent pattern (icon + one-liner + primary action);
  Memory and Review already have decent ones.

### D4 — Resizable panes

- Draggable splitters for `MemoryWorkspace` (list/editor/graph) and `ReviewWorkspace`
  (queue/diff/actions three-column layout).
- Persist per-workspace in localStorage, modeled on `terminalLayoutStore`
  (`src/stores/terminalLayoutStore.ts`).

## Suggested order

Merge-to-master decision → B3 → B4 → D1 → C4 → D2 → D3 → D4 → (C6 only after user provides
release/signing setup). Each item independently shippable; verify + commit after each.
