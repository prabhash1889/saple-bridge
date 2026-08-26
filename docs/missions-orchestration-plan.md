# Missions: Multi-Harness Agent Orchestration - End-to-End Implementation Plan

| Field | Value |
| --- | --- |
| **Status** | Draft v1 (2026-08-26) |
| **Goal** | One orchestrator agent (any harness, e.g. an opencode model) plans and drives many worker agents across different harnesses (Claude Code, Codex, Gemini, Droid, Grok, ...), each in its own git worktree, with deterministic lifecycle, verifiable settlement, and durable markdown context |
| **Scope** | saple-bridge (Tauri app) + saple-mcp sidecar |
| **Related** | `docs/agent-orchestration-plan.md` (engine phases 0-6), `docs/swarm-cross-provider-orchestration.md` (swarm v2 phases A-F) |

This plan is informed by a 20-agent deep dive of Orca (`D:\project\repos\orca`) and Traycer (`D:\project\repos\traycer`) orchestration systems (see Traycer artifact `orca-traycer-orchestration-deep-dive`). It does not replace the two existing plans - it is the product layer that consumes them, and it fills the gaps they leave open (durable planning artifacts, dispatch identity binding, honest unknown states, decision gates, orchestrator-loop guardrails).

---

## 1. What we are building

A **Mission** is a durable, markdown-first work order:

- A coordinator (the orchestrator agent, any harness, or the human via the UI) decomposes an objective into a **task DAG**.
- Each task is **dispatched** to a worker agent: a specific harness (provider CLI), model, and git worktree.
- The **engine** (Rust, inside the Bridge process) owns all lifecycle: scheduling, dispatch, settlement, retries, liveness, gates. React renders projections.
- Workers report completion through structured channels (MCP tools first, terminal markers and PTY exit as fallbacks). Settlement is **identity-bound**: a "done" from the wrong attempt or wrong pane can never complete a task.
- The coordinator receives compact result summaries each round, issues the next round of actions (assign / message / request_worker / complete), and loops until the mission converges - with budget caps, round caps, and context-watermark handoffs.

### Why this design (evidence from the deep dive)

| Lesson | Source | How we apply it |
| --- | --- | --- |
| The engine must be deterministic; intelligence lives in the coordinator agent | Orca (`coordinator.ts` decompose stub; retired auto-loop) | Rust engine never calls an LLM. It schedules, gates, and settles. |
| Planning context should be markdown agents read/write directly | Traycer artifact model (`epics/<id>/artifacts/<chain>/index.md`) | Mission = folder of markdown under `.saple/missions/<id>/`; the plan IS the context. |
| Completion authority must be identity-bound, not prose-trust | Orca `lifecycle-reconciliation.ts` (pane key + dispatch id + capability hash) | Every dispatch mints `dispatch_id` + `attempt_id` + capability token; only the matching tuple settles a task. |
| Honest unknown states beat fake certainty | Orca `start_unknown`/`stop_unknown`/`abandoned`; Traycer no-dispatch-guarantee retry errors | Dispatch states include `start_unknown`, `stop_unknown`, `settlement_unknown`; retries are safe because they are idempotent. |
| Prompt injection differs per harness | Orca `TUI_AGENT_CONFIG.promptInjectionMode`; swarm v2 Phase A capability matrix | One adapter registry owns launch/resume/result/permission facts per provider. |
| Human gates block tasks; the engine never auto-resolves them | Orca `coordinator-decision-gates.ts` | Mission gates reuse the swarm acceptance-approval flow; engine blocks dependents until resolved. |
| Workers must return summaries, not transcripts | Claude Code issue #10212; Traycer subagent nesting | Workers write artifacts to files; the coordinator receives a compact structured summary per round. |
| Warn-only staleness, circuit breakers, retry budgets | Orca dispatch circuit breaker (3 failures), warn-only stale heartbeats | Same thresholds and semantics, ported. |

### Capability parity targets

Every capability below is covered by a named phase in this plan. This table is the completeness contract: if a phase ships without its parity rows, the phase is not done.

| Capability | Orca / Traycer reference | Covered in |
| --- | --- | --- |
| Task DAG with readiness promotion | Orca `task-store.ts` promoteReadyTasks | M3 |
| Identity-bound settlement (wrong attempt can never complete) | Orca `lifecycle-reconciliation.ts` | M3, M4 |
| Honest unknown states (`start_unknown`, `stop_unknown`, `abandoned`) | Orca WorkerDispatch states | M3, M7 (distinct UI badges) |
| Decision gates blocking tasks, never auto-resolved by the engine | Orca `coordinator-decision-gates.ts` | M4 |
| Circuit breaker + carried retry budget | Orca `dispatch-circuit-breaker.ts` | M3 |
| Heartbeat/lease liveness, warn-only staleness | Orca `coordinator-task-dispatch.ts` | M4 |
| Worker-initiated blocking question with durable answer | Orca `ask`/`reply` with resume-by-message-id | M4 (ask/reply) |
| Inter-agent mailbox: threads, acks, unread tracking, stalled-receiver notices | Orca mailbox system; Traycer `agent.inbox.*` | M4 (mission mailbox) |
| Worker session reuse (next dispatch continues the same session) | Orca `worker-start --terminal` reuse / retain / release | M3 (session pooling) |
| Per-worker worktree isolation + deliberate merge-back | Orca worktree topology; swarm v2 E | M5 |
| Stale-base guard that does not burn retry budget | Orca `coordinator-task-dispatch.ts` | M5 |
| One harness coordinating heterogeneous workers | Orca coordinator agent; swarm v2 C | M6 |
| Structured action contract for the coordinator | swarm v2 Phase C JSON schema | M6 |
| Dynamic subtask requests (worker grows the graph, human/coordinator approves) | Orca `saple_subtask_request` (engine plan 4); swarm P6 | M6 |
| Review-only dispatches as a first-class task kind | Orca review-only `worker_done` doctrine | M6 |
| Best-of-N speculative execution (fan out, merge the winner) | Orca README parallel-worktrees doctrine | M6 |
| Fork an agent from its checkpoint with a new instruction | Traycer `agent.fork`; Orca `worker-start --retry-of` | M6 |
| Role claims so peers avoid duplicated responsibility | Traycer `agent.roles.claim` | M6 |
| Durable planning artifacts agents read/write directly | Traycer artifact model (`index.md` chain) | M1 |
| Compact summaries to the coordinator, full output in files | Claude issue #10212; Traycer nesting | M4 (artifacts), M6 (round brief) |
| Auditable decision/timeline log | Traycer communication graph | M6 (event log), M7 (feed) |
| Budget caps, round caps, context-watermark handoffs | swarm v2 C guardrails | M6 |

Explicitly **not** targeted (deferred with re-entry triggers): cross-machine federation (Orca), cross-host/cloud replication (Traycer Yjs sync), group broadcast addresses, MCP-tasks-based scheduling. See "Non-goals" in section 2.5.

