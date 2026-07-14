# SAPLE Bridge Improvement Plan 1

> A minimal, implementation-ready roadmap derived from the CNVS comparison. Ordered by leverage, not novelty.

## Objective

Make SAPLE Bridge's existing agent-control infrastructure feel immediate and coherent while preserving its local-first storage, explicit review, and safety boundaries.

The plan deliberately avoids an infinite canvas, a new memory engine, and a general workflow framework. SAPLE already has the primitives it needs.

## Guiding constraints

- Reuse the existing stores, PTY layer, `.saple/` files, Swarm scheduler, Command Palette, Review room, and Saple MCP sidecar.
- Do not add a second source of truth for agents, runs, tasks, or artifacts.
- Keep API keys in the OS keychain.
- Keep project-path validation in Rust.
- Preserve bounded concurrency and human review defaults.
- Add one runnable check for each non-trivial behavior.
- Prefer a prompt/tool contract over a new service.

---

## Priority 0 — Connect the existing control plane

> **Status: Done.** Bridge writes the canonical `agents.json` / `runs.json` / `artifacts.json`
> directly through a whitelisted, cross-process-locked Rust command (`control_plane.rs`
> `canonical_record_write`); `sessions.json` gained `agentId`/`runId` cross-references.
> `createSession` registers one agent + one run per launch (`src/lib/controlPlane.ts`),
> `completeSession` finishes the run and writes outcome artifacts, and swarm terminal/review
> transitions route through it. `review.rs` reads completion evidence from the canonical artifact
> store via the session's `runId` and records the decision back onto the run. Both crates' `fs_lock`
> gained a shared sentinel-file OS advisory lock so concurrent Bridge/sidecar read-modify-write
> cycles can't lose updates. Covered by a Rust cross-process lock test, a Rust launch→completion→
> review integration test, and frontend control-plane tests.

### Problem

Bridge sessions, Swarm state, and Saple MCP's agents/runs/artifacts are only partially connected. `AgentSession.artifacts` exists, and Review looks for test artifacts, but Bridge initializes sessions with an empty list and does not complete the lifecycle.

### Implement

Create one integration path for these events:

```text
Bridge launch       → register agent + create run
Status transition   → update agent + append run event
Agent completion    → create artifacts + finish run
Review decision     → record final run/review outcome
```

Do not create a new event bus. Route the events through the existing session and status transition functions.

### Canonical store decision

Two agent/artifact stores already exist and this priority must not leave both authoritative:

- Bridge: `.saple/agents/sessions.json` (embedded `artifacts` array, read by `review.rs` today)
- Saple MCP: `.saple/agents.json`, `.saple/runs.json`, `.saple/artifacts.json` (+ blob bodies under `.saple/artifacts/`)

Decision: the Saple MCP files (`agents.json`, `runs.json`, `artifacts.json`) are canonical for the control plane. `sessions.json` remains Bridge's runtime/PTY state only and gains `agentId` and `runId` cross-reference fields. Bridge is not an MCP client; it writes the canonical files directly through its Rust layer. `review.rs` switches to reading artifacts from the canonical store via the session's `runId`.

Cross-process locking caveat: both crates' `fs_lock` implementations are process-local by their own documentation ("Cross-process serialization is impossible here"). Temp-file-and-rename prevents torn reads but not lost updates: Bridge and one or more sidecar processes (each agent CLI spawns its own `saple-mcp` stdio server) can interleave read-modify-write cycles on the same collection file and silently drop a record. This race already exists today between two concurrent agents; P0 widens the writer set, so P0 must include an OS-level advisory file lock (Windows `LockFileEx`, Unix `flock`, via a shared lock-sentinel convention) held across the whole read-modify-write cycle in both crates for the canonical collection files. The long-term fix is the single mutation owner described in `all-other-files/agent-orchestration-architecture.md`; the OS lock is the bridge until that engine exists.

### Likely touchpoints

- `src/stores/agentSessionStore.ts`
- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- `src/types/agent.ts`
- `src-tauri/src/review.rs`
- `../saple-mcp` agent, run, artifact, and context tools

### Acceptance criteria

- Launching a Kanban or Swarm agent creates one agent record and one run record.
- Status changes update the same records rather than creating duplicates.
- Completion stores a summary and test result when supplied.
- Review can display the recorded completion evidence.
- Restart reconciliation does not duplicate an existing run.
- Concurrent read-modify-write cycles from two processes against the same canonical file do not lose updates (covered by a cross-process locking test).
- One integration test covers launch → completion → review evidence.

---

