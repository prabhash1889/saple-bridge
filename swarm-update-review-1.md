# Swarm Update Implementation Review

## Verdict

About **58% of the full roadmap is implemented**. Phases 0–5 contain a substantial orchestration skeleton, but they are not fully complete or production-safe. The two headline promises—verified completion and reliable realtime behavior—still have gaps.

| Phase | Estimate | Assessment |
| --- | ---: | --- |
| 0 — Contracts | 90% | Strong parsers and tests; provider validation remains unsafe |
| 1 — Events | 75% | Event backbone exists; the first-ever swarm may not activate it |
| 2 — Orchestration | 85% | Coordinator planning and task materialization are substantial |
| 3 — Live coordinator | 90% | Digest injection, relaunch fallback, and crash counting exist |
| 4 — Review gate | 85% | Automated verdict and rework flow is mostly implemented |
| 5 — Acceptance | 65% | Core runner and repair waves exist, but completion and execution safety have serious flaws |
| 6 — Providers | 5% | Assigner, caps, cooldowns, and expanded sign-in detection are absent |
| 7 — UI | 25% | Basic composer exists; most mission-first UI remains |
| 8 — Hardening | 5% | Debate is parsed but not executed; telemetry and cleanup are absent |

For the phases marked “DONE” in `swarm-update-new.md`, implementation is roughly **80–85% by code presence**, but lower by production reliability.

## Spec Findings

### Critical — A swarm can complete without acceptance ever running

The design says `completed` means the acceptance command passed. Missing or malformed acceptance becomes `null`, but tasks still launch and the scheduler later marks the swarm completed because acceptance gating is conditional.

- `src/lib/swarmPlan.ts:23`
- `src/stores/swarmStore.ts:1565`
- `src/stores/swarmStore.ts:1582`
- `src/stores/swarmStore.ts:1595`
- `src/stores/swarmStore.test.ts:930`

This is the largest mismatch with the stated design.

### High — Realtime updates are not armed for the first swarm in a project

Loading a project attempts to start the watcher, but Rust returns successfully without watching if `.saple/swarm` does not exist. `startSwarm` later creates the directory without retrying the watcher.

- `src-tauri/src/watcher.rs:187`
- `src/stores/swarmStore.ts:797`
- `src/stores/swarmStore.ts:916`

Mailbox, outcome, handoff, and fallback plan updates may remain stale until the project is reloaded.

### High — The Phase 6 prompt-loss bug remains

`cursor` and `copilot` do not accept piped prompts, while interactive prompt delivery is enabled only for coordinators. Explicit workers using those providers can still launch without their mission.

The following Phase 6 features are also absent:

- Readiness-backed automatic provider assignment
- Expanded sign-in detection
- Per-provider concurrency caps
- Rate-limit detection and cooldowns
- Reassignment from unavailable providers

### High — Arbitrary provider strings pass the plan sanitizer

Any nonempty provider string is retained and later cast to `AgentProvider`. Malformed coordinator output can therefore reach process launch instead of being dropped or resolved to `auto`.

- `src/lib/swarmPlan.ts:40`
- `src/stores/swarmStore.ts:1029`

### Medium — Restart recovery does not resume the wave automatically

Lost running panes are reconciled to failed agents and the swarm is paused, requiring manual intervention. This provides state recovery but not the automatic mid-wave continuation promised by the document.

### Medium — Phases 7 and 8 are mostly placeholders

Missing work includes:

- Gated/manual plan approval and editing
- Readiness-aware provider chips
- Wave timeline
- Coordinator state and latest-digest strip
- Escalation actions
- Verdict badges and richer live status
- Legacy wizard/template removal
- Debate builders, isolation, and judge
- Telemetry
- Fuzz hardening
- Old request-flow cleanup

## Quality and Safety Findings

### High — Cross-project acceptance race can corrupt state

Acceptance checks the selected project before launching a process that may run for ten minutes, but not after it returns. If the user switches projects meanwhile, the result can mutate the new project’s in-memory state and serialize that state into the old project’s `.saple/swarm/state.json`.

