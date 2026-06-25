# Saple Bridge — Improvement Plan (vs BridgeMind BridgeSpace)

> Phased, checkbox-tracked roadmap from a 5-agent deep-dive audit (Amber, terminals/PTY,
> kanban/swarm, memory/MCP, cross-cutting quality). Work top-to-bottom; each phase is its
> own branch + PR. **Do the phases in order** — later phases depend on earlier fixes.

## Why this exists

**BridgeMind / BridgeSpace** is the direct paid competitor (cloud, ~$50/mo). Saple already
ships *every piece* it charges for — terminals, kanban, swarm, memory graph, MCP, an in-app
agent (Amber) — but they're **siloed**, and several have real P0 bugs. BridgeSpace's signature
features Saple lacks: **(1)** launch an agent *directly from a Kanban task*, **(2)** Warp-style
**command blocks** (OSC 133), **(3)** an **integrated code editor**, **(4)** a
**reviewer-gates-merge** swarm flow.

**Saple's durable edge — local-first, offline, no-account, privacy (stdio MCP, keys in keychain
read only in Rust) — must be preserved in every change. No cloud lock-in, no telemetry, offline
must keep working.**

### Verified bugs (confirmed in source)
- `src/stores/providerStore.ts:104-141` — `testProvider` writes `'test-connection'` into the
  keychain (`set_api_key`), **destroying the user's real provider key**, then reads it back.
  `checkKeychain` (`:181-190`) pulls the raw secret to the renderer via `get_api_key` just to
  check presence — on every settings load.
- `src-tauri/tauri.conf.json:23` — CSP allows `script-src 'self' 'unsafe-inline' 'unsafe-eval'`.
- `src-tauri/src/project.rs:8-27` — `get_project_file_path` canonicalizes the *parent* (not the
  target), runs `create_dir_all` *before* the containment check, and never rejects absolute paths.