## Priority 1 — Automatic on-demand context briefs

> **Status: Done.** A shared `contextBriefSection` (`src/lib/contextBrief.ts`) appends a short context
> contract to every launch prompt, pointing the agent at the smallest relevant saple-memory MCP brief
> (`get_task_context` for tasks, `get_project_brief` for coordinators, `get_agent_brief` for other
> registered agents) instead of inlining project memories, and telling it to pull individual memories
> with `search_memories` only when a brief points there and to record decisions/lessons via
> `record_decision` / `record_lesson`. The three Kanban task-launch sites (`TaskCard`,
> `TaskDetailDrawer`, `CommandPalette`) now share one `buildTaskAgentPrompt` helper
> (`src/lib/taskAgentPrompt.ts`); `swarmStore`'s launch prompt embeds the same section keyed on the
> agent role. Bridge never calls these MCP tools at launch (the prompt is text handed to the provider
> CLI, which owns the MCP connection), so the launch path can't break when the sidecar is down - the
> contract's fallback line tells the agent to say so and continue from the mission text and attached
> files. Covered by `contextBrief.test.ts` (task/coordinator/registered-agent branches, no-inline-memory,
> graceful-fallback, and the assembled task prompt).

### Problem

SAPLE already has project, task, incident, and agent context tools, but launch prompts mostly provide mission text and attached files. Agents are not consistently directed toward the smallest relevant brief.

### Implement

Extend launch prompts with a short context contract:

- Coordinator: call `get_project_brief` before planning.
- Task agent: call `get_task_context` before editing.
- Registered agent: call `get_agent_brief` when role-specific context is needed.
- Search individual memories only when the brief points to them.
- Record durable decisions and lessons through the existing MCP tools.

Do not inject the complete memory graph into prompts.

### Likely touchpoints

- `src/stores/swarmStore.ts`
- `src/components/kanban/TaskCard.tsx`
- `src/components/kanban/TaskDetailDrawer.tsx`
- `src/components/common/CommandPalette.tsx`

### Acceptance criteria

- Every agent launch identifies its task, role, and relevant MCP brief tool.
- Prompts do not inline all project memories.
- A test asserts the generated task and swarm prompts contain the correct brief instruction.
- The application behaves normally when the MCP sidecar is unavailable and surfaces a clear diagnostic.

---

## Priority 2 — Universal agent composer

> **Status: Done.** The Command Palette gained a composer: a global `Ctrl+Shift+K` (and a
> "Compose / Send to Agent..." entry) opens a target picker, and choosing a target moves to a
> message step whose chip keeps the current target visible before sending. Targets reuse existing
> primitives - a specific running agent or "All running agents" append to the mailbox via the new
> shared `swarmStore.postToMailbox` (re-reads disk, appends under the agent's content; the Swarm
> room's own composer now calls the same action instead of duplicating the stamp); "New terminal
> agent" and "Existing Kanban task" launch through the existing `addPane`/`buildTaskAgentPrompt`
> paths with the provider readiness check and a shared pane-limit guard; "New swarm" seeds the
> wizard mission through a transient `pendingWizardMission` flag consumed by `SwarmWorkspace`;
> "Project memory" writes a note via `memoryStore.saveNote`. All keyboard-driven (Enter sends, Esc
> steps back to the target picker), no new dependency, no second command store. Covered by
> `postToMailbox` append/fresh/blank tests.
>
> ponytail: the reviewer is not a separate target - it surfaces in the running-agents list with its
> role shown; the message field is the palette's single-line input (OS dictation works there, per
> the plan), a textarea can come later if multi-line operator notes are needed.

### Problem

Bridge can already launch terminals, launch tasks, switch rooms, and post to Swarm mailboxes, but these actions live in different interfaces.

### Implement

Extend the existing Command Palette into a composer with a target selector:

- Selected agent
- All running agents
- Reviewer
- New terminal agent
- Existing Kanban task
- New swarm
- Project memory

Reuse `writeMailbox`, `addPane`, existing task launch logic, and the Swarm wizard. Do not create a second command store.

Support normal text entry first. OS dictation already works at the text-input layer on Windows and macOS; treat that as the first voice implementation.

### Likely touchpoints

- `src/components/common/CommandPalette.tsx`
- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- `src/stores/projectStore.ts`

### Acceptance criteria

- One global shortcut opens the composer.
- The current target is always visible before sending.
- Sending to an agent appends to its existing mailbox.
- Launch actions use existing provider readiness checks and pane limits.
- Keyboard-only operation is complete and focus returns predictably.
- No new dependency is introduced.

