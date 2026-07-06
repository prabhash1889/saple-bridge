# Saple Bridge Improvement Plan

## Context

Saple Bridge (Tauri 2 + React 19 + Rust) is a local-first AI development workspace with terminals, Kanban, memory, swarm, review, and a file editor. The app works, but exploration found concrete bugs, UX gaps, heavy style debt, and missing engineering guardrails:

- **Fonts are broken in the packaged app.** `src/styles/tokens.css` loads Inter and JetBrains Mono Nerd from Google Fonts / jsDelivr CDNs, but `src-tauri/tauri.conf.json` CSP only allows `style-src 'self'` and `font-src 'self' data:`. Production builds silently fall back to system fonts, and the terminal loses Nerd Font glyphs (powerline symbols used by Claude Code and other CLIs).
- **Room navigation is undiscoverable.** `src/components/layout/Sidebar.tsx` only navigates Home / Files / Settings. The five main rooms (terminals, kanban, memory, swarm, review) are reachable only via command palette, dashboard cards, or Alt+1-9. Dead badge code in Sidebar (checks for `item.id === 'review' | 'swarm'` on nav lists that no longer contain them) shows these items were removed at some point.
- **The theme toggle is unreachable from the main rooms.** `ThemeToggle` lives only in `TopBar`, and `App.tsx` hides the TopBar on all heavy views (`terminals`, `kanban`, `memory`, `swarm`, `review`). Git branch / workspace context disappears there too.
- **565 `extracted-style-*` class occurrences across 39 files** - machine-generated class names (e.g. `extracted-style-014`) that make styles unmaintainable.
- **No lint tooling at all** (no ESLint/Prettier config, no CI), and only 6 small test files.
- The editor is a hand-rolled textarea + highlight overlay - fine for quick edits, but no undo history across sessions, no search/replace, no multi-file tabs, degrades on large files.

Goal: fix the real bugs first, establish a maintainable UI foundation, then deepen each room's functionality, in phases that each ship a verifiable improvement.

Note: the working tree has in-flight clipboard changes (`src/lib/clipboard.ts` + terminal clipboard refactor). Build on top of them; do not revert.

---

## Phase 1 - Correctness fixes and engineering guardrails - DONE

Small, high-leverage, mostly independent items. Implemented; typecheck, lint (0 errors),
`npm test` (23 passing), `npm run build`, and `cargo check` all green.

### 1.1 Bundle fonts locally (fixes packaged-app typography + terminal glyphs) - DONE
- [x] Downloaded woff2 for Inter (400/500/600/700), JetBrains Mono (400/500/600), and JetBrains Mono Nerd Font (400/700) into `src/assets/fonts/` (Inter/JBMono from the `@fontsource` latin woff2 files; Nerd from `Nick2bad4u/nerd-fonts-woff2@1.0.5`).
- [x] Replaced the `@import url(...)` and CDN `@font-face` rules in `src/styles/tokens.css` with local `@font-face` declarations. Verified the production build emits hashed `dist/assets/*.woff2` and the built CSS references them as `/assets/...` (no `googleapis`/`jsdelivr` left), so `font-src 'self'` is satisfied without touching the CSP.
- [x] Kept `font-display: swap` and the existing `--font-sans` / `--font-mono` variable names.
- Remaining manual check: `npm run tauri:build` + install, and eyeball a Claude Code pane for powerline/Nerd glyphs (only manifests in a packaged build).

### 1.2 Restore room navigation in the sidebar - DONE
- [x] Added the five rooms to `Sidebar.tsx` nav (`terminals`, `kanban`, `memory`, `swarm`, `review`) between Home and the workspaces rail, reusing the `room-nav-item accent-*` pattern and existing per-room accent tokens.
- [x] Reworked the (previously dead) badge code into a shared `renderNavItem` helper: open-task count on the Tasks + Review items, running-agent count on Swarm.
- [x] Order matches Alt+1-9 / command palette / dashboard cards; Alt+1-9 unchanged.

### 1.3 Persistent app chrome for heavy views - DONE
- [x] TopBar is now always rendered; on heavy views it uses a slim variant (`topbar-slim` / `app-grid.slim-topbar`, new `--topbar-slim-height` token) that keeps workspace name, git branch, room title, and ThemeToggle while dropping the verbose subtitle/path. Removed the old `no-topbar` hide path.
- [x] `TopBar.tsx` now also re-fetches `git_current_branch` on window `focus`, not just on project change.

