# Update 11 - Saple Bridge Improvement Plan

Date: 2026-07-21
Sources: two parallel deep-dive analyses (frontend/UX surface, backend/architecture/security), cross-checked against `security-audit-report.md` (2026-07-14), `auditor_report.md`, `swarm-redesign.md`, and `docs/swarm-cross-provider-orchestration.md`.

## Executive summary

Saple Bridge is in unusually good shape for a project of this scope: the PTY pipeline, path containment, keychain hygiene, atomic write layer, and the swarm v1 recovery machinery are all genuinely well engineered. The plan below is therefore not a rescue plan - it is a leverage plan. It closes the known security and data-integrity deltas first (cheap, high value), then converts the app's strongest raw material (control-plane records, existing Rust commands, existing store patterns) into visible user features, and finally executes the already-designed Swarm v2 architecture, which is the single largest capability jump available.

Guiding priorities, in order:

1. Fix what is known-broken or known-risky (audit findings F1-F4, LOW-1/LOW-2, the review.rs lost-update window).
2. Remove performance and robustness debt that will hurt as projects grow.
3. Ship UX polish and quick wins that make the existing features feel finished.
4. Upgrade existing features where the building blocks already exist in-repo.
5. Add new features that reuse existing plumbing (highest feature value per line of code).
6. Execute Swarm v2 (provider adapters, worktrees, Rust scheduler) - the flagship phase.
7. Pay down testing and infra debt continuously, with a dedicated closing hardening pass.

Effort key: **S** = hours, **M** = 1-3 days, **L** = 1-2 weeks.

---

## Phase 1 - Security and data integrity (do first)

All items here are either unfixed findings from the 2026-07-14 security audit or concrete bug candidates found in this pass. They are small, well-understood, and reduce real risk.

| # | Item | Why | Files | Effort |
|---|------|-----|-------|--------|
| 1.1 | **Workspace-root allowlist for `project_path` (audit F1)** | Every Tauri command accepts an arbitrary `project_path`; containment only constrains the relative part. A renderer compromise gets arbitrary-root filesystem access plus the two RCE-capable commands. Maintain a managed `HashSet` of roots populated by `select_directory` / project open, checked inside `get_project_file_path`. Single highest-value hardening item in the repo. | `src-tauri/src/project.rs`, `src-tauri/src/lib.rs` | M |
| 1.2 | **Serialize `submit_review_decision` writes under the cross-process lock** | It does 4 sequential read-modify-writes of `tasks.json` / `sessions.json` outside `with_path_lock` while agent-spawned sidecars write the same files - a silent lost-update window. `control_plane.rs` already has the correct locked RMW pattern to reuse. This is the one concrete data-integrity bug found. | `src-tauri/src/review.rs` | S |
| 1.3 | **Reap the verification-command process tree on timeout (audit F4)** | `run_shell_with_timeout` kills only the shell; a spawned dev server survives the 90s kill. Extract `pty.rs::proc_tree::JobObject` into a shared module and attach it after spawn. | `src-tauri/src/review.rs`, `src-tauri/src/pty.rs` | S |
| 1.4 | **Cap agent-controlled outcome sizes (audit LOW-1)** | `parseAgentOutcome` type-checks but never bounds `summary` / `changedFiles` / `decisions`; a runaway agent writes multi-MB strings persisted to `artifacts.json` and re-rendered every poll. Slice summary to ~2KB, arrays to ~200 entries. | `src/lib/controlPlane.ts` | S |
| 1.5 | **Read `artifacts.json` once per poll tick (audit LOW-2)** | `SwarmWorkspace` calls `readRunOutcome` per session inside `Promise.all`; each call reads and parses the full file. Fetch once per tick, resolve all runs in memory. | `src/lib/controlPlane.ts`, `src/components/swarm/SwarmWorkspace.tsx` | S |
| 1.6 | **Scope the opener capability (audit F3)** | `capabilities/default.json` grants plain `opener:default`; the http/https/mailto scheme gate exists only in app code. Move the allowlist into the capability definition so a renderer bypass cannot open arbitrary schemes. | `src-tauri/capabilities/default.json` | S |
| 1.7 | **Rust-side scheme allowlist for `browser_navigate`** | It accepts any URL parseable by `Url` (including `file://` and custom protocol handlers); only the renderer gates input today. Mirror the opener policy: http/https only. | `src-tauri/src/browser.rs` | S |
| 1.8 | **Provenance marking for project-sourced verification presets (audit F2)** | Presets read from a project's `.saple/config.json` run verbatim shell. Keep the operator-initiated model, but visually distinguish "preset from this project's config" vs "preset you created" in the review UI so a cloned repo cannot socially engineer a dangerous command. | `src/components/review/ReviewWorkspace.tsx`, `src-tauri/src/project.rs` | S |
| 1.9 | **Bound the June control event log and results map** | Both grow for the whole process lifetime; a long session with a chatty June client leaks memory and makes `observe` an O(all-events) scan. Ring-buffer with a floor sequence (June already handles gaps), prune results by age/count. Also consider ACL-restricting the plaintext token discovery file, or document the same-user threat model in a comment. | `src-tauri/src/june_control.rs` | S |