---

## Priority 3 — Structured agent outcomes

> **Status: Done.** `AgentOutcome` (summary / changedFiles / tests / decisions / needsReview) is
> written to the canonical artifact store as `report` + `test_result` records by
> `completeSession` → `writeOutcomeArtifacts` (never into `sessions.json`). An agent records one by
> writing `.saple/swarm/outcomes/<agentId>.json`; `parseAgentOutcome` sanitizes the untrusted/partial
> data so bad input can't break completion. The swarm card surfaces the summary and test result
> without opening a terminal (`readRunOutcome`), and Review shows the test command/result via the
> run's `test_result` artifact. Marker-only agents keep working (outcome is optional). Covered by
> `parseAgentOutcome` robustness tests and the `completeSession` outcome/fallback tests.
> Review fix: `launchAgentProcess` now clears `.saple/swarm/outcomes/<agentId>.json` (writes `{}`)
> before every launch, so a relaunch that finishes without writing its own outcome can't pick up
> the previous attempt's stale file.

### Problem

Terminal completion markers communicate status but not enough evidence. Review, handoffs, history, and notifications need a predictable summary of what happened.

### Implement

Record outcomes as artifacts in the canonical store from the Priority 0 decision (`.saple/artifacts.json`, written by agents through the MCP artifact tools or by Bridge through Rust). Do not write outcome artifacts into `sessions.json`. Shape:

```json
{
  "summary": "Fixed the authentication race",
  "changedFiles": ["src/auth.ts"],
  "tests": {
    "command": "npm test",
    "passed": true
  },
  "decisions": ["Retained refresh-token locking"],
  "needsReview": true
}
```

Keep scoped terminal completion markers as the fallback when no structured outcome is supplied.

### Likely touchpoints

- `src/types/agent.ts`
- `src/stores/agentSessionStore.ts`
- `src/stores/terminalStore.ts`
- `src/components/swarm/SwarmAgentCard.tsx`
- `src/components/review/*`

### Acceptance criteria

- A completed agent can have summary, changed-file, test-result, decision, and handoff artifacts.
- Swarm inspection shows the summary without opening a terminal.
- Review shows the test command and result.
- Invalid or incomplete outcome data cannot break completion handling.
- Existing agents that only emit markers continue to work.

---

## Priority 4 — Bounded review-and-rework loop

> **Status: Done.** Rejecting an in-review agent now routes it through one bounded rework instead of
> just failing it. `SwarmAgent` gained `attempt` / `maxAttempts` (default 1) / `lastReviewFeedback`
> (persisted in `.saple/swarm/state.json`, so attempts survive restart). The card's Reject button
> opens an inline feedback box; sending calls the new `swarmStore.reworkAgent`, which appends the
> feedback to the agent's mailbox, records it, bumps `attempt`, and relaunches through the existing
> `relaunchAgent` path (same previous context + a "Review Feedback" prompt section built in
> `launchAgentProcess`). Starting an attempt past `maxAttempts` returns `limitReached` rather than
> relaunching — `SwarmWorkspace` then requires explicit human approval via the shared `confirmStore`
> before forcing another attempt, so repeated review signals can't silently loop past the cap.
> Dependency scheduling is untouched (rework relaunches the same node, adds no graph edge), so real
> cycles are still rejected. Covered by `swarmStore.test.ts` rework tests (within-budget relaunch +
> feedback delivery, and cap-refusal-then-force).
>
> ponytail: rework targets the agent that is in `review` (the builder under the gate), not a
> reviewer's dependency builders — one uniform rule, no ambiguity when a reviewer has several
> builder deps. Add dependency-routed rework only if a reviewer-agent-driven flow needs it.

### Problem

The current dependency graph is intentionally acyclic. A reviewer can reject work, but a safe automatic route back to the responsible builder is missing.

### Implement

Add one explicit rework behavior rather than arbitrary cycles:

```text
Builder → Reviewer
             │ reject
             ▼
      feedback to mailbox
             │
             ▼
       Builder retry
```

Suggested fields:

- `attempt`
- `maxAttempts`, default `1`
- `lastReviewFeedback`

The reviewer rejection should append feedback to the builder mailbox and offer a relaunch. Automatically exceeding `maxAttempts` must require human approval.

### Likely touchpoints

- `src/types/agent.ts`
- `src/stores/swarmStore.ts`
- `src/components/swarm/SwarmWorkspace.tsx`
- `src/components/swarm/SwarmAgentCard.tsx`
- `src/stores/swarmStore.test.ts`

