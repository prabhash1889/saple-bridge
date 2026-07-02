# Saple Bridge — Improvement Plan Handoff (2026-07-02, updated after B3)

Paste this into a fresh Claude Code session started in `saple-bridge/` to continue the
improvement plan. Read `CLAUDE.md` and the `AGENTS.md` files first, as usual.

## Context

A four-phase improvement plan (security → performance/health → features → UI polish) was
executed against this repo on 2026-07-02. **Phases A (security/stability, all 16 plan.md
Phase-7 findings), B1/B2/B3, and C1/C2/C3/C5 are DONE, committed, and pushed to `main`.**
This handoff covers what remains: **B4, C4, C6, and D1–D4.**

### Branch situation — resolved

The earlier debug-branch situation is resolved: all completed work is merged to **`main`**
and pushed to origin. Work directly on `main` per CLAUDE.md.

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
- **B3** — God components split (commit `ed92aa7`), mechanical, no behavior change:
  - `ProjectSettings.tsx` is now a thin shell (tab bar + `pendingSettingsTab` consumption);
    each tab lives in `src/components/project/settings/` (`KeychainTab`, `ProvidersTab`,
    `WorkspaceTab`, `McpTab`, `MemoryTab`, `SessionsTab`, `DiagnosticsTab`), with shared
    keychain constants (`KEYCHAIN_SERVICE_PREFIX`, `CODEX_KEY_SERVICE`, `SIGN_IN_COMMANDS`,
    `MASKED_KEY`) in `settings/constants.ts`. Per-tab data loads moved from
    `activeTab === 'x'` effects to mount effects inside each tab (equivalent — tabs only
    mount when active).
  - `TerminalPane.tsx` is now chrome-only; the xterm/PTY lifecycle lives in
    `useXtermSession.ts` (init, addons, replay, resize, theme/font sync, WebGL
    acquire/release), palettes in `terminalThemes.ts`, the WebGL context budget
    (cap, holder registry, TEMP diagnostics) in `webglBudget.ts`, plus
    `TerminalPaneTitlebar.tsx` and `TerminalSearchBar.tsx` (the C1 find bar — it now owns
    its query state; the pane only holds the `searchOpen` flag).
  - `ReviewWorkspace.tsx` keeps the queue/diff orchestration; extracted
    `VirtualizedTextViewer.tsx`, `ReviewFileList.tsx` (file list + stage checkboxes +
    commit bar), `ReviewActionsPanel.tsx` (right-hand actions/context column).

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

Worst offenders (post-B3 locations): the settings tab components under
`src/components/project/settings/` (~70 combined — `SessionsTab`/`DiagnosticsTab`/`MemoryTab`
are the heaviest), `ReviewWorkspace.tsx` + `ReviewActionsPanel.tsx`/`ReviewFileList.tsx`/
`VirtualizedTextViewer.tsx` (~40 combined), swarm wizard files (`wizardStyles.ts` is a
start — it already centralizes some). Convert to classes in the (post-B4) per-view CSS files
using `var(--*)` tokens. Mechanical; do after B4 to avoid conflicts.

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

B4 → D1 → C4 → D2 → D3 → D4 → (C6 only after user provides release/signing setup).
Each item independently shippable; verify + commit after each.
