# SAPLE Bridge Swarm Orchestration Improvement Plan

Status: Proposed  
Created: 2026-08-04  
Scope: Local-first multi-agent swarm orchestration in SAPLE Bridge  
Primary implementation areas: `src/stores/swarmStore.ts`, `src/lib/swarm*.ts`, `src/stores/terminalStore.ts`, `src-tauri/src/swarm.rs`, `src-tauri/src/pty.rs`, `src-tauri/src/review.rs`, `src-tauri/src/june_control.rs`

## 1. Purpose

This plan turns SAPLE Bridge's current swarm prototype into a deterministic, project-scoped, provider-aware orchestration runtime without copying Traycer's full product architecture.

The current implementation already has valuable orchestration behavior:

- Coordinator-authored task plans
- Dependency-aware task scheduling
- Parallel worker limits
- Automated reviewer gates
- Bounded rework
- Whole-mission acceptance commands
- Repair waves and escalation
- Persistent local swarm state

The main problem is not missing orchestration features. The problem is that the orchestration authority is concentrated in a large renderer store and depends on mutable UI state, PTY text markers, shell heuristics, and several parallel persistence models. The improvement program therefore prioritizes correctness, isolation, and one authoritative runtime before expanding swarm capabilities.

## 2. Target outcome

At the end of this program, SAPLE Bridge should provide the following guarantees:

1. A swarm can never reach `completed` without satisfying an explicit verification contract.
2. An asynchronous result can only mutate the swarm, plan revision, agent, and attempt that created it.
3. Switching projects cannot redirect scheduler, acceptance, provider, or PTY events into another project's swarm.
4. `manual`, `gated`, and `auto` autonomy modes have distinct, enforced behavior.
5. Rust owns the authoritative swarm state machine, scheduler, persistence, and process lifecycle.
6. React/Zustand is a projection of authoritative state and cannot independently advance the swarm.
7. Provider-specific behavior is hidden behind a small provider adapter seam.
8. Structured provider events are the primary lifecycle signal where supported; PTY markers are a compatibility fallback.
9. Every launch has a unique attempt identity and, where supported, a durable provider session identity.
10. Parallel editing agents do not write into the same working tree.
11. Reviewers inspect the exact task attempt diff that they are judging.
12. Messages have explicit sender, receiver, delivery, and reply state.
13. Recovery after application restart is deterministic and does not silently relaunch, fail, or complete the wrong work.
14. Existing legacy paths are removed as each replacement becomes authoritative.

## 3. Architectural direction

### 3.1 Target module

Create one deep Rust module, referred to throughout this plan as `SwarmEngine`.

Its external interface should remain small:

```text
capabilities() -> runtime and provider capabilities
command(project, request_id, command) -> accepted result or typed rejection
observe(project, swarm_id, after_sequence) -> snapshot plus ordered events
```

`start`, `pause`, `resume`, `approve plan`, `reject plan`, `stop`, `approve rework`, and similar actions are variants of `command`; they are not separate Tauri commands.

The module hides:

- Plan validation
- Plan revisions
- State transitions
- Dependency scheduling
- Launch attempts
- Reviewer gates
- Acceptance execution
- Repair waves
- Coordinator recovery
- Persistence
- Event sequencing
- Provider selection
- Worktree lifecycle
- Message delivery

This interface becomes both the caller interface and the principal test surface.

### 3.2 Target data flow

```text
React UI / Zustand projection
            |
            | command / observe
            v
       Rust SwarmEngine
        /      |       \
       /       |        \
state +     provider     Git worktree
events      adapters     integration
  |             |
  v             v
.saple/      Claude / Codex / legacy PTY
swarm/
```

### 3.3 Replace, do not layer

The migration must not leave a fourth orchestration path.

As behavior moves into `SwarmEngine`, the equivalent logic must be deleted from:

- `swarmStore.ts`
- `terminalStore.ts`
- `juneDispatcher.ts`
- `agentSessionStore.ts`
- `controlPlane.ts`

Temporary compatibility code must have an explicit removal phase and must never write authoritative state in parallel with the new engine.

### 3.4 Constraints

- Remain local-first.
- Preserve Tauri's filesystem and process trust boundary.
- Use existing atomic-write and containment helpers.
- Use native Git worktrees; add no worktree dependency.
- Start with JSON/JSONL persistence; add no database until a measured need exists.
- Start structured provider support with Codex and Claude.
- Do not add Yjs, multi-host orchestration, cloud coordination, or protocol-version machinery.
- Do not implement `debate` execution until the core runtime is stable and there is a concrete product requirement.
- Do not keep unsupported provider or strategy values in the public plan contract as promises for later.

## 4. Program rules

### 4.1 Phase discipline

Every phase must:

- Begin from a green baseline.
- Be independently reviewable and releasable where practical.
- Include migration behavior for persisted state it changes.
- Add the smallest tests that prove its new invariant.
- Delete superseded implementation in the same phase or the immediately following cleanup task.
- End with explicit exit criteria.

No later phase begins until the prior phase's exit criteria pass.

### 4.2 Required validation commands

Run the commands relevant to the files changed in each phase:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

For phases involving PTYs, process trees, shell commands, filesystem watching, or worktrees, also run the phase-specific Windows integration checks defined below.

### 4.3 Common terminology

- **Swarm**: one mission execution with a stable `swarmId`.
- **Plan revision**: a monotonically increasing version of the sanitized plan accepted by the engine.
- **Task**: a logical plan node with a stable task ID.
- **Agent**: the logical actor assigned to a task or coordinator role.
- **Attempt**: one concrete launch of an agent, identified by a unique `attemptId`.
- **Provider session**: the provider-native session or thread ID used for resume.
- **Wave**: tasks added to repair a failed mission-level verification.
- **Verification contract**: either an executable command or an explicit human-verification requirement.
- **Projection**: UI state derived from the engine snapshot and events.

## 5. Roadmap summary

| Phase | Name | Primary result | Depends on | Relative size |
|---|---|---|---|---|
| 0 | Baseline and contract freeze | Reproducible current behavior and explicit invariants | None | Small |
| 1 | Completion and autonomy correctness | Verified completion and truthful approval modes | Phase 0 | Medium |
| 2 | Project, run, and attempt isolation | No cross-project or stale-async mutations | Phase 1 | Medium |
| 3 | Process and provider launch hardening | Reliable commands, watchers, and honest provider support | Phase 2 | Medium |
| 4 | Authoritative Rust SwarmEngine | One deep orchestration module and thin UI projection | Phase 3 | Large |
| 5 | Structured provider adapters | Typed lifecycle events, sessions, and reliable resume | Phase 4 | Large |
| 6 | Worktree isolation and integration | Collision-free parallel editing and exact review diffs | Phase 5 | Large |
| 7 | Durable routed messaging | Attributed, resumable agent communication | Phase 5 | Medium |
| 8 | Provider-aware scheduling | Capability/readiness/cooldown-based assignment | Phases 5 and 7 | Medium |
| 9 | Operator UX and observability | Approval, timeline, recovery, and escalation controls | Phases 4-8 | Medium |
| 10 | Consolidation and release hardening | Legacy deletion and production-readiness evidence | Phases 0-9 | Medium |

---

# Phase 0: Baseline and contract freeze

## Goal

Create a reliable baseline before changing the state machine. Document what is intentionally retained, what is currently incomplete, and which behaviors must not regress.

## Why this phase comes first

The existing scheduler has accumulated fixes for marker scoping, away-project terminal events, reviewer re-entry, coordinator recovery, and atomic state updates. Moving code without characterizing these behaviors risks recreating previously fixed races.

## Deliverables

- A checked-in swarm behavior specification.
- Deterministic fixtures for plan, verdict, outcome, and persisted state parsing.
- Characterization tests around the current scheduler and acceptance flow.
- A frozen list of provider capabilities currently supported in practice.
- Removal or rejection of contract values that are parsed but not implemented.

## Work items

### P0.1 Record state-machine invariants

Add a concise `docs/swarm-runtime-invariants.md` or an equivalent section near the engine tests covering:

- Legal swarm status transitions.
- Legal agent status transitions.
- Dependency-gate semantics.
- Reviewer approval and rejection semantics.
- Rework budget semantics.
- Coordinator crash budget semantics.
- Acceptance and repair-wave semantics.
- Pause, resume, stop, and restart behavior.
- Which state changes require operator approval in each autonomy mode.

The specification must state forbidden transitions, not only happy paths. Examples:

- A stale attempt cannot move an agent to `done`.
- An acceptance result for plan revision N cannot complete revision N+1.
- A reviewer cannot approve a task attempt it did not inspect.
- A project-scoped event cannot mutate another project.
- A blocked dependency can never be treated as satisfied.

### P0.2 Add canonical test fixtures

Create small fixtures for:

- Valid command-verification plan.
- Valid human-verification plan.
- Missing verification.
- Invalid provider.
- Duplicate task IDs.
- Unknown dependency.
- Self-dependency.
- Multi-node dependency cycle.
- Reviewed task with downstream dependency.
- Reviewer approval verdict.
- Reviewer rejection verdict.
- Corrupt final JSON/JSONL record.
- Persisted swarm interrupted during planning, execution, review, and acceptance.

Fixtures should be data-only. Avoid a fixture-builder abstraction until duplication becomes material.

### P0.3 Characterize the existing scheduler

Extend `src/stores/swarmStore.test.ts` only enough to pin current intended behavior:

- Ready tasks launch once.
- Parallel capacity is respected.
- Dependants wait for all gates.
- Reviewer rejection triggers one bounded rework.
- Invalid reviewer output parks instead of guessing.
- Identical acceptance failure escalates at the configured threshold.
- Maximum waves escalate.
- A completed coordinator does not make unfinished workers complete.
- Duplicate marker or watcher delivery remains idempotent.

These tests are temporary protection for the extraction. Phase 4 replaces them with tests at the engine interface and deletes tests that only describe Zustand internals.

### P0.4 Freeze unsupported plan features

Make a product decision and encode it immediately:

- `strategy: "single"` remains supported.
- `strategy: "debate"` is rejected or normalized with a visible plan warning until an execution design exists.
- Arbitrary provider strings are rejected.
- `provider: "auto"` remains supported as a routing request.
- Explicit provider IDs must exist in the runtime capability catalog.

Do not leave `debate` and arbitrary providers appearing accepted while their behavior is absent.

### P0.5 Capture baseline results

Record:

- Test counts and pass/fail result.
- Typecheck and lint result.
- Rust test result.
- A manual one-coordinator/one-worker/one-reviewer smoke run.
- Current state files written during that smoke run.
- Current recovery behavior after closing the app during a worker run.

Store only a concise result summary; do not commit provider transcripts or credentials.

## Expected files

- `src/lib/swarmPlan.ts`
- `src/lib/swarmPlan.test.ts`
- `src/stores/swarmStore.test.ts`
- `src/types/swarmPlan.ts`
- New invariant documentation or test fixture files

## Exit criteria

- Current intended scheduler behavior is represented by runnable tests.
- Unsupported plan values no longer silently survive sanitization.
- The team agrees on the state-machine and autonomy invariants.
- TypeScript and Rust checks are green.
- No runtime architecture has been added yet.

## Rollback

This phase is tests, validation, and contract honesty. Revert individual contract changes if they block existing saved plans, but keep the characterization tests and document the compatibility exception.

---

# Phase 1: Completion and autonomy correctness

## Goal

Make `completed` a trustworthy state and make autonomy modes match their UI descriptions.

## Required design decisions

### Verification contract

Replace nullable acceptance semantics with an explicit discriminated contract:

```ts
type VerificationContract =
  | { kind: 'command'; command: string; description?: string }
  | { kind: 'human'; description: string };
```

Compatibility parsing rules:

- Existing `{ acceptance: { command } }` becomes `{ kind: "command" }`.
- Explicit human verification must be written as such; absence is not human verification.
- Missing or malformed verification makes the plan invalid and parks the coordinator for correction.
- An empty task list may be valid only if verification is still explicit.

### Plan revision

Add:

```text
planRevision: integer
approvedPlanRevision: integer or null
verifiedPlanRevision: integer or null
```

Rules:

- Increment `planRevision` whenever the sanitized plan meaningfully changes.
- Re-reading identical content does not increment it.
- Any revision change resets plan approval and verification.
- A command verification result carries the revision it executed.
- Human verification carries the revision the operator approved.
- `completed` requires `verifiedPlanRevision === planRevision`.

Use deterministic serialization of the sanitized plan for equality. A separate cryptographic hash is unnecessary unless the revision later crosses a remote trust boundary.

## Autonomy semantics

### Manual

Require operator approval for:

- Initial plan
- Each newly appended plan revision
- Each task launch batch
- Reviewer-requested rework
- Acceptance-command execution
- Repair-wave continuation
- Force-completion

### Gated

Require operator approval for:

- Initial plan and acceptance command
- Material changes to the plan or verification contract
- Rework beyond the configured automatic budget
- Any force-completion
- Continuing after escalation

Allow automatically:

- Launching tasks from the approved revision
- Reviewer-approved dependency advancement
- Rework within the approved budget
- Running the already approved acceptance command
- Repair waves that do not alter the verification command and remain within the approved wave budget

### Auto

Allow the same transitions as gated without plan approval, subject to:

- Valid verification contract
- Parallelism cap
- Rework cap
- Wave cap
- Provider capability and readiness
- No destructive operator-only actions

## Work items

### P1.1 Extend plan and persisted state types

Add verification, plan revision, approval, and verification revision fields. Keep migration defaults explicit rather than relying on falsy values.

Suggested states:

```text
planApprovalStatus: not_required | pending | approved | rejected
verificationStatus: idle | awaiting_human | running | passed | failed
```

Persist the exact command and revision used for the last verification result.

### P1.2 Validate the complete plan before materialization

Plan ingestion order must become:

1. Read untrusted file.
2. Parse and sanitize.
3. Validate verification contract.
4. Validate provider and strategy support.
5. Compare with current sanitized plan.
6. Create the next revision if changed.
7. Reset stale approval and verification.
8. Persist revision state.
9. Materialize tasks only if the autonomy gate allows it.

Never materialize part of a revision and then discover that its verification contract is invalid.

### P1.3 Add plan approval commands and UI state

Add store actions temporarily, later replaced by engine commands:

- `approvePlan(projectPath, revision)`
- `rejectPlan(projectPath, revision, feedback)`
- `approveVerification(projectPath, revision)` for human verification

Each action must use compare-and-set semantics: reject a request if the current revision differs from the revision shown to the operator.

### P1.4 Bind acceptance to revision

Before starting acceptance, capture:

```text
projectPath
swarmId
planRevision
command
```

After the process exits, re-check all four values. A mismatch records a diagnostic event but does not alter the live swarm.

### P1.5 Prevent unverified completion

Centralize completion eligibility in one pure function:

```text
canComplete(snapshot) -> Complete | Wait(reason) | Escalate(reason)
```

It must check:

- All required tasks and review gates are done.
- No failed or blocked tasks remain.
- Coordinator finalization requirements are satisfied.
- The current plan revision is verified.
- Verification is not stale, running, or rejected.

All completion paths must call this function. No UI or marker handler may set `completed` directly.

### P1.6 Migrate existing state

For old `state.json` files:

- Assign `planRevision = 1` when a plan exists, otherwise `0`.
- Treat old `acceptanceStatus = passed` as verified only if the persisted command exactly matches the current parsed command.
- Treat a missing verification contract as `pending correction`, never passed.
- Preserve terminal historical swarms for display, but do not retroactively claim they were verified.

## Tests

- Missing verification cannot complete.
- Malformed verification cannot materialize tasks.
- Human verification requires an explicit operator command.
- Gated plan remains pending until approved.
- Approval for revision N cannot approve revision N+1.
- Changing only the acceptance command resets approval and verification.
- Changing only a task mission resets approval and verification.
- Re-reading identical sanitized plan content does not reset progress.
- Acceptance pass for revision N cannot complete N+1.
- Human verification for revision N cannot complete N+1.
- Auto mode still enforces verification, wave, and rework budgets.

## Expected files

