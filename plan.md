# Saple Bridge — Remediation & Completion Plan

## Context

A full integrity audit of `saple-bridge/` confirmed the app is structurally sound: it
typechecks (`tsc --noEmit` → 0), compiles (`cargo check` → 0), and every `invoke()` maps to a
registered Tauri command with matching arg names and serialized type shapes. No architectural
breakage exists.

However the audit surfaced **16 findings** in four classes: (a) edge-case correctness bugs that
cause silently wrong behavior, (b) credential/label UI disconnects, (c) half-built features
(swarm handoffs, mailbox-write, unwired providers, inert buttons), and (d) defense-in-depth gaps.
This plan fixes all of them and completes the half-built features, so the app's surface matches
what actually works. Phases are ordered by risk: correctness first, then UX, then feature
completion, then hardening and cleanup.

---

## Phase 1 — Critical correctness bugs (silently wrong behavior) — ✅ DONE

> Completed 2026-06-26. Commits: `bbde96e` (1.1), `1b76c92` (1.2), `3fa06df` (1.3),
> `83bf8a3` (1.4). Verified: `npm run typecheck` exit 0; `cargo test` 3/3 new git tests pass.
> Note on 1.2: on this machine `git status --porcelain` v1 actually emits the rename as
> `R  old -> new` (` -> `, not tab) — the existing parser already handled that case. The fix
> still lands as planned: a `parse_rename_dest` helper treats ` -> ` as primary with a `\t`
> fallback for robustness, plus unit tests.

**1.1 Unify the approve/reject path.** ✅ `src/components/kanban/TaskDetailDrawer.tsx:72-111` flips
the task column + session status directly and never records the decision, leaving
`.saple/review/<taskId>.json` stuck at `"pending"`. Refactor both drawer buttons to call the same
flow ReviewWorkspace uses: `useReviewStore.submitDecision(...)` (`src/stores/reviewStore.ts:122`)
which invokes `submit_review_decision` and atomically updates record + task + session, then
`loadTasks(force)`. Remove the duplicated TS-side mutation. Also replace the ad-hoc
`Math.random().toString(36)` session id at `TaskDetailDrawer.tsx:133` with `createId('agent')`
(`src/lib/id.ts`) for consistency with `TaskCard.tsx:43`.

**1.2 Fix staged-rename diff parsing.** ✅ `src-tauri/src/git.rs:83-91` parses renames with
`find(" -> ")`, but `git status --porcelain` v1 emits `R  old\tnew` (tab-separated). Parse the
porcelain rename format: split the XY-status path field on `\t` and take the destination path.
Keep the ` -> ` fallback for safety. Add a unit test in `git.rs` covering a staged-rename
porcelain line so the downstream `git_diff_file` call receives a clean path.

**1.3 Clear editor content on new note.** ✅ Creating a blank note via `MemoryGraph.tsx:364-373` →
`memoryStore.ts` `setActiveNote({ id: '', ... })` does not reset `activeNoteContent`, so the
editor pre-fills with the previously open note's body. Update `setActiveNote` in
`src/stores/memoryStore.ts` to reset `activeNoteContent` to `''` when the incoming node has no
`filePath`/`id` (new-note case), or have `handleCreateNewNote` call a dedicated
`startNewNote()` action that clears both `activeNote` and `activeNoteContent`.

**1.4 Force swarm state re-read on project open.** ✅ `src/stores/swarmStore.ts:319`
`loadSwarmState` short-circuits on `loadedProjectPath`, which is rehydrated from `localStorage`
(zustand `persist`), so reopening a project skips reading `.saple/swarm/state.json` and discards
external/MCP changes. Add a `force?: boolean` param mirroring `kanbanStore.loadTasks`
(`src/stores/kanbanStore.ts:61`), and call `loadSwarmState(path, true)` from the project-open
flow in `src/stores/projectStore.ts` (the same place Kanban/Memory are loaded).
(Implemented: the project-open flow that loads Kanban/Swarm is actually the effect in
`src/App.tsx:75-76`, not `projectStore.ts`; the `force=true` call was added there.)

---

## Phase 2 — Credential & diagnostics UI disconnects — ✅ DONE

> Completed 2026-06-26. Commits: `04278e1` (2.1 + 2.2), `ae39388` (2.3), `c6c84d7` (2.4).
> Verified: `npm run typecheck` exit 0; `npm run build` OK; `cargo test` 25/25 pass (+2 new
> wikilink tests). Notes: the Keychain tab was kept (not folded) and re-pointed at the shared
> `saple_provider_codex_api_key` slot, with `refreshReadiness()` on save/delete so the Codex
> card's badge updates. For 2.2, recommendation (a) was taken — a single "OS Keychain Backend"
> row replaces the per-provider rows (frontend-only; the Rust `keychains` array is unchanged and
> read at `[0]`). For 2.3, edge extraction was factored into a reusable `extract_wikilinks`
> helper that also strips `|label` from targets, matching `remarkWikilinks.ts`.