### Relationship to the existing plans

This plan **assumes** the following foundations land first (they are prerequisites, not duplicates):

| Foundation | Covered by | Used by Missions for |
| --- | --- | --- |
| Provider adapters (headless launch, JSON results, permission posture) | swarm v2 Phase A | M2 consumes and extends the adapter registry |
| Persistent multi-turn worker sessions (`resume` turns) | swarm v2 Phase B | M6 coordinator loop and rework turns |
| Rust engine crate (`saple-engine`): single writer, `submit/command/observe`, durable workflow documents | engine plan Phases 1-3 | M3 is the mission-flavored workflow model on top |
| Structured worker signals + leases + atomic task claiming | engine plan Phase 4, swarm v2 Phase D | M4 settlement and liveness |
| Worktree isolation + merge-back | swarm v2 Phase E | M5 per-dispatch worktrees |
| MCP protocol modernization | engine plan Phase 6 | worker reporting channel transport |

Where this plan names a module that already exists in those plans (e.g. `saple-engine`, provider adapters), it defines the mission-specific schema and behavior only, and cites the foundation phase.

---

## 2. Architecture

```
+--------------------------------------------------------------------------+
| Saple Bridge (Tauri process)                                             |
|                                                                          |
|  React UI (projection only)                                              |
|    Missions room: mission doc editor, DAG view, live dispatch grid,      |
|    gates/approvals, event feed          <-- new ViewType 'missions'      |
|         ^  fold events                                                   |
|         | mission-event { missionId, seq, event }  (Tauri event)         |
|  +----------------------------------------------------------------------+
|  | saple-engine (Rust crate)  -- single writer for .saple/missions/*    |
|  |   MissionStore        one atomic JSON per mission + markdown folder  |
|  |   Scheduler           DAG readiness, parallelism cap, gates          |
|  |   DispatchSupervisor  spawn via PTY layer, attempt registry          |
|  |   Reconciler          periodic tick: leases, stale, crash recovery   |
|  |   Settlement          identity-bound worker_done reconciliation      |
|  +---+-------------------+-----------------------------+----------------+
|      |                   |                             |
|      v                   v                             v
|  pty.rs spawn_pty   git.rs worktree ops          control_plane.rs
|  (existing)         (new commands, M5)           (.saple agents/runs)
+--------------------------------------------------------------------------+
         |  PTY (headless, per harness CLI)          |  MCP over stdio
         v                                           v
  Worker agents: claude -p / codex exec / droid exec / gemini -p / grok -p
  each in its own worktree, each with .mcp.json pointing at saple-mcp
         |
         v
  saple-mcp sidecar (connector): saple_step_report / saple_message_send /
  saple_artifact_publish / saple_gate_request  -> engine HTTP (loopback)
```

Key boundary rules (inherited from repo AGENTS.md contracts):

- Rust owns filesystem, PTY, process lifecycle, and all `.saple/missions/*` writes.
- React never writes mission state directly; it calls engine commands and folds events.
- All writes atomic via `fs_lock.rs`; single mutation owner per workspace (engine plan Phase 2).
- Secrets stay in the OS keychain; worker processes get credentials via env constructed in Rust (`providers.rs`), never in prompts or state files.

### 2.5 Non-goals (deferred, with re-entry triggers)

| Left out | Why | Revisit when |
| --- | --- | --- |
| Cross-machine federation (dispatch workers to remote hosts, Orca-style relay) | Single-host is the product; relay auth/lifecycle is a large surface | A user-visible need to run workers on a second machine or CI runner |
| Cross-device/cloud state replication (Traycer Yjs sync) | Local-first; markdown + JSON already satisfy single-host durability | Mobile companion or multi-machine teams become a requirement |
| Group broadcast addresses (`@all`, `@claude`) | Coordinator-mediated routing covers fan-out with better auditability | A real mission shape needs broadcast; then add one `broadcast` message kind |
| SQLite for mission state | Whole-document atomic JSON is sufficient at mission scale (tens of tasks) | Event volume or multi-mission queries measurably hurt |
| MCP Tasks (experimental spec) for workflow submission | Client support varies | Feature stabilizes across target CLIs |
| OS-level sandboxing of workers | Out of scope repo-wide; permission posture per adapter is the boundary | A provider ships a usable local sandbox primitive |

---

## 3. Core concepts and data model

### 3.1 Mission (the durable work order)

Stored as a **folder** (markdown context) plus **one state file** (engine truth):

```
.saple/missions/<mission_id>/
  mission.md              # objective, constraints, acceptance criteria (human+agent readable)
  artifacts/              # sub-documents: specs, findings, reports (nested folders each with index.md)
    <slug>/index.md
  state.json              # engine-owned: DAG, dispatches, attempts, events, gates (schema below)
```

`mission.md` frontmatter (parsed by the engine, mirrored in `state.json.spec`):

```markdown
---
title: Add OAuth login
objective: One paragraph the coordinator decomposes.
acceptance:
  - "npm test passes"
  - "manual login flow works"
max_parallel: 4
max_rounds: 12
budget_usd_cap: 15.00
worktree_mode: per-task | per-mission | shared
coordinator: { provider: opencode, model: "...", permission: full_access }
---
```

### 3.2 state.json schema (engine truth, one atomic file per mission)

```jsonc
{
  "id": "msn_01J...",
  "revision": 42,                    // all mutations CAS on this
  "status": "draft|running|paused|gated|completed|failed|cancelled",
  "spec": { /* parsed mission.md frontmatter + step graph */ },
  "tasks": [{
    "id": "task_01J...",
    "title": "Implement token refresh",
    "kind": "implement|review|verify",   // review/verify tasks settle with findings, not edits
    "spec": "full instructions for the worker",
    "deps": ["task_01J..."],         // DAG edges
    "fanout": 1,                     // >1 = best-of-N speculative dispatches (M6)
    "status": "pending|ready|dispatched|completed|failed|blocked|circuit_broken",
    "result": null,                  // settled WorkerReport JSON (summary only)
    "gateId": null                   // set while blocked by a gate
  }],
  "dispatches": [{                   // one per task attempt assignment
    "id": "dsp_01J...",
    "taskId": "task_01J...",
    "attemptId": "att_01J...",
    "provider": "codex",
    "model": "gpt-5.2",
    "worktreePath": "D:/repo/.saple/worktrees/msn_x/task_y",  // or null = shared
    "paneId": "pane_...",            // PTY identity binding
    "capabilityHash": "sha256:...",  // hash of the per-dispatch capability token
    "status": "pending|starting|starting_unknown|running|succeeded|failed|stop_unknown|abandoned",
    "failureCount": 0,
    "lastHeartbeatAt": null,
    "startedAt": null, "finishedAt": null,
    "terminationReason": null,       // operator_close|signaled|exited|lease_expired|crash|unknown
    "outputLogPath": ".saple/missions/<id>/logs/<attempt>.log"
  }],
  "gates": [{ "id": "gate_01J...", "taskId": "...", "question": "...", "options": ["approve","reject"],
              "status": "pending|resolved|timeout", "resolution": null }],
  "messages": [{                    // mission mailbox (M4): durable, threaded, acked
    "id": "msg_01J...", "threadId": "thr_01J...",
    "from": "task_01J...|coordinator|operator", "to": "task_...|coordinator|operator",
    "kind": "message|ask|reply|notice", "body": "...",
    "expectsReply": false, "inReplyTo": null, "answeredBy": null,
    "read": false, "acked": false, "createdAt": "..."
  }],
  "pool": [{                        // reusable settled worker sessions (M3)
    "key": "pool_01J...", "provider": "codex", "model": "...", "worktreePath": null,
    "sessionId": "...",             // resumable harness session id
    "state": "idle|retained|released", "lastTaskId": null, "reusedCount": 0
  }],
  "events": [/* sequence-numbered; the observe feed; capped + archived to events.log */],
  "idempotency": { "<request_id>": { "outcome": "..." } }
}
```

