# Swarm Update 1 - Usability Plan

Status: proposal (no code yet)
Scope: make the Saple Bridge swarm system actually usable end to end.

---

## 1. Diagnosis

The swarm is **not** vaporware. It genuinely spawns provider-CLI agents in native PTYs
(`src-tauri/src/pty.rs:367-415`) and schedules them by dependency
(`src/stores/swarmStore.ts:548-618`). State persists through the write queue + Rust
atomic writes. The plumbing works.

It is unusable because the **feedback and control loop is broken**. The app delegates
everything semantic to the LLMs over loose file conventions and three magic strings,
with no ground-truth fallback and no in-room control.

### Confirmed blockers (evidence-based)

| # | Blocker | Evidence |
| --- | --- | --- |
| 1 | **Silent stalls.** An agent only leaves `running` when its terminal prints an exact marker (`[AGENT_DONE]`, `[TASK_COMPLETE]`) on its own line. There is no process-exit fallback. On Windows agents run under PowerShell `-NoExit`, so the shell never exits either. A finished-but-unmarked agent stays `running` forever; dependents never start; the swarm hangs with no explanation. | `terminalStore.ts:204-207` (markers), `terminalStore.ts:426-431` (`pty-exit` only prints a notice, does not touch agent status), `pty.rs:408` (`-NoExit`) |
| 2 | **`review` deadlocks the pipeline.** `[REVIEW_REQUESTED]` parks an agent in `review`, which is neither `done` nor `failed`, so dependents wait forever. Only escape is a scary green **"Force Complete"** button. No Approve/Reject. | `swarmStore.ts:576-597`, `SwarmAgentCard.tsx:176-184` |
| 3 | **Provider/model preconditions unmet -> instant `failed`.** Hardcoded model strings with a warn-but-launch flow. Wrong or unauthenticated CLI -> agent fails immediately with no remediation. | `swarmStore.ts:309-312`, `providerMeta.ts:39-50`, `LaunchStep.tsx:44-51` |
| 4 | **No visibility inside the room.** Mailbox/handoff panels are empty unless the LLM voluntarily writes files. To see actual work you must leave for the Terminals room. | `SwarmAgentCard.tsx:101-114`, `SwarmWorkspace.tsx:78-81` |
| 5 | **Broken crash/restart recovery.** After a restart mid-run, agents reload as `running` pointing at dead PTYs and are never relaunched. `loadSwarmState` does not re-run the scan. | `swarmStore.ts:330-349`, `swarmStore.ts:591-593` (scan only launches `waiting`/`idle`) |
| 6 | **Discoverability + dead UI.** No sidebar nav entry. The sidebar template picker's `startSwarm` action has **zero callers** - only the wizard launches. Two competing template UIs, inconsistent naming, Play icon opens a config wizard. | `Sidebar.tsx:67-76`, `swarmStore.ts:381` (no callers), `SwarmWorkspace.tsx:282-301,337,492` |
| 7 | **Siloed from Kanban/Review.** No task -> swarm assignment. The review -> Kanban/Review bridge only fires for Kanban-owned panes, which swarm panes never are. The advertised "task -> review pipeline" is not connected. | `swarmStore.ts:297-308`, `terminalStore.ts:399-406` |
| 8 | **`saple-memory` MCP is a separate system.** The in-app swarm never reads or writes it. `get_swarm_status`/`create_agent` describe a parallel registry Bridge never populates. | no `saple-memory` calls anywhere in swarm code; server lives in sibling `../saple-mcp` |
| 9 | **Zero test coverage** on the scheduler, status machine, and marker detection. | no `*swarm*` test files; `swarm.rs` has no `#[cfg(test)]` |

### Through-line

Fixing usability = giving the app **real signals** (process exit, artifacts) and **real
controls** (approve, tail output, recover). Phases 1-3 make a swarm actually run to
completion; the rest is reliability, discoverability, and integration.

---

## 2. Phased plan

Ordered by impact. Each phase is independently shippable and leaves the swarm more
usable than before.

### Phase 1 - Kill silent stalls (completion fallback) [highest impact]