- `src/types/swarmPlan.ts`
- `src/lib/swarmPlan.ts`
- `src/lib/swarmPlan.test.ts`
- `src/stores/swarmStore.ts`
- `src/stores/swarmStore.test.ts`
- `src/components/swarm/SwarmComposer.tsx`
- `src/components/swarm/SwarmWorkspace.tsx`
- State migration helper or test fixture

## Exit criteria

- There is no code path that sets `completed` without current-revision verification.
- Gated mode visibly and functionally waits for plan approval.
- Stale verification is impossible by test.
- Old state loads without crashing and never gains a false verified state.

---

# Phase 2: Project, swarm, plan, and attempt isolation

## Goal

Ensure every asynchronous operation is scoped to the exact work that created it.

## Core identity model

Introduce immutable references:

```ts
interface SwarmRef {
  projectPath: string;
  swarmId: string;
}

interface PlanRef extends SwarmRef {
  planRevision: number;
}

interface AttemptRef extends PlanRef {
  agentId: string;
  attemptId: string;
}
```

Do not pass bare `projectPath` into long-running orchestration operations after this phase.

## Work items

### P2.1 Replace global scheduler flags

Replace module-global `agentScanInFlight` and `agentScanQueued` booleans with a keyed structure:

```text
Map<swarmId, { inFlight: boolean, queued: boolean }>
```

Rules:

- Only one scan per swarm runs at once.
- Different swarms may scan independently.
- A queued scan retains its own `SwarmRef`.
- Removing or replacing a swarm clears its scheduler entry.
- A scan checks that its `SwarmRef` remains current before every commit.

### P2.2 Create attempt IDs

Mint a new UUID for every initial launch, retry, rework, crash recovery, or manual relaunch.

Persist on the agent:

```text
currentAttemptId
attemptNumber
attemptStartedAt
providerSessionId
```

Include `attemptId` in:

- Prompt file name
- Outcome file
- Verdict target
- Lifecycle markers
- PTY session metadata
- Acceptance digest entries
- Event records

Recommended compatibility layout:

```text
.saple/swarm/attempts/<attemptId>/prompt.md
.saple/swarm/attempts/<attemptId>/outcome.json
.saple/swarm/attempts/<attemptId>/verdict.json
```

Keep legacy outcome and verdict paths readable during migration, but write new attempts only to the attempt directory.

### P2.3 Add a single stale-result guard

Create one shared helper used by every asynchronous completion path:

```text
isCurrentAttempt(ref) -> boolean
```

Use it after:

- PTY creation
- Prompt delivery
- Provider process exit
- Marker detection
- Verdict file read
- Outcome file read
- Acceptance process completion
- Coordinator quiet-period wait
- Coordinator recovery delay
- Watcher debounce

Do not scatter ad hoc `loadedProjectPath` comparisons across callers once this helper exists.

### P2.4 Scope terminal routing by attempt

Change pane/session linkage from `terminalId -> agentId` to:

```text
terminalId -> AttemptRef
```

When a marker or exit arrives:

1. Resolve the exact attempt reference from the pane.
2. Ask the swarm runtime whether it is current.
3. Apply the transition only when current.
4. Record stale output as diagnostic history without advancing state.

### P2.5 Make saves identity-aware

Every state save must include the swarm ID it intends to write. Before atomic replacement:

- Read or lock the current state identity.
- Reject an attempt to save a different swarm over it.
- Never serialize whichever Zustand swarm happens to be active under a captured old project path.

### P2.6 Reconcile restart state conservatively

On load:

- A persisted running attempt with no live process becomes `interrupted`, not immediately `failed`.
- The swarm becomes `paused_recovery` or equivalent.
- The operator can resume, retry, or stop.
- Automatic resume is allowed only for providers with a durable session ID and an explicit safe-resume capability.
- Never infer task completion from the presence of an outcome file unless its `attemptId` matches.

## Tests

Use deferred promises/fake invokes to control ordering:

- Project A acceptance finishes after project B loads; B remains unchanged.
- Project A scan queues while project B scans; each uses its own state.
- Attempt 1 exits after attempt 2 starts; attempt 2 remains running.
- Attempt 1 emits a valid completion marker after attempt 2 starts; marker is ignored.
- Old reviewer verdict cannot approve a new builder attempt.
- Old outcome file cannot enter a new digest.
- Stale save cannot overwrite a newer swarm in the same project.
- Restarted running attempt becomes interrupted and requires a defined recovery action.

## Expected files

- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- `src/types/agent.ts`
- `src/lib/agentSignals.ts`
- `src/lib/swarmPrompts.ts`
- Relevant tests
- `.saple/swarm/state.json` migration logic

## Exit criteria

- No long-running orchestration function operates with only a project path.
- Every launched process has a unique attempt ID.
- Stale attempt output is harmless by test.
- Concurrent swarms no longer share scheduler flags.
- Restart reconciliation exposes interruption instead of guessing failure or success.

---

# Phase 3: Process, watcher, and provider launch hardening

## Goal

Remove process-level failure modes before moving authority into Rust.

## Work items

### P3.1 Re-arm the first-swarm watcher

After `ensure_workspace_dirs` creates `.saple/swarm`, explicitly arm `watch_swarm_dir`.

Improve the watcher command contract so it reports one of:

```text
armed
already_armed
directory_missing
```

Do not silently return success for a missing directory. The caller must know whether it has a watcher.

Add a test or Rust-level temporary-directory check:

1. Watch before directory exists.
2. Confirm `directory_missing`.
3. Create workspace directories.
4. Watch again.
5. Write `plan.json`.
6. Confirm one classified event.

### P3.2 Drain command output while processes run

Fix `run_shell_with_timeout` so stdout and stderr are drained concurrently from process start.

Minimum standard-library design:

- Take stdout and stderr handles immediately after spawn.
- Start one reader thread per stream.
- Poll or wait for process completion with the existing timeout policy.
- On completion or termination, join readers.
- Truncate only after the full captured output is assembled.
- Bound memory if output is unbounded; retain the beginning and tail with an explicit truncation marker.

Test with output larger than typical OS pipe capacity on both stdout and stderr.

### P3.3 Terminate the command process tree

Extract the existing PTY process-tree behavior into a small shared Rust module only because it will have two real callers:

- PTY sessions
- Review/acceptance command runner

Windows:

- Assign the spawned shell to a Job Object configured for kill-on-close.
- Terminate the Job Object on timeout.

Unix:

- Create a process group/session.
- Send termination to the group.
- Escalate only if the group does not exit within a short grace period.

Verify that a command spawning a long-lived child leaves no descendant after timeout.

### P3.4 Centralize provider capabilities

Create one Rust-owned capability record per provider:

```text
providerId
installed
authenticated
acceptsInitialPrompt
supportsInteractiveTurns
supportsStructuredEvents
supportsResume
supportsRateLimitEvents
supportsA2A
supportsHeadlessWorker
```

Expose this record to TypeScript. Remove independently maintained provider behavior lists from:

- `providerMeta.ts`
- `provider.ts`
- `pty.rs`
- `swarmStore.ts`

Display labels and model suggestions may remain in the frontend; execution capability must come from Rust.

### P3.5 Fail before launch

At plan approval/materialization:

- Reject unknown providers.
- Reject disabled providers.
- Reject providers that cannot receive an initial worker prompt.
- Reject unavailable explicit providers with an actionable error.
- Leave `auto` unresolved until the scheduler chooses a capable provider.
- Never silently substitute an explicit provider.

For this phase, Cursor and Copilot swarm workers should be disabled unless their prompt-delivery path is proven by an integration test.

### P3.6 Replace fixed readiness delays where evidence exists

Keep the existing delay only as a declared fallback. For providers with detectable readiness:

- Parse a known startup event or prompt-ready signal.
- Deliver the initial prompt once.
- Time out with a typed `provider_not_ready` failure.

Do not build provider-specific readiness probes for every CLI at once. Add them when a supported adapter can prove readiness semantically.

## Tests

- First swarm in a new project receives watcher events.
- Verbose command exceeding pipe capacity completes normally.
- Timed-out command leaves no child process.
- Unknown provider is rejected during plan validation.
- Explicit unavailable provider parks the plan with a useful reason.
- Cursor/Copilot worker cannot launch without a supported prompt path.
- Capability response and actual Rust launch behavior agree.