**2.1 Unify the OpenAI/Codex key slot.** ✅ `src/components/project/ProjectSettings.tsx:171-209`
(Keychain tab) reads/writes service `'openai_api_key'`, while the Codex provider card (line 225)
uses `saple_provider_codex_api_key`. Pick the `saple_provider_<provider>_api_key` convention
(matches `keychain.rs` + CLAUDE.md spec) everywhere and route the Keychain tab through the same
`providerStore` helpers the provider cards use, so a saved key reflects in both places. If the
generic "Keychain" tab is redundant after this, fold it into the provider section.

**2.2 Correct the diagnostics keychain labels.** ✅ The per-provider "X Keychain — Ready" rows
(`ProjectSettings.tsx:988-997`) all render the single backend-probe result from
`diagnostics.rs:131-139`, implying per-provider key presence. Either (a) relabel to "Keychain
backend: Ready/Error" shown once, or (b) populate real per-provider presence using
`has_api_key(saple_provider_<p>_api_key)` per provider. Recommended: (a) for the backend probe
plus reuse the existing provider cards' "Key saved" badge for per-provider presence.

**2.3 Resolve wikilinks via aliases + skip code in edge extraction.** ✅ Two divergences:
- Preview `resolveTarget` (`src/components/memory/markdown/MemoryMarkdown.tsx:26-31`) resolves by
  id/title only. Extend it to also match `node.aliases` (the Rust graph already does at
  `memory.rs:342-344`), so `[[alias]]` renders as a resolved link.
- Rust graph-edge extraction (`memory.rs:276-287`) does a raw `[[` scan that includes fenced/inline
  code. Make it skip code spans/fences (mirror the AST approach of
  `src/components/memory/markdown/remarkWikilinks.ts:63-76`) so code samples don't create spurious
  edges. Add a unit test with a `[[x]]` inside a fenced block asserting no edge.

**2.4 Fix hardcoded memory path display.** ✅ `src/components/memory/MemoryEditor.tsx:333` hardcodes
`.saple/memory/`. Derive the prefix from the workspace `memoryMode` (`bridge-compatible` →
`.bridgememory/`) available on `WorkspaceConfig` in `projectStore`. Display-only change.

---

## Phase 3 — Complete the half-built features — ✅ DONE