**Exit criteria:** all F1-F4 and LOW-1/LOW-2 findings closed or formally accepted with a written rationale; `security-audit-report.md` statuses updated; a regression test for 1.2 (concurrent RMW) added.

---

## Phase 2 - Performance and robustness debt

Items that are fine today but degrade as projects, memory dirs, and swarm runs grow. Fix them before the features in later phases multiply the load.

| # | Item | Why | Files | Effort |
|---|------|-----|-------|--------|
| 2.1 | **In-memory index for memory notes** | `find_note_file_inner`, `search_memory_content`, `get_unlinked_mentions`, and every `save_memory_node` walk and re-parse every `.md` file - O(N files) per operation, and `add_memory_link` triggers a save that triggers another walk. A small id-to-path index invalidated by the existing watcher collapses this. | `src-tauri/src/memory.rs`, `src-tauri/src/watcher.rs` | M |
| 2.2 | **Atomic snapshot restore** | Restore does `remove_dir_all(memory_dir)` then copies; a crash mid-copy loses the live memory dir (the pre-restore backup is best-effort `let _ =`). Copy to a sibling temp dir and rename-swap. | `src-tauri/src/memory.rs` | S |
| 2.3 | **Swarm state versioning / CAS** | `write_swarm_state` is a blind full-state overwrite of renderer-held state; the crash-recovery machinery exists precisely to compensate. Add a `version` field checked in Rust (reject stale writes) as an interim step before the Phase 6 Rust scheduler makes this moot. | `src-tauri/src/swarm.rs`, `src/stores/swarmStore.ts` | M |
| 2.4 | **Stop reading untracked file contents in `git_status`** | For each untracked file the backend reads the entire file to count lines; repos with many untracked files make status slow. Count lazily in the diff view instead. | `src-tauri/src/git.rs` | S |
| 2.5 | **Per-tab draft content in the Files room** | One global `dirty` flag and only the active tab holds content; switching tabs with edits forces discard-or-lose. Hold per-tab draft content in a Map so tab switches keep unsaved edits. | `src/stores/fileStore.ts`, `src/components/editor/*` | M |
| 2.6 | **Memory autosave / dirty guard** | `saveNote` is manual and navigating notes discards edits silently; there is also a race where edits made during the save await are overwritten. Add a dirty flag plus confirm (pattern exists in `fileStore.openFile`) or debounced autosave, and merge rather than clobber `activeNoteContent` after save. | `src/stores/memoryStore.ts`, `src/components/memory/MemoryEditor.tsx` | S |
| 2.7 | **fileStore depth-8 prune ceiling** | A tab opened deeper than 8 directory levels can be silently dropped on layout restore (self-flagged ponytail comment). Union `openFiles` into the prune whitelist. | `src/stores/fileStore.ts` | S |
| 2.8 | **Deduplicate `now_iso()`** | Identical ~35-line hand-rolled calendar math lives in both `project.rs` and `memory.rs` - drift risk. Extract one shared helper. | `src-tauri/src/project.rs`, `src-tauri/src/memory.rs` | S |
| 2.9 | **Extend the file watcher beyond 3 tracked files** | External edits to memory notes, review records, and mailboxes never trigger reloads, so stale-snapshot overwrites remain possible for those stores. Generalize `TRACKED` and wire store reloads; this also becomes the substrate for Phase 6's coordinator loop (watching `plan.json` / verdicts instead of 5s polling). | `src-tauri/src/watcher.rs`, `src/App.tsx` | M |

**Exit criteria:** memory operations no longer O(N) per keystroke-adjacent action; no store can silently lose user edits on navigation; watcher covers memory, review, and mailbox files.