## Expected files

- `src-tauri/src/watcher.rs`
- `src-tauri/src/review.rs`
- `src-tauri/src/pty.rs`
- New shared process-tree implementation if extraction is needed
- `src-tauri/src/providers.rs` or the existing provider module
- `src/stores/providerStore.ts`
- `src/components/swarm/wizard/providerMeta.ts`
- `src/types/provider.ts`

## Exit criteria

- Acceptance/review commands cannot deadlock on output pipes.
- Timeout terminates the process tree.
- First-run watching is deterministic.
- Every provider shown as swarm-capable has a proven prompt-delivery path.
- Provider capability has one authoritative source.

---

# Phase 4: Authoritative Rust SwarmEngine

## Goal

Move orchestration authority from mutable renderer state into one deep Rust module while preserving current behavior.

## Non-goals

- No provider SDK expansion in this phase.
- No worktrees yet.
- No new A2A transport.
- No new debate strategy.
- No simultaneous legacy and new schedulers.

## Engine interface

### Commands

Start with the minimum command variants required by existing UI behavior:

```text
StartSwarm
ApprovePlan
RejectPlan
PauseSwarm
ResumeSwarm
StopSwarm
ApproveRework
ForceCompleteAgent
PostOperatorMessage
ContinueEscalatedSwarm
```

Internal process and watcher events should enter through private engine methods, not public renderer commands.

Every mutating command includes:

```text
requestId
expectedSwarmId
expectedPlanRevision where applicable
```

The engine returns typed results such as:

```text
accepted
already_applied
stale_swarm
stale_plan
invalid_transition
approval_required
provider_unavailable
conflict
```

### Observation

`observe` returns:

```text
snapshot
events where sequence > afterSequence
nextSequence
```

The UI applies snapshots/events idempotently and never manufactures authoritative transitions.

## Persistence model

### Snapshot

Continue using:

```text
.saple/swarm/state.json
```

Add:

```text
schemaVersion
lastSequence
swarmId
planRevision
approvedPlanRevision
verifiedPlanRevision
agents and attempts
pending approvals
provider assignments
recovery state
```

### Event log

Add:

```text
.saple/swarm/events.jsonl
```

Envelope:

```json
{
  "schemaVersion": 1,
  "sequence": 42,
  "swarmId": "swarm_...",
  "occurredAt": 0,
  "requestId": null,
  "attemptId": null,
  "type": "task.completed",
  "payload": {}
}
```

Rules:

- One Rust writer per project.
- Monotonic sequence persisted in the snapshot.
- Append event before publishing it to observers.
- Snapshot after applying the transition.
- A dropped Tauri notification causes delayed observation, not lost state.
- On restart, load snapshot then replay later events if present.
- Ignore only a final incomplete JSONL line caused by interruption; malformed records in the middle are corruption and must surface an error.
- Compact only after measured log growth warrants it. Initial release may retain the complete local log.

### Command idempotency

Persist enough recent mutating request IDs to make UI retries safe.

Use a bounded recent-result list in the snapshot. Do not add a database. Reusing a request ID with different command content must return a conflict.

## Extraction sequence

### P4.1 Create engine state and persistence

- Define Rust snapshot, plan, task, agent, attempt, verification, and event types.
- Implement schema-versioned loading.
- Implement atomic snapshot writes with existing helpers.
- Implement JSONL event append and replay.
- Implement per-project engine registry/locking.
- Add corruption and incomplete-tail tests.

### P4.2 Port plan validation

- Port the sanitized plan parser to Rust.
- Match current safe-ID, dependency, duplicate, and cycle behavior.
- Add verification and provider capability validation.
- Keep TypeScript parsing only for display previews until the UI consumes Rust's sanitized plan.
- Delete TypeScript authority once parity tests pass.

Use shared fixture JSON files so Rust and TypeScript parity can be proven temporarily without maintaining duplicate test cases forever.

### P4.3 Port the scheduler

Model transitions as deterministic functions over engine state:

```text
apply_command(state, command) -> state changes + effects + events
apply_runtime_event(state, event) -> state changes + effects + events
```

Effects are descriptions such as:

```text
LaunchAttempt
TerminateAttempt
RunVerification
NotifyCoordinator
CreateReviewer
PersistEscalation
```

Execute effects after the transition is durably recorded. Feed effect results back as runtime events with the originating identity.

Scheduler responsibilities:

- Propagate blocked dependencies.
- Determine ready tasks.
- Respect maximum parallelism.
- Create reviewer gates.
- Detect wave completion.
- Start verification.
- Request repair or escalation.
- Determine completion through the centralized invariant.

### P4.4 Port review and rework

- Read verdicts through Rust containment-safe file access.
- Validate task ID, attempt ID, reviewer identity, and plan revision.
- Approval completes the review gate.
- Rejection consumes the configured rework budget.
- Reset prior verdict state on a new attempt.
- Clear or archive stale verdict files.
- Require operator approval when autonomy or budget demands it.

### P4.5 Port acceptance and repair waves

- Launch verification as an engine effect.
- Carry `SwarmRef` and `planRevision` through the result.
- Persist output truncation and timeout state.
- Maintain identical-failure detection.
- Ensure a repair plan revision invalidates prior verification.
- Escalate with a structured, persisted reason.

### P4.6 Port coordinator lifecycle

- Store coordinator attempt and provider session state in the engine.
- Deliver digests through an effect.
- Preserve one bounded crash recovery.
- Escalate after the recovery budget.
- Replace quiet-time decisions with provider capabilities where available; retain the existing heuristic only in the legacy adapter.

### P4.7 Replace the frontend store

Reduce `swarmStore.ts` to:

- Current projected snapshot
- Last applied event sequence
- Loading/error state
- Thin command dispatchers
- Selectors used by the UI

Remove public methods that directly advance agent or swarm state, including scheduler scans and direct status updates.

Target external store actions:

```text
load
refresh/observe
command
clearProjection
```

The exact names may differ, but the interface should remain this small.

### P4.8 Route June through the same engine

For swarm-related June actions:

- Rust HTTP handler calls `SwarmEngine::command` directly.
- `observe` reads the same durable engine events.
- Remove renderer-mediated swarm mutation from `juneDispatcher.ts`.
- Preserve June's external request/response compatibility where required.

June terminal and browser actions may remain renderer-mediated if they are outside swarm authority.

### P4.9 Migrate legacy state once

- Detect legacy snapshot schema.
- Parse using a dedicated migration function.
- Write the new schema atomically.
- Preserve the old file as a single backup only during the migration window if needed.
- Never dual-write old and new schemas.
- Record a `state.migrated` event.
- Remove the migration backup after a successful subsequent load or leave cleanup to Phase 10.

## Engine tests

Create an in-memory filesystem or temporary-directory test harness and a fake effect executor.

Test entirely through `command` and `observe`:

- Start -> plan -> approval -> parallel tasks -> review -> verification -> completion.
- Review rejection -> rework -> approval.
- Missing verification -> plan rejection.
- Stale plan approval -> typed rejection.
- Stale attempt event -> diagnostic only.
- Failed dependency -> dependant blocked.
- Acceptance failure -> repair wave.
- Repeated identical failure -> escalation.
- Maximum waves -> escalation.
- Command retry with same request ID -> same result.
- Same request ID with different body -> conflict.
- Restart from every major state.
- Incomplete final event-log line recovery.
- Middle-log corruption refusal.

Delete Zustand-internal tests once equivalent engine-interface tests exist.

## Expected files

- `src-tauri/src/swarm.rs` as the Tauri command seam
- New `src-tauri/src/swarm_engine.rs` initially
- Additional private implementation files only when the single file becomes materially hard to navigate
- `src-tauri/src/lib.rs`
- `src-tauri/src/june_control.rs`
- `src/lib/juneDispatcher.ts`
- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- Shared JSON fixtures

## Exit criteria

- Rust is the only authority that can transition swarm or agent state.
- `swarmStore.ts` is a projection with a small interface, not a scheduler.
- June and the UI drive the same engine.
- State survives restart and event replay through engine-interface tests.
- No legacy scheduler runs alongside the engine.
- Every removed TypeScript transition has an equivalent Rust engine test.

## Rollback