> Completed 2026-06-26. Verified: `npm run typecheck` exit 0; `npm run build` OK;
> `cargo check` OK; `cargo test` 25/25 pass. Notes:
> - The working tree already carried an in-flight `bridgecode → openrouter` provider rename
>   (the prerequisite 3.3 assumes — "openrouter has full Rust command-building + keychain
>   support"), a diagnostics provider-CLI/sign-in probe refactor, and a version bump. Per
>   decision these were committed together with the Phase-3 feature work.
> - 3.1: handoff read/write actions added to `swarmStore`; `SwarmWorkspace` polls handoff
>   pairs (derived from the dependency graph's edges) on the *same* timer/ref as the mailbox
>   poll; `SwarmAgentCard` renders each resolved handoff JSON via `MarkdownPreview` (wrapped in
>   a fenced ```json block), split by in/out direction.
> - 3.2: `writeMailbox` action + an operator compose box in the inspect panel that appends an
>   "Operator message" beneath existing mailbox content (never clobbers the agent's own writes).
> - 3.3: `gemini`, `openrouter`, `cursor`, `copilot` added to `AI_PROVIDERS`; `openrouter`
>   given an explicit arm in the `pty.rs` provider-cleaning match.
> - 3.4: restored `selectedProvider` state + a provider `<select>` in the empty-state "New
>   Pane"; `TerminalPane`'s branch button now passes `sessionInfo?.model` (was `undefined`).
> - 3.5: "SHOW LESS" now toggles an expand/collapse of the provider picker (shows "SHOW MORE
>   (N)" when collapsed); "+ ADD CUSTOM COMMAND" launches a custom-command pane via
>   `addPane(..., customCommand)`, disabled until a command is typed.

**3.1 Swarm handoffs (read + write UI).** ✅ `read_handoff_file` / `write_handoff_file`
(`src-tauri/src/swarm.rs`, registered `lib.rs:89-90`) are never called from the frontend, yet
agent prompts instruct agents to write handoffs. Wire end-to-end:
- Add `readHandoff`/`writeHandoff` actions to `src/stores/swarmStore.ts` invoking the commands.
- Surface handoff content in `src/components/swarm/SwarmWorkspace.tsx` / `SwarmAgentCard.tsx`
  (poll alongside the existing mailbox polling at `SwarmWorkspace.tsx:93-148`, reusing that
  interval/ref pattern rather than adding a second timer).
- Render handoff markdown with the existing `MemoryMarkdown`/markdown viewer component.

**3.2 Mailbox writing from the UI.** ✅ `write_mailbox_file` (`lib.rs:88`) is registered but the UI
only reads. Add a `writeMailbox` action to `swarmStore.ts` and a compose/send affordance in
`SwarmWorkspace.tsx` so the operator can post a message into an agent's mailbox (agents already
read their mailbox via their own FS tools). Keep writes path-contained via the existing command.

**3.3 Wire the missing terminal providers.** ✅ `gemini`, `openrouter`, `cursor`, `copilot` have
full Rust command-building + keychain support but are absent from the wizard list
(`src/components/terminal/TerminalGrid.tsx:18-25`). Add them to `AI_PROVIDERS` with correct
metadata (reuse `src/components/swarm/wizard/providerMeta.ts` if it already encodes provider
display/info). Also make `openrouter` an explicit arm in the Rust provider-cleaning match
(`pty.rs:312-323`) for parity with the other providers rather than falling through `_`.

**3.4 Fix terminal pane provider/model regressions.** ✅
- `TerminalGrid.tsx:92` `selectedProvider` is frozen at `'codex'`; restore a working selector
  (state + setter) so the empty-state "+ New Pane" honors the chosen provider.
- Titlebar branch button `TerminalPane.tsx:838` passes `model: undefined` to `addPane`, dropping
  the parent's model. Pass `sessionInfo?.model` so it matches `splitPane`'s inheritance
  (`terminalStore.ts:556`).

**3.5 Wire the inert buttons.** ✅ `TerminalGrid.tsx:524` ("SHOW LESS") and `:549` ("+ ADD CUSTOM
COMMAND") render without handlers. Implement "SHOW LESS" to collapse the expanded provider list
(inverse of the existing expand state) and "+ ADD CUSTOM COMMAND" to open the custom-command
launch path that already exists in `terminalStore.addPane(..., customCommand)`.

---

## Phase 4 — Security & defense-in-depth hardening — ✅ DONE

> Completed 2026-06-26. Commit: `008427e`. Verified: `npm run typecheck` exit 0;
> `npm run build` OK; `cargo test` 27/27 pass (+2 new memory-traversal tests). Notes:
> - 4.2: containment is checked against each `dir.canonicalize()` per write-dir (memory mode can
>   resolve to multiple dirs), not a single base, so the check holds in `both`/`bridge-compatible`
>   modes too.
> - 4.4: implemented part (a) — trust-boundary doc comments on `run_verification_command_inner`
>   (`review.rs`) and `handleRunVerification` (`ReviewWorkspace.tsx`). Part (b) (opt-in
>   confirmation) was deferred as a "consider"; the command stays operator-initiated and is shown
>   in the editable input before running.

**4.1 Validate snapshot restore name.** ✅ `src-tauri/src/memory.rs` `restore_memory_snapshot_inner`
accepted `name` raw. Applied the same `[a-zA-Z0-9\-_]` validation used by
`create_memory_snapshot_inner` before building the path.

**4.2 Contain memory file ops to the memory dir.** ✅ `delete_memory_file_inner` /
`read_memory_file_inner` canonicalize-checked against the **project root**,
allowing a crafted `filePath` to touch any project file. Changed the canonical base to the resolved
memory dir (per write-dir `canonicalize()`). Added traversal unit tests mirroring the existing
`project.rs` containment tests.

**4.3 Atomic writes for config/user files.** ✅ Routed `install_mcp_config_inner`'s four writes
and `write_text_file_inner` (`files.rs`) through the existing
`crate::fs_lock::atomic_write` (`src-tauri/src/fs_lock.rs:36`) to avoid torn reads during
concurrent access, matching how tasks/config are already written.

**4.4 Constrain / acknowledge verification commands.** ✅ `run_verification_command`
(`review.rs`) is unconstrained shell execution by design. Kept the capability and (a) documented
the trust boundary in `review.rs` and the review UI. (b) opt-in confirmation deferred as a
"consider". No allowlist (would break the dev-tool use case); this is a documented, contained risk.

**4.5 Path-validate `check_mcp_status`.** ✅ `check_mcp_status_inner` built the path with bare
`Path::new(&project_path).join(...)`. Routed through `get_project_file_path` for consistency with
the rest of the module (read-only, low impact, consistency fix).

---

## Phase 5 — Dead code & consistency cleanup — ✅ DONE

> Completed 2026-06-26. Verified: `npm run typecheck` exit 0; `cargo check` clean (no warnings);
> `cargo test` 27/27 pass. Notes:
> - `git_diff_summary` had no caller after Phase 1, so beyond dropping the Tauri wrapper its
>   now-orphaned `git_diff_summary_inner` helper **and** the `GitDiffSummary` struct were also
>   removed (review.rs only uses `git_status_inner`, which is kept). `git_status` likewise: only
>   the wrapper was removed; `git_status_inner` stays.
> - The `McpStatus`/`McpConfigStatus` distinction was documented (doc comments cross-referencing
>   each other) rather than renamed — they live in different modules and `McpStatus` carries an
>   extra `other_servers` field for the Settings UI, so they are genuinely distinct types.

- **Remove orphaned `src/types/review.ts`** — ✅ superseded by the inline type in `reviewStore.ts`,
  imported nowhere, and had a field-name mismatch (`decision` vs `status`) that would mislead future
  edits.
- **Remove unused command wrappers** — ✅ `get_app_binary_path` (`lib.rs`) and the standalone
  `git_status` / `git_diff_summary` Tauri wrappers were dropped from the `invoke_handler` list and
  deleted (no frontend caller). `git_status_inner` is kept (review uses it internally);
  `git_diff_summary_inner` + `GitDiffSummary` were removed as genuinely dead.
- **Reconcile `McpStatus` vs `McpConfigStatus`** (`project.rs` / `diagnostics.rs`) — ✅ documented
  the distinction with cross-referencing doc comments.

---

## Phase 6 — Verification — ✅ DONE

> Completed 2026-06-26. Full automated verification re-run at the end of the plan, all green:
> - `npm run typecheck` → exit 0
> - `npm run build` (tsc + vite) → built in 3.58s, no errors
> - `cargo check --manifest-path src-tauri/Cargo.toml` → finished clean (no warnings)
> - `cd src-tauri; cargo test` → **27 passed; 0 failed** (incl. git-rename, wikilink/code-skip,
>   snapshot-name, and memory-traversal containment tests added across Phases 1–4)
>
> The end-to-end manual checks below require an interactive desktop session (`npm run tauri dev`)
> and remain operator-driven — they are not runnable headless from CI/agent. Listed here as the
> smoke matrix for a human pass before release.

Run after each phase and again at the end:

```powershell
# Frontend
npm run typecheck            # must stay exit 0
npm run build                # tsc + vite

# Rust
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri; cargo test     # exercises new git-rename, wikilink, snapshot, containment tests
```

End-to-end manual checks (per the README smoke matrix):
- **Review:** approve a task from `TaskDetailDrawer`; confirm `.saple/review/<id>.json` flips to
  `approved` and the card moves columns (Phase 1.1). Stage a file rename; confirm its diff loads
  (Phase 1.2).
- **Memory:** create a new note from the graph and confirm the editor is empty (1.3). Add an alias,
  reference it as `[[alias]]`, confirm it resolves in preview (2.3). Put `[[x]]` in a fenced code
  block, confirm no graph edge appears (2.3).
- **Swarm:** open a project with existing `.saple/swarm/state.json` from a fresh app start; confirm
  disk state loads, not stale localStorage (1.4). Trigger a handoff/mailbox write from an agent and
  confirm it surfaces in the UI (3.1, 3.2).
- **Keychain:** save an OpenAI/Codex key; confirm it shows saved in both the Keychain tab and the
  Codex card (2.1).
- **Diagnostics:** run diagnostics; confirm keychain label reads as backend status, and provider
  CLI/signin reflect reality (2.2).
- **Terminals:** launch each newly wired provider from the wizard; confirm correct command + model
  inheritance on branch (3.3, 3.4); confirm SHOW LESS / ADD CUSTOM COMMAND work (3.5).
- **MCP:** re-run "Test MCP tools" in settings; confirm 18 tools still list and the server still
  starts via `["mcp", <path>]` after the atomic-write change (4.3).

## Suggested commits (conventional, focused)

`fix:` per Phase-1 item · `fix:` per Phase-2 item · `feat:` for 3.1–3.5 · `fix:`/`refactor:` for
Phase 4 · `chore:`/`refactor:` for Phase 5. Verify locally before pushing per CLAUDE.md.
