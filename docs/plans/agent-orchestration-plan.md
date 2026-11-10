# Saple Agent Orchestration Plan

Status: Draft v1 (2026-07-13)
Scope: saple-bridge + saple-mcp
Decision: Embed the orchestration engine inside Saple Bridge as a Rust crate behind a host-agnostic interface. Keep the `saple-mcp` binary as a thin connector. Defer the standalone daemon until a real headless/survivability need appears.

---

## 1. Background and verdict

Two independent deep analyses (of `saple-mcp` and of saple-bridge's swarm/PTY/sidecar infrastructure) plus a cross-check against an external review converged on the same findings:

- **saple-mcp is a context store, not an orchestrator.** 59 tools (docs say 58) across memory, tasks, runs, agents, incidents, artifacts, permissions, mappings, and a read-only `get_swarm_status`. By design it never launches agents, never executes runs, and only reports swarm state.
- **The real scheduler lives in the React renderer** (`src/stores/swarmStore.ts`): an event-driven DAG scan (`runAgentScan`), dependency blocking, a parallelism cap, and completion inferred by regex-scraping PTY output for `[AGENT_DONE:<marker>]` lines (`src/lib/agentSignals.ts`).
- **The cross-process data model is unsafe for multi-agent writes.** Both codebases use an in-process per-path mutex plus temp-file+rename. That prevents torn files but not lost updates: the Bridge app, plus one `saple-mcp` process per CLI agent, all do read-modify-write on the same whole-file JSON arrays under `.saple/`. Last writer wins the entire array.
- **The storage layer is already duplicated.** `saple-mcp/src/storage/*` is a stated copy of saple-bridge's `project.rs`/`fs_lock.rs` logic, with a shared crate named as the intended fix in its own comments.
- **Verified defects to fix along the way:** `append_run_event` writes `run-events.json` and `runs.json` in two separate non-atomic mutations (`saple-mcp/src/tools/runs.rs:119-153`); docs claim 58 tools while the catalog ships 59 (`add_task_event` undocumented); the MCP protocol version advertised is `2024-11-05` while the current spec revision is `2025-11-25`; saple-mcp's working tree holds ~28 uncommitted modified/untracked files.

### Architecture decision

```
                     Saple Bridge (Tauri process)
                    +--------------------------------------+
  React UI  <------ |  projections only (Zustand stores)   |
                    |                                      |
                    |  saple-engine (Rust crate)           |
                    |   - workflow state machine           |
                    |   - DAG scheduler + reconciler       |
                    |   - single writer for .saple/*       |
                    |   - PTY attempt supervisor           |
                    |   - localhost HTTP (token auth)      |
                    +-----------------^--------------------+
                                      | HTTP (loopback)
              +-----------------------+--------------------+
              |                       |                    |
      saple-mcp (stdio          saple-mcp (stdio     external HTTP
      connector, agent A)       connector, agent B)  consumers
      spawned by Claude Code    spawned by Cursor    (future)
```

- **One mutation owner per workspace:** the Bridge process. Every other actor reaches state through it.
- **`saple-mcp` becomes a connector:** if the Bridge engine is alive it proxies stdio MCP calls to it over loopback HTTP; if not, it falls back to today's direct-file mode so `claude` in a bare terminal still works.
- **The engine is a crate, not a daemon.** Its public interface (`submit` / `command` / `observe`) is host-agnostic, so promoting it into a standalone daemon later is a deployment change, not a redesign.

### Why not a standalone daemon now

- Windows daemon lifecycle (single-instance locks, port discovery, auth handshake, updating a running daemon during app auto-update, orphan cleanup, firewall prompts) is exactly the class of pain this project already fought once with the MSIX sidecar staging workaround (`ensure_stable_sidecar`).
- The daemon's headline benefit (workflows survive UI close) only materializes after PTY ownership also moves into the daemon, which drags the xterm streaming path across an extra IPC hop. Full cost up front, benefit deferred.
- Headless automation is not a current product requirement. The crate boundary keeps the option open at near-zero cost.

---

## 2. Goals and non-goals

### Goals

1. Exactly one writer for all `.saple/` orchestration state per workspace.
2. Scheduling, retries, liveness, and completion decided in Rust, not in React.
3. Agents report structurally (MCP tool calls) instead of being text-scraped, with markers kept as fallback.
4. One task system: swarm agents claim and work kanban tasks atomically.
5. Durable, restart-safe workflows with immutable attempt history.
6. No breakage for external MCP clients at any phase boundary (`.mcp.json` keeps working).

### Non-goals (deferred, with re-entry triggers)

| Left out | Why | Revisit when |
| --- | --- | --- |
| Standalone daemon / headless engine | Lifecycle cost exceeds benefit today; crate boundary preserves the option | A user-visible need to close the UI mid-swarm, or CI/headless runs become a product feature |
| SQLite (or any DB) | Whole-document atomic JSON is sufficient at current scale | Whole-document rewrites or event volume measurably limit throughput |
| Temporal / Kafka / gRPC / message brokers | Single-machine, single-process engine does not need them | Never, unless multi-host scheduling becomes real |
| Multi-host / remote scheduling | Out of product scope | Explicit product decision |
| Plugin framework for tools | YAGNI; tool surface is first-party | Third-party tool authors exist |
| Dynamic graph expansion, budgets, nested teams | Static DAG must be reliable first | Phase 5 exit criteria met and stable in real use |
| Git worktree isolation per editing agent | Valuable but orthogonal; needs merge/review UX design | Parallel editing agents produce real merge conflicts in practice |
| MCP Tasks (experimental spec feature) | Client support varies; engine must be correct without it | Feature stabilizes and target clients support it |
| Rewriting memory markdown storage | Memory graph works; not on the orchestration critical path | Only if unified storage becomes necessary |

---

## 3. Phases

Dependency order: 0 -> 1 -> 2 -> 3 -> 4 -> 5. Phase 6 can run in parallel any time after Phase 1. Each phase ships independently and leaves the product working.

---

### Phase 0 - Hygiene and baseline (saple-mcp)

**Objective:** a clean, committed, documented, correct baseline before any structural move.

**Steps**

1. Commit saple-mcp's working tree (~14 modified + ~14 untracked files) in logical commits: protocol additions (`prompts.rs`, `resources.rs`), new tool modules (`agents.rs`, `artifacts.rs`, `mappings.rs`, `permissions.rs`), storage changes, tests, docs. Tag the result (e.g. `pre-monorepo-baseline`).
2. Fix the 58/59 documentation drift: add `add_task_event` to `docs/saple-mcp-tools.md` and correct the counts in `README.md:122`, `docs/saple-mcp-tools.md:3`, `docs/saple-mcp-rust-upgrade-plan.md:49`, `plan.md`.
3. Fix `append_run_event` atomicity (`src/tools/runs.rs:119`): the event append and the run projection update are two separate `collection::mutate` calls. Fix in two parts:
   - Order writes so the event (source of truth) lands first, then the projection.
   - Make the projection self-healing: when reading a run, derive `phase` from the latest phased event if the stored projection is behind. A crash between the two writes then heals on next read.
4. Add a regression test for the crash window (write event, skip projection, assert read repairs).
5. Run the full suite; the 118-test baseline must pass and stay the floor for every later phase.

**Exit criteria:** clean `git status`; docs match the catalog; new atomicity test passes; 118+ tests green.

**Explicitly out of scope:** any behavior or API change beyond the atomicity fix.

---

### Phase 1 - Monorepo move and `saple-core` extraction

**Objective:** one repository, one copy of the shared storage code, zero behavior change.

**Steps**

1. Restructure saple-bridge into a Cargo workspace:
   ```
   saple-bridge/
     src-tauri/          (existing app crate)
     crates/
       saple-core/       (new: shared storage + domain)
       saple-mcp/        (moved from ../saple-mcp, history preserved via git subtree or filter-repo)
   ```
2. Extract into `saple-core` the code that is currently duplicated between `src-tauri/src/` and `saple-mcp/src/storage/`:
   - `fs_lock.rs` (per-path mutex + atomic temp+rename + own-writes fingerprints)
   - `paths.rs` (`get_project_file_path` containment: rejects `..`, absolute paths, symlink escape)
   - `collection.rs` (generic JSON-array store: load/save/mutate/upsert)
   - `ids.rs`, timestamp helper (`now_iso`)
   - memory markdown parsing shared by both sides
3. Point both `src-tauri` and `crates/saple-mcp` at `saple-core`. Delete the duplicated copies. Keep public function signatures identical so this is a pure move.
4. Update `scripts/prepare-sidecar.mjs`: build the sidecar from the in-repo `crates/saple-mcp` path instead of the sibling checkout. Keep the output name `saple-mcp-<triple>[.exe]` and the `tauri.conf.json` `bundle.externalBin` entry unchanged.
5. Update CI to build the workspace and run all three crates' tests.
6. Leave the old sibling repo archived with a pointer commit.

**Exit criteria:** `cargo test --workspace` green (118 saple-mcp tests + src-tauri tests); `npm run tauri:dev` and `npm run tauri:build` stage the sidecar from the new path; installed app still writes a working `.mcp.json`; `saple-memory` still answers `tools/list` with 59 tools.

**Explicitly out of scope:** any runtime behavior change; connector mode; engine work.

---

### Phase 2 - Single-writer broker

**Objective:** the Bridge process becomes the only writer of `.saple/` orchestration state. This fixes the lost-update hazard before any new orchestration features are built on top of it.

**Steps**

1. New crate `crates/saple-engine`. Initial content: hosting glue around saple-mcp's pure handlers (`handle_tool_call(name, args, project_path)`) plus its axum router (`http.rs` `build_router`), mounted inside the Bridge process:
   - Loopback-only listener on an OS-assigned port.
   - Bearer token minted per app run; auth required (no anonymous mode in embedded hosting).
2. Discovery handshake: on workspace open, Bridge writes `.saple/engine.json`:
   ```json
   { "pid": 12345, "port": 49213, "token": "<per-run secret>", "startedAt": "...", "version": "1.0.x" }
   ```
   Removed on clean shutdown; treated as stale when the pid is dead. This file is the connector's map to the live engine.
   - Note: the token in this file is readable by anything that can read the workspace. Acceptable for now (same trust domain as the files themselves); revisit if remote consumers appear.
3. Convert the `saple-mcp` binary into a connector-first binary:
   - On start, read `.saple/engine.json`; verify liveness with `GET /health` + token.
   - Engine alive: forward every stdio JSON-RPC call to the engine over HTTP, stream results back. The connector holds no state and takes no locks.
   - Engine absent: fall back to today's embedded direct-file mode (bare-terminal usage without the app keeps working).
   - Mid-session transitions: if the engine appears after start, switch to proxy on next call; if it dies, fall back and log to stderr.
4. Migrate Bridge's own writes through the engine crate (direct Rust calls, no HTTP loopback for in-process callers):
   - `kanbanStore` writes -> engine task handlers (replacing raw `write_project_file` of `tasks.json`).
   - `agentSessionStore` -> engine-owned sessions collection.
   - `swarmStore` state persistence -> engine-owned swarm state.
   - Keep `writeQueue.ts` ordering semantics on the TS side; the engine's per-path lock now actually covers all writers.
5. Keep the `.saple` file watcher as reconciliation for the fallback path (files edited while Bridge was closed) and for human edits.
6. Version handshake: connector sends its version; engine answers with min/max supported connector version. Mismatch -> connector falls back to direct mode and prints a one-line upgrade hint to stderr.

**Exit criteria:**
- Concurrency test: N parallel connector processes hammer `create_task`/`update_task`/`append_run_event` against one workspace while the UI mutates the board; zero lost updates (every write observable afterward).
- Kill-the-app test: engine dies mid-session; connectors fall back to direct mode without crashing the CLI agent.
- All Phase 1 exit criteria still hold.

**Explicitly out of scope:** scheduler changes; new tools; workflow model. This phase only changes *who writes*, not *what exists*.

---

### Phase 3 - The orchestration engine core

**Objective:** move scheduling from React to Rust behind a minimal, durable, idempotent interface. React becomes a projection.

**Engine public interface (three operations, no method-per-action sprawl):**

```rust
submit(spec: WorkflowSpec, request_id: Uuid) -> WorkflowRef
command(workflow_id, expected_revision, request_id, cmd: Command) -> WorkflowRef
observe(workflow_id, after_sequence: u64) -> (Snapshot, Vec<Event>)
```

`Command` = `Pause | Resume | Cancel | Approve | Reject | Retry { step } | ForceComplete { step } | Steer { step, message } | Message { to, body }`.

**Workflow document** - one atomic JSON file per workflow at `.saple/workflows/<id>.json`:

```
revision            monotonically increasing; all mutations CAS on it
status              pending | running | paused | completed | failed | cancelled
spec                mission, context files, skills, step graph (agents + dependencies)
steps[]             id, role, provider, model, status, current_attempt
attempts[]          immutable: attempt_id, step_id, started_at, finished_at,
                    exit_code, outcome, prompt_path, output_log_path
events[]            ordered, sequence-numbered; the observe() feed
idempotency[]       request_id -> outcome (dedupes retried submits/commands)
approvals[]         pending approval gates
messages[]          steer/inter-agent messages awaiting delivery
```

State change + its events commit in one atomic file write, closing the class of bug fixed in Phase 0 by construction.

**Core invariants (enforced in the engine, tested directly):**

1. One mutation owner per workspace (Phase 2 gives this).
2. Commands are idempotent via `request_id`; replays return the recorded outcome.
3. Every mutation checks `expected_revision`; stale callers get a conflict, never a silent overwrite.
4. Step graphs are validated acyclic at submit (reuse `validate_dependency_graph` from `src-tauri/src/swarm.rs`).
5. Every launch mints an immutable `attempt_id`. **Output attributed to attempt N can never complete attempt N+1.** This fixes the latent relaunch bug where `relaunchAgent` reuses the marker minted at seed time.
6. Completed history is append-only; no rewriting.
7. Parallelism cap, retries, timeouts, approvals, and cancellation are engine-enforced.

**Steps**

1. Implement the workflow document store and the three-operation interface in `saple-engine`.
2. Port the scheduler from `swarmStore.ts` (`runAgentScan`, lines ~552-667) to Rust, preserving proven behavior: dependency blocking with fixpoint propagation, terminal-state detection, launch of ready steps bounded by `maxParallelAgents`. Port the existing scheduler test cases first (TDD; the TS logic is the spec).
3. Add what the TS scheduler never had:
   - A periodic reconciliation tick (event-driven scans stay, but a missed event can no longer strand a swarm).
   - Per-step timeout/deadline -> attempt marked failed -> retry policy consulted.
   - Configurable retry policy per step (default: 0 retries, matching today).
4. Move attempt execution behind the engine: the engine asks the existing PTY layer (`src-tauri/src/pty.rs`) to spawn provider CLIs; `pty-exit` and marker detections are delivered to the engine (tagged with `attempt_id`), which decides transitions. `terminalStore` keeps rendering output but stops deciding anything.
5. Restart recovery: on workspace open the engine replays workflow documents; attempts whose PTY no longer exists are marked failed-by-crash; the workflow pauses for user resume (parity with today's `loadSwarmState` reconciliation, but at attempt granularity).
6. Expose engine events to the UI as Tauri events (`workflow-event { workflow_id, sequence, event }`). `swarmStore` becomes a projection: subscribe, fold events into view state, render. Delete its scheduling logic (`runAgentScan`, `agentScanInFlight` machinery, status-transition decisions).
7. Migration: `.saple/swarm/state.json` is imported into a workflow document on first open (one-way), then maintained as a read-only compatibility projection for one release so external readers don't break.

**Exit criteria:**
- Ported scheduler test suite green in Rust (same scenarios as the TS tests, plus: reconciliation tick rescues a lost-event swarm; stale-attempt output ignored; idempotent command replay; revision conflict rejected).
- A full swarm template (e.g. `full_stack`) runs end-to-end through the engine with the UI as pure projection.
- Kill/relaunch mid-swarm: restart recovery marks crashed attempts failed and the swarm resumes correctly.

**Explicitly out of scope:** new agent-facing tools (Phase 4); kanban unification (Phase 5); dynamic graphs.

---

### Phase 4 - Structured agent signals, liveness, and atomic claiming

**Objective:** agents stop being text-scraped TUIs and start being API clients; the engine detects dead or stuck agents.

**Steps**

1. Scoped agent tool surface, exposed through the connector, authorized by a per-attempt capability token:
   - `saple_step_report { status: progress|blocked|done|failed, summary, data? }`
   - `saple_message_send { to, body }`
   - `saple_artifact_publish { kind, path|content, label }`
   - `saple_subtask_request { title, description, dependencies? }` (recorded for operator approval; no auto graph expansion yet)
   - `saple_approval_request { question, options? }`
   Tokens are minted per attempt, embedded in the generated `.mcp.json`/prompt env for that agent's process, and die with the attempt. A call with a stale attempt token is rejected (invariant 5).
2. Completion becomes an API call: `saple_step_report done` is the primary signal. Terminal markers (`agentSignals.ts`) remain as fallback for providers that cannot call MCP tools, feeding the same engine transition path tagged by attempt.
3. Leases and heartbeats:
   - Every tool call from an attempt refreshes its lease (no separate heartbeat protocol to start; tool traffic is the heartbeat).
   - The reconciliation tick expires leases: a silent-but-running attempt past its lease gets a status probe window, then is marked stale -> retry policy.
   - PTY liveness (process exists) and lease liveness (agent is making progress) are tracked separately; both surface in the UI.
4. Atomic task claiming:
   - Add `assignee: { workflowId, stepId, attemptId } | null` to the kanban `Task` shape.
   - New tool `claim_task { taskId }`: compare-and-set inside the engine's single-writer lock; second claimer gets a clean rejection. `release_task` on failure/timeout is engine-automatic when the owning attempt dies.
5. Persist agent output: actually write `outputLogPath` (declared on `AgentSession` today, never written). The PTY layer tees raw output per attempt to `.saple/agents/logs/<attempt_id>.log` with size-capped rotation.
6. Prompt updates: swarm prompt templates instruct agents to use the tool surface first, markers as fallback, and to claim tasks via `claim_task` rather than editing files by convention.

**Exit criteria:**
- Two agents racing `claim_task` on the same task: exactly one wins, deterministically, under load.
- An agent that never prints a marker but calls `saple_step_report done` completes correctly; an agent that only prints the marker still completes (fallback intact).
- A hung agent (process alive, no tool calls, no output) is detected by lease expiry and handled by retry policy within the configured window.
- Attempt logs exist on disk for every launch and are linked from the session record.

**Explicitly out of scope:** auto-executing subtask requests (operator approves); enforcement of the advisory permissions store at exec time (tracked separately; requires provider-CLI cooperation to be meaningful).

---

### Phase 5 - Unification: one task graph, one review flow, one UI story

**Objective:** collapse the parallel systems (kanban vs swarm convention files; swarm review badge vs real ReviewRecord) into one coherent product surface.

**Steps**

1. **Kanban is the task graph.** Swarm steps that produce work items create/claim real kanban tasks (via the Phase 4 tools). Retire the convention files (`.saple/swarm/tasks.json`, `bug_report.json`) from prompts; keep reading them for one release as a compatibility import.
2. **Review integration.** When a step reports `review` (or `saple_approval_request` for code), the engine opens a real `ReviewRecord` (existing `reviewStore` + `review.rs` flow) with the attempt's diff, linking `taskId`/`sessionId`/`attemptId`. `autoApprove` steps skip the human gate but still record the diff. The swarm `review` badge and the Review workspace now show the same object.
3. **Sessions become projections** of attempts: `agentSessionStore` reads engine attempt records instead of maintaining a parallel lifecycle. `AgentArtifact[]` (currently always empty) is populated from `saple_artifact_publish`.
4. **UI (inside existing rooms only - no new nav entries):**
   - Swarm room: per-step attempt history, lease/liveness indicators, live claimed-task links, message/steer input wired to `command(Steer)`, approval prompts inline.
   - Kanban room: assignee chips showing which agent holds a task.
   - Review room: swarm-originated reviews appear alongside single-agent task reviews.
   - Sidebar footer agent counter now derives from engine state (already exists; re-point it).
5. **Memory linkage (light touch):** `record_decision`/`record_lesson` calls made by agents during a workflow get backlinks to the workflow id, so post-mortems can traverse from a workflow to what was learned. No storage change.
6. Delete the dead duplicated paths: TS scheduler remnants, direct `tasks.json` writes, `swarm/state.json` writer (projection only now).

**Exit criteria:**
- One swarm run produces: claimed kanban tasks with assignee chips, real ReviewRecords with diffs for review-gated steps, populated session artifacts, attempt logs, and memory backlinks.
- No code path outside the engine writes `tasks.json`, `sessions.json`, or workflow state.
- The five built-in templates all run under the unified flow.

**Explicitly out of scope:** dynamic graph expansion from `saple_subtask_request` (still operator-approved); worktree isolation.

---

### Phase 6 - MCP protocol modernization (parallel track, any time after Phase 1)

**Objective:** bring the external protocol surface up to the current spec without breaking existing clients.

**Steps**

1. Protocol version negotiation: advertise `2025-11-25` while continuing to accept `2024-11-05` initializations (`crates/saple-mcp/src/protocol/jsonrpc.rs:53`).
2. Add a real Streamable HTTP `/mcp` endpoint on the engine's listener; keep the custom `POST /tools/:name` REST bridge temporarily for existing consumers, marked deprecated in docs.
3. Resumable event delivery on the streamable endpoint (session id + last-event-id replay from the workflow event log, which Phase 3 already gives us for free).
4. Auth on by default for every engine-hosted transport (Phase 2 already requires it; extend to any newly exposed endpoint).
5. Public orchestration tools for external clients: `start` (submit), `command`, `observe` - the same three engine operations, exposed as MCP tools. Existing 59 context tools remain unchanged.
6. Evaluate MCP Tasks (experimental) for long-running workflow submission once client support is real; the engine must remain fully correct without it.

**Exit criteria:** Claude Code and one other client initialize at `2025-11-25`; an old-style `2024-11-05` client still works; streamable endpoint passes an interop check; REST bridge unchanged for legacy callers.

---

## 4. Testing strategy (cross-phase)

- **Floor:** the 118-test saple-mcp baseline and existing src-tauri/Vitest suites never regress; CI runs `cargo test --workspace` + `npm test` + `npm run typecheck` on every phase PR.
- **Concurrency harness (from Phase 2 onward):** a stress test that runs N connector processes + in-app mutations against one workspace and asserts zero lost updates. This is the guardrail for the whole plan; it runs in CI on every change to engine/storage code.
- **Scheduler spec parity (Phase 3):** the TS scheduler's test scenarios are ported first and must pass against the Rust engine before the TS implementation is deleted.
- **Chaos cases (Phases 3-4):** kill -9 the app mid-swarm; kill a provider CLI mid-attempt; freeze an agent (no output, no calls); disk-full on state write. Each has a defined, tested recovery.
- **E2E (every phase):** launch the built app, run a real template swarm against a scratch repo, verify UI projections match on-disk state. Windows is the primary target; macOS smoke on release branches.

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Monorepo move breaks sidecar staging/CI in subtle ways | Phase 1 changes paths only; exit criteria include a full `tauri:build` + installed-app `.mcp.json` check |
| Connector fallback mode reintroduces multi-writer when app opens mid-session | Connector re-checks `engine.json` per call batch and switches to proxy; watcher reconciles the fallback window; documented as the one accepted eventual-consistency gap |
| Rust scheduler port loses subtle TS behavior (the "clobbering" class of bug) | Port tests first; keep per-step commit semantics (never write back whole captured arrays); run TS and Rust side by side behind a flag for one release if needed |
| Provider CLIs cannot call MCP tools reliably | Markers remain a permanent fallback path, not a temporary one |
| Token in `engine.json` readable by workspace readers | Same trust domain as the state files themselves; loopback-only listener; revisit before any non-local exposure |
| Scope creep toward the daemon | The deferred table is the contract; daemon work requires a named product trigger |

## 6. Sequence summary

| Phase | Ships | Depends on |
| --- | --- | --- |
| 0 | Clean committed baseline, doc fix, atomicity fix | - |
| 1 | Monorepo, `saple-core`, one storage implementation | 0 |
| 2 | Single writer: engine hosted in Bridge, connector binary | 1 |
| 3 | Rust engine: submit/command/observe, durable workflows, scheduler | 2 |
| 4 | Structured signals, leases, atomic `claim_task`, output logs | 3 |
| 5 | Unified tasks/review/sessions/UI | 4 |
| 6 | MCP 2025-11-25 + Streamable HTTP (parallel track) | 1 |