### Acceptance criteria

- Reviewer feedback reaches the correct builder mailbox.
- The builder relaunches with the previous context and review feedback.
- Attempts are persisted across restart.
- The configured limit cannot be bypassed by repeated completion signals.
- Dependency scheduling still rejects real graph cycles.

---

## Priority 5 — Local development preview and screenshot context

> **Status: Done (preview panel); screenshot capture still deferred.** A loopback-only Preview drawer
> (`src/components/preview/PreviewPanel.tsx`) opens as a global overlay - deliberately not a nav room
> (respecting the no-new-nav rule) - via `Ctrl+Shift+B` or the Command Palette's "Open Local Preview"
> entry (which dispatches an `open-local-preview` window event `App` listens for). A single shared
> validator (`src/lib/loopback.ts` `parseLoopbackUrl`) is the gate: only `localhost`, `127.0.0.1`, and
> `[::1]` http(s) URLs load, everything else is rejected with a clear message. The panel offers Load,
> Refresh, and Open-externally (`@tauri-apps/plugin-opener`), and an attach row whose `<select>` shows
> the chosen destination before attaching - Project memory (`memoryStore.saveNote`), any active swarm
> agent's mailbox (`swarmStore.postToMailbox`), or a Kanban task (appended to its description via
> `kanbanStore.updateTask`) - all existing store writes, no new persistence. A preflight
> `fetch(url, { mode: 'no-cors' })` distinguishes "server unavailable" (rejected) from a reachable
> server whose blank frame means embedding is blocked (a persistent hint explains X-Frame-Options /
> frame-ancestors). Keyboard is complete: `useFocusTrap` traps Tab + Esc-to-close and the URL field
> autofocuses. The production and dev CSPs gained `frame-src` and loopback `connect-src` entries for
> the three loopback origins (http/https, any port). Covered by `loopback.test.ts`
> (accept/reject/normalize).
>
> Screenshot capture stays deferred exactly as scoped below - it needs native per-OS webview capture
> and is its own follow-up once this ships.

### Problem

Terminal URLs currently open in the system browser. The agent cannot receive a visual screenshot feedback loop from inside Bridge.

### Implement

Add a small localhost-only Preview panel. First release:

- User-entered or detected local URL
- Refresh
- Open externally
- Attach the previewed URL to a task, swarm context, or selected agent mailbox

Start with `localhost`, `127.0.0.1`, and `[::1]`. Do not create a general browsing or automation system. The production CSP in `tauri.conf.json` needs a `frame-src` entry for the loopback origins.

### Screenshot capture (separate follow-up, needs investigation)

Deliberately excluded from the first release. JavaScript cannot capture a cross-origin iframe, and Tauri 2 has no built-in webview-capture API, so this requires native per-OS capture code in Rust (or a vetted plugin). Scope and estimate it as its own item once the preview panel ships; only then add "attach screenshot" on top of the existing attach-URL path.

### Likely touchpoints

- New `src/components/preview/PreviewPanel.tsx`
- `src/App.tsx`
- `src/stores/projectStore.ts`
- Existing context-file and mailbox paths
- `src-tauri/tauri.conf.json` CSP (`frame-src` for loopback origins)

### Acceptance criteria

- Only loopback URLs are accepted in the first release.
- Preview failure explains whether the server is unavailable or embedding is blocked.
- The selected destination is visible before attachment.
- Keyboard navigation is complete.
- Screenshot capture ships separately; when it does, captured images are stored inside the project context area.

---

## Priority 6 — Approved dynamic worker requests

> **Status: Done.** A running coordinator can request another specialist by appending a JSON entry to
> `.saple/swarm/requests.json` (contract injected into coordinator launch prompts). It only records
> the request - Bridge remains the executor. `swarmStore.loadWorkerRequests` reads that file through
> the existing `read_project_file` command and `parseWorkerRequests` sanitizes the untrusted array
> (drops entries missing an id/mission, collapses duplicate ids). `SwarmWorkspace` polls it while the
> swarm is active and renders a requests panel showing role, provider/model, mission, dependencies,
> and estimated new pane count (+1, against the current running/limit). Approve routes through the
> shared `confirmStore` gate, then `resolveWorkerRequest` inserts a `SwarmAgent` (fresh unique id,
> unknown dependencies filtered out) and hands it to the existing scheduler, which enforces provider
> launch and the parallel-agent cap. Writer separation keeps it race-free: agents own
> `requests.json` (append-only), Bridge records resolved request ids in `resolvedWorkerRequests`
> (persisted in the Bridge-owned `state.json`), so a resolved request can't reappear or launch a
> duplicate worker across reloads. Covered by `swarmStore.test.ts` (parse/filter, approve-inserts +
> resolves, unknown-dep drop + idempotent double-approve, reject-without-insert).
>
> ponytail: no new MCP tool or Rust command - agents already write mailbox/outcome/handoff files by
> convention, so the request is one more convention file read via the existing project-file command.
> The residual agent-vs-agent append race on the single `requests.json` is accepted (worker requests
> are rare and approval-gated); switch to per-request files if concurrent coordinators ever make it
> real.