Rollback is release-level, not runtime dual authority. Keep the pre-migration application version able to read its original state backup. Do not add a live feature flag that allows both engines to mutate one swarm.

---

# Phase 5: Structured provider adapters and durable sessions

## Goal

Replace provider shell assumptions and PTY marker scraping with provider-specific adapters that emit one normalized runtime event model.

## Why this seam is justified

There are multiple real production implementations—Codex, Claude, and legacy PTY providers—and a fake test implementation. Provider behavior genuinely varies, so an adapter seam earns its complexity.

## Internal adapter interface

Keep it private to `SwarmEngine`:

```text
capabilities() -> ProviderCapabilities
prepare(attempt) -> ProcessSpec
start(process_spec, event_sink) -> RunningProcess
send_turn(session, message) -> result
resume(session, message, event_sink) -> RunningProcess
terminate(process) -> result
```

If the actual implementation can combine `prepare` and `start` without harming tests, prefer the smaller interface.

## Normalized event model

Start with only events the scheduler needs:

```text
session.started
session.resumed
turn.started
text.delta
tool.started
tool.completed
file.changed
usage.updated
provider.notice
turn.awaiting_input
turn.completed
turn.failed
process.exited
```

Every event carries:

```text
swarmId
planRevision
agentId
attemptId
providerId
providerSessionId when known
timestamp
```

Do not reproduce Traycer's entire event vocabulary. Add event kinds only when the scheduler or UI has a concrete consumer.

## Work items

### P5.1 Create a fake adapter first

The fake adapter must support scripted behavior:

- Emit session started.
- Emit arbitrary typed events.
- Complete or fail a turn.
- Pause until the test sends a reply.
- Simulate rate limiting.
- Simulate late events from stale attempts.
- Simulate resume with a stable provider session ID.

Use it for one deterministic end-to-end engine test before building production adapters.

### P5.2 Implement Codex adapter

Use the provider's supported structured/event protocol available in the installed CLI rather than terminal text scraping.

Responsibilities:

- Construct argv without shell string interpolation.
- Deliver the initial prompt explicitly.
- Capture the provider thread/session ID.
- Parse structured completion and failure events.
- Normalize usage and rate-limit notices when available.
- Resume the same provider session for coordinator digests and reviewer rework.
- Treat unrecognized provider events as logged diagnostics, not crashes.

Pin behavior with recorded, sanitized event fixtures. Do not commit real transcripts or tokens.

### P5.3 Implement Claude adapter

Responsibilities mirror Codex:

- Use the existing bridge-generated Claude session identity where compatible.
- Capture session changes after clear/resume behavior.
- Normalize tool, file, usage, completion, and failure signals.
- Support live coordinator turns through provider-native session interaction where possible.
- Preserve the current PTY display as a view, not the lifecycle authority.

### P5.4 Keep one legacy PTY adapter

All other currently supported CLIs use one declared legacy adapter:

- Prompt piping or supported interactive delivery
- Scoped attempt markers
- Exit-code fallback
- Fixed/readiness heuristic where unavoidable
- No claim of durable resume unless proven
- No claim of A2A or structured rate-limit support

The UI must label these capabilities honestly.

### P5.5 Persist provider sessions

For each agent:

```text
providerId
providerSessionId
sessionCreatedAt
lastResumedAt
resumeCapability
```

Recovery rules:

- Resume only when adapter capability is true and the session ID is present.
- A new attempt may resume the same provider session but always gets a new SAPLE `attemptId`.
- Provider session identity never substitutes for attempt identity.
- If resume fails, park for operator choice; do not silently start a fresh session with missing context.

### P5.6 Demote markers to compatibility

- Structured adapters ignore lifecycle markers for state transitions.
- Legacy adapter continues scoped marker parsing.
- Terminal UI may still display marker text.
- Remove generic bare-marker compatibility after the saved-state migration window.

### P5.7 Capture cost and usage without cloud telemetry

Persist local per-attempt usage when providers expose it:

```text
inputTokens
outputTokens
contextTokens
contextWindow
cost if provider reports it
```

Do not infer pricing or send telemetry externally. Missing data remains unknown.

## Tests

- Full swarm lifecycle with fake adapter and no PTY markers.
- Codex/Claude recorded event fixtures parse deterministically.
- Unknown provider event does not crash the adapter.
- Provider session ID survives restart.
- Resume continues the intended session.
- Resume failure parks instead of silently resetting context.
- Late event from prior attempt is ignored.
- Legacy adapter still handles scoped markers and exits.
- Structured adapter completion cannot be double-applied by a marker.

## Exit criteria

- Codex and Claude use typed lifecycle events.
- Provider session IDs are durable and used for genuine resume.
- Fake adapter drives the main engine end-to-end test.
- Markers are explicitly legacy behavior.
- Unsupported providers are not presented as having structured/resume capabilities.

---

# Phase 6: Per-task worktree isolation and integration

## Goal

Prevent parallel editing agents from modifying the same working tree and ensure reviewers inspect an exact, attributable diff.

## Workspace model

Use three workspace roles:

```text
User workspace       Existing checkout; never mutated by swarm integration automatically.
Integration worktree One per swarm; approved task changes are merged here serially.
Task worktree        One per editing task attempt; created from the current integration head.
```

Read-only scouts may use the integration worktree without receiving write permission through the prompt contract. Editing builders receive task worktrees.

## Git identity

Persist:

```text
repositoryRoot
baseCommit
integrationBranch
integrationWorktreePath
taskBranch
taskWorktreePath
taskBaseCommit
taskHeadCommit
mergeCommit
cleanupStatus
```

Suggested deterministic branch naming:

```text
saple/<short-swarm-id>/integration
saple/<short-swarm-id>/<safe-task-id>/<attempt-number>
```

Paths must be derived under a validated SAPLE-owned worktree root. Never construct deletion targets from unvalidated agent content.

## Work items

### P6.1 Add Git preflight

Before starting an editing swarm:

- Confirm the project is inside a Git repository.
- Resolve canonical repository root.
- Record current commit.
- Detect uncommitted user changes.
- Detect existing conflicting SAPLE branches/worktrees.
- Confirm Git worktree support.

If the project is not a Git repository:

- Default to sequential execution with `maxParallel = 1` for editing tasks.
- Display an explicit isolation warning.
- Require operator confirmation for auto mode.

Do not invent a custom filesystem copy/merge system.

### P6.2 Create integration worktree

- Create from the recorded base commit.
- Keep it outside the user's active checkout.
- Run all mission-level acceptance commands inside the integration worktree.
- Persist creation before launching tasks.
- Reconcile an existing integration worktree on restart rather than creating another.

### P6.3 Create task worktrees just in time

Create a task worktree only when dependencies are satisfied and immediately before launch.

This ensures dependent tasks start from an integration head that includes approved prerequisite changes.

For parallel ready tasks:

- All may branch from the same current integration commit.
- Each writes only to its own worktree.
- Merge ordering is serialized after review approval.

### P6.4 Record task changes

On agent completion:

- Resolve current task head.
- Capture `git status --porcelain` and diff summary.
- Require the task to leave an attributable commit, or have SAPLE create a commit only after explicit author policy is defined.
- Record changed paths, additions, deletions, and head commit.
- Reject changes outside the task worktree/repository containment.

Prefer requiring agents to commit their work because it gives native provenance and makes integration and rollback smaller. If SAPLE creates commits, use a clearly identified SAPLE author and never alter global Git configuration.

### P6.5 Bind review to exact attempt diff

Reviewer prompt and verdict contract must carry:

```text
taskId
attemptId
taskBaseCommit
taskHeadCommit
diff command or precomputed patch path
verification commands
```

The reviewer runs in read-only mode against the task worktree or a detached review checkout.

A verdict is invalid if the task head changes after review begins.

### P6.6 Serialize approved merges

Use one integration queue per swarm:

1. Confirm approved task head still matches the verdict.
2. Confirm integration head matches the expected merge base or prepare a merge.
3. Merge the task branch into the integration branch.
4. Run task-level verification if configured.
5. Record merge commit.
6. Mark the task gate complete.
7. Schedule newly unblocked dependants.

On conflict:

- Abort the merge cleanly.
- Preserve both branches/worktrees.
- Mark the task `integration_conflict`.
- Ask the coordinator for a conflict-resolution task or escalate to the operator.
- Never auto-resolve source conflicts by choosing one side.

### P6.7 Run acceptance in integration worktree

Mission verification must execute against the integrated result, never an arbitrary task worktree or the user's checkout.

Record the integration commit verified by the result. A later merge invalidates that result even if the plan revision did not change.

Extend verification identity:

```text
verifiedPlanRevision
verifiedIntegrationCommit
```

### P6.8 Safe cleanup

Cleanup eligibility requires proof:

- No active attempt uses the worktree.
- Worktree status is clean.
- Task head is merged or intentionally abandoned by operator command.
- Path resolves inside the SAPLE worktree root.

Default cleanup behavior:

- Remove clean, merged task worktrees after swarm completion.
- Keep integration worktree until the operator applies/merges the result or discards it.
- Keep dirty, conflicted, unmerged, or recovery-relevant worktrees.
- Show retained paths to the operator.

No recursive deletion may run against an unresolved path.

## Tests

Use temporary Git repositories:

- Two parallel tasks modify different files and merge successfully.
- Two parallel tasks conflict; conflict is preserved and surfaced.
- Dependent task branches from the commit containing its prerequisite.
- Reviewer verdict becomes stale when task head changes.
- Acceptance runs at the recorded integration commit.
- A later merge invalidates prior acceptance.
- Dirty/unmerged worktree is never automatically removed.
- Non-Git project falls back to sequential, explicitly approved behavior.
- Restart reconciles existing worktrees and branches.
- Malicious task ID cannot escape the worktree root.

## Exit criteria

- Editing agents never share a working tree.
- Review verdicts name an immutable attempt diff.
- Approved changes enter one integration branch through a serialized queue.
- Acceptance identifies the exact integrated commit.
- Cleanup never risks user or unmerged work.

---

# Phase 7: Durable routed messaging and turn delivery

## Goal

Replace mailbox dead drops with explicit, attributable delivery that can wake or resume capable agent sessions.

## Scope discipline

This is local, same-swarm messaging. Do not add cross-host routing, distributed consensus, or cloud mailboxes.

## Message model

```text
messageId
swarmId
from: operator | bridge | agentId
to: coordinator | agentId
threadId
inReplyTo
expectReply
body
createdAt
deliveryState: pending | delivered | acknowledged | failed | cancelled
targetAttemptId when delivery is attempt-specific
```

Messages are engine events and therefore use the existing ordered durable event log. Do not introduce a second message database.

## Work items

### P7.1 Add message commands and events

Commands:

- Send operator message
- Send agent message
- Reply to thread
- Cancel pending message

Events:

- `message.queued`
- `message.delivered`
- `message.acknowledged`
- `message.failed`
- `message.reply_overdue`

Validate that sender and receiver belong to the same swarm and that an agent cannot impersonate another sender.

### P7.2 Define adapter delivery behavior

For adapters supporting live turns:

- Deliver to the current provider session.
- Attribute the sender in the injected content.
- Record delivery only after the adapter accepts the turn.

For resumable but inactive sessions:

- Resume the provider session with the message.
- Create a new SAPLE attempt for the resumed execution.
- Preserve the same provider session ID.

For legacy adapters:

- Keep the message pending.
- Include it in the next relaunch prompt.
- Optionally render the legacy mailbox Markdown as a compatibility projection.
- Never claim live delivery.

### P7.3 Convert coordinator digests

Coordinator result and acceptance digests become ordinary Bridge-authored messages. Remove separate digest-injection orchestration once parity is proven.

The digest log becomes a filtered projection of message events rather than a separate authoritative array.

### P7.4 Add reply tracking

When `expectReply` is true:

- Mint a thread ID.
- Track the outstanding receiver.
- Close the thread only on a correlated reply or explicit cancellation.
- Emit an overdue notice after configurable inactivity.
- Do not automatically fail the swarm solely because a reply is overdue; expose it as awaiting input/escalation context.

### P7.5 Project compatibility files

If `.saple/swarm/mailbox/*.md` remains useful for human inspection:

- Generate it from durable events.
- Mark it as a projection.
- Stop reading it as the source of truth.
- Prevent external edits from silently becoming authenticated agent messages.

Handoff JSON files should similarly become exported artifacts or be removed.

## Tests

- Operator message reaches a live capable coordinator once.
- Message resumes an inactive capable provider session.
- Legacy receiver retains pending message until relaunch.
- Duplicate command request does not duplicate delivery.
- Reply closes the correct thread.
- Wrong `inReplyTo` cannot close another thread.
- Cross-swarm target is rejected.
- Stale attempt-specific message is rejected or retargeted only by explicit command.
- Restart preserves pending messages and thread state.
- Coordinator digest uses the same delivery mechanism as other messages.

## Exit criteria

- Every message has durable sender, receiver, and delivery state.
- A capable inactive agent can be resumed by a message.
- Mailbox files are projections, not authority.
- Coordinator digest delivery no longer has a separate lifecycle path.

---

# Phase 8: Capability- and readiness-aware provider scheduling

## Goal

Make `provider: "auto"` select an actually usable provider and react predictably to provider availability and rate limits.

## Prerequisites

Do not begin until structured adapters emit reliable provider/session failures and provider notices. Scheduling based on scraped error strings would recreate the current heuristic problem.

## Scheduling inputs

Per provider:

```text
enabled
installed
authenticated
capabilities
supportedModels
activeAttemptCount
configuredConcurrencyCap
cooldownUntil
lastLaunchFailure
```

Per task:

```text
requestedProvider: explicit | auto
requestedModel
requiredCapabilities
role
workspace mode
```

## Assignment rules

### Explicit provider

- Validate provider and model before plan approval.
- Wait or park if temporarily unavailable.
- Do not silently switch providers.
- Allow operator to edit the plan assignment or explicitly authorize substitution.

### Auto provider

Filter candidates by:

1. Enabled
2. Installed/authenticated
3. Supports headless or structured worker execution
4. Supports required task capabilities
5. Supports requested model when specified
6. Not in cooldown
7. Below concurrency cap

Select deterministically using:

1. Existing compatible provider session when resuming
2. Lowest active-attempt-to-cap ratio
3. Oldest last-assigned timestamp for fairness
4. Stable provider ID tie-breaker

Avoid opaque scoring or AI-based provider selection until simple deterministic rules are demonstrably insufficient.

## Work items

### P8.1 Move readiness into Rust

Reuse existing CLI/auth checks, but make their result available to `SwarmEngine` directly. The frontend store becomes a projection of the same readiness source.

### P8.2 Add concurrency caps

Support:

- Global swarm maximum parallelism
- Per-provider maximum active attempts

The effective launch capacity is the minimum of both constraints.

Default provider cap may remain unlimited within the global cap until the user configures it or a provider requires a known limit.

### P8.3 Add cooldowns from typed notices

When an adapter supplies a reset time:

- Persist `cooldownUntil` exactly.
- Stop assigning new auto tasks until then.
- Keep explicit-provider tasks waiting with visible reason.

When no reset time exists:

- Use one conservative bounded retry delay.
- Escalate or ask the operator after repeated failures.
- Do not create an unbounded exponential-retry subsystem.

### P8.4 Handle launch failure

For `auto` tasks:

- Mark the candidate temporarily unavailable when failure is capability/readiness related.
- Re-run deterministic assignment.
- Limit reassignment attempts.
- Preserve every failed attempt in history.

For explicit tasks:

- Park with the exact failure.
- Offer operator actions: retry, change provider, stop.

### P8.5 Defer multi-profile subscriptions

Do not copy Traycer's profile-selection system yet.

Add it only when SAPLE supports multiple authenticated profiles for the same provider and users need to assign work across them. Until then, one local provider login is one schedulable resource.

## Tests

- Auto excludes unavailable providers.
- Auto respects required capabilities.
- Explicit provider never silently changes.
- Global and per-provider caps compose correctly.
- Cooldown persists across restart.
- Provider becomes eligible after cooldown.
- Auto launch failure reassigns within a bounded budget.
- Deterministic tie-break produces stable tests.
- Resume stays on the provider/session that owns the context.

