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

## Phase 2 - Design-system cleanup and UI polish

Makes every later UI change cheaper and safer. This is styling/token work; it does not move or restructure the sidebar or terminal controls, only renames classes and swaps hardcoded values for tokens.

### 2.1 Kill the `extracted-style-*` classes (565 occurrences, 39 files)
- Work file-pair by file-pair (component + its CSS file, e.g. `swarm.css` has 125, `settings.css` 68). For each `extracted-style-NNN`: rename to a semantic class in both the CSS and the component, merge duplicates, and replace one-off hardcoded colors with `var(--*)` tokens per the AGENTS.md contract.
- Mechanical, reviewable commits: one commit per view folder (swarm, settings, review, terminal, kanban, memory, layout, editor). For the terminal and layout folders this is a pure class-name/token swap - visual output stays identical.

### 2.2 Token and consistency pass
- Add spacing scale tokens (`--space-1..8`) and font-size tokens to `tokens.css`; sweep obvious magic numbers in the view CSS files onto them opportunistically during 2.1.
- Audit the light theme end-to-end (every room, dialogs, toasts, context menus) - the dark palette is clearly primary; fix low-contrast or unthemed spots.
- Normalize interactive states: every button/list-row gets consistent hover, active, focus-visible (`--focus-ring`) treatment; icon-only buttons keep aria-labels.

### 2.3 Micro-UX polish
- Empty states: consistent illustration/icon + primary action for each room (some rooms have them, e.g. CodeViewer; make them uniform).
- Loading: replace bare "Loading room..." text in `App.tsx` Suspense fallbacks with a lightweight skeleton.
- Reduced motion: respect `prefers-reduced-motion` for any animations added.
- Window state: add `tauri-plugin-window-state` so size/position/maximized persist across launches; add `tauri-plugin-single-instance` so opening the app again focuses the existing window.

**Verification:** `npm run tauri:dev`; walk every room in dark and light themes with a picky eye (per project standard). Grep confirms zero `extracted-style-` occurrences. Screenshot comparison before/after per room - the terminal room and sidebar must look pixel-identical to before (class rename only).

---

## Phase 3 - Terminal room polish (additive only)

**No layout, grid, or session-lifecycle changes.** Every item here layers on top of the existing terminal without moving or restructuring current controls.

### 3.1 Quality-of-life (non-invasive)
- Clickable URLs via `@xterm/addon-web-links` (open through the existing opener plugin) - pure addon, no UI change.
- Font-size control (Ctrl+= / Ctrl+- / Ctrl+0 on the focused pane) added to `terminalFontStore` alongside the existing font-family choice - keyboard-only, no new controls.
- Configurable scrollback limit in Workspace settings (wire through existing `terminalLimits.ts`) - lives in the Settings room, not the terminal chrome.
- Activity / exit-status indicators: a small unobtrusive dot on `TerminalPaneTitlebar` for unfocused panes that produced output since last focus, and an exit-status badge when a session's process exits (instead of a silently dead pane). These sit inside the existing titlebar - no layout reflow.

### 3.2 Search and copy polish (additive)
- Ship the in-flight clipboard work; add "Copy last command output" if feasible from the buffer.
- Add a right-click context menu on panes (Copy / Paste / Clear / Search) so mouse-first users are not stranded - a menu overlay, not a change to existing controls.
- Add a "Keyboard shortcuts" help dialog reachable from the command palette that documents the existing pane shortcuts (e.g. Ctrl+Alt+Right to cycle). Documentation only; no new bindings that change current behavior.

**Explicitly out of scope** (would restructure the terminal): drag-to-reorder panes, persisting/respawning a per-workspace pane set on open, and any change to the grid or split layout.

**Verification:** E2E in `npm run tauri:dev` as a user would: open two providers, click URLs, exercise the context menu and font-size shortcuts, verify glyphs/fonts/scrollback. Confirm the grid, splitting, maximize, and focus behavior are byte-for-byte the same as before.

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