**Goal:** an agent that stops working always reaches a terminal state, marker or not.

**Problem:** markers are the only signal; `pty-exit` is ignored; `-NoExit` keeps the
Windows shell alive so exit never fires.

**Changes:**
- Stop using `-NoExit` (or wrap the command so the shell exits) for swarm-launched
  panes, so the child process exit actually fires `pty-exit` on Windows
  (`pty.rs:388-410`).
- Wire `pty-exit` into the swarm: when an agent is still `running`/`starting` and its
  PTY exits without a marker, transition it - exit code 0 -> `review` (human confirm),
  non-zero -> `failed` - and store the exit code as the status reason
  (`terminalStore.ts:426-431`, `swarmStore.ts:504-528`).
- Keep markers as the fast path; exit is the safety net.

**Acceptance:** launch a one-agent swarm whose CLI finishes without printing a marker ->
the agent leaves `running` on process exit and the swarm reaches a terminal state.

**Effort:** small (~2 files). **Depends on:** none.

### Phase 2 - Fix the review deadlock + approval UX

**Goal:** a swarm with a review step can advance without a human guessing.

**Problem:** `review` silently blocks dependents; only escape is a mislabeled
"Force Complete".

**Changes:**
- Add explicit **Approve** (-> `done`) and **Reject** (-> `failed` or re-queue) controls
  on the agent card; retire/relabel "Force Complete" (`SwarmAgentCard.tsx:176-184`).
- Make `runAgentScan` handle `review` deliberately per the chosen semantics (see
  Decisions), instead of silently blocking (`swarmStore.ts:576-597`).

**Acceptance:** an agent in `review` can be approved or rejected from the swarm room;
dependents advance on approve, and reject surfaces clearly.

**Effort:** small-medium (UI + one scheduler branch). **Depends on:** Phase 1 (its
`exit 0 -> review` landing state needs an Approve control).

### Phase 3 - Provider/model preflight

**Goal:** find out a CLI is missing/unauthenticated/wrong-model **before** launch, not
via a failed agent.

**Problem:** hardcoded models + warn-but-launch = instant `failed` for first-run users.

**Changes:**
- Reuse `diagnostics.rs` to check each rostered provider is installed and has stored
  credentials; validate model strings against a per-provider list
  (`providerMeta.ts:39-50`).
- Surface per-agent readiness in the wizard **Roster** step (not just the final Launch
  step), and block launch on hard failures (`LaunchStep.tsx:44-51`).

**Acceptance:** launching a swarm whose provider is missing/unauthenticated is blocked
with a clear per-agent reason instead of producing `failed` agents.

**Effort:** small-medium. **Depends on:** none (parallel to 1-2).

### Phase 4 - In-room observability

**Goal:** see what an agent is doing without leaving the Swarm room.

**Problem:** the inspect panel shows mailbox/handoff files only; real work is only
visible in the Terminals room.

**Changes:**
- Show a live tail of each agent's terminal output in the inspect panel (reuse the
  existing xterm buffer / `terminalStore`), plus a clear status-reason line
  ("stuck running - no marker", "exited code 1") (`SwarmAgentCard.tsx:101-114`).
- Keep "Open terminal" as the full view.

**Acceptance:** selecting an agent shows recent terminal output and a human-readable
reason for its current status.

**Effort:** medium (wiring terminal buffer into the panel). **Depends on:** Phase 1
(for the status-reason field).

### Phase 5 - Crash/restart recovery + launch-time cycle check

**Goal:** reopening the app mid-run does not leave a zombie swarm; an invalid roster
fails loudly instead of stalling silently.

**Problem:** `loadSwarmState` reloads agents as `running` with dead PTYs and never
re-runs the scan; `startSwarm`/`startSwarmFromWizard` never validate the DAG.

**Changes:**
- On `loadSwarmState`, reconcile agents whose PTY no longer exists (mirror
  `agentSessionStore.ts:52-55`): downgrade to `stopped`/`failed` or offer relaunch, then
  call `checkAndRunNextAgents` (`swarmStore.ts:330-349`).