### Problem

Swarm topology is mostly fixed before launch. A coordinator cannot safely request another specialist during execution.

### Implement

Allow an agent to create a durable worker request:

```json
{
  "role": "builder",
  "provider": "codex",
  "mission": "Fix the mobile layout",
  "dependsOn": ["frontend-agent"]
}
```

Bridge displays the request and requires human approval. Approved requests are inserted through the existing scheduler and remain subject to provider readiness and parallel-agent limits.

Do not allow the MCP sidecar to execute shell commands. It should record the request; Bridge remains the executor.

### Likely touchpoints

- `../saple-mcp` request tool and storage
- `src/stores/swarmStore.ts`
- `src/components/swarm/SwarmWorkspace.tsx`
- Existing confirm dialog

### Acceptance criteria

- A coordinator can request, but cannot directly execute, a new worker.
- The user sees provider, model, mission, dependencies, and estimated new pane count.
- Rejected requests never spawn a process.
- Approved requests obey the existing concurrency cap.
- Duplicate request IDs cannot launch duplicate workers.

---

## Priority 7 — SSH terminal presets

> **Status: Done.** A persisted `sshPresetStore` (localStorage, user-level) holds presets of
> `{ name, hostAlias, remoteDir?, providerCommand? }` - no password/key field exists, so nothing
> sensitive is ever stored. `buildSshCommand` (`src/lib/sshPreset.ts`) assembles the launch string:
> `ssh <alias>` for a bare host, or `ssh -t <alias> "cd '<dir>' && <cmd>"` when a remote dir/command
> is set (TTY forced only when handing ssh a command). Quoting is cross-shell safe - the remote
> payload is one level of double quotes (passed to ssh as a single arg by both Windows PowerShell and
> macOS sh) and the remote dir is single-quoted so paths with spaces still `cd` on the remote shell.
> A new "SSH Terminal Presets" section lives inside Settings > Workspace (no new nav entry, per the
> no-new-nav rule) with add/edit/delete and a live command preview. Launch routes through the
> existing custom-command `addPane` path (so its validation is unchanged and the Rust launch gate is
> the same), behind the shared confirm dialog that shows the exact command first; on success it
> switches to the Terminals room. Because the custom-command path keeps the pane alive after the
> process exits (`-NoExit` on Windows, `; exec $shell` on Unix), a failed auth drops to a live shell
> for manual SSH. The section copy states it's a remote terminal, not a remote workspace. Covered by
> `sshPreset.test.ts` (bare host, TTY-on-command, space-safe dir quoting, no secrets).

### Problem

Custom commands can run SSH manually, but remote setup is repetitive and not represented as a reusable terminal configuration.

### Implement

Add saved terminal presets containing:

- Display name
- SSH host alias
- Remote working directory
- Remote provider command

Launch the preset through the existing custom-command PTY path. Store no passwords; rely on the user's SSH agent and configuration.

This is not a remote SAPLE workspace. Files, Git, memory, Kanban, and Review remain local.

### Likely touchpoints

- Existing terminal preset/session state
- `src/components/terminal/TerminalGrid.tsx`
- `src/stores/terminalStore.ts`
- Settings diagnostics

### Acceptance criteria

- Presets never persist passwords or private keys.
- The final command is visible before launch.
- Existing custom-command validation remains active.
- Failed authentication leaves the terminal available for normal SSH interaction.
- Documentation clearly distinguishes a remote terminal from a remote workspace.

---

## Priority 8 - Dynamic model selection for agents