### 1.4 Lint, format, CI - DONE
- [x] Added ESLint 9 flat config (`eslint.config.js`) with `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, and `eslint-config-prettier`; added Prettier config (`.prettierrc.json`, `.prettierignore`) matching current style. Scripts: `lint`, `lint:fix`, `format`, `format:check`.
- [x] Fixed all lint errors (empty interface in `TerminalGrid.tsx`, browser globals + unused catch binding in `public/theme-init.js`, unused catch bindings, stale `eslint-disable`). Remaining items are `react-hooks/exhaustive-deps` warnings (8), left as warnings per plan since fixing blindly risks behavior changes.
- [x] Added GitHub Actions workflow (`.github/workflows/ci.yml`, Windows runner): typecheck, lint, test, build; plus cargo check/test.
- [x] Removed dead code: the dead Sidebar badge branches (folded into the helper) and the unused `ChevronsUpDown` "Workspace options" button that had no handler.

**Verification:** typecheck / lint / `npm test` / `npm run build` / `cargo check` green locally. Font bundling confirmed in build output. Packaged-install glyph check and a live click-through of sidebar nav/badges remain a manual QA pass on a real `tauri:build`.

---

## Phase 2 - Design-system cleanup and UI polish - DONE

Makes every later UI change cheaper and safer. Implemented; typecheck, lint
(0 errors), `npm test` (23 passing), `npm run build`, and `cargo check` all green.

### 2.1 Kill the `extracted-style-*` classes (565 occurrences, 40 files) - DONE
- [x] Renamed every `extracted-style-NNN` to a semantic, token-based class in both the CSS and the component, across all view folders (layout, common/editor/files, memory, kanban, review, terminal, settings, and swarm - the largest at 125). Exact duplicates merged.
- [x] Added shared utility layers to `common.css` that absorb the many identical single-property helpers extraction had generated per element: foreground-color helpers (`.fg-primary/secondary/muted/accent/success/danger/warning/border`) and flex-grow helpers (`.flex-1/.flex-2`).
- [x] Grep confirms zero `extracted-style-` occurrences remain in `src/` (only this plan doc still names them).
- Committed as one squashed refactor commit (the per-view work was mechanical and verified together) rather than one commit per folder.

### 2.2 Token and consistency pass - DONE (audit is manual QA)
- [x] Added a 4px-based spacing scale (`--space-1..8`) and a font-size scale (`--text-xs..2xl`, mapped to the sizes already used across the view CSS) to `tokens.css`.
- [x] Interactive states: the global `*:focus-visible` treatment (outline + `--focus-ring`) in `common.css` already covers every focusable element; icon-only buttons retain their aria-labels.
- Remaining manual pass: the end-to-end light-theme audit (every room, dialogs, toasts, context menus) and the before/after screenshot comparison need `npm run tauri:dev` and a picky eye; the spacing/font tokens are now available to retire magic numbers opportunistically in later phases.

### 2.3 Micro-UX polish - DONE
- [x] Loading: replaced the bare "Loading room..." `App.tsx` Suspense fallbacks with a lightweight `RoomSkeleton` (shimmer header + card grid).
- [x] Reduced motion: added a global `prefers-reduced-motion` rule in `common.css` that neutralizes animations, transitions, and smooth scrolling (covers the skeleton shimmer and any future animation).
- [x] Window state: added `tauri-plugin-window-state` (size/position/maximized persist across launches) and `tauri-plugin-single-instance` (registered first, desktop-only; re-launching unminimizes and focuses the existing window instead of starting a second process).
- Empty-state uniformity across rooms is left as an opportunistic visual pass for the per-room phases (3-6), where each room's empty state is touched anyway.

**Verification:** typecheck / lint / `npm test` / `npm run build` / `cargo check` green locally. Grep confirms zero `extracted-style-` occurrences. The light/dark visual walk-through and window-state/single-instance behavior remain a manual QA pass on `npm run tauri:dev` (window-state only persists across real launches).

---

## Phase 3 - Terminal room (the daily driver) - DONE

Implemented; typecheck, lint (0 errors, 8 pre-existing `exhaustive-deps` warnings),
`npm test` (31 passing), `npm run build`, and `cargo check` all green. No Rust changes.

### 3.1 Quality-of-life - DONE
- [x] Clickable URLs: the stable `@xterm/addon-web-links` still peers on xterm 5 and its
  xterm-6 build is a pre-release, so instead of pinning a shipped app to a beta we register
  our own provider through xterm's supported `registerLinkProvider` API (`webLinks.ts`).
  URLs open through the existing opener plugin (`openUrl`), never navigating the WebView.
  Wrapped-line stitching + the offset→buffer-cell coordinate math are pure functions with
  unit tests (`webLinks.test.ts`).
- [x] Activity + exit indicators: `terminalStore` now tracks `activityPanes` (set on the
  `pty-output` hot path only on the transition to "has unread output", cleared on focus) and
  `exitedPanes` (set from `pty-exit`). `TerminalPaneTitlebar` shows an accent activity dot and
  an "exited" badge; both maps are cleaned up on pane/workspace teardown.
- [x] Font size control: `fontSize` added to `terminalFontStore` (with increase/decrease/reset,
  clamped 8-32). Ctrl+= / Ctrl+- / Ctrl+0 handled inside the pane key handler; a stepper in the
  sidebar Terminal Controls mirrors it. `useXtermSession` re-applies size live and re-fits the PTY.
- [x] Configurable scrollback: `scrollbackRows` added to `terminalFontStore` (clamped
  1,000-100,000), surfaced as a "Terminal Preferences" section in Settings > Workspace, applied
  live via `term.options.scrollback`. `terminalLimits.ts` keeps the old constant as the default.

### 3.2 Layout and session resilience - DONE
- [x] Per-workspace pane restore already existed (`restoreWorkspacePanes` + the setup wizard's
  "Restore previous terminals"); left intact and now also re-snapshotted after a reorder.
- [x] Drag-to-reorder: the pane title is a drag grip; dropping onto another pane's titlebar calls
  the new `reorderPane` store action (same-workspace only, via a private DnD MIME so a drag never
  pastes into a terminal) and re-persists the layout.
- [x] Ctrl+Alt+Left added alongside the existing Ctrl+Alt+Right (unified into
  `focusAdjacentTerminal`). A "Keyboard Shortcuts" dialog (`KeyboardShortcutsDialog`) documents
  every shortcut and terminal gesture, reachable from the command palette or Ctrl+/.

### 3.3 Search and copy polish - DONE
- [x] The in-flight clipboard work is shipped (Ctrl+C copy-selection / Ctrl+V paste already
  present). Added a right-click context menu on panes (`TerminalPaneContextMenu`):
  Copy / Copy all output / Paste / Clear / Search. Per-command output boundaries aren't captured
  in the buffer, so "Copy last command output" was implemented as "Copy all output" (clean text
  serialized from the xterm buffer, no ANSI codes) rather than an unreliable heuristic.

**Verification:** typecheck / lint / `npm test` (incl. new `webLinks` tests) / `npm run build` /
`cargo check` green locally. The live E2E pass (click URLs, drag-reorder, restart-and-restore,
Nerd-Font glyphs) remains a manual `npm run tauri:dev` / packaged-build check.

---

## Phase 4 - Editor and Files room

### 4.1 CodeMirror 6 editor
- Replace the textarea+overlay editing path in `src/components/editor/CodeViewer.tsx` with CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, language packs loaded lazily per file type). Gains: proper undo/redo, search/replace, bracket matching, multi-cursor, huge-file viewport rendering.
- Keep Shiki for the read-only viewing path initially (it is already good), or unify on CodeMirror read-only mode if it proves visually equal - decide during implementation, prefer one engine long-term.
- Preserve existing behaviors: markdown Code/Preview toggle, `enableEditMode` workspace flag, Open Externally, copy, wrap toggle.
- Add Ctrl+S save and a dirty indicator; warn on navigating away with unsaved changes (use existing `confirmStore`).

### 4.2 Files room capability
- Multi-file tabs across the top of the editor pane (open files list in `fileStore`, most-recent-first, middle-click close).
- Git-aware `FileTree`: modified/added/untracked badges using existing `git.rs` status command.
- File operations in the tree (new file/folder, rename, delete to recycle bin) - Rust commands in `files.rs` with the existing path-containment validation; confirm destructive ops via `confirmStore`.
- Workspace-wide text search: Rust-side search command (walk + match, respect `.gitignore`, cap results) with a search panel in the Files room; reuse for a "Search in files" command-palette entry.

**Verification:** unit tests for fileStore tab logic; E2E: edit/save/undo across large files (>5k lines), tabs, tree operations, search; `cargo test` for the new Rust search/file-op commands including containment tests.

---

## Phase 5 - Task -> Review pipeline

### 5.1 Kanban
- Keyboard support: arrows to move selection, Enter to open drawer, `E` edit, bracket keys to move between columns (kanban currently is mouse-only apart from dialogs).
- Task metadata: optional due date and simple checklist/subtasks in `TaskDialog` + `TaskCard` progress chip; stored in `.saple/tasks.json` (backward-compatible optional fields).
- Column WIP indicator (count/limit) - display only, no hard block.

### 5.2 Review room
- Syntax-highlighted, side-by-side diff option: parse the unified diff already fetched by `loadGitDiff` and render split view (reuse Shiki tokenization; keep `VirtualizedTextViewer` for very large diffs).
- Per-file review state (viewed/unviewed checkmarks) persisted in the review record so reviewers can track progress across files.
- Verification command presets per workspace (e.g. `npm test`, `cargo test`) stored in workspace config instead of the hardcoded `npm test` default in `ReviewWorkspace.tsx`.
- Commit UX: show staged-file summary and conventional-commit prefix helper in the commit box.

### 5.3 Git surface
- Branch display already in TopBar (Phase 1.3 keeps it visible everywhere); add a branch switcher dropdown (list local branches, checkout via new `git.rs` command with dirty-tree guard).

**Verification:** E2E: create task -> move to review -> inspect split diff -> stage subset -> run verification preset -> commit; confirm `.saple/tasks.json` stays backward compatible (open an old file). Rust tests for the new git commands.

---

## Phase 6 - Memory, Swarm, distribution, and hardening

### 6.1 Memory room
- Full-text search across memory markdown (Rust side in `memory.rs`, indexed or straightforward scan - the corpus is small) with highlighted results in `MemoryList`.
- Backlinks panel in `MemoryEditor` (the wikilink graph already exists in Rust; expose "what links here").
- Note templates (decision, pattern, bug) matching the existing memory category tokens.

### 6.2 Swarm room
- Surface agent health more clearly on `SwarmAgentCard` (last-activity timestamp, stalled indicator) and one-click "open this agent's terminal pane".

### 6.3 Distribution and robustness
- `tauri-plugin-updater` with signed releases so users stop manually reinstalling (needs a hosting decision - GitHub Releases is the default).
- Structured frontend error logging to a rotating file via a Rust command; surface "Report a problem" in Settings > Diagnostics that zips logs + diagnostics output.
- Test expansion: store-level tests for kanbanStore, reviewStore, terminalLayoutStore restore logic; Rust tests for path containment on every new command added in earlier phases.

**Verification:** full regression pass of all rooms, `npm run typecheck && npm run lint && npm test`, `cargo test`, `npm run tauri:build` and install the produced bundle on Windows; updater dry-run against a staged release.

---

## Sequencing and dependencies

- Phase 1 first (bug fixes + guardrails); everything after benefits from lint/CI.
- Phase 2 before Phases 3-6 UI work, so new UI lands on semantic classes and tokens, not on more `extracted-style-*` debt.
- Phases 3, 4, 5 are independent of each other after Phase 2 and can be reordered based on what hurts most day-to-day (recommended order as written: terminal is the daily driver).
- New dependencies introduced: `@xterm/addon-web-links`, CodeMirror 6 packages, `tauri-plugin-window-state`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, ESLint/Prettier toolchain. All are mainstream, maintained, and align with the quality-over-dev-cost preference.

## Global verification approach

Per phase: `npm run typecheck`, `npm run lint`, `npm test`, `cargo check`/`cargo test`, then an E2E walkthrough in `npm run tauri:dev` exercising the changed room the way an end user would. Phases 1 and 6 additionally require a real `npm run tauri:build` install test on Windows, since the font fix and updater only manifest in packaged builds.