- `src/stores/swarmStore.ts:1191`

### High — Scheduler serialization loses the queued project identity

The scheduler lock uses two module-level booleans. If project B requests a scan while project A is scanning, the queued rerun uses A’s path while reading the current global store.

- `src/stores/swarmStore.ts:542`
- `src/stores/swarmStore.ts:1475`
- `src/stores/swarmStore.ts:1493`

This creates another cross-project state-corruption path.

### High — Verbose acceptance commands can deadlock

Rust pipes stdout and stderr but does not drain them until the child exits. A sufficiently verbose test or build can fill an OS pipe, block indefinitely, and eventually be reported as a 600-second timeout. Output truncation happens after process completion and does not prevent the blockage.

- `src-tauri/src/review.rs:327`
- `src-tauri/src/review.rs:355`
- `src-tauri/src/swarm.rs:137`

### High — Agent-authored commands execute without operator approval

Default `gated` mode currently launches tasks immediately and later executes the coordinator’s acceptance command verbatim. The promised plan-approval screen is not implemented.

- `src/stores/swarmStore.ts:989`
- `src/stores/swarmStore.ts:1191`
- `src/stores/swarmStore.ts:1565`

This conflicts with the trust-boundary guidance already documented for the analogous review command runner.

### Medium — Acceptance success is not tied to a plan snapshot

When `plan.json` changes without adding a new task, intake replaces the in-memory plan but does not persist it or reset acceptance state. Changing only the acceptance command after a previous pass can therefore leave the old `passed` result valid for the new command.

- `src/stores/swarmStore.ts:1005`
- `src/stores/swarmStore.ts:1582`

### Medium — Timeout kills only the immediate shell

The timeout kills PowerShell or `sh`, not necessarily its full process tree. Child test/build processes may survive and continue consuming resources or modifying the workspace.

- `src-tauri/src/review.rs:359`

### Medium — The branch contains substantial unrelated scope

The comparison with `origin/main` includes Obsidian state, duplicated HTML documentation, audit reports, browser behavior changes, and packaging changes. These changes are unrelated to the swarm roadmap and make the branch harder to validate and merge safely.

## What Was Implemented Well

- Plan and verdict parsing use a clear sanitize-or-drop posture.
- Task IDs are restricted before being used in verdict filenames.
- Dependency materialization preassigns IDs, allowing sibling dependencies regardless of input order.
- Reviewer gates reuse the scheduler’s dependency model instead of adding a second scheduler.
- Verdict ingestion is serialized and prevents watcher events from causing premature rework.
- Rework is bounded and stale reviewer verdicts are cleared before relaunch.
- Coordinator digests are persisted before live delivery, providing a durable fallback.
- Acceptance uses a native command runner and real exit codes instead of trusting agent claims.
- Repair waves include repeated-failure and maximum-wave guards.
- State fields are generally persisted and covered by focused tests.

## Verification

- Frontend tests: **238/238 passed**
- Rust tests: **72/72 passed**
- TypeScript typecheck: passed
- ESLint: 0 errors, 9 warnings
- No automated real swarm E2E test was found

The unit coverage is good, especially around parsing, verdicts, repair transitions, and acceptance result handling. Missing tests align with the serious risks identified above:

- Project switching during async acceptance or scheduler work
- First-swarm watcher activation
- Large command output
- Process-tree timeout
- Missing acceptance commands
- Acceptance-command changes after a previous pass

## Recommended Order of Work

1. Make acceptance mandatory before `completed`.
2. Fix cross-project async state routing and scheduler serialization.
3. Drain command output concurrently and terminate process trees on timeout.
4. Re-arm the swarm watcher after creating the first swarm directory.
5. Require operator approval for agent-authored acceptance commands in `manual` and `gated` modes.
6. Validate or safely resolve provider names and block prompt-incompatible workers.
7. Implement the remaining provider layer and UI before treating the roadmap as complete.
8. Add one real Windows E2E swarm test covering plan → build → review → acceptance → repair/completion.
