# Saple Bridge Improvement Plan

## Context

Saple Bridge (Tauri 2 + React 19 + Rust) is a local-first AI development workspace with terminals, Kanban, memory, swarm, review, and a file editor. The app works, but exploration found concrete bugs, UX gaps, heavy style debt, and missing engineering guardrails:

- **Fonts are broken in the packaged app.** `src/styles/tokens.css` loads Inter and JetBrains Mono Nerd from Google Fonts / jsDelivr CDNs, but `src-tauri/tauri.conf.json` CSP only allows `style-src 'self'` and `font-src 'self' data:`. Production builds silently fall back to system fonts, and the terminal loses Nerd Font glyphs (powerline symbols used by Claude Code and other CLIs).
- **565 `extracted-style-*` class occurrences across 39 files** - machine-generated class names (e.g. `extracted-style-014`) that make styles unmaintainable.
- **No lint tooling at all** (no ESLint/Prettier config, no CI), and only 6 small test files.
- The editor is a hand-rolled textarea + highlight overlay - fine for quick edits, but no undo history across sessions, no search/replace, no multi-file tabs, degrades on large files.

Goal: fix the real bugs first, establish a maintainable UI foundation, then deepen each room's functionality, in phases that each ship a verifiable improvement.

### Hard constraint: freeze the sidebar and terminal structure

**The current layout and behavior of the sidebar (`src/components/layout/Sidebar.tsx`) and the terminal room (`src/components/terminal/*`) must not be restructured.** Keep:

- The sidebar as it is today: brand, Home nav item, the Workspaces rail, the contextual "Terminal Controls" block, and the Files / Settings / Command-palette footer nav. **No new room-navigation rail, no reflow of these sections.**
- The terminal grid, pane splitting, maximize, and focus behavior exactly as they are. **No drag-to-reorder, no automatic pane/session respawn, no grid layout changes.**

Only **additive, non-invasive** polish is permitted in these two areas - things that layer on top without moving or changing existing controls (e.g. making URLs clickable, a keyboard shortcut, a right-click menu, styling cleanup). Anything that would move, remove, or restructure an existing control is out of scope.

Note: the working tree has in-flight clipboard changes (`src/lib/clipboard.ts` + terminal clipboard refactor). Build on top of them; do not revert.

---

## Phase 1 - Correctness fixes and engineering guardrails - DONE

Small, high-leverage, mostly independent items. None of these restructure the sidebar or terminal.

**Status: Complete (2026-07-06).** typecheck / lint (0 errors) / `npm test` (16 passed) / `npm run build` / `cargo check` / `cargo test` (30 passed) all green locally. Fonts confirmed bundled and hashed into `dist/assets/*.woff2` with no CDN references remaining. Only the packaged-install glyph eyeball remains as a manual QA pass on a real `tauri:build`.

### 1.1 Bundle fonts locally (fixes packaged-app typography + terminal glyphs) - done
- [x] Downloaded woff2 for Inter (400/500/600/700), JetBrains Mono (400/500/600), and JetBrains Mono Nerd Font (400/700) into `src/assets/fonts/` (Inter/JBMono from the `@fontsource` latin woff2 files; Nerd from `Nick2bad4u/nerd-fonts-woff2`).
- [x] Replaced the `@import url(...)` and CDN `@font-face` rules in `src/styles/tokens.css` with local `@font-face` declarations. The production build emits hashed `dist/assets/*.woff2` referenced as `/assets/...` (no `googleapis`/`jsdelivr` left), so `font-src 'self'` is satisfied without touching the CSP.
- [x] Kept `font-display: swap` and the existing `--font-sans` / `--font-mono` variable names. Purely a font-source swap - no visible layout change.
- [ ] Manual check: `npm run tauri:build` + install, and eyeball a Claude Code pane for powerline/Nerd glyphs (only manifests in a packaged build).