## Exit criteria

- `auto` never means “copy the coordinator provider.”
- Scheduler uses authoritative readiness and capability data.
- Rate limits produce visible waiting/cooldown state rather than generic failure loops.
- Explicit assignments remain under operator control.
- No speculative multi-profile subsystem is added.

---

# Phase 9: Operator UX, recovery, and observability

## Goal

Expose the engine's real state and decisions without duplicating its state machine in React.

## UI principles

- UI commands include expected swarm/plan identity.
- Buttons render from engine-reported allowed actions.
- The UI never predicts or commits a transition locally.
- Errors state what happened, which identity was affected, and the next valid action.
- Historical events are clearly separated from current state.

## Work items

### P9.1 Plan approval view

Show:

- Plan revision
- Tasks and dependency graph
- Provider/model assignments
- Review gates
- Parallelism and wave budgets
- Verification contract
- Acceptance command verbatim
- Changes from the previously approved revision
- Validation warnings and unsupported capabilities

Actions:

- Approve displayed revision
- Reject with feedback
- Ask coordinator to revise
- Stop swarm

Disable approval as soon as a newer revision arrives.

### P9.2 Runtime timeline

Project ordered engine events into a timeline:

- Plan created/updated/approved
- Task ready/launched
- Attempt started/resumed/completed/failed
- Reviewer verdict
- Merge queued/completed/conflicted
- Verification started/passed/failed
- Message delivery/reply
- Provider cooldown
- Recovery/escalation

Use event sequence for ordering. Use timestamps only for display.

### P9.3 Agent detail view

Show:

- Logical task and dependencies
- Current attempt ID and attempt number
- Provider and provider session ID, safely truncated
- Worktree and branch
- Base/head/merge commits
- Review target and verdict
- Usage when available
- Pending messages
- Current allowed actions
- Historical attempts

### P9.4 Recovery panel

For interrupted swarms, show an engine-produced recovery assessment:

- Attempts that can resume
- Attempts that require retry
- Dirty or retained worktrees
- Pending approval
- Pending messages
- Last verified plan revision and integration commit

Actions must be explicit:

- Resume safe sessions
- Retry as new attempts
- Mark task for manual inspection
- Stop and retain work
- Stop and clean only proven-safe resources

### P9.5 Escalation panel

Display:

- Escalation reason
- Wave and rework budgets consumed
- Last verification command/output
- Repeated-failure fingerprint summary
- Coordinator diagnosis
- Proposed repair tasks
- Conflicted worktrees or unavailable providers

Actions:

- Approve one additional wave with a new budget
- Edit/change provider assignments
- Send coordinator guidance
- Mark human verification
- Stop and preserve integration worktree

### P9.6 Split large UI files by behavior

After the engine projection is stable, split `SwarmWorkspace.tsx` only along real behavior seams:

- Plan approval
- Runtime timeline
- Agent details
- Recovery/escalation

Do not create generic wrapper components or a second client-side domain model.

### P9.7 Local diagnostics export

Add an operator-triggered export containing:

- Sanitized snapshot
- Engine event log
- Provider capability summary
- Attempt/process exit summaries
- Worktree status
- Application version

Exclude:

- API keys
- Environment secrets
- Full provider transcripts by default
- Arbitrary source contents

## UX tests

- Approval action carries the revision displayed.
- New revision invalidates an open approval button.
- Timeline ordering follows sequence, not timestamp.
- Allowed actions come from engine state.
- Recovery view does not offer resume for unsupported adapters.
- Dirty worktree cannot be cleaned from the normal completion action.
- Keyboard navigation and accessible labels cover approval and destructive actions.

## Exit criteria

- Operator can understand why a swarm is waiting, failed, or escalated.
- Approval and destructive actions are identity-safe.
- UI contains no duplicate scheduler logic.
- Recovery and retained work are visible.
- Large UI files are split only where behavior justifies it.

---

# Phase 10: Consolidation, deletion, and release hardening

## Goal

Delete superseded paths, prove end-to-end behavior, and define the support boundary for the production release.

## Deletion candidates

Delete after confirming no live callers or migration need:

- `startSwarmFromWizard` as an orchestration authority
- Legacy `DEFAULT_TEMPLATES` roster-launch path if mission-first planning is canonical
- `WorkerRequest`/`requests.json` if engine commands and routed messaging replace it
- Best-effort canonical `agents.json`, `runs.json`, and `artifacts.json` writes when they duplicate engine state
- `agentSessionStore` fields derivable from engine attempts
- Renderer-mediated June swarm dispatch
- Bare unscoped lifecycle markers
- Legacy outcome/verdict paths after the migration window
- Separate digest log after digests are message events
- Handoff files after routed messages/artifacts replace them
- Duplicate provider capability tables
- Zustand tests that inspect removed implementation details

Run `rg` for every symbol and file before deletion. Delete only when behavior is already covered through the engine interface.

## End-to-end test matrix

### Deterministic fake-provider suite

Required automated scenarios:

1. Coordinator creates plan; operator approves; two tasks run in parallel; reviewer approves; work merges; verification passes; swarm completes.
2. Reviewer rejects; builder resumes/reworks; reviewer approves; verification passes.
3. Verification fails; coordinator adds repair task; repair merges; verification passes.
4. Verification repeats same failure; swarm escalates.
5. Provider rate limit causes cooldown and auto reassignment.
6. Project switch occurs during every long-running stage; no cross-project mutation.
7. Stale events arrive from prior attempts; no current state changes.
8. Application restarts during planning, building, review, merge, verification, and messaging.
9. Parallel task merge conflict is preserved and escalated.
10. Dirty worktree survives stop and cleanup.

### Real-provider smoke suite

Maintain a documented opt-in local smoke test for Codex and Claude:

- Create a temporary Git repository.
- Ask one worker to make a deterministic small edit.
- Run a deterministic verification command.
- Confirm provider session ID capture.
- Send a follow-up turn using resume.
- Confirm worktree integration and cleanup behavior.

Never require paid-provider smoke tests in the default unit test suite.

### Windows process suite

- Large stdout/stderr command completes.
- Timeout kills descendants.
- PTY close kills provider process tree.
- Application restart reconciles processes and worktrees.
- Paths containing spaces remain contained and correctly quoted.

## Performance and reliability budgets

Measure locally before release:

- Scheduler decision latency after an event.
- Snapshot load and event replay time at representative log sizes.
- PTY/event throughput without UI lockup.
- Memory retained per active attempt.
- Worktree creation and cleanup time.

Use measurements to decide whether event compaction or a database is needed. Do not add either pre-emptively.

Suggested initial operational bounds:

- Event application remains responsive at 10,000 events.
- A duplicate event causes no state change.
- A watcher notification may be lost without losing durable state.
- App restart reconstructs a representative swarm deterministically.
- Default parallelism remains conservative on Windows.

## Migration and compatibility closure

- Document the oldest state schema that the release imports.
- Import old schema once; never dual-write.
- Mark legacy provider adapters clearly.
- Provide a recovery message when state is too new or corrupt.
- Preserve user worktrees and state files on migration failure.
- Remove temporary migration code only after the supported upgrade window.

## Release gate

Release only when:

- All phase exit criteria pass.
- TypeScript and Rust validation commands are green.
- Deterministic end-to-end suite is green.
- Codex and Claude smoke runs pass on Windows.
- No known path can complete without current verification.
- No known cross-project or stale-attempt mutation remains.
- Process timeouts terminate descendants.
- Dirty/unmerged work is never automatically deleted.
- UI, June, and recovery all observe the same engine state.
- Legacy authority paths have been deleted.

---

# 6. Cross-phase data migration plan

## Schema versions

Use an integer `schemaVersion` in `state.json`.

Suggested progression:

- Existing unversioned/v2 state: renderer-owned legacy snapshot
- v3: explicit verification, plan revision, attempt identity
- v4: Rust-engine snapshot and event sequence
- v5: provider session and worktree identity
- v6: durable message/thread state

Do not bump the schema for purely additive UI projections.

## Migration rules

- Migrations are pure transformations where possible.
- Validate before overwriting the prior snapshot.
- Write atomically.
- Never discard unknown worktree paths, outcomes, or provider session IDs silently.
- A failed migration leaves the source file untouched and returns a recovery error.
- Tests load real representative fixtures from every supported prior schema.
- New code writes only the newest schema.