---

## Phase 3 - UX polish and quick wins

Small, user-visible fixes. Most are hours each; together they change how finished the app feels.

| # | Item | Why | Files | Effort |
|---|------|-----|-------|--------|
| 3.1 | **Unify error surfacing through toasts** | Many failure paths only `console.error` (Sidebar `handleAddWorkspace`, `MemoryWorkspace.handleOpenProject`, `KanbanBoard.handleOpenProject`, browser nav failures), and `projectStore.workspaceError` is set but never rendered. Route them through `notificationStore.error` so failures are visible. | `src/components/layout/Sidebar.tsx`, `src/components/memory/MemoryWorkspace.tsx`, `src/components/kanban/KanbanBoard.tsx`, `src/stores/browserStore.ts` | S |
| 3.2 | **Kanban undo on delete/move** | Deletes are irreversible; `notificationStore` already supports toast actions. Ship "Task deleted - Undo". | `src/stores/kanbanStore.ts` | S |
| 3.3 | **Fix the dead Sidebar chevron button** | "Workspace options" button renders and does nothing. Wire it or remove it. | `src/components/layout/Sidebar.tsx:327` | S |
| 3.4 | **Shortcut hygiene and parity** | Normalize key matching in `App.tsx` (the Ctrl+P / Ctrl+Shift+P branches are inconsistent about case), remove or implement the documented-but-missing Ctrl+O, add a `?` / Ctrl+/ binding to open the shortcuts dialog, and add a test asserting `ShortcutsHelpDialog` parity with actual App.tsx bindings (it has already drifted once). | `src/App.tsx`, `src/components/common/ShortcutsHelpDialog.tsx` | S |
| 3.5 | **Per-room shortcut groups in the help dialog** | The dialog documents only Global and Terminals; Kanban, Memory, Review, and the Alt+1-9 room list are undocumented. Per saved memory: document in the help dialog, do not add new nav UI. | `src/components/common/ShortcutsHelpDialog.tsx` | S |
| 3.6 | **Single source of truth for providers and colors** | Sidebar hand-copies 7 of 11 providers (gemini/openrouter/cursor/copilot cannot be picked from the sidebar) and duplicates COLOR_PRESETS with different entries than terminalStore. Derive both from the canonical store definitions. | `src/components/layout/Sidebar.tsx`, `src/stores/providerStore.ts`, `src/stores/terminalStore.ts` | S |
| 3.7 | **Per-workspace Kanban filters** | Filters persist in a single global localStorage key, so filters from project A leak into project B - unlike every other layout store, which is per-path. | `src/stores/kanbanStore.ts` | S |
| 3.8 | **Accessibility pass** | Toast container is `aria-live="assertive"` for all toasts (success spam interrupts screen readers - use polite for non-errors); context-menu items lack arrow-key navigation; color-only workspace status dots need a text equivalent. | `src/components/common/ToastHost.tsx`, `src/components/layout/Sidebar.tsx` | S |
| 3.9 | **Consistent empty states** | Memory and Kanban have designed empty states; Files with no selection, Review with no review tasks, and a blank browser tab are bare. Bring them to the same standard. | `src/components/editor/CodeViewer.tsx`, `src/components/review/ReviewWorkspace.tsx`, `src/components/browser/BrowserPanel.tsx` | S |
| 3.10 | **Configurable WIP limits** | Limits are fixed and display-only (self-flagged). Move into `WorkspaceConfig` with an optional block-on-exceed. | `src/stores/kanbanStore.ts`, `src/stores/projectStore.ts` | S |
| 3.11 | **Browser nav error state** | Failed navigation only logs to console; show an inline error state on the tab. | `src/stores/browserStore.ts`, `src/components/browser/BrowserPanel.tsx` | S |

**Exit criteria:** no silent failure paths in the main user flows; shortcuts dialog is complete and test-pinned; no duplicated provider/color definitions.

---

## Phase 4 - Existing-feature upgrades

Each item reuses infrastructure that already ships in the app, so value per effort is high.