### 1.2 Lint, format, CI - done
- [x] Added ESLint 9 flat config (`eslint.config.js`) with `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `eslint-config-prettier`; added Prettier config (`.prettierrc.json`, `.prettierignore`) matching current style (single quotes, semicolons, 2-space). Scripts: `lint`, `lint:fix`, `format`, `format:check`.
- [x] Fixed all lint errors (`no-explicit-any` typed properly at the sites, unused catch bindings dropped, empty interface removed); `react-hooks/exhaustive-deps` findings left as warnings (fixing blindly risks behavior changes).
- [x] Added a GitHub Actions workflow (`.github/workflows/ci.yml`, Windows runner): typecheck, lint, test, build; plus cargo check/test.
- [x] Removed the dead Sidebar badge branches that referenced `review`/`swarm` nav items no longer in `primaryNavItems`/`secondaryNavItems` - a behavior-neutral tidy, not a restructure.

**Verification:** typecheck / lint / `npm test` / `npm run build` / `cargo check` green locally. Font bundling confirmed in build output. Packaged-install glyph check remains a manual QA pass on a real `tauri:build`.

---

## Phase 2 - Design-system cleanup and UI polish - DONE

Makes every later UI change cheaper and safer. This is styling/token work; it does not move or restructure the sidebar or terminal controls, only renames classes and swaps hardcoded values for tokens.

**Status: Complete (2026-07-06).** typecheck / lint (0 errors, only pre-existing exhaustive-deps warnings) / `npm test` (23 passed) / `npm run build` / `cargo check` all green locally. Grep confirms zero `extracted-style-` occurrences remain in `src/`. Light-theme audit and pixel-identical terminal/sidebar remain a manual QA eyeball on `npm run tauri:dev`.

### 2.1 Kill the `extracted-style-*` classes (565 occurrences, 39 files) - done
- [x] Renamed all 565 machine-generated `extracted-style-NNN` occurrences to semantic, token-based classes in both the CSS and the components across all view folders (layout, memory, kanban, review, terminal, settings, editor, and swarm - the largest at 125). Exact duplicates merged.
- [x] Added shared utility layers to `common.css`: foreground-color helpers (`.fg-primary/secondary/muted/accent/success/danger/warning/border`) and flex-grow helpers (`.flex-1/.flex-2`) that absorb the many identical single-property helpers extraction had generated per element.
- [x] Terminal and layout folders are a pure class-name/token swap - rendered output stays identical (sidebar/terminal freeze respected).

### 2.2 Token and consistency pass - done
- [x] Added spacing scale tokens (`--space-1..8`) and font-size tokens to `tokens.css`; swept obvious magic numbers in the view CSS onto them during 2.1.
- [ ] Light-theme end-to-end audit (rooms, dialogs, toasts, context menus): manual QA eyeball on `tauri:dev`.
- [x] Interactive states normalized against `--focus-ring` during the class-rename pass; icon-only buttons keep aria-labels.

### 2.3 Micro-UX polish - done
- [x] Uniform empty states retained/normalized during the class-rename pass.
- [x] Replaced the bare "Loading room..." Suspense fallbacks in `App.tsx` with a lightweight `RoomSkeleton`.
- [x] `prefers-reduced-motion` respected in `common.css` for added animations.
- [x] Added `tauri-plugin-window-state` (size/position/maximized persist across launches) and `tauri-plugin-single-instance` (a second launch focuses the existing window instead of spawning a duplicate).

**Verification:** typecheck / lint / `npm test` (23) / `npm run build` / `cargo check` green locally; zero `extracted-style-` occurrences confirmed by grep. Remaining: manual `npm run tauri:dev` walk of every room in dark and light themes, confirming the terminal room and sidebar render pixel-identical to before.

---

## Phase 3 - Terminal room polish (additive only) - DONE

**No layout, grid, or session-lifecycle changes.** Every item here layers on top of the existing terminal without moving or restructuring current controls.

**Status: Complete (2026-07-06).** typecheck / lint (0 errors, only pre-existing exhaustive-deps warnings) / `npm test` (23 passed) / `npm run build` all green locally. No Rust changes, so `cargo` was untouched. All additions are overlays/store fields - the grid, split, maximize, and focus paths are unchanged. Remaining is a manual `npm run tauri:dev` eyeball pass.

### 3.1 Quality-of-life (non-invasive) - done
- [x] Clickable URLs via `@xterm/addon-web-links@0.12.0` (xterm-6 compatible line). The `WebLinksAddon` handler opens through the existing `@tauri-apps/plugin-opener` `openUrl` (OS browser, never the WebView); `opener:default` capability already present. Pure addon in `useXtermSession`, no UI change.
- [x] Font-size control (Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0) added to `terminalFontStore` (`fontSize` + `increase/decrease/resetFontSize`, clamped 8-28). Wired in the pane's `attachCustomKeyEventHandler` so the change never reaches the shell; the existing font effect re-fits every pane and pushes the new cols/rows to the PTY. Keyboard-only, no new controls.
- [x] Configurable scrollback in `terminalFontStore.scrollbackRows` (clamped via new `MIN/MAX_SCROLLBACK_ROWS` in `terminalLimits.ts`), applied live in `useXtermSession` via `term.options.scrollback`. Control lives in Settings > Workspace (`WorkspaceTab`), not the terminal chrome. Kept app-wide (localStorage, matching the font pref) rather than adding a per-workspace Rust config field - simpler and equally robust; noted in the UI as app-wide.
- [x] Activity / exit indicators on `TerminalPaneTitlebar`: an unobtrusive dot for unfocused panes that produced output since last focus (tracked via a local `subscribeOutput` listener that only sets state on the false->true edge, so the hot output path stays off React's reactive path), and an "exited" badge driven by a new reactive `exitedPanes` map in `terminalStore` set on the existing `pty-exit` event. Both sit inside the existing titlebar - no reflow.

### 3.2 Search and copy polish (additive) - done
- [x] In-flight clipboard work shipped (already wired: `lib/clipboard.ts` retry helper + `terminalClipboard.ts`).
- [ ] "Copy last command output" - **skipped.** The output buffer has no per-command boundaries (command detection runs off the *input* path and never maps to output line ranges), so reconstructing a single command's output from the rolling buffer would be unreliable. Deferred rather than shipping a guessy feature; the context-menu "Copy" (selection) covers the common case.
- [x] Right-click context menu on panes (`TerminalContextMenu`): Copy (selection) / Paste / Search / Clear. A `position: fixed` overlay that closes on outside press or Escape - it never touches the existing titlebar controls.
- [x] "Keyboard Shortcuts" help dialog (`ShortcutsHelpDialog`) reachable from the command palette (new "Keyboard Shortcuts" command), toggled through a tiny `shortcutsHelpStore` and rendered once at the app root. Documents the existing global + terminal bindings (incl. Ctrl+Alt+Right to cycle). Documentation only; registers no new bindings.

**Explicitly out of scope** (would restructure the terminal): drag-to-reorder panes, persisting/respawning a per-workspace pane set on open, and any change to the grid or split layout. None touched.

**Verification:** typecheck / lint / `npm test` (23) / `npm run build` green locally. Remaining: manual `npm run tauri:dev` walk - open two providers, click URLs, exercise the context menu and font-size shortcuts, verify glyphs/fonts/scrollback, and confirm the grid, splitting, maximize, and focus behavior are byte-for-byte the same as before.

---

## Phase 4 - Editor and Files room - DONE

**Status: Complete (2026-07-06).** typecheck / lint (0 errors, only pre-existing exhaustive-deps warnings) / `npm test` (29 passed, +6 new fileStore tab tests) / `npm run build` / `cargo check` / `cargo test` (34 passed, +4 new file-op/search tests) all green locally. Remaining is a manual `npm run tauri:dev` eyeball of editing, tabs, tree ops, and search.

### 4.1 CodeMirror 6 editor - done
- [x] Replaced the textarea+overlay edit path in `CodeViewer.tsx` with a dedicated `CodeMirrorEditor.tsx` (`@codemirror/state`, `@codemirror/view`, `codemirror` `basicSetup`, `@codemirror/commands` `indentWithTab`). This brings persistent undo/redo, `Ctrl+F` search/replace, bracket matching, multi-cursor, and viewport rendering for large files - all from the batteries-included setup rather than hand-rolled. Language packs (`@codemirror/lang-*`) load lazily per file extension via a `Compartment`, so each grammar is a separate chunk.
- [x] Kept Shiki for the read-only viewing path (per the plan's "keep Shiki initially" note) - only edit mode swapped engines, which isolates the change and leaves the viewer untouched. Long-term unification onto one engine is still open.
- [x] Preserved existing behaviors: markdown Code/Preview toggle, `enableEditMode` flag (still enforced Rust-side in `write_text_file`), Open Externally, copy, wrap toggle (live `EditorView.lineWrapping` compartment), and light/dark theme (reuses the same classification as Shiki via `@codemirror/theme-one-dark`).
- [x] `Ctrl+S` saves from inside the editor; a dirty dot shows in the header and on the active tab; the Save button disables when clean. Switching files or closing a dirty tab prompts through `confirmStore`. The dead edit-overlay CSS/Shiki-sync code was removed.

### 4.2 Files room capability - done
- [x] Multi-file tabs (`EditorTabs.tsx`) across the top of the editor pane, backed by `fileStore.openFiles` (most-recent-first, de-duplicated). Middle-click or the ✕ closes a tab; closing the active tab activates its neighbor.
- [x] Git-aware `FileTree`: modified/added/untracked/deleted badges (M/A/U/D, color-coded) from a new `git_status` Tauri command wrapping the existing `git_status_inner`. Non-git workspaces degrade silently to no badges.
- [x] File operations in the tree via right-click context menu + toolbar (new file/folder, rename, delete). New Rust commands in `files.rs` (`create_file`, `create_directory`, `rename_path`, `delete_path`) all route through `get_project_file_path` for path-containment; delete uses the `trash` crate (recycle bin, recoverable) and is confirmed via `confirmStore`. Tabs follow renames and close on delete.
- [x] Workspace-wide text search: a Rust `search_in_files` command (walks the tree, reuses the tree's ignore list for `node_modules`/`target`/`.git`/binaries, skips non-UTF-8 and >1MB files, caps at 500 hits with a `truncated` flag) surfaced in a `FileSearchPanel` reached from a Files/Search toggle in the room, plus a "Search in Files" command-palette entry that navigates in and opens the panel.

**Known limitation:** the unsaved-changes guard covers in-room navigation (switching files, closing tabs) but not switching to another room, which unmounts the editor and discards edits silently. Intercepting global room navigation would be invasive against the current nav wiring; deferred rather than shipped half-wired.

**Verification:** typecheck / lint / `npm test` (29) / `npm run build` / `cargo check` / `cargo test` (34) green locally. New tests: `fileStore.test.ts` (tab open/close/dirty-guard/rename-follow/delete-descendants) and Rust `files::tests` (create-traversal reject, rename absolute-dest reject, search hit/empty). Remaining: manual `tauri:dev` walk - edit/save/undo a large file, exercise tabs, tree new/rename/delete, and full-text search.

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
- Branch switcher: add a dropdown in the Review/commit UI (list local branches, checkout via new `git.rs` command with dirty-tree guard). Keep it inside the Review room's existing chrome - do not add persistent branch chrome over the terminal/sidebar.

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
- Test expansion: store-level tests for kanbanStore, reviewStore, terminalLayoutStore logic; Rust tests for path containment on every new command added in earlier phases.

**Verification:** full regression pass of all rooms, `npm run typecheck && npm run lint && npm test`, `cargo test`, `npm run tauri:build` and install the produced bundle on Windows; updater dry-run against a staged release.

---

## Sequencing and dependencies

- Phase 1 first (bug fixes + guardrails); everything after benefits from lint/CI.
- Phase 2 before Phases 3-6 UI work, so new UI lands on semantic classes and tokens, not on more `extracted-style-*` debt.
- Phases 3, 4, 5 are independent of each other after Phase 2 and can be reordered based on what hurts most day-to-day.
- The sidebar and terminal freeze applies across all phases: any styling/token work in those folders must be a rename/token swap that leaves the rendered result identical.
- New dependencies introduced: `@xterm/addon-web-links`, CodeMirror 6 packages, `tauri-plugin-window-state`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, ESLint/Prettier toolchain. All are mainstream, maintained, and align with the quality-over-dev-cost preference.

## Global verification approach

Per phase: `npm run typecheck`, `npm run lint`, `npm test`, `cargo check`/`cargo test`, then an E2E walkthrough in `npm run tauri:dev` exercising the changed room the way an end user would. Phases 1 and 6 additionally require a real `npm run tauri:build` install test on Windows, since the font fix and updater only manifest in packaged builds. For any phase that touches the terminal or sidebar folders, add a before/after visual check confirming those sections are unchanged.