## File ownership after completion

Authoritative:

```text
.saple/swarm/state.json
.saple/swarm/events.jsonl
.saple/swarm/plan.json              untrusted coordinator input until ingested
.saple/swarm/attempts/...           attempt artifacts
.saple/swarm/escalation.json        export/projection of engine state
```

Compatibility or human-readable projections:

```text
.saple/swarm/mailbox/...
.saple/swarm/handoffs/...
.saple/agents/sessions.json
.saple/agents.json
.saple/runs.json
.saple/artifacts.json
```

Each compatibility file must either be deleted or explicitly documented as non-authoritative by Phase 10.

---

# 7. Testing strategy

## Test pyramid

### Pure transition tests

Use for:

- Plan validation
- Dependency readiness
- Completion eligibility
- Approval rules
- Provider assignment
- Rework/wave budgets
- Stale identity rejection

These should be fast table-driven Rust tests.

### Engine interface tests

Use `command` and `observe` with:

- Temporary filesystem
- Fake provider adapter
- Fake clock where timeout behavior needs determinism
- Fake process effect executor
- Temporary Git repositories for worktree phases

Do not reach into private engine state from tests.

### Adapter contract tests

Every provider adapter runs the same small contract suite:

- Initial prompt delivered once
- Session identity captured when supported
- Completion emitted once
- Failure normalized
- Termination works
- Resume behavior matches capability
- Unknown event does not crash

### Integration tests

Use real filesystem watcher, process, PTY, and Git behavior for the limited cases where fakes cannot prove correctness.

### UI tests

Test projection and command identity, not the scheduler. The UI test should assert that the right command is sent for the displayed snapshot and that events render correctly.

## Replace-not-layer rule

When an engine-interface test covers behavior previously tested inside `swarmStore`, remove the old implementation-detail test. The goal is not to double the suite indefinitely.

---

# 8. Security and trust boundaries

## Agent-authored files

Treat as untrusted:

- Plan
- Verdict
- Outcome
- Message content
- Handoff/artifact metadata
- Suggested verification commands

Validate:

- IDs used in paths
- Provider/model values
- Attempt and plan identity
- File containment
- Size bounds
- JSON structure
- Allowed transitions

## Command execution

- Show agent-authored verification commands before gated approval.
- Execute inside the integration worktree.
- Use a hard timeout and process-tree termination.
- Drain and bound output.
- Record exact command, plan revision, and integration commit.
- Never interpolate provider, model, or path values that have not passed allowlists/validators.

## Filesystem cleanup

- Resolve absolute targets.
- Require containment under the SAPLE-owned root.
- Refuse broad or unresolved paths.
- Preserve dirty/unmerged work by default.
- Report what was removed and what remains.

## Renderer trust

After Phase 4, the renderer is not authorized to claim that an agent completed, a plan was verified, or a swarm completed. It may request commands and display observations only.

---

# 9. Observability model

## Required event fields

Every event includes:

```text
sequence
schemaVersion
swarmId
occurredAt
type
requestId when command-caused
planRevision when plan-scoped
agentId when agent-scoped
attemptId when attempt-scoped
payload
```

## Required diagnostic questions

The event history must answer:

- Why is this task waiting?
- Which dependency or approval blocks it?
- Which provider/session/attempt ran it?
- Why was a provider selected?
- What caused a retry or rework?
- Which diff did the reviewer inspect?
- Which integration commit was verified?
- Why did the swarm escalate?
- Was an event ignored as stale, duplicate, or invalid?
- Which resources were retained after stop/recovery?

## Logging discipline

- Structured engine events are durable product history.
- Debug logs are non-authoritative diagnostics.
- PTY output is presentation/transcript data, not state.
- Avoid logging secrets, complete environments, or credentials.
- Truncate provider and command output with a visible marker.

---

# 10. Risks and mitigations

| Risk | Likely phase | Mitigation |
|---|---|---|
| Big-bang engine rewrite changes behavior | 4 | Port in vertical slices, characterize first, delete each old slice only after interface parity |
| Temporary dual authority | 4 | Never let legacy and new schedulers write the same swarm; migrate whole swarms, not individual events |
| State migration loses recoverable work | 1, 4, 5, 6 | Validate before atomic write; preserve source on failure; retain worktrees and attempt artifacts |
| Provider CLI output changes | 5 | Structured protocols where supported, recorded fixtures, legacy adapter fallback |
| Provider resume silently starts fresh | 5, 7 | Capability gate; require stable session ID; park on resume failure |
| Parallel branches conflict during integration | 6 | Serialized merge queue; preserve conflicts; coordinator repair or human escalation |
| Event log grows indefinitely | 4, 10 | Measure first; add compaction only when real replay/storage data requires it |
| UI recreates scheduler logic | 4, 9 | Engine reports state and allowed actions; UI only projects and commands |
| More provider configuration than users need | 8 | Implement readiness/cooldowns first; defer multi-profile support |
| Legacy paths linger indefinitely | All | Every phase lists deletion targets; Phase 10 release gate requires authority-path deletion |

---

# 11. Explicitly deferred work

The following are not part of the core improvement program:

- Multi-host or distributed swarms
- Cloud message relay
- Yjs collaborative swarm state
- SQLite event storage before JSONL limits are measured
- Full provider-protocol version negotiation
- Supporting every available provider with a structured adapter
- Multi-profile subscription scheduling before SAPLE supports multiple profiles
- Debate/competition strategy without a concrete selection and merge design
- General-purpose workflow language
- Custom rollback/checkpoint engine beyond Git commits and worktrees
- Autonomous conflict resolution

If any deferred item becomes necessary, create a separate design plan based on observed limitations of the completed runtime.

---

# 12. Recommended implementation order within releases

## Reliability release

Ship Phases 0-3 together or as small consecutive releases:

1. Contract baseline
2. Verified completion and approval semantics
3. Project/attempt scoping
4. Watcher and process hardening
5. Honest provider capability gating

This release improves safety without requiring the engine extraction.

## Runtime release

Ship Phases 4-5:

1. Rust engine persistence and interface
2. Scheduler/review/acceptance extraction
3. UI and June projection migration
4. Fake adapter end-to-end test
5. Codex and Claude structured adapters
6. Marker demotion

This is the largest architectural change and should not be mixed with worktree UX.

## Isolation release

Ship Phase 6:

1. Git preflight
2. Integration worktree
3. Task worktrees
4. Review binding
5. Serialized merge queue
6. Safe cleanup

## Coordination release

Ship Phases 7-9:

1. Durable messages
2. Session wake/resume
3. Provider-aware auto assignment
4. Approval/timeline/recovery UI

## Consolidation release

Ship Phase 10 after a migration window:

1. Delete legacy authority paths
2. Run complete deterministic and real-provider test matrices
3. Verify migration and recovery
4. Publish the supported provider/capability matrix

---

# 13. Definition of done for the whole program

The program is complete when all of the following are true:

- A mission-first swarm is owned by one Rust engine.
- The engine has a small `capabilities / command / observe` interface.
- React and June use that same interface.
- The engine persists a schema-versioned snapshot and ordered local event log.
- Every asynchronous result is scoped by swarm, plan, agent, and attempt identity.
- Gated mode requires approval of the exact plan and verification contract.
- Completion requires verification of the current plan revision and integration commit.
- Review and acceptance processes cannot deadlock on output and terminate their process trees on timeout.
- Codex and Claude have structured adapters and durable session resume.
- Other providers use an explicitly limited legacy adapter or are unavailable to swarms.
- Parallel editing uses isolated task worktrees.
- Reviewers approve immutable task diffs.
- Approved changes merge through a serialized integration queue.
- Messages have durable attribution and delivery state.
- `auto` provider assignment uses capability, readiness, caps, and cooldowns.
- Restart recovery is deterministic and operator-visible.
- Dirty or unmerged work is preserved.
- Legacy orchestration and duplicate state authorities have been removed.
- The deterministic end-to-end suite covers success, rework, repair, escalation, restart, stale events, provider cooldown, and merge conflict.
- All project validation commands pass.