> **Status: Done.** The free-text model inputs in the Swarm wizard (`RosterStep.tsx`), task dialog
> (`TaskDialog.tsx`), and template editor (`SwarmTemplateEditor.tsx`) are now the shared
> `ModelCombobox` - a native `<input list>` + `<datalist>` (dropdown plus free text, keyboard/a11y
> for free). Options come from three layers assembled in `modelCatalogStore.ts`: stable CLI aliases
> (`PROVIDER_MODEL_ALIASES` in `providerMeta.ts`; only Claude's `default`/`sonnet`/`opus`/`haiku`
> plus `openrouter/auto` - no version-pinned ids), persisted recents (recorded on launch at the
> swarm and task choke points), and live API discovery via the new Rust `list_provider_models`
> command (`models.rs`, ureq + keychain key, best-effort - empty on no-key/offline/unknown provider,
> so it silently falls back). A value not in the assembled catalog shows a warning chip before
> launch. `is_safe_model` in `pty.rs` is untouched and remains the launch gate.
> Covered by `models.rs` parser/guard tests and `modelCatalogStore.test.ts` (assembly + recents).
> Review fix: the warning chip now fires only when API discovery actually returned entries for the
> provider (`apiModels` non-empty), not merely once the fetch kicked off — without a key/offline the
> catalog is just aliases + recents, and flagging every legitimate full id would be a false alarm.

### Problem

The model field in the Swarm wizard, task dialog, and template editor is free text. Users have no way to discover valid ids, and stale saved templates/swarm state can still carry rotted ids (e.g. `gpt-4o`) that launch with a wrong `--model` flag. Provider CLIs expose no "list models" command, so purely CLI-driven discovery is not available; the dropdown must be assembled from other live sources.

### Implement

Replace the free-text input with a per-provider combobox (dropdown plus free text), fed by layered sources:

1. Stable CLI aliases per provider (Claude: `default`, `sonnet`, `opus`, `haiku`; others per their documented aliases). Aliases only - never version-pinned ids, which rot.
2. Live API discovery through a new Rust command when a keychain API key exists for the provider (Anthropic/OpenAI/Gemini/OpenRouter models endpoints). Cached per session; silently skipped when no key or offline.
3. Recently used models per provider, persisted.

`default` stays first and preselected. Free text stays available. `is_safe_model` validation in `pty.rs` is unchanged and remains the final gate. Templates or saved swarms whose model id is not in the assembled catalog show a warning chip instead of silently launching.

### Likely touchpoints

- `src/components/swarm/wizard/providerMeta.ts`
- `src/components/swarm/wizard/steps/RosterStep.tsx`
- `src/components/kanban/TaskDialog.tsx`
- `src/components/swarm/SwarmTemplateEditor.tsx`
- New Rust command for API model listing (uses `keychain.rs` secrets; keys never reach the frontend)

### Acceptance criteria

- Every model picker is a dropdown with free-text entry.
- No version-pinned model id is hardcoded in source.
- Fully functional offline (aliases + recents only).
- API discovery activates only when a keychain key exists and fails silently to the offline behavior.
- Stale template model ids produce a visible warning before launch.

---

## Priority 9 - Swarm room visual refresh

> **Status: Done (code); live visual pass pending.** The status→color mapping is now a single shared
> source of truth (`src/lib/swarmStatus.ts` `swarmStatusColor`), consumed by both views so they can't
> drift. A reusable `.swarm-status-surface` class carries the same status-tinted wash, status-colored
> border, and running pulse the graph nodes already had; the Agent Cards Grid (`SwarmAgentCard`) now
> opts into it via `--node-border`, bringing it to visual parity with the graph. A compact status
> legend (`SWARM_STATUS_LEGEND`) renders above both views in `SwarmWorkspace` - running+starting
> collapse into one "Running" swatch so every swatch is a distinct color. Running nodes and cards show
> a ticking elapsed-time badge (`ElapsedTime`), fed by a new persisted `SwarmAgent.startedAt` stamped
> when the agent goes `running` (survives room/project switches and restart, re-stamped on relaunch).
> All new motion is box-shadow/opacity only. Tints use `color-mix(... , var(--bg-surface))` and the
> border/legend use the semantic status vars, so they adapt to every light and dark theme in
> `tokens.css`. Covered by `swarmStatus.test.ts` (elapsed formatting + color-distinctness).
>
> Remaining: a screenshot-based pixel pass in `tauri:dev` (CDP per the debug-webview workflow) to
> eyeball light-theme contrast on the live tints - the code is theme-adaptive by construction but the
> final pixel sign-off wants a running instance.

### Acceptance criteria

- Both views communicate role and status by color without reading text.
- Light and dark themes both verified visually.
- Motion uses transform/opacity/box-shadow only - no layout-property animation.

---

## Priority 10 - Live visibility for headless agent panes