- Call the existing Rust `validate_dependency_graph` (`swarm.rs:108-161`) at launch so a
  cyclic roster errors instead of silently never starting.

**Acceptance:** restart the app during a run -> swarm reconciles instead of showing a
frozen "running"; a cyclic roster is rejected at launch with a clear error.

**Effort:** small. **Depends on:** none.

### Phase 6 - Discoverability + remove dead UI

**Goal:** the room is easy to find and presents one coherent way to launch.

**Problem:** no sidebar nav; dead `startSwarm` template picker; dual template UIs;
inconsistent naming; Play icon opens a config wizard.

**Changes:**
- Add a Swarm entry to the sidebar nav (`Sidebar.tsx:67-76`).
- Resolve the dual-template confusion: either wire the sidebar template picker to launch
  (`startSwarm` currently has no callers) or remove it and keep the wizard as the single
  path.
- Consistent naming ("Swarm") and fix the Play-icon-opens-config affordance
  (`SwarmWorkspace.tsx:337,492`).

**Acceptance:** the swarm room is reachable from the sidebar; there is exactly one launch
path; naming is consistent across dashboard/topbar/room.

**Effort:** small. **Depends on:** none.

### Phase 7 - Connect to Kanban + Review (make the pipeline real)

**Goal:** the advertised "task -> assign -> agent works -> review" chain actually
connects.

**Problem:** no task -> swarm assignment; the review -> Kanban/Review bridge never fires
for swarm panes.

**Changes:**
- Let a Kanban task be assigned to a swarm/agent as its mission input
  (`swarmStore.ts:297-308`).
- Route swarm review signals into the Review room (today the bridge only fires for
  Kanban-owned panes - `terminalStore.ts:399-406`).

**Acceptance:** a Kanban task can be handed to the swarm, and a swarm review signal shows
up in the Review room.

**Effort:** medium. **Depends on:** Phases 1-2 (swarm must reliably run first).

### Phase 8 - Tests + hardening

**Goal:** lock in the fixes so they do not regress.

**Changes:**
- Unit tests: `runAgentScan` scheduling/blocking/completion, `updateAgentStatus` +
  auto-approve, marker + exit detection.
- Rust test for `validate_dependency_graph_inner` (`swarm.rs`).

**Acceptance:** the scheduler, status machine, and marker/exit detection have unit
coverage that fails if their logic breaks.

**Effort:** small-medium. **Depends on:** Phases 1-5 (test the fixed behavior).

### Phase 9 - `saple-memory` bridge [optional, deferred]

**Goal:** decide whether the in-app swarm should register agents/runs in the
`saple-memory` graph (`create_agent`/`create_run`/`append_run_event`) so
`get_swarm_status` reflects reality.

**Note:** architectural decision, not a bug fix. Today they are two unrelated systems.
Defer until Phases 1-8 land.

**Effort:** large. **Recommendation:** defer.

---

## 3. Suggested order

1. Phase 1 (silent stalls) - unblocks completion.
2. Phase 2 (review approval) - unblocks review pipelines.
3. Phase 3 (preflight) - unblocks first-run.
4. Phase 5 (recovery + cycle check) - removes permanent-stall states.
5. Phase 4 (observability) - makes remaining issues diagnosable.
6. Phase 6 (discoverability) - friction removal.
7. Phase 7 (Kanban/Review integration) - delivers the stated product value.
8. Phase 8 (tests).
9. Phase 9 (saple-memory) - optional/deferred.

Phases 1-3 are the "make a swarm run to completion" set and should land first.

---

## 4. Open decisions

1. **Review semantics (affects Phase 2):** when an agent hits `review`, should dependents
   (a) wait for human Approve, or (b) proceed on `review` as if done and let the reviewer
   gate only the final output?
   Default: **(a) wait for Approve** - matches the "reviewer validates before builders
   continue" intent.
2. **`saple-memory` bridge (affects Phase 9):** is making the in-app swarm show up in the
   memory graph's `get_swarm_status` a goal, or are the two systems fine staying separate?
   Default: **keep separate for now** (Phase 9 deferred).