### 3.3 Identity binding (the core safety invariant)

When the engine dispatches a task it mints, in one atomic write:

1. `dispatch_id` - the assignment,
2. `attempt_id` - the concrete process launch,
3. a **capability token** (random 32 bytes); only its SHA-256 is stored,
4. the `paneId` of the PTY it was injected into.

The token is delivered to the worker via env var (`SAPLE_DISPATCH_TOKEN`) and via its prompt preamble. Every settling report (`saple_step_report done`, marker line, or exit fallback) must carry `dispatch_id` + `attempt_id`; the engine verifies the token hash **and** that the report's PTY session id matches the dispatch's bound pane. Mismatches are persisted as rejections with typed codes (mirroring Orca's taxonomy):

`sender_not_assignee | stale_attempt | task_dispatch_mismatch | inactive_dispatch | invalid_payload | unknown_dispatch`

**Invariant (tested directly): output attributed to attempt N can never settle attempt N+1.** This closes the relaunch race that exists in today's marker system (seed-time token reuse).

### 3.4 State machines

```
Task:    pending -> ready -> dispatched -> completed
                        ^            |-> failed (retry budget) -> circuit_broken (3 strikes)
                        |            |-> blocked (gate pending; engine never auto-resolves)
                        +---- re-ready on failed dispatch under budget

Dispatch: pending -> starting -> running -> succeeded
                        |            |-> failed
                        +-> starting_unknown        (spawn outcome unprovable)
             running -> stop_unknown               (crash/kill outcome unprovable)
             any -----> abandoned                   (operator decision, bookkeeping only)
```

`starting_unknown` / `stop_unknown` are honest states: the engine records what it knows, surfaces "outcome unproven" in the UI, and requires an explicit operator choice (retry / abandon) rather than guessing. Retries mint fresh dispatches with `retryOf` linkage; `failure_count` carries forward (circuit breaker trips at 3, matching Orca's `DISPATCH_CIRCUIT_BREAK_FAILURES`).

---

## 4. Phases

Dependency order: M0 -> M1 -> M2 -> M3 -> M4 -> M6. M5 can start any time after M3. M7 starts after M3 and ships incrementally. M8 is continuous. Each phase ships independently and leaves the product working.

---

### Phase M0 - Baseline, decisions, and feature flag

**Objective:** a green, decided, reversible starting point.

**Steps**

1. Record the architecture decisions in this doc as settled: engine-in-process (not daemon), JSON-per-mission (not SQLite), markdown artifacts (not Yjs), identity-bound settlement, warn-only staleness. Any later change requires a new decision entry.
2. Add feature flag `missions` (default off) to `.saple/config.json` schema and the settings UI, gating the new room and all new Tauri commands behind a single `isMissionsEnabled()` helper in `src/lib/featureFlags.ts`.
3. Verify prerequisites are actually landed (checklist against the foundation plans; if any is missing, Missions work on later phases blocks):
   - [ ] provider adapters with headless launch + JSON result parsing (swarm v2 A)
   - [ ] `saple-engine` crate with single-writer broker (engine plan 2)
   - [ ] `submit/command/observe` workflow core (engine plan 3)
   - [ ] `saple_step_report` tool surface (engine plan 4)
4. Baseline: `npm run verify` green (typecheck, lint, tests, build, clippy/check/test). Record test counts as the floor.

**Exit criteria:** flag exists and gates nothing yet (no dead code shipped); prerequisite checklist either fully green or gaps explicitly filed against the foundation plans; verify green.

---

### Phase M1 - Mission artifact model and storage

**Objective:** missions exist as durable markdown + engine state; the UI can create, read, edit, and list them. No execution yet.

**Rust (`src-tauri/src/missions.rs`, new module)**

Commands (all registered in `lib.rs`, all path-contained via `project_roots.rs`, all writes atomic via `fs_lock.rs`):

- `mission_create(project_path, title, objective, acceptance, options) -> MissionSummary`
  - mints `msn_<ulid>`, writes `mission.md` (frontmatter + body) and initial `state.json` (status `draft`) in one atomic sequence under the cross-process lock.
- `mission_list(project_path) -> Vec<MissionSummary>` (id, title, status, counts, updatedAt)
- `mission_read(project_path, id) -> { state: MissionState, doc: MissionDoc }` - state.json parsed + `mission.md` raw
- `mission_update_doc(project_path, id, body, expected_revision)` - human/agent edits to `mission.md`; frontmatter re-parsed and validated (unknown keys rejected, `max_parallel` 1..=8, budget cap > 0)
- `mission_set_tasks(project_path, id, expected_revision, tasks: Vec<TaskSpec>)` - **the decomposition write**. Validates the DAG acyclic with fixpoint reachability (reuse the validator pattern from `swarm.rs::validate_dependency_graph`), rejects unknown deps, computes initial statuses (`ready` iff no deps, else `pending`), CAS on revision.
- `mission_command(project_path, id, expected_revision, request_id, cmd: MissionCommand)` - `Start | Pause | Resume | Cancel | Retry { dispatch } | Abandon { dispatch } | ResolveGate { gate, resolution }`. Idempotent via `request_id` (replay returns recorded outcome). Emits events.

**Markdown conventions (Traycer-style, simplified for local-first)**

- `artifacts/<slug>/index.md` sub-documents; relative links between artifacts resolve against the artifact folder chain (no cross-machine path resolution needed - single host).
- The engine treats `mission.md` and `artifacts/**` as **agent-writable, engine-read-only**: agents edit markdown with normal file tools; the engine only parses frontmatter and never rewrites prose. `state.json` is engine-only.
- Watcher integration: register `state.json` with `watcher.rs` so external edits (should not happen; engine is sole writer) surface as `saple-file-changed` and trigger a reconcile-on-read.

**Frontend**

- `src/types/mission.ts` - TS mirrors of the schemas above (single source: generate-by-hand, keep in sync with serde via round-trip tests).
- `src/stores/missionStore.ts` - Zustand projection: list, active mission, doc text, state; actions call Tauri commands; subscribes to `mission-event` (M3) but works without it (poll on focus).
- `src/components/missions/MissionsView.tsx` - minimal v1: list + detail + mission.md editor (reuse editor components from the memory view) + task table (add/remove/edit tasks, deps picker). No DAG rendering yet.
- Register `ViewType 'missions'` in `projectStore.ts` (`ROOM_ORDER` after 'swarm'), `App.tsx` routing, `Sidebar.tsx` entry, and a landing-screen card (the new section) with shortcut `Alt+9`.

**Tests**

- Rust: create/read/update round-trip; frontmatter validation rejections; DAG validation (cycle, unknown dep, self-dep); CAS conflict on stale revision; idempotent command replay; atomicity (kill between mission.md and state.json writes -> next read repairs or surfaces corrupt per `state_load.rs` semantics).
- TS: store projection tests; view smoke test.

**Exit criteria:** create a mission in the UI, add 3 tasks with a dependency, edit the doc, restart the app - everything survives and re-renders; `mission.md` is hand-editable in any editor and the UI picks up frontmatter changes on next read.

---

### Phase M2 - Harness adapter registry (mission-grade)

**Objective:** every orchestratable provider is described by one declarative adapter: how to launch headless, how to inject the task prompt, how to resume, how to parse the result, what permission posture to pin, and how it may settle.

**Rust: extend `providers.rs` (single owner of provider facts) with `ProviderAdapter`**

```rust
pub struct ProviderAdapter {
    pub id: ProviderId,                  // existing AgentProvider union
    pub headless: HeadlessLaunch,        // argv template + prompt delivery mode
    pub prompt_mode: PromptMode,         // Argv | FlagPrompt | StdinFile | PasteAfterIdle
    pub resume: Option<ResumeLaunch>,    // argv template for a follow-up turn
    pub result_format: ResultFormat,     // FinalJsonLine | JsonlEvent | OutputLastMessageFile | MarkerOnly
    pub permission_args: &'static str,   // pinned posture (see table)
    pub session_id_key: &'static str,    // envelope field carrying the resumable session id
    pub supports_mcp: bool,
    pub tested_version_range: (String, String),
}
```

Verified launch table (from swarm v2 Phase A research; keep pinned + version-detected, warn on untested versions):

| Provider | Headless launch | Prompt mode | Result format | Permission posture (pinned) |
| --- | --- | --- | --- | --- |
| claude | `claude -p --output-format stream-json --verbose --bare` | argv/stdin | JSONL envelope (`result`, `session_id`) | `--permission-mode acceptEdits` (configurable) |
| codex | `codex exec --json --sandbox workspace-write` + `--output-last-message <tmp>` | argv | JSONL + last-message file | `--sandbox workspace-write` (`--full-auto` is deprecated) |
| droid | `droid exec -f <prompt> -o json --auto medium` | file | JSON | `--auto medium` |
| gemini | `gemini -p "$(cat prompt.md)" --output-format json` | argv | JSON | non-interactive implies approval posture; document |
| grok | `grok -p "..." --output-format json --always-approve --no-auto-update` | argv | JSON | `--always-approve` |
| opencode | `opencode run` (or `opencode serve` HTTP for long-lived) | argv | text/JSON | document; mark experimental |
| cursor / copilot | not mission-eligible v1 (hang reports / weak headless) | - | - | excluded from worker picker |

**Dispatch preamble generation** (`missions/preamble.rs`, new): builds the worker's instruction block injected as the prompt file:

- identity ("You are a dispatched worker for Saple mission `<id>`"),
- `task_id`, `dispatch_id`, `attempt_id`, capability token (env var name + value),
- the exact saple-mcp tool calls to use (`saple_step_report done --summary ...`, `saple_artifact_publish`), markers as fallback,
- heartbeat rule (tool traffic is the heartbeat; if the harness cannot call MCP, emit `[SAPLE_HEARTBEAT:<dispatch>]` every 5 min),
- worktree rules (branch name, do not touch the main checkout),
- the raw task spec + links to `mission.md` and relevant artifacts (absolute paths).

**Tests**

- Adapter unit tests: argv construction per provider (snapshot), result envelope parsing against checked-in fixture JSONs (claude stream-json, codex JSONL, droid/gemini/grok JSON), session-id extraction.
- Prompt-mode test: preamble file written under `.saple/missions/<id>/prompts/<attempt>.md`, contained path, no secrets in file (capability token only in env for MCP-capable providers; in-file only for marker-fallback providers - documented tradeoff).
- Preflight: provider binary detection + version probe (reuse `diagnostics.rs` probes) gates the worker picker.

**Exit criteria:** a mission task can be launched manually ("dispatch this task" button) on each eligible provider and the parsed result (text, session id, cost, is_error) appears in the dispatch record. Markers still settle a `custom`-provider agent.

---

### Phase M3 - Dispatch engine core (scheduler + supervisor)

**Objective:** the engine owns the mission lifecycle end to end; React becomes a projection. This is the heart of the plan.

**Rust: `saple-engine` mission module** (assumes engine plan Phase 3 crate exists; this adds the mission workflow flavor)

1. **Scheduler tick** (event-driven + periodic reconcile every 2 s, Orca's cadence):
   - fold settled results -> `promote_ready_tasks(task_id)`: dependents whose deps are all `completed` flip `pending -> ready` inside the same atomic write as the settlement;
   - gates: tasks with pending gates are re-blocked every tick (`reblock_tasks_with_pending_gates`); the engine never resolves gates;
   - dispatch loop: while `running_count < min(spec.max_parallel, per-provider cap)` and ready tasks exist and no gate blocks: pick a task (FIFO by creation), create dispatch, launch.
   - **one new worker PTY per tick** (Orca's burst guard).
2. **DispatchSupervisor** - the launch sequence, each stage recorded on the dispatch row before the next begins (crash-safe):
   1. `starting` persisted;
   2. worktree ready (M5; or shared-cwd mode v1);
   3. `spawn_pty` via the PTY layer with the adapter's headless argv, `cwd` = worktree, `prompt_file` = preamble, `ai_provider`, `model`, env including `SAPLE_DISPATCH_TOKEN` (credential env vars come from `providers.rs`/keychain as today);
   4. bind `paneId` into the dispatch row;
   5. `running` persisted. If the engine dies between stages, recovery marks the dispatch `starting_unknown` (honest state) and the UI offers retry/abandon.
3. **PTY event wiring**: subscribe to the existing `pty-exit` and raw output streams; tag everything with `attempt_id`. Exit handling:
   - exit 0 with no settlement yet -> park dispatch in `settlement_pending` window (2 min grace for a trailing `saple_step_report`); then apply the exit fallback (succeeded for review-gated tasks per existing semantics, else failed) - preserving shipped v1 behavior;
   - non-zero exit -> `failed` (failure_count++, retry policy);
   - operator pane close -> `failed { terminationReason: operator_close }` without escalation noise (a deliberate close is not an incident - Orca lesson).
4. **Retry policy**: default `max_retries = 2` per task (3 total attempts = circuit breaker). Under budget: task returns to `ready`, fresh dispatch with `retryOf`. At budget: task `failed`, mission-level escalation event. Stale-base refusals (M5) do not burn budget.
5. **Restart recovery**: on workspace open, replay all mission `state.json` files; dispatches whose pane no longer exists -> `stop_unknown` + reconcile (existing orphan-reconciliation pattern, now per-attempt). Mission with all tasks terminal -> `completed`/`failed`.
6. **Events**: every mutation appends `{ seq, kind, payload, at }` to the mission's event list (capped in-file, archived to `events.log`); emitted to the UI as Tauri event `mission-event { missionId, seq, event }`. `missionStore` folds events; falls back to `mission_read` on gap.
7. **Migration/interop**: swarm templates can create missions ("Run as Mission" toggle in the wizard) - the wizard's DAG becomes `mission_set_tasks`; the old swarm path remains for one release.

**Worker session pooling (Orca worker-reuse parity)**

Spawning a fresh CLI per dispatch pays startup + context-loading cost every time. The engine therefore keeps a per-mission **session pool** (`state.json.pool`):

- After a dispatch settles, the worker's harness session (adapter `session_id`) is pooled as `idle` instead of being discarded, when the adapter has a `resume` launch and the session ended cleanly.
- The next dispatch to the same `(provider, model, worktree)` pair **prefers a pooled session**: the supervisor launches via the adapter's resume argv with the new preamble as the follow-up turn, reusing the worker's accumulated context. Pool hit is recorded (`reusedCount`); a fresh spawn is the fallback.
- Semantics mirror Orca's terminal ownership: `idle` (reusable), `retained` (operator pinned for debugging; never auto-reused), `released` (closed; the PTY exits and the pane is cleaned up). Missions end by releasing every pool entry; a `stop_unknown` on release is surfaced, never guessed.
- Pool entries are worktree-scoped: a pooled session is only reused for dispatches bound to the same worktree (context correctness). Shared-mode missions may pool per `(provider, model)`.
- Failure handling: a resume that fails (session dead) falls back to a fresh spawn and marks the pool entry `released` - identical to swarm v2 Phase B's session-death handling.

**Tests (port-first, TDD)**

- Port the TS scheduler test scenarios (`swarmStore.test.ts`) to Rust against the engine before deleting any TS logic (engine plan Phase 3 rule).
- New: readiness promotion cascade (A->B->C completes in waves); parallelism cap respected; one-spawn-per-tick; gate re-blocking; retry budget + circuit breaker; stale attempt output cannot settle (M4 harness but the invariant is enforced here); kill-engine-between-stages recovery matrix (each stage boundary -> expected honest state); idempotent `mission_command` replay under concurrency; pool reuse (same provider+model+worktree resumes the pooled session; dead-session resume falls back to a fresh spawn; retained entries never reused; mission end releases all entries).

**Exit criteria:** a 3-task mission (A -> B,C parallel -> D) runs end to end headless on two different providers with the UI as pure projection; kill -9 the app mid-run, reopen: state is honest (no fake "running"), and retry/abandon resumes correctly.

---

### Phase M4 - Settlement, liveness, and gates

**Objective:** completion is verifiable; dead or stuck workers are detected; humans gate what matters.

**Worker reporting channel (saple-mcp connector, engine plan Phase 4 tools, mission semantics)**

- `saple_step_report { dispatch_id, attempt_id, token, status: progress|blocked|done|failed, summary, changed_files?, tests? }` - the **only** primary completion path. Engine validates the identity tuple (3.3) and settles transactionally: dispatch -> `succeeded|failed`, task -> `completed|failed`, dependents promoted, all in one atomic write. Duplicate/stale reports return the recorded rejection code (idempotent).
- `saple_gate_request { dispatch_id, question, options }` - worker-initiated gate: creates a gate, blocks its task, notifies the UI + coordinator. Resolution (human, via UI; or coordinator via its own gate tool with `authority: coordinator`) unblocks and the resolved answer is appended to the **next** attempt's preamble if the task retries (Orca's resolved-gate replay).
- `saple_artifact_publish { dispatch_id, kind, path|content, label }` - writes under `artifacts/` and records the artifact on the dispatch; large outputs live here, summaries go to the coordinator (issue #10212 lesson).
- `saple_ask`, `saple_inbox_fetch`, `saple_inbox_ack` - the ask/reply and mailbox channel; specified in the two subsections below.

**Fallbacks (permanent, per engine plan Phase 4)**

- Scoped markers `[SAPLE_DONE:<dispatch_id>:<token-prefix>]` parsed from the pane tail (reuse `agentSignals.ts` machinery, retargeted) - for providers that cannot call MCP.
- PTY exit fallback (M3) - last resort.

**Liveness**

- Tool traffic refreshes the dispatch lease (no separate heartbeat protocol). Reconcile tick: lease expired (default 10 min silence) -> **warn-only** status + one status-probe turn (`resume` with "report status"); a second silent window -> `failed { terminationReason: lease_expired }` -> retry policy. PTY-process liveness and lease liveness are tracked and displayed separately.
- Attempt output tee: PTY layer tees per-attempt output to `logs/<attempt_id>.log` (size-capped, ANSI kept raw) - evidence for review and post-mortems.

**Gates in the UI + coordinator contract**

- Gates surface in the Missions room (inline card) and as `mission-event`s. `ResolveGate` is a `mission_command` (idempotent, audited). The coordinator agent resolves gates only when the mission spec grants `coordinator.canResolveGates: true`; default is human-only (Orca: the engine never auto-resolves).

**Blocking ask/reply (Orca `ask`/`reply` parity)**

For mid-run questions that do not deserve a full gate (quick clarification, "may I rename X?"):

- New saple-mcp tool `saple_ask { dispatch_id, attempt_id, token, question, options?, timeout_ms? }`: durably records an `ask` message (thread minted), notifies coordinator + operator, and **blocks the tool call** (long-poll on the engine's loopback HTTP) until a `reply` arrives or the timeout hits. On timeout the tool returns the thread id so the worker can re-ask with `resume` semantics instead of duplicating the question (Orca's resume-by-message-id).
- `reply` sources: coordinator agent (via `saple_mission_act {type:"reply", threadId, body}`), operator (Missions room inline), or a mission-level auto-responder rule (frontmatter, e.g. "questions matching /deps|version/ -> 'use latest stable'"). Every answer is an audited event.
- The worker's dispatch is **not** failed while it waits; its lease is refreshed by the pending ask itself, and the UI shows "waiting for answer (thread X)" - distinguishing an intentionally blocked worker from a hung one.

**Mission mailbox (Traycer `agent.inbox` + Orca mailbox parity)**

All non-settlement traffic between mission participants flows through the durable mailbox in `state.json.messages`:

- Senders/recipients are mission addresses: `task_<id>` (routed to that task's active dispatch), `coordinator`, `operator`. Every message carries `threadId`; replies reference `inReplyTo`; the engine enforces that an `expectReply` thread is answered exactly once (`answeredBy`), and emits a `notice` (kind `stalled`) to the sender when the receiver settles/exits without replying - Traycer's stalled-receiver sweep, local-file scale.
- **Delivery to workers**: MCP-capable workers get `saple_inbox_fetch { wait_seconds }` (long-poll; tool traffic keeps the lease warm) and `saple_inbox_ack { ids }` - unacked messages are redelivered on next fetch, acked ones never again (Traycer's durable-inbox semantics). Non-MCP workers receive undelivered mailbox content injected into their next turn (pool resume or retry preamble) under a `--- MISSION MAIL ---` section.
- **Delivery to the coordinator**: undelivered mail addressed to `coordinator` is folded into the next round brief (M6) as a compact section; urgent messages can trigger an out-of-round coordinator turn when the adapter supports resume (Phase B).
- **Operator channel**: the Missions room message box posts as `operator`; replies from workers render in the event feed threaded.
- Storage discipline: messages live in `state.json` (durable, atomic with everything else); bodies are capped at 16 KiB (larger content belongs in `artifacts/`); the list is pruned to the last 200 per mission with older messages archived to `messages.log`.

**Tests**

- Identity matrix: correct tuple settles; wrong attempt / wrong pane / stale token / duplicate each return the specific rejection code and change nothing.
- Marker fallback completes a non-MCP provider; MCP report beats marker race deterministically (report wins if both valid for the same attempt).
- Lease expiry -> probe -> fail -> retry -> circuit breaker, with fake clocks; a pending ask refreshes the lease and shows as intentionally blocked, not hung.
- Gate: worker gate blocks task + dependents; resolve unblocks; resolved answer appears in retry preamble.
- Ask/reply: blocking tool call returns when reply arrives; timeout returns the thread id; re-ask with resume does not duplicate threads; auto-responder rule fires; every answer audited.
- Mailbox: expectReply thread answered exactly once; stalled notice on receiver exit without reply; unacked redelivery, acked never redelivered; mail to coordinator appears in next round brief; 16 KiB cap and 200-message pruning enforced.

**Exit criteria:** a hung agent (process alive, silent) is detected and handled within the configured window; a lying agent (reports done for the wrong dispatch) is rejected; every settlement has evidence (report payload, marker line with attempt id, or exit record) linked in the event log.

---

### Phase M5 - Worktree isolation and merge-back (parallel track, after M3)

**Objective:** parallel workers never share a working tree; results merge deliberately.

**Rust (`git.rs` extensions + `missions/worktrees.rs`)**

- `mission_worktree_create(project_path, mission_id, task_id, mode) -> WorktreeInfo` - `git worktree add` at `<repo>/.saple/worktrees/<mission>/<task>-<slug>` with branch `saple/<mission-short>/<task-short>` (sibling-dir alternative `../<repo>-wt-<branch>` if the repo rejects in-tree worktrees; decide by probe, Orca-style topology choice: `new-child` under the mission dir vs `new-top-level`).
  - Containment: register the worktree path in `project_roots.rs` as an approved root for the mission's lifetime; remove on cleanup.
  - Post-create setup hook: run the workspace's configured setup command if present (surface the cost honestly: node_modules is not shared); skip via `worktree_mode: shared`.
- `mission_worktree_diff(project_path, worktree, base) -> GitDiffSummary` (reuse `review.rs` diff machinery) and `mission_worktree_merge(project_path, worktree, strategy: merge|pr|discard)` - merge is operator-gated in v1 (Review room shows the diff; approve = merge to mission branch, reject = discard with optional rework turn).
- Stale-base guard: before dispatch, if the worktree base is > 20 commits behind its upstream base, refuse dispatch (task stays `ready`, retry next tick) unless the task spec contains `allow_stale_base: true`. **Refusals do not burn the circuit-breaker budget** (Orca lesson: failing a recoverable condition here poisons retries).
- Cleanup: mission completion offers merge/discard per task worktree; `mission_worktree_remove` prunes worktree + branch (only when clean; dirty worktrees require explicit confirm).

**Frontend**

- Task table gains a worktree column (path, branch, ahead/behind, status); dispatch picker offers `per-task | per-mission | shared` (mission default from frontmatter).
- Merge-back lives in the existing Review room: mission-originated diffs appear alongside single-agent reviews, each carrying `missionId/taskId/dispatchId` provenance (ReviewRecord linkage as in engine plan Phase 5).

**Tests**

- Two workers editing the same file in parallel worktrees produce two reviewable diffs; main checkout untouched throughout (E2E).
- Stale-base refusal: base drift simulated -> dispatch refused without failure_count increment; `allow_stale_base` overrides.
- Cleanup: clean worktree prunes; dirty worktree refuses without confirm; crash recovery re-lists orphaned mission worktrees (disk truth walk, Traycer-style).

**Exit criteria:** a 2-worker mission on a scratch repo ends with the user's checkout untouched and two mergeable branches; merge-back produces the expected tree.

---

### Phase M6 - The orchestrator loop (one harness drives many)

**Objective:** the headline capability: a coordinator agent in **any** harness (e.g. opencode running any model) decomposes, dispatches, monitors, and iterates across heterogeneous workers - with guardrails.

**Design: Bridge-mediated routing with structured actions** (the Claude Agent-Task pattern across vendors; swarm v2 Phase C contract, now engine-native)

1. **Coordinator session**: launched via the adapter as a persistent session (`claude -p --resume`, `codex exec resume`, `droid exec -s`, `opencode serve` HTTP) with a JSON action contract. MCP-capable coordinators get the actions as saple-mcp tools instead (preferred: `saple_mission_act`), non-MCP coordinators get `--json-schema` structured output. Contract:

```json
{
  "actions": [
    { "type": "assign",  "taskId": "...", "provider": "codex", "model": "...", "worktree": "per-task", "instruction": "..." },
    { "type": "message", "toTaskId": "...", "body": "..." },
    { "type": "reply",   "threadId": "...", "body": "..." },
    { "type": "request_worker", "role": "builder", "provider": "grok", "mission": "..." },
    { "type": "request_gate", "taskId": "...", "question": "...", "options": ["a","b"] },
    { "type": "accept_subtask", "proposalId": "..." },
    { "type": "select", "taskId": "...", "dispatchId": "..." },
    { "type": "fork", "dispatchId": "...", "instruction": "..." },
    { "type": "review", "summary": "..." },
    { "type": "complete", "summary": "..." }
  ]
}
```

2. **The loop** (implemented in the engine as `CoordinatorLoop`, not TS - swarm v2 Phase C's minimal TS loop is skipped because the engine now exists):
   - round begins -> coordinator receives a compact **round brief**: mission objective, task board (statuses only), per-dispatch result summaries (from `state.json` `result` fields, truncated to ~2k chars each), open gates, budget/round counters. Full outputs live in `artifacts/` and logs; the brief links paths.
   - coordinator returns actions -> engine validates (unknown taskId -> rejected action recorded, not fatal), executes: `assign` creates tasks/dispatches (subject to `max_rounds`, parallel cap, per-provider caps), `message` becomes a resume turn to that worker (Phase B) or lands in its inbox file if one-shot, `request_worker` honors the human-approval gate (existing P6 flow) unless the mission pre-approves providers,
   - round ends when all dispatched tasks of the round settle or the round deadline hits -> next brief.
3. **Guardrails (all engine-enforced, all configurable in frontmatter):**
   - `max_rounds` (default 12) and round deadline (default 20 min);
   - `budget_usd_cap` summed from result envelopes' cost fields (claude/codex provide; others estimate 0 and say so);
   - **context watermark**: when the coordinator session's usage crosses ~70% (claude_context.rs pattern generalized; provider-agnostic fallback: fixed turn count), the engine asks it for a handoff summary and starts a fresh session seeded with the brief + handoff (two-stage: memory sync ~64%, handoff ~80%);
   - coordinator failure/timeout -> mission `paused` with a human-readable reason; never silent (swarm v1 lesson);
   - every coordinator action is an audited, sequence-numbered event - the mission's decision log is inspectable in the UI (Traycer communication-graph lesson, local-file scale).
4. **Human steering**: the Missions room can inject a steer message into the coordinator's next brief (`mission_command Steer`); operator mailbox messages to workers become delivered turns (Phase B), not dead-drop files.

**Extended orchestration capabilities (parity completions)**

These five capabilities round out the orchestration surface; each is engine-enforced and surfaced in the UI.

1. **Dynamic subtask requests** (worker grows the graph): new saple-mcp tool `saple_subtask_request { dispatch_id, title, spec, depends_on_task_ids? }` - recorded as a `pending` proposal event, never auto-executed. The coordinator may promote it in its next round (`{type:"accept_subtask", proposalId}` -> real task inserted into the DAG with correct deps, validated acyclic); otherwise it waits for operator approval in the Missions room. Rejecting records the decision with the reason. This formalizes the existing P6 `requests.json` flow into the mission event log.
2. **Review-only dispatches as first-class task kinds**: `kind: "review"` tasks dispatch a worker with a review-only preamble (inspect the diff/artifacts of the dependency tasks; **findings settle the task; the worker is never authorized to edit**). `kind: "verify"` runs a specified command suite and settles from its exit code + output. The coordinator's `review` action and the human Review room consume the same findings payload - one review object, two consumers (engine plan Phase 5 linkage).
3. **Best-of-N speculative execution**: a task with `fanout: N` (default 1, max 3) is dispatched to N different `(provider, model)` pairs (distinct worktrees mandatory - M5). All N run; the first `succeeded` settlement parks the task in `awaiting_selection`; the others are cancelled at their next heartbeat check (or run to completion if `spec.speculative.runToCompletion: true`). Selection: the coordinator nominates (`{type:"select", taskId, dispatchId}`), the operator confirms in the UI (or auto-confirms when the mission grants it). Losers' worktrees are kept for diff-until selection resolves, then discarded per the M5 cleanup rules. Cancelled dispatches do not burn any task's retry budget (they are speculative by declaration).
4. **Fork-from-checkpoint**: every dispatch start captures a git checkpoint (existing `git.rs` checkpoint machinery, `refs/saple/checkpoints/<mission>/<attempt>`). New saple-mcp tool `saple_fork_request { dispatch_id, instruction }` and coordinator action `{type:"fork", dispatchId, instruction}` create a **new task** whose worktree is seeded from that checkpoint and whose preamble contains the fork instruction plus the source dispatch's result summary - Traycer `agent.fork` semantics ("clone the agent at its best moment, try again with new information") without re-running from the mission base. Forked tasks are ordinary DAG nodes (they can gate, be gated, and be depended on).
5. **Role claims**: workers claim a free-text role on their active dispatch via `saple_role_claim { role }` (e.g. "db-migrations owner"); claims are stored on the dispatch, listed in the round brief, and surfaced as chips in the UI. Purpose is de-duplication of responsibility (Traycer's rationale): the coordinator sees "fe_builder already claims CSS ownership" before assigning overlapping work. Claims are advisory - the engine never enforces them - and die with the dispatch.

**Tests**

- Loop harness with a scripted fake coordinator (deterministic action sequences): assign->settle->second-round assign->complete; budget cap aborts mid-round with mission paused; watermark handoff produces a fresh session whose brief contains the handoff summary; invalid actions rejected and surfaced; round deadline fires.
- Subtask proposals never auto-execute; coordinator acceptance inserts a valid DAG node, rejection records the reason; a proposal with cyclic deps is rejected at acceptance time.
- Review-only dispatch settles on findings without any file edits (assert worktree untouched); verify task settles from command exit code.
- Best-of-N: two speculative dispatches on distinct worktrees; first settlement parks in `awaiting_selection`; loser cancellation does not burn retry budget; selection merges the winner and discards the loser per cleanup rules.
- Fork: forked task's worktree matches the source checkpoint tree; fork instruction + source summary present in the preamble; forked node participates in gating normally.
- Role claims appear in the round brief and UI chips; claims die with the dispatch.
- E2E: real coordinator (claude) + two workers (codex + droid) on a scratch repo: "add feature X with tests" completes with zero human intervention except configured gates, all within caps.

**Exit criteria:** the user picks any coordinator harness and any mix of worker harnesses; the loop runs to completion or stops honestly at a cap/gate; every round's brief, actions, and results are visible in the event feed.

---

### Phase M7 - Missions UI (incremental, starts after M3)

**Objective:** one room where a mission is fully observable and steerable. Ships in slices; each slice usable.

**Slice 1 - Board and doc (ships with M3)**
- Task table with statuses, assignee (provider+model chip), dispatch state incl. honest unknown badges (`starting_unknown` etc. rendered distinctly - never as "running").
- mission.md editor + artifacts browser (reuse memory/editor components).
- Event feed (right rail): folded `mission-event` stream with filters (settlements, gates, coordinator actions, errors).

**Slice 2 - DAG and live grid**
- DAG canvas (reuse/extend the swarm `SwarmGraph`): nodes = tasks colored by status; edges animate on promotion; gate nodes render as blocking diamonds.
- Live terminal grid: embedded `TerminalPane`s for running dispatches (multi-pane composition already proven in the terminals room); click-through from task -> pane -> log tail.

**Slice 3 - Gates, ask/reply, mailbox, steering, selection, merge-back**
- Inline gate cards (question, options, resolve); coordinator-vs-human authority badge.
- Ask/reply threads: pending-ask cards with options and countdown; answered threads render inline history.
- Mailbox view: threaded operator/coordinator/worker messages with unread + stalled badges; operator send box.
- Best-of-N selection cards when a task is `awaiting_selection` (diff-per-dispatch, nominate/confirm).
- Steer input -> coordinator brief; per-worker message box -> resume turn.
- Merge-back panel per task worktree: diff summary, merge/discard/rework actions (wired to M5 commands).

**Slice 4 - Landing + polish**
- Landing-screen card ("Saple Missions - plan multi-agent missions with durable context", shortcut `Alt+9`), onboarding hint, template gallery (3 starter mission templates: `feature_delivery`, `bug_hunt`, `review_sweep`).
- Pixel pass per repo standards: CSS variables only, dark/light parity, keyboard navigation.

**Constraint honored:** the earlier "no new nav entries" rule came from project memory when Missions did not exist; the user has explicitly directed adding this section, so the new room is intentional - documented here as the superseding decision.

**Exit criteria per slice:** each slice passes `npm run verify` + a scripted E2E walkthrough; the room never shows a state the engine did not report (projection-only rule enforced by a store test that rejects local status mutations).

---

### Phase M8 - Hardening, observability, and cost (continuous from M3)

**Objective:** production-grade behavior under failure, and honest economics.

1. **Chaos matrix (each case: defined recovery + automated test)**
   - kill -9 app mid-dispatch (each launch stage boundary); kill a worker CLI mid-run; freeze a worker (silent); disk-full during state write; worktree deleted underneath a running worker; coordinator session dies mid-round; sidecar (saple-mcp) absent for the whole mission (markers-only mode).
2. **Observability**
   - Mission log: `app_log.rs` gains a `missions` source; every dispatch/launch/settlement audited (audit.rs) with provider tag.
   - Diagnostics bundle (`diag_report.rs`) includes mission summaries (redacted).
   - Event log export: one-click "copy mission timeline" for bug reports.
3. **Cost & rate limits**
   - Per-provider concurrency caps (config, default 2 for grok/gemini free tiers); budget meter in the room header; mission-level and global (per-day) caps; over-cap -> pause with reason, never silent failure (swarm v1 lesson).
4. **Performance**
   - Event list capping + archival; `mission_read` lazy-loads artifacts; store tests assert no unbounded growth over a 100-round simulated mission.
5. **Docs**: `docs/missions.md` user guide (concepts, harness matrix, worktree modes, caps) + update `CLAUDE.md`/AGENTS.md files with the new module map entries.

**Exit criteria:** full chaos matrix green in CI; a 10-task, 3-provider mission completes on a cold Windows machine from `npm run tauri:dev` with zero manual fixes; docs merged.

---

## 5. Cross-phase engineering rules

1. **Engine-first, projection-always**: no mission state mutation outside `saple-engine`; store tests enforce it.
2. **Identity binding everywhere**: every completion path (MCP report, marker, exit) carries `dispatch_id` + `attempt_id`; the stale-attempt-settles test is a permanent CI guard.
3. **Honest uncertainty**: any unprovable outcome becomes an explicit unknown state with an operator choice; the UI renders unknowns distinctly.
4. **Permanent fallbacks**: markers and PTY-exit fallbacks are permanent, not transitional (providers without MCP must always work).
5. **Version pinning + detection** for provider CLIs (swarm v2 rule): adapters declare tested ranges; warn, never block.
6. **Windows-first E2E**: every phase exits through a real mission on Windows against a scratch repo; macOS smoke on release branches.
7. **Verify floor**: `npm run verify` green on every phase PR; the recorded test-count floor never drops.
8. **No secrets in prompts, state, or markdown**: capability tokens are scoped and hashed at rest; provider credentials only via keychain-derived env in Rust.

## 6. Testing strategy summary

| Layer | What |
| --- | --- |
| Rust unit | adapters, preamble, DAG validation, state machines, settlement identity matrix, retry/breaker, recovery matrix (fake clock) |
| Rust integration | engine + PTY layer with fake provider binaries (scripted CLIs that emit known envelopes/markers/hangs) |
| TS unit | missionStore projection, event folding, unknown-state rendering |
| E2E (per phase) | real providers on a scratch repo; Windows primary; the scripted fake-provider harness runs the full matrix in CI without API keys |
| Chaos | M8 matrix, automated where possible, scripted otherwise |

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Provider CLI flag drift breaks adapters | Pinned tested ranges + version probe + warn-only; adapters are the single place flags live |
| Coordinator loops burn money on undecomposable work | Round/budget caps default-on; mission template guidance; "one agent is sometimes right" note in the wizard |
| Engine complexity creep (rebuilding Orca wholesale) | The phase table is the contract; anything not listed needs an explicit decision entry (Orca's federation, groups, and legacy-compat machinery are explicitly out of scope) |
| Markdown/state divergence (agents edit frontmatter badly) | Frontmatter validation on read with safe fallback to last-good spec + surfaced warning; prose is never parsed |
| Worktree setup cost on Windows (node_modules) | Setup hook opt-in, honest cost in UI, `shared` mode for read-only/scout tasks |
| MCP sidecar unavailable for some harnesses | Markers + exit fallback permanent; capability matrix drives the picker |

## 8. Sequencing summary

| Phase | Ships | Depends on | Foundation plan linkage |
| --- | --- | --- | --- |
| M0 | Flag, decisions, prerequisite audit | - | audit of engine 2-4, swarm A |
| M1 | Mission markdown + state + CRUD UI | M0 | engine 2 (single writer) |
| M2 | Harness adapter registry + preambles | M0 | swarm v2 A (extends) |
| M3 | Dispatch engine: scheduler, supervisor, recovery | M1, M2 | engine 3 (core) |
| M4 | Settlement identity, liveness, gates, ask/reply, mission mailbox | M3 | engine 4 + swarm v2 D |
| M5 | Worktree per dispatch + merge-back | M3 (parallel) | swarm v2 E |
| M6 | Orchestrator loop + subtask proposals, review/verify kinds, best-of-N, fork, role claims | M4 (M5 for full value) | swarm v2 C (engine-native) |
| M7 | Missions UI slices 1-4 | M3+ (incremental) | swarm v2 F (new room) |
| M8 | Hardening, chaos, cost, docs | continuous | - |

**Minimum lovable milestone:** M0+M1+M2+M3+M4 with UI slice 1 - one mission, two harnesses, identity-bound settlement, honest recovery. M5+M6 deliver the full "one model orchestrates many, in many worktrees" capability; M7 slices 2-3 make it feel effortless.