| # | Item | Why | Files | Effort |
|---|------|-----|-------|--------|
| 4.1 | **Memory editor on CodeMirror** | Memory notes edit in a raw textarea while the Files room already ships CodeMirror with `@codemirror/lang-markdown` installed. Reuse it: syntax highlight, real undo history, and wikilink autocomplete hooked into the existing suggestion engine. | `src/components/memory/MemoryEditor.tsx`, `src/components/editor/CodeMirrorEditor.tsx` | M |
| 4.2 | **Command palette: open file by name + jump to memory note** | The palette already has modal modes and warms the memory graph; the file list already lives in `fileStore.files`. Add a fuzzy file mode - the app's six siloed searches start converging here. | `src/components/common/CommandPalette.tsx`, `src/stores/fileStore.ts` | M |
| 4.3 | **Browser tabs: titles, favicons, and keyboard** | Tabs show hostname only; Rust already pushes nav events and can push document titles too. Add Ctrl+L (focus address), Ctrl+T (new tab), Ctrl+W (close tab), close-others/duplicate in the tab context menu. | `src/stores/browserStore.ts`, `src/components/browser/BrowserPanel.tsx`, `src-tauri/src/browser.rs` | M |
| 4.4 | **Terminal broadcast input** | There is no "type into N terminals at once", which is the common way to drive several agent CLIs. terminalStore already owns all pane ids; add a broadcast toggle. | `src/stores/terminalStore.ts`, `src/components/terminal/TerminalPane.tsx` | M |
| 4.5 | **Session log viewer + terminal transcript export** | `agentSessionStore` already allocates `.saple/agents/logs/*.ansi` per run but no UI reads it; post-mortem of an agent run currently dies with the pane. Ship "open session log" in SessionsTab and "export buffer" in the terminal context menu. | `src/components/settings/SessionsTab.tsx`, `src/components/terminal/TerminalContextMenu.tsx` | M |
| 4.6 | **Review room: word-level diff** | Split view exists but no intraline highlighting; word-diff alone materially improves reviewability. (Per-hunk staging is deliberately deferred to 5.8 - it needs new Rust commands.) | `src/lib/diffSplit.ts`, `src/components/review/SplitDiffViewer.tsx` | M |
| 4.7 | **Workspace-scoped env vars / launch profiles** | `spawn_pty` already accepts an `env` param that is always empty. Add per-workspace env presets (PORT, API_BASE) in workspace settings; SSH presets already establish the exact pattern. | `src/stores/terminalStore.ts`, `src/components/project/settings/WorkspaceTab.tsx` | M |
| 4.8 | **Task templates / reusable agent presets** | `Task.template` and `agentConfig` fields already exist in the type with no picker UI. Save a task (prompt, provider, model, acceptance criteria) as a reusable preset, mirroring `swarmStore.saveTemplatePreset`. | `src/components/kanban/TaskDialog.tsx`, `src/stores/kanbanStore.ts` | M |

**Exit criteria:** memory editing feels equal to file editing; palette answers "open X" for files and notes; browser and terminals gain their expected keyboard idioms.

---

## Phase 5 - New features

Ordered by value-per-effort. Each names its integration points; none requires new architecture.