> **Status: Done.** `isHeadlessProvider` (`src/types/provider.ts`) mirrors `pty.rs`'s
> `provider_accepts_prompt_pipe`. The Swarm agent card shows a "Headless run - terminal output
> appears on completion. Watch the mailbox below for live progress." hint while a piped-prompt agent
> is running/starting, and the inspector's terminal-tail label reads "headless - appears on
> completion" for those agents (the mailbox, rendered above the tail, is the primary live surface).
> The `pty-exit` + scoped-marker completion path is untouched. Covered by `provider.test.ts`.

### Problem (validated in real use)

Swarm agents launch headless: the prompt is piped into the CLI (`pty.rs`), which puts Claude into print mode - zero terminal output until the process exits. The pane looks dead while the agent works; the mailbox file is the de-facto live view.

### Implement

1. Label headless panes ("headless - output appears on completion") and make the inspector's mailbox/report tail the primary live surface for them.
2. Evaluate a streaming invocation for Claude headless runs (print mode with streaming output flags), under the hard constraint that the shell must still exit so `pty-exit` keeps feeding the scheduler. Record the decision in this file before implementing.

### Streaming decision (2026-07-14)

Evaluated `claude -p --output-format stream-json --verbose` for Claude headless runs. It satisfies
the hard constraint - the process still exits at the end, so `pty-exit` keeps feeding the scheduler -
but the streamed bytes are newline-delimited JSON event envelopes, not human-readable text. Piping
that straight into the PTY would replace an empty pane with an unreadable JSON firehose, and making
it legible needs a stream-json parser in the tail view (a new, provider-specific failure surface)
plus per-provider flag handling (only Claude has this shape today).

**Decision: do not adopt streaming now.** The mailbox is already the live surface - agents write
progress there mid-run - so Part 1 (labeling headless panes and pointing the operator at the
mailbox) delivers the "working vs. hung" distinction without the parser. Revisit streaming only if
agents that never touch their mailbox need live visibility; at that point add an opt-in stream-json
tail parser behind the existing tail view rather than changing the launch command for everyone.

### Acceptance criteria

- A user can distinguish a working headless agent from a hung one within seconds.
- The completion signal path (`pty-exit` + scoped markers) is unchanged.

---

## Priority 11 - Launch swarms into their own workspace instance

> **Status: Done.** `startSwarmFromWizard` now creates and activates a dedicated workspace instance
> of the same folder (`projectStore.addWorkspace`, renamed `<base> (swarm)`) and records its id as
> `swarmWorkspaceId` (persisted in `.saple/swarm/state.json`). `addPane` gained an optional
> `workspaceId` that pins a pane to a specific instance instead of the active one, and
> `launchAgentProcess` passes `swarmWorkspaceId` on every launch - so late dependent agents still
> land in the swarm's instance even after the user has flipped back to their own. Same path means
> every store and the P13 lifecycle-signal handling stay loaded when flipping between the two
> instances. Because the launch now switches the active instance, App's workspace-change
> `loadSwarmState(force)` could fire mid-launch and reconcile a just-`starting` agent (pane not
> spawned yet) into `failed`; `loadSwarmState` now skips the disk reload while an agent of the
> currently-loaded same-path swarm is `starting` (in-memory is the fresher writer during a live
> launch; cross-project P13 recovery is unaffected because there `loadedProjectPath` points at the
> other project). Covered by a workspace-isolation test (dedicated instance + pinned pane) and a
> mid-launch force-reload guard test.

### Problem

Swarm panes land in the active workspace, mixing agent terminals with the user's interactive panes.

### Implement

On swarm launch, create and activate a new workspace instance of the same folder and bucket all swarm panes there. Workspace instances of the same path are already supported, and panes are already bucketed by instance id, so this is a contained change to the launch path. Same project path means all stores and signal handling stay loaded when flipping between instances.

### Likely touchpoints

- `src/stores/swarmStore.ts` (launch path)
- `src/stores/terminalStore.ts`
- `src/stores/projectStore.ts` (instance creation/activation)

### Acceptance criteria

- Swarm launch opens its own instance; the user's panes are untouched.
- Closing the swarm instance does not kill unrelated terminals.
- Lifecycle signals and scheduling are unaffected by flipping between the two instances.

---

## Priority 12 - Files room state persistence