### Conventions
- Branch per phase off `master`: `<type>/bridge-<desc>`. Open a PR into `master` after each phase.
  (Don't pile this onto the shared `feat/voice-bridge-windows-ci` branch.)
- Severity tags: **P0** critical · **P1** high · **P2** medium · **P3** polish.
- Paths are relative to `apps/saple-bridge/`.

---

## Phase 1 — Security & correctness hardening
**branch:** `fix/bridge-hardening` · fast, low-risk, highest safety payoff — **land first**

> **Status (complete):** all 12 items done on `fix/bridge-hardening`. The final three — CSP
> hardening, split-chunk signal detection, evict-stale-pane-keys — plus the deferred TS-side
> atomic-write promise chains (kanban/swarm) landed together. Frontend builds clean
> (`npm --prefix apps\saple-bridge run build`, tsc + vite). The earlier Rust changes still want a
> Windows-CI `cargo check`/`cargo test` pass as a backstop; this final batch touched only the CSP
> string in `tauri.conf.json` and TypeScript, no `.rs` source.

- [x] **P0** Kill the testProvider key-destroyer: stop writing `'test-connection'`; replace the
  `set_api_key`+`get_api_key` round-trip with the existing **`has_api_key`** command. For real
  connectivity add a Rust `test_provider_connection(provider)` that reads the key internally.
  — `src/stores/providerStore.ts:104-141,181-190` ✓ `test_provider_connection` added in `keychain.rs`
- [x] **P0** Stop leaking secrets to the renderer: swap every renderer `get_api_key` → `has_api_key`;
  remove `get_api_key` from the `invoke_handler` allowlist if no Rust consumer needs it.
  — `src/stores/providerStore.ts`, `src/components/project/ProjectSettings.tsx:147,162`,
  `src/components/common/CommandPalette.tsx:133`, `src-tauri/src/lib.rs` ✓ command removed; only
  `get_api_key_inner` (Rust-internal) remains
- [x] **P0** Atomic writes + per-file locking (fixes silent corruption when UI + MCP write
  concurrently during agent runs): write-to-temp + `fs::rename`; per-file `Mutex` in Tauri state;
  serialize TS saves through a per-file promise chain.
  — new `src-tauri/src/fs_lock.rs` (`atomic_write` + per-path mutex), wired into `project.rs`,
  `swarm.rs`, `mcp.rs`, `memory.rs`. ✓ TS per-file promise chains now done too — shared
  `src/lib/writeQueue.ts` (`enqueueWrite(key, task)`) serializes saves per logical file; wired into
  `kanbanStore.saveTasks` (`tasks:<path>`) and `swarmStore.saveSwarmState` (`swarm:<path>`).
- [x] **P0** CSP hardening: dropped `unsafe-eval` (→ narrower `'wasm-unsafe-eval'` so Shiki's
  oniguruma WASM engine still loads; highlighting already degrades to plain text via `.catch` if a
  WebView ever rejects it) and `unsafe-inline` from `script-src` (moved the FOUC theme script to an
  external `public/theme-init.js`, still render-blocking in `<head>`). — `src-tauri/tauri.conf.json:23`,
  `index.html`, `public/theme-init.js` ✓
- [x] **P0** Path-containment fix: reject absolute `file_path` early; validate containment *before*
  `create_dir_all`; canonicalize the full target when it exists. — `src-tauri/src/project.rs:8-27`
  ✓ rejects absolute/`..`/drive-prefix; canonicalizes nearest existing ancestor before any
  `create_dir_all`; `#[cfg(test)]` traversal/absolute/long-path tests added
- [x] **P0** Frontmatter YAML injection: escape/quote `unknown_frontmatter` values (or use
  `serde_yaml`). — `src-tauri/src/memory.rs:176-178,582-584` ✓ `yaml_quote`/`yaml_unquote` round-trip
  (id, category, tags, aliases, unknown fields), backward-compatible with unquoted legacy files
- [x] **P0/P1** Amber loop robustness: one `reqwest::Client` in `AmberRegistry` with
  `connect_timeout(15s)`/`timeout(300s)`; retry 429/529/503 honoring `Retry-After` (cancel-aware);
  `persist_conversation` per-turn; validate `base_url` (https, no arbitrary host → closes IPC→SSRF
  key-exfil). — `src-tauri/src/amber/{mod,provider,anthropic}.rs`
- [x] **P0** PTY zombie cleanup: `impl Drop for PtyRegistry` (kill+wait children, join threads) +
  Tauri `on_window_event(CloseRequested)`. — `src-tauri/src/lib.rs`, `src-tauri/src/pty.rs`
- [x] **P1** Split-chunk signal detection: per-pane rolling tail buffer (`paneSignalTails`, 512 chars)
  + line-anchored regexes (`/^\s*\[(?:AGENT_DONE|…)\]\s*$/m`) matched against the tail so a marker
  split across PTY bursts is rejoined; tail evicted in `removePane`/`closeWorkspaceTerminals`/`clearAll`.
  — `src/stores/terminalStore.ts` ✓
- [x] **P1** Validate `review.rs` `decision` param (reject anything not `approve`/`reject`).
  — `src-tauri/src/review.rs:187`
- [x] **P1** Evict stale `workspacePanes`/focus/maximized map keys in `removePane` (last pane in a
  workspace closed → delete all three keys instead of leaving empty entries); `clearAll` already
  resets the maps. — `src/stores/terminalStore.ts` ✓
- [x] **P1** Guard the legacy `openai_api_key` keychain fallback to codex-only. — `src-tauri/src/pty.rs:267-272`

**Verify:** `npm --prefix apps\saple-bridge run build`; `cargo check`/`cargo test` (src-tauri).
Click "Test" on a provider with a real key → key **not** overwritten; settings load makes no
`get_api_key` calls; run agents in two terminals while editing the board → `tasks.json` stays valid.

---

## Phase 2 — FLAGSHIP: Kanban task → agent loop
**branch:** `feat/bridge-task-agent-loop` · the BridgeSpace signature feature — connects existing pieces
> Depends on Phase 1 atomic writes (live-reload safety).

- [ ] **P1** Schema: add `swarmId?: string` and `dependsOn?: string[]` to `Task`; update
  `normalizeTask` + the MCP `create_task` schema.
  — `src/types/task.ts:14-29`, `src/stores/kanbanStore.ts:23-41`, `src-tauri/src/mcp.rs:698-758`
- [ ] **P2** Extract shared `buildTaskPrompt(task)` → `src/lib/agentPrompt.ts` (TaskCard & drawer
  copies have diverged — drawer omits MCP/memory instructions); reuse in `launchAgentProcess`.
  — `src/components/kanban/TaskCard.tsx:52-76`, `src/components/kanban/TaskDetailDrawer.tsx:142-155`,
  `src/stores/swarmStore.ts:228-300`
- [ ] **P1** "Run in Swarm" on `TaskDetailDrawer`: opens `SwarmWizard` pre-filled with the task's
  title/description/acceptance/target-files; on launch write back `swarmId` + move task to
  `progress`; "Back to task" link in `SwarmWorkspace`.
  — `src/components/kanban/TaskDetailDrawer.tsx`, `src/components/swarm/wizard/SwarmWizard.tsx`,
  `src/stores/swarmStore.ts`
- [ ] **P3** Amber ↔ swarm bridge: add `read_swarm_mailbox`/`write_swarm_mailbox` (reuse
  `swarm::read_mailbox_file`/`write_mailbox_file`) + `spawn_swarm_agent` to Amber's tools so Amber
  can plan→delegate. — `src-tauri/src/amber/tools.rs:59`, `src-tauri/src/swarm.rs:50-66`
- [ ] **P1** Live reflect external writes: file-watch `.saple/tasks.json` + `.saple/swarm/state.json`
  → `loadTasks(path,true)` / `loadSwarmState(forceReload)`; add `forceReload` to bypass idempotent
  guards. — `src/stores/kanbanStore.ts:57-80`, `src/stores/swarmStore.ts:317-338`
- [ ] **P1** `pauseSwarm` must actually kill running panes. — `src/stores/swarmStore.ts:450-458`
- [ ] **P2** In-flight `Set` guard in `checkAndRunNextAgents` to prevent double-launch.
  — `src/stores/swarmStore.ts:500-569`
- [ ] **P2** Drop `persist` middleware from `swarmStore` (file is source of truth). — `src/stores/swarmStore.ts:637`

**Verify:** create a task → "Run in Swarm" launches a pre-filled swarm, task → `progress` with
`swarmId`; a task created via the MCP `create_task` tool appears on the board without manual reload;
"Pause" stops running terminals.

---

## Phase 3 — Terminal command blocks + resizable panes + search
**branch:** `feat/bridge-terminal-blocks` · Warp-style parity

- [ ] **P1** OSC 133 shell integration (replaces broken heuristic `detectCommand`): ship shell init
  snippets (pwsh/zsh/bash) emitting `133;A/B/C/D`; intercept in the PTY emit path and fire
  structured `pty-command-start`/`pty-command-end` events **with exit code**.
  — `src-tauri/src/pty.rs:305-343`, `src/stores/terminalStore.ts:665-713,14-21`
- [ ] **P1** Block-navigator UI per pane (elapsed time + exit-code color, "jump to" via
  `terminal.scrollToLine`). — `src/components/terminal/TerminalPane.tsx`
- [ ] **P1** In-terminal search: `@xterm/addon-search` + `Ctrl/Cmd+F` overlay.
  — `package.json`, `src/components/terminal/TerminalPane.tsx`
- [ ] **P1** Resizable panes: replace fixed CSS-grid breakpoints with `react-resizable-panels`;
  call `resize_pty` after drag; persist ratios in `SavedWorkspaceLayout`.
  — `src/components/terminal/TerminalGrid.tsx`, `src/styles/index.css:1797-1841`,
  `src/stores/terminalLayoutStore.ts`
- [ ] **P1** Surface PTY spawn errors in-pane (stop swallowing in `.catch`).
  — `src/stores/terminalStore.ts:466-469,524-532`
- [ ] **P3** Platform-aware copy/paste. — `src/components/terminal/TerminalPane.tsx:107-113`
- [ ] **P3** Remove dead "SHOW LESS"/"ADD CUSTOM COMMAND" buttons; add odd pane counts.
  — `src/components/terminal/TerminalGrid.tsx:30,431-433,457-459`

**Verify:** run a command → navigable block with correct exit-code color; `Ctrl/Cmd+F` searches the
buffer; drag a divider → terminal reflows.

---

## Phase 4 — Integrated Monaco editor
**branch:** `feat/bridge-monaco-editor` · largest single product gap (effort: L)

- [ ] **P1** Integrate `@monaco-editor/react` in the Files room; map `fileStore` open/save to Monaco
  models (multi-cursor, undo, bracket matching). Keep the Shiki `CodeViewer` as read-only preview
  for memory/review. Add Monaco's diff editor for Review.
  — `src/components/editor/EditorPanel.tsx`, `src/components/editor/CodeViewer.tsx:24-469`,
  `src/stores/fileStore.ts`

**Verify:** open a file, edit in Monaco, save → file changes on disk.

---

## Phase 5 — Reviewer-gates-merge swarm flow
**branch:** `feat/bridge-reviewer-gate` · closes BridgeSwarm's "Reviewer gates every merge"

- [ ] **P1** Add a `status === 'review'` path in `SwarmAgentCard` with **Approve / Reject**; surface
  the agent mailbox + diff as the review surface; approve → `done` (unlock dependents), reject →
  `relaunchAgent`. Promote to a prominent gate in `SwarmWorkspace`.
  — `src/components/swarm/SwarmAgentCard.tsx:130-140`, `src/stores/swarmStore.ts:608-610`

**Verify:** a reviewer agent enters `review` → Approve unlocks dependents; Reject relaunches.

---

## Phase 6 — Memory / MCP depth
**branch:** `feat/bridge-memory-mcp`

- [ ] **P1** Live-reload graph after agent writes: emit `memory:changed` from
  `save_memory_node_inner`/`delete_memory_file_inner`; debounced reload listener in `memoryStore`;
  add `forceReload`. — `src-tauri/src/memory.rs`, `src/stores/memoryStore.ts:70-84`
- [ ] **P1** In-process read-through cache for the MCP server (mtime-invalidated) — O(N) dir-walk per
  tool call today. — `src-tauri/src/mcp.rs:149-171,121-146`
- [ ] **P0** De-dupe + fix `get_graph`: call `get_memory_graph_inner` instead of the inline O(E²)
  copy; make `find_note_file_inner` `pub(crate)` and delete the `mcp.rs` copy.
  — `src-tauri/src/mcp.rs:548-590,121-146`, `src-tauri/src/memory.rs:307,642-667`
- [ ] **P1** Alias/title-aware `find_backlinks`. — `src-tauri/src/mcp.rs:402-417`
- [ ] **P1** `suggest_connections`: body-text scoring + exclude already-linked. — `src-tauri/src/mcp.rs:419-454`
- [ ] **P2** `[[target|label]]` split in the Rust wikilink extractor. — `src-tauri/src/memory.rs:225-234`
- [ ] **P2** Body-text sidebar search via `bodyExcerpt`/`search_memories_quick`. — `src/components/memory/MemoryList.tsx:85-97`
- [ ] **P1** Cursor pagination for `resources/list` / `list_memories`. — `src-tauri/src/mcp.rs:1135-1147`
- [ ] **P2** Graph viz: preserve node positions across reloads; O(1) adjacency map; responsive
  `viewBox`; stop RAF on convergence/when hidden. — `src/components/memory/MemoryGraph.tsx:106-120,169-189,48-49`
- [ ] **P2** Fix Review "Create Memory Note" (silently broken — add missing `aliases: []`).
  — `src/components/review/ReviewWorkspace.tsx:408-416`
- [ ] **P3** Optional loopback HTTP/SSE transport (`--http <port>` axum `/mcp`, stdio stays default)
  so external agents (Cursor/Windsurf) can connect without giving up the private default.
  — `src-tauri/src/mcp.rs`

**Verify:** write a memory via the MCP tool → graph updates live; `find_backlinks` finds alias/title
links; Review "Create Memory Note" succeeds.

---

## Phase 7 — UX / accessibility / quality + tests & CI
**branch:** `chore/bridge-quality`

- [ ] **P1** Add a reusable `ErrorBoundary` around each view in `App.tsx`
  (`renderHeavyView`/`renderLightView`) so one view crash doesn't blank the app.
- [ ] **P1** Offline-bundle fonts: remove Google Fonts/`jsdelivr` `@import`s; ship Inter +
  JetBrains Mono (Nerd) WOFF2 locally. — `src/styles/index.css:2,6,14`
- [ ] **P2** Keyboard drag-and-drop + ARIA roles on Kanban. — `src/components/kanban/KanbanColumn.tsx`, `TaskCard.tsx`
- [ ] **P2** Toast `aria-live` polite/assertive split. — `src/components/common/ToastHost.tsx:9`
- [ ] **P2** ConfirmDialog focus-return + `aria-describedby`. — `src/components/common/ConfirmDialog.tsx:12-41`
- [ ] **P2** Drop global `body { user-select: none }`; scope it to chrome. — `src/styles/index.css:197`
- [ ] **P3** `@media (prefers-reduced-motion)`; stop MemoryGraph RAF when reduced-motion is set.
- [ ] **P2** Wire or remove dead "Workspace options" button + dead review/swarm badge code.
  — `src/components/layout/Sidebar.tsx:255,231-237,509-514`
- [ ] **P2** Add `loading`/`error` to `swarmStore`. — `src/stores/swarmStore.ts`
- [ ] **P2** Fix `CommandPalette` `setTimeout(50)` focus race. — `src/components/common/CommandPalette.tsx:44-52`
- [ ] **P2** Replace both hand-rolled `now_iso()` with `chrono`. — `src-tauri/src/project.rs:80-114`, `src-tauri/src/memory.rs:53-82`
- [ ] **P1** Split the 948-line `ProjectSettings` into per-tab components.
- [ ] **P1** Split the 705-line `ReviewWorkspace` into a `useReviewActions` hook + extracted `VirtualizedTextViewer`.
- [ ] **P1** Tests & CI (the big gap): add Vitest + `@testing-library/react`; unit-test the complex
  stores (`terminalStore`, `kanbanStore`, `swarmStore`, `projectStore` migration); add Rust tests
  (pty utf8 split, swarm scheduler); add a **Windows CI workflow** running `cargo test` + `npm test`;
  add a `"test": "vitest"` script. — `package.json`, `.github/workflows/`

**Verify:** `npm --prefix apps\saple-bridge test` passes; CI gate runs on Windows.

---

## Global verification (any phase)

```powershell
npm --prefix apps\saple-bridge run build           # tsc + vite
cargo check --manifest-path apps/saple-bridge/src-tauri/Cargo.toml
cd apps\saple-bridge\src-tauri ; cargo test        # then: cd ..\..\..
npm run dev:bridge                                 # manual smoke
```

- Fresh release builds may hit Smart App Control **"os error 4551"** transiently — re-run, do
  **not** `cargo clean`.
- After each phase, use the `code-review-graph` MCP tools (`detect_changes`, `get_affected_flows`,
  `query_graph` tests_for) to confirm impact radius and test coverage.
```