| # | Item | Description | Integration | Effort |
|---|------|-------------|-------------|--------|
| 5.1 | **Global cross-room search** | One palette-driven search over tasks, memory notes, file names, file contents, terminal names, and sessions. Users think in "find X", not "which room's search". | `CommandPalette.tsx` + existing stores + `search_in_files` / `search_memory_content` commands | M |
| 5.2 | **Git "Changes" surface outside Review** | Review is task-gated; users commit constantly, not only at agent-review time. A lightweight changes view with stage/commit reuses `git_status`, `git_stage_file`, `git_commit` verbatim. | `src/stores/reviewStore.ts` commands, `StatusBar.tsx` | M |
| 5.3 | **Local model support (Ollama / LM Studio)** | `models.rs` already abstracts auth and endpoints, and the CSP already allows localhost connects. Add the no-key `http://localhost:11434/api/tags` path and an `ollama` provider entry. Cheap, differentiating for a local-first app. | `src-tauri/src/models.rs`, `src/stores/providerStore.ts` | S |
| 5.4 | **Memory quick capture / daily notes** | Global shortcut appends a timestamped entry to an inbox note with backlink autocomplete; the palette compose flow already has a memory target to extend. Capture friction is the main reason knowledge bases die. | `CommandPalette.tsx`, `save_memory_node` | S |
| 5.5 | **Swarm run history / timeline** | Control plane already records runs, artifacts, durations, and outcomes; the UI shows only the live swarm. A per-swarm timeline (who ran, how long, outcome summaries, rework count) answers "what happened last night". | `SwarmWorkspace.tsx` new tab, `agentSessionStore`, `controlPlane.readRunOutcome` | M |
| 5.6 | **"Send page to agent" from the browser** | Post the current tab URL (plus optional selection) to an agent mailbox or task; the attach pattern already shipped in PreviewPanel. Closes the "look at this docs page / bug repro" loop. | `BrowserPanel.tsx`, `swarmStore.postToMailbox`, `kanbanStore.updateTask` | S |
| 5.7 | **Diff-aware review notifications** | When a task hits review, toast "agent touched N files" with a jump-to-review action; the data is already returned by `create_review_record`. | `terminalStore.ts` review-signal path, `notificationStore` | S |
| 5.8 | **Per-hunk staging in Review** | Whole-file staging today; hunk-level apply needs new Rust commands (`git apply --cached` on generated patches). Builds on 4.6's diff work. | `src-tauri/src/git.rs`, `SplitDiffViewer.tsx` | L |
| 5.9 | **Git history and blame in Review** | "What did this agent's run actually commit" is unanswerable; `git log` / `show` / `blame -p` via the existing argv-exec timeout pattern. | `src-tauri/src/git.rs`, `src/components/review/*` | M |
| 5.10 | **Process supervision panel** | Rust already owns Job Objects and PTY lifecycles; expose per-session pid, memory, and child tree so users can see which agent CLIs are alive and how much RAM they hold. | `src-tauri/src/pty.rs` registry + process enumeration | M |
| 5.11 | **Split editor panes** | Side-by-side files in the editor room; the CodeMirror instance is isolated and the resizable-pane layout store pattern exists. Depends on 2.5 (per-tab drafts). | `src/components/editor/*`, `workspacePaneLayoutStore` | L |

**Exit criteria:** global search shipped; git usable for daily commits without entering Review; at least one local-model provider works end to end.

---

## Phase 6 - Swarm v2 (flagship)

This executes the already-written design in `docs/swarm-cross-provider-orchestration.md` and `swarm-redesign.md`. It is the largest capability jump available and is sequenced last among feature work because every sub-phase builds on the previous one. The interim hardening from Phases 1-2 (state CAS, watcher extension, outcome caps) feeds directly into it.

| # | Item | Description | Integration | Effort |
|---|------|-------------|-------------|--------|
| 6.1 | **Provider adapter layer (`providers.rs`)** | Per-provider `headless_cmd` / `resume_cmd` / `parse_result`, replacing marker-scraping with parsed JSON envelopes (`claude -p --output-format stream-json`, `codex exec --json`, `droid exec -o json`) and pinned permission postures. The highest-leverage backend work in the repo. | Replaces ad-hoc branches in `pty.rs`; new `agent-result` event consumed by `swarmStore` | L |
| 6.2 | **Resumable agent sessions (`agent_send_turn`)** | Run the adapter's resume invocation as a new attempt into the same pane, turning rework and mailbox messages into actually-delivered turns instead of dead drops. | `pty.rs`, `swarmStore.sendTurnToAgent` | M |
| 6.3 | **Git worktree isolation per agent** | `worktree_create/list/remove/merge_preview` commands so parallel builders stop editing one shared tree - the root cause of most swarm conflicts, and the pattern every comparable product uses. Review diffs become scoped to the worktree branch. | `git.rs`, swarm launch pipeline, review scoping | L |
| 6.4 | **MCP message bus in the sidecar** | `send_message` / `fetch_inbox` tools in saple-mcp make the dead-drop mailbox files a live channel with zero per-provider integration, since every agent CLI already talks to the sidecar over stdio. | `../saple-mcp/src/tools/`, Bridge reads the same files | M |
| 6.5 | **Rust-side swarm scheduler** | Move the DAG scan and completion state machine out of the renderer (today it dies with the window; the P13 replay machinery exists only to compensate). Consumes `pty-exit` / `agent-result`; the renderer becomes a view. Supersedes 2.3's interim CAS. | New `src-tauri/src/engine.rs`, `control_plane.rs` records as substrate | L |

**Exit criteria:** a swarm survives an app restart mid-run; rework turns are delivered as real resumed sessions; two builders can run in parallel without touching each other's tree.

**Sequencing inside the phase:** 6.1 -> 6.2 -> 6.3 in strict order; 6.4 can run in parallel with any of them; 6.5 last.

---

## Phase 7 - Quality, testing, and infrastructure