> **Status: Done.** Files-room view state - expanded folders plus open editor tabs and the active tab -
> now lives in a persisted `fileLayoutStore` keyed by workspace path (modeled on `terminalLayoutStore`).
> `fileStore` owns `expanded` (moved out of `FileTree`'s component-local state) and captures the layout
> on every tab/expansion change; `restoreLayout` - called from `App.tsx` on project switch in place of
> the old unconditional `reset` - rehydrates it, and `loadFiles` prunes deleted/renamed paths against
> the file listing so stale entries are not resurrected. `currentProjectPath` is already persisted, so
> restart rehydrates the same way. Covered by prune + restore(+null) tests in `fileStore.test.ts`.

### Problem

File tree expansion is component-local state (`FileTree.tsx`) and open editor tabs are cleared on project switch, so both reset on any room change, project switch, or restart - unlike terminals, which persist per workspace.

### Implement

A small persisted store keyed by workspace path (modeled on `terminalLayoutStore`) holding expanded folder paths and open tabs. Prune stale paths on load.

### Acceptance criteria

- Expansion and open tabs survive room switches, project switches, and restart.
- Deleted/renamed paths are pruned rather than resurrected.

---

## Priority 13 - Cross-project lifecycle signal routing

> **Status: Done.** Both PTY handlers now route by the pane's own `workspacePath` instead of
> `currentProjectPath` and only apply transitions when that project's swarm/kanban store is the
> loaded one. Signals for a not-loaded project are recovered instead of dropped: the scoped marker
> stays in the pane's rolling signal tail (`getPaneSignalTail`) and `loadSwarmState` re-checks it
> per running agent before the orphan downgrade (marker wins over exit); pty-exits are queued via
> `recordPendingAgentExit` and replayed as the existing exit-fallback transition; kanban review
> moves are queued via `recordPendingTaskReview` and applied by `loadTasks`. Recovered transitions
> run through `updateAgentStatus`, so outcome artifacts, run close-out, notifications, and
> dependent scheduling all fire normally. Switching projects while a swarm runs now shows an info
> toast ("continues in the background"). Covered by five `loadSwarmState` recovery tests (marker
> recovery, dependent advance, pending exit, marker-beats-exit, bare-marker cannot advance a scoped
> agent).

### Problem

Marker and exit handlers (`terminalStore.ts`) resolve agents and tasks through the singleton stores of the currently open project. A swarm agent or task pane finishing while a different project is open is silently dropped; on return, reconciliation strands the agent as running against a dead pane or falsely fails it, and Kanban cards never move to Review.

### Implement

- Route `pty-output`/`pty-exit` lifecycle handling by the pane's own `workspacePath` instead of `currentProjectPath`.
- When the target project is not loaded, apply the transition to that project's state files directly (or queue it and reconcile on load, checking the pane's log tail for scoped markers before declaring failure).
- Warn when switching projects while a swarm is mid-run.

### Acceptance criteria

- An agent completing while another project is open still advances its swarm/task when the project is reopened.
- No false "terminal was lost" for agents that finished while unwatched.
- A test covers cross-project completion delivery.

---

## Deferred deliberately

### Infinite canvas

The existing Terminal grid, Swarm graph, Memory graph, resizable panes, and room navigation already cover the functional requirement. Revisit only if user testing shows navigation—not orchestration—is the dominant problem.

### Bundled Parakeet or Whisper

Use the universal composer with OS dictation first. Add a local model only if measured usage demonstrates demand for push-to-talk routing, command latency, or offline transcription.

### GPT Realtime

Adds recurring cost, conversational state, audio permissions, and a new trust boundary. Revisit after local/OS voice proves valuable.

### True remote workspaces

Do not scatter SSH branches across Bridge's local filesystem, Git, memory, and review commands. Build a remote Saple sidecar/protocol as a separate milestone if remote workspace demand is validated.

### Arbitrary loops and autonomous spawning

Bounded rework and approved worker requests cover the real workflows while retaining cost and safety controls.

---

## Delivery sequence

| Phase | Work | Outcome |
|---|---|---|
| A | Priorities 0–1 | One durable control plane and context-aware launches |
| B | Priorities 2–3 | Faster direction and evidence-rich completion |
| C | Priority 4 | Safe iterative review workflow |
| D | Priorities 5–6 | Visual feedback and dynamic orchestration |
| E | Priority 7 | Convenient remote terminals without architectural overreach |
| F | Priorities 8-9 | Trustworthy model selection and legible swarm status |
| G | Priorities 10-11 | Headless-agent visibility and isolated swarm workspaces |
| H | Priorities 12-13 | Workspace-switching robustness |

## Definition of success

The plan succeeds when a user can open one composer, launch or redirect an agent, have that agent retrieve only the context it needs, see a structured outcome without reading the entire terminal, send rejected work through one bounded retry, and review the resulting evidence—all while `.saple/` remains the durable source of truth.