Runs partly in parallel with everything above (each phase should land tests with its code); the items here are the dedicated debt-payoff pass.

### Frontend testing

| # | Item | Detail | Effort |
|---|------|--------|--------|
| 7.1 | **Component test harness** | Add `@testing-library/react` + jsdom. The entire 14k+ line component tree is untested. First targets, in value order: CommandPalette mode machine, ReviewWorkspace approve/reject/rework flow, TaskDialog validation, KanbanBoard drag/reorder. | M |
| 7.2 | **Untested stores** | `reviewStore` (decision/staging/diff-cache logic - the biggest gap), `providerStore` (readiness merge, currency token), `themeStore`, `sshPresetStore`, layout stores. | M |
| 7.3 | **Untested security-relevant libs** | `juneDispatcher.ts` (external control surface), `highlighter.ts`, `taskAgentPrompt.ts`, `useFocusTrap.ts`. | S |
| 7.4 | **Pin documented invariants with tests** | The race-condition invariants documented in prose (swarmStore commit-by-id vs snapshot overwrite, P13 pending-exit replay, kanban `pendingTaskReviews` consume) get regression tests; shortcuts-dialog parity test from 3.4. | M |

### Rust testing

| # | Item | Detail | Effort |
|---|------|--------|--------|
| 7.5 | **PTY lifecycle integration test** | A gated `#[ignore]`d test spawning `cmd /c echo` asserting kill/join/no-orphan covers the highest-risk code in the crate (Job Object path, duplicate-id race, write-after-close, reader retry). | M |
| 7.6 | **fs_lock concurrency tests** | Multi-thread contention on `atomic_write`; stale-sentinel stealing and timeout-proceed behavior of `with_cross_process_lock`. | S |
| 7.7 | **Zero-test modules** | `browser.rs` (URL validation, label handling) and `diagnostics.rs` (throwaway keychain slot, CLI detection parsing) are testable without a webview. | S |
| 7.8 | **Snapshot create/restore tests** | Including the destructive-window behavior fixed in 2.2. | S |
| 7.9 | **review.rs timeout/kill path + june_control auth/bad-JSON branches** | The sidecar's tests show the pattern: drive server logic without binding a port. | S |

### Build / release / infra

| # | Item | Detail | Effort |
|---|------|--------|--------|
| 7.10 | **CI gate** | Required jobs: `npm run typecheck`, `npm test`, `cargo test` before any tag-driven release. | S |
| 7.11 | **Sidecar version stamping** | Nothing records which `../saple-mcp` commit shipped in which Bridge version; stamp the sidecar git hash into a manifest for support/debugging. | S |
| 7.12 | **Sidecar staging freshness by hash** | The size+mtime check (self-flagged) misses a rebuilt sidecar with identical size and older mtime; hash comparison is the named upgrade path. | S |
| 7.13 | **Robust version bumping** | The Cargo.toml bump regexes the first `version =` line (fragile); anchor it or use `cargo set-version`, and refresh `Cargo.lock` after the bump so builds stop leaving it dirty. | S |
| 7.14 | **Deduplicate MCP config healing** | `.mcp.json` and `mcp_config.json` are written/healed in duplicate blocks; extract the shared merge helper. | S |

**Exit criteria:** CI blocks releases on typecheck + both test suites; every module with a known race or destructive path has a pinning test.

---

## Suggested ordering and milestones

```
Milestone A  (Phases 1 + 2)          "Hardened"        ~1-2 weeks
Milestone B  (Phase 3 + Phase 4)     "Polished"        ~2-3 weeks
Milestone C  (Phase 5, items 5.1-5.7) "Feature wave"   ~2-3 weeks
Milestone D  (Phase 6)               "Swarm v2"        ~4-6 weeks
Milestone E  (Phase 7 close-out + 5.8-5.11) "Solid"    ~2 weeks
```

Testing (Phase 7) is not a trailing phase in practice: every item in Phases 1-6 lands with its own tests; Milestone E is the dedicated pass for pre-existing debt.

Notes on scope discipline:

- Do not re-implement what `swarm-redesign.md` already designs - Phase 6 executes that design rather than inventing a parallel one.
- Preview screenshot capture stays a known follow-up (flagged in `PreviewPanel.tsx`); it is deliberately not scheduled here.
- Per the project's UI philosophy, no new navigation entries: new surfaces (Changes view, run timeline, supervision panel) attach to existing rooms, the StatusBar, or the palette.
