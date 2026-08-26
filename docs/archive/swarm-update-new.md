# Swarm v2 - Complete Redesign

A from-scratch replacement of the current swarm with real orchestration:
**mission -> coordinator plans -> workers build live -> reviewers verdict -> coordinator synthesizes -> acceptance runs for real -> repair waves -> done or escalate.**

Everything is event-driven (no polling), contract-driven (machine-read JSON, never prose), and
subscription-aware (agents run on signed-in provider CLIs, spread across subscriptions).

---

## Design goals

1. **Coordinator actually coordinates.** Its plan is machine-read and materializes workers. It stays alive, receives results, reacts, and produces the final answer.
2. **Seamless and realtime.** File-watcher events replace every 5-second poll. A task completion propagates to the scheduler, the UI, and the coordinator in milliseconds.
3. **Contracts, not conventions.** `plan.json`, `verdicts/*.json`, `outcomes/*.json` are parsed, sanitized, and enforced by Bridge. Agent output is untrusted: sanitize, fall back, or escalate - never trust, never hang.
4. **Verified completion.** `completed` means the acceptance command passed, not "markers printed".
5. **Subscriptions are the fuel.** Sign-in detection for every provider, auto-assignment of tasks across signed-in CLIs, per-provider concurrency caps.

## What is kept vs deleted

| Keep (proven substrate) | Delete (orchestration theater) |
| --- | --- |
| PTY spawn, allowlist, validated inputs, headless exit codes (`pty.rs`) | 6-step wizard as the launch flow (`SwarmWizard.tsx` + steps) |
| Scoped lifecycle markers + rolling-tail detection + exit fallback (`agentSignals.ts`) | Static roster templates (`DEFAULT_TEMPLATES`, `SwarmTemplateEditor`) |
| Crash/restart reconciliation + cross-project recovery (`loadSwarmState` P13) | Prompt-only `tasks.json` convention (nothing parses it) |
| Serialized scheduler core, parallel cap, per-agent commit discipline | 5-second polling loops in `SwarmWorkspace` |
| Bounded rework (`reworkAgent`, attempt budgets) | Human-approval-only worker requests (`requests.json` P6 flow) |
| Mailboxes, handoffs, workspace pinning (P11) | "All agents done = completed" terminal condition |
| Control plane records (`controlPlane.ts`: agents/runs/artifacts) | |
| Provider readiness store (`providerStore`) - extended in Phase 6 | |
| Rust file watcher (`watcher.rs`) - promoted to the event backbone | |

## Target architecture

```
User mission
    |
    v
Coordinator (live interactive PTY, never headless)
    | writes .saple/swarm/plan.json  ->  [PLAN_READY:token]
    v
Bridge: parse + sanitize plan -> materialize worker agents
    |
    v
Workers build in parallel (headless PTYs, capped, subscription-assigned)
    | outcomes/<id>.json + [AGENT_DONE:token]      <- watcher event, ms latency
    v
Reviewer tasks (auto-generated per review:true task)
    | verdicts/<taskId>.json                        <- machine-read
    |   approve -> dependents unblock
    |   reject  -> auto rework (bounded) -> relaunch with feedback
    v
Wave complete -> digest injected into coordinator's live PTY
    v
Coordinator synthesis -> Bridge runs plan.acceptance.command (real process, real exit code)
    |   pass -> final report -> swarm COMPLETED
    |   fail -> coordinator appends repair tasks -> [PLAN_UPDATED:token] -> next wave
    v
maxWaves exhausted / repeated identical failure -> structured escalation to human
```

### Data model (`.saple/swarm/`)

All files written through existing contained commands. Bridge owns `state.json`; agents own the rest (always sanitized on read).

| File | Owner | Purpose |
| --- | --- | --- |
| `plan.json` | Coordinator | Task list + acceptance command (contract below) |
| `state.json` | Bridge | Roster, statuses, waves, applied task ids, autonomy |
| `verdicts/<taskId>.json` | Reviewers | `approve` / `reject` + feedback |
| `outcomes/<agentId>.json` | Workers | Structured outcome (existing P3 contract, unchanged) |
| `mailbox/<agentId>.md` | Both | Operator/agent messages (existing, now push-updated) |
| `handoffs/<from>-to-<to>.json` | Workers | Peer handoffs (existing, now push-updated) |

### `plan.json` contract

```json
{
  "version": 2,
  "acceptance": { "command": "npm test", "description": "suite green" },
  "tasks": [
    {
      "id": "fe_auth",
      "mission": "Implement login form + token storage in keychain",
      "role": "builder",
      "dependsOn": ["design"],
      "provider": "auto",
      "model": "default",
      "review": true,
      "strategy": "single"
    }
  ]
}
```

Sanitizer rules: unknown fields dropped; missing `id`/`mission` drops the task; unknown deps filtered; cycles rejected; task ids are append-only dedup keys; `provider: "auto"` resolved by the subscription assigner (Phase 6). A malformed plan can never crash the scheduler or launch a bad worker.

### `verdicts/<taskId>.json` contract

```json
{ "taskId": "fe_auth", "verdict": "reject", "feedback": "token stored in localStorage, move to keychain" }
```

### New lifecycle markers (same scoped-token scheme as `[AGENT_DONE:<token>]`)

- `[PLAN_READY:<token>]` - coordinator finished initial planning
- `[PLAN_UPDATED:<token>]` - coordinator appended tasks mid-run (dynamic growth / repair wave)

---

## Phase 0 - Contracts and parsers (pure lib, zero behavior change) - DONE

The foundation everything else compiles against. No UI or runtime changes ship here.

Shipped: `src/types/swarmPlan.ts` (`SwarmPlan`, `PlanTask`, `Verdict`, `SwarmWave`, `AutonomyMode`, `SwarmEvent`), `src/lib/swarmPlan.ts` (`parsePlan` with dedup + unknown-dep filtering + Kahn acyclic-subset cycle rejection, `parseVerdict`, `diffPlan`), scoped `PLAN_READY`/`PLAN_UPDATED` markers + `getPlanSignalFromOutput` in `src/lib/agentSignals.ts`, and full vitest coverage (`swarmPlan.test.ts` + plan-marker cases in `agentSignals.test.ts`). `npm run typecheck` and `npm test` green (198 tests).

**Steps**

1. `src/types/swarmPlan.ts` - `SwarmPlan`, `PlanTask`, `Verdict`, `SwarmWave`, `AutonomyMode` (`'manual' | 'gated' | 'auto'`), `SwarmEvent` union (`plan_ready`, `plan_updated`, `task_completed`, `task_failed`, `verdict_recorded`, `wave_completed`, `acceptance_passed`, `acceptance_failed`, `escalated`).
2. `src/lib/swarmPlan.ts`:
   - `parsePlan(raw: unknown): SwarmPlan` - full sanitizer per the contract rules above (mirror the `parseWorkerRequests` / `parseAgentOutcome` style: drop, never throw).
   - `parseVerdict(raw: unknown): Verdict | null` - only `approve`/`reject` accepted; anything else is `null` (parks the task for a human).
   - `diffPlan(appliedIds: string[], incoming: SwarmPlan): PlanTask[]` - returns only new, valid, acyclic tasks.
   - Cycle detection: reuse the logic behind the existing `validate_dependency_graph` command (or port `hasDependencyCycle` into this lib so it runs sync in TS).
3. `src/lib/agentSignals.ts` - add scoped `PLAN_READY` / `PLAN_UPDATED` regexes to the cached per-token battery; extend `mightContainAgentMarker` with `PLAN_`.
4. Vitest: every malformed-input path for `parsePlan`/`parseVerdict`/`diffPlan` (missing fields, wrong types, cycles, duplicate ids, prototype pollution attempts), plus marker tests mirroring `agentSignals.test.ts`.

**Done when:** `npm run typecheck` and `npm test` pass; nothing user-visible changes.

---

## Phase 1 - Realtime event backbone (kill all polling) - DONE

Replace every `setInterval` with push events from the Rust file watcher.

Shipped: a second, independent Rust watcher (`watcher.rs`: `SwarmWatcherState`, `watch_swarm_dir` / `unwatch_swarm_dir`, registered in `lib.rs`) - recursive, 150 ms debounce on `.saple/swarm/`, emits `swarm-file-changed { projectPath, relPath }` with the swarm-dir-relative path, reusing the existing debouncer + `is_last_own_write` self-write filter (unit-tested `swarm_rel_path`). `src/lib/swarmEvents.ts` is a module-level bus (single lazily-started `swarm-file-changed` listener, mirrors `startPtyOutputListener`) that classifies `relPath` (`plan` / `state` / `requests` / `verdict` / `outcome` / `mailbox` / `handoff` / `unknown`) and fans out to subscribers via `subscribeSwarmEvents`. `swarmStore.loadSwarmState` arms the watcher (`watch_swarm_dir`); `App.tsx` disarms it on project close (`unwatch_swarm_dir`) alongside `unwatch_project_files` - tied to project lifecycle, not swarm-run lifecycle, so a stop→start within a project stays watched. `SwarmWorkspace.tsx`'s two 5 s polls (worker-requests + mailbox/handoff/outcome) are gone: each now fetches once, then re-reads only on its matching classified event, with an away-project guard dropping events whose `projectPath` isn't current. Vitest for `classifySwarmPath`; `cargo test`, `npm run typecheck`, `npm test` (202) and `npm run lint` (0 errors) green.

> Deviation from the step list: watching is disarmed on project close (App.tsx), not in `stopSwarm`. Unwatching in `stopSwarm` would leave a new swarm launched after a stop (which never re-runs `loadSwarmState`) unwatched. Store routing to stub handlers (step 3) was skipped as speculative - the real consumer is `SwarmWorkspace`; Phases 2-5 add store handlers when they have behavior.

**Steps**

1. Rust (`watcher.rs`): add `watch_swarm_dir(projectPath)` / `unwatch_swarm_dir` commands - a recursive, debounced (~150 ms) notify watcher on `.saple/swarm/` that emits a `swarm-file-changed { projectPath, relPath }` Tauri event. Reuse the existing watcher infrastructure; register in `lib.rs`.
2. `src/lib/swarmEvents.ts` - a tiny TS event bus: subscribes to `swarm-file-changed` once, classifies `relPath` (`plan.json`, `verdicts/*`, `outcomes/*`, `mailbox/*`, `handoffs/*`), and fans out typed callbacks. Single listener, module-level, mirrors `startPtyOutputListener` lifecycle.
3. `swarmStore`: start/stop watching in `loadSwarmState` / `stopSwarm`; route classified events to handlers (stubs for now; Phases 2-5 fill them in).
4. `SwarmWorkspace.tsx`: delete the 5 s worker-request poll and the mailbox/handoff polling effects; re-read the touched file only when its event fires.
5. Guard: watcher events for a project that is not `loadedProjectPath` are dropped (the P13 recovery path already covers away-project catch-up on load).

**Done when:** editing a mailbox file externally updates the open Swarm room in under a second with zero intervals registered; `npm test` green.

---

## Phase 2 - Coordinator-driven orchestration core (the pivot) - DONE

The swarm starts with a coordinator only; its plan materializes the workers. The wizard DAG dies.

Shipped: `swarmStore` gained `plan` / `appliedPlanTaskIds` / `autonomy` / `wave` / `maxWaves` / `maxParallel` (all persisted in `state.json` and round-tripped through reconciliation). New `startSwarm(projectPath, mission, options)` seeds ONE coordinator (fresh marker, its own pinned P11 workspace) and launches it; `startSwarmFromWizard` stays only for the still-on-disk wizard until Phase 7. New `ingestPlan(projectPath)` reads `plan.json`, `parsePlan` + `diffPlan` against `appliedPlanTaskIds`, materializes each new task as a `SwarmAgent` (fresh id + marker, `systemPrompt` = the task mission, `taskId` tag, `dependsOn` remapped task-id -> agent-id via a pre-assigned id map so sibling-order deps resolve), appends the ids, persists, and runs the scheduler - idempotent on re-emit. Plan intake fires from the coordinator's `[PLAN_READY]`/`[PLAN_UPDATED]` marker (`terminalStore` fast path, primary) and from the `plan` watcher event in `SwarmWorkspace` (fallback). Prompt building moved to `src/lib/swarmPrompts.ts` (`buildAgentPrompt`): coordinators get the `plan.json` contract + acceptance requirement + `PLAN_READY`/`PLAN_UPDATED`/`AGENT_DONE` markers; workers keep the P3/P4 brief with the task mission as their assignment (no `tasks.json` paragraph, no legacy worker-request section). Coordinator completion containment lives in `updateAgentStatus`: on the coordinator's done/review it force-ingests the plan first, then resolves to `done` if any task applied (a clean exit without `AGENT_DONE` still completes - the plan is the deliverable) or parks it in `review` with a "relaunch to retry planning" reason if none did. The scheduler now honours the swarm's `maxParallel` (0 = global pane limit). A minimal mission-first `SwarmComposer` (mission + coordinator CLI + autonomy dial + `maxParallel`/`maxWaves`) replaced the wizard/template UI as the launch surface in `SwarmWorkspace`. `npm run typecheck`, `npm test` (207), `npm run lint` (0 errors) green.

> Deviations from the step list: retry-planning (step 7) reuses the existing per-agent Relaunch on the parked coordinator card - no new one-click affordance needed. `provider: "auto"` resolves to the coordinator's provider for now (the real subscription assigner is Phase 6). The wizard/template files (`SwarmWizard`, `wizard/steps/*`, `SwarmTemplateEditor`, `DEFAULT_TEMPLATES`, `startSwarmFromWizard`) are left on disk and unreferenced by the room - Phase 7 formally deletes them so this phase's diff stays reviewable. The plan-watcher fallback is subscribed in `SwarmWorkspace` (component-level, like the Phase 1 consumers) rather than the store, keeping the store free of a Tauri listener in the node test env; the marker path is the always-on primary.

**Steps**

1. New store shape (`swarmStore` rewrite, keeping the proven pieces):
   - State adds: `plan: SwarmPlan | null`, `appliedPlanTaskIds: string[]`, `autonomy: AutonomyMode`, `wave: number`, `maxWaves`, `maxParallel` (persisted in `state.json`).
   - Keep: marker minting, scheduler serialization guard, per-agent commit discipline, reconciliation, mailbox/handoff/outcome plumbing, `reworkAgent`.
2. `startSwarm(mission, options)` replaces `startSwarmFromWizard`: writes dirs, pins a swarm workspace instance (existing P11 flow), seeds ONE coordinator agent, launches it.
3. Coordinator prompt (new builder in `src/lib/swarmPrompts.ts`): mission, the `plan.json` contract verbatim, the acceptance-command requirement, its scoped markers including `[PLAN_READY:<token>]` / `[PLAN_UPDATED:<token>]`, mailbox path.
4. Plan intake: on `PLAN_READY`/`PLAN_UPDATED` (marker via signal tail) or `plan.json` watcher event (belt and braces - marker wins, watcher is fallback): read the file, `parsePlan`, `diffPlan` against `appliedPlanTaskIds`, materialize each new task as a `SwarmAgent` (fresh id + `createMarker()`, prompt generated from `task.mission` + role + outcome/signal/mailbox sections), append ids to `appliedPlanTaskIds`, persist, run the scheduler.
5. Scheduler: existing `runAgentScan` logic (deps-done -> launch under cap) operating on materialized tasks. Plan task `dependsOn` maps to agent dependencies through a taskId->agentId map kept in state.
6. Worker prompts: mission comes from the plan task. Remove the `tasks.json` paragraph from every prompt template - the plan IS the assignment.
7. Failure containment: coordinator exits without ever writing a valid plan -> swarm parks in `review` with the terminal tail visible and a one-click "retry planning" (fresh coordinator launch).
8. Tests: plan intake (valid, partial, garbage, duplicate re-emit), materialization idempotency, scheduler cascade.

**Done when (E2E):** type a mission -> coordinator plans -> workers spawn from `plan.json` -> complete -> dependents cascade. Kill the app mid-run -> reconciliation still recovers.

---

## Phase 3 - Live coordinator (seamless, not fire-and-forget) - DONE

The coordinator stays alive for the whole swarm and receives results in its own PTY.

Shipped: `pty.rs` gained interactive prompt delivery - a new `interactive_prompt` flag on `spawn_pty` launches the provider CLI as an interactive TUI (no stdin pipe) and, after a fixed startup delay (2.5 s), types the validated prompt file into it via the existing writer thread as a bracketed paste followed by Enter as its own keypress (`bracketed_paste` unit-tested; CRLF normalized). `providerMeta.ts` gained `TURN_INJECTION_PROVIDERS` (`claude`/`codex`/`gemini`/`opencode`, conservative on purpose) + `providerSupportsTurnInjection`; coordinators on these providers launch live, everything else keeps the headless/fallback path. `swarmStore.notifyCoordinator(projectPath, digest)` records every digest in a persisted `digestLog` first (the durable channel), then injects it into the live coordinator's PTY - queued and flushed only when the pane has been quiet for 3 s (busy/idle heuristic via a `subscribeOutput` watch on the coordinator pane; `coordinatorState: 'planning' | 'idle' | 'digesting'` on the store) - or, when injection isn't possible, relaunches the coordinator with the whole digest log embedded in its prompt (new `## Results So Far` + `## Live Session` sections in `swarmPrompts.ts`). Digests fire on wave completion (all materialized workers finished -> scheduler delivers a results digest with per-task outcome summaries instead of ending the swarm; `lastDigestWave` makes it once-per-wave, and the swarm completes on a later scan once the coordinator emits its done marker) and on terminal worker failures (injection-only, so failures can't cause a relaunch storm). Digest text is built by the pure `src/lib/swarmDigest.ts` (`buildResultsDigest`, vitest-covered). Coordinator crash mid-swarm: the pane-exit fallback plus an `exitedPanes` check detects a live coordinator dying while workers are unfinished, auto-relaunches it once with a crash-recovery digest (`coordinatorCrashes` persisted), and parks the second crash in `review` for a human. New tasks ingested after a delivered wave digest bump `wave`. All new state (`digestLog`, `coordinatorCrashes`, `lastDigestWave`) round-trips through `state.json`; the coordinator watch is re-armed on `loadSwarmState` and torn down in `stopSwarm`. `cargo test` (70), `npm run typecheck`, `npm test` (218), `npm run lint` (0 errors) green.

> Deviations from the step list: the interactive spawn mode keeps the headless exit-code wiring (shell exits with the CLI) instead of dropping it - that pty-exit signal IS the crash detection step 5 requires; only the stdin pipe is gone. Digest injection uses bracketed paste + a separate Enter write rather than plain stdin lines so multi-line digests survive TUI input handling. The per-provider fallback flag lives in `providerMeta.ts` as `TURN_INJECTION_PROVIDERS` (allowlist) rather than a reject-list, so unverified TUIs default to the guaranteed relaunch path. `coordinatorState` is store-observable but not yet surfaced in the room UI - the coordinator strip is Phase 7's rebuild.

**Steps**

1. `pty.rs`: new spawn mode `interactive_with_prompt` - launch the provider CLI interactively (no stdin pipe, no headless exit wiring), then deliver the prompt by writing it to the PTY via the existing writer path once the CLI is ready (small fixed delay, then write prompt + Enter). Coordinator panes use this; workers stay headless.
2. Digest injection: `swarmStore.notifyCoordinator(digest)` writes a compact results digest (task id, status, outcome summary, verdict) into the coordinator's PTY stdin as a user turn. Triggered on `wave_completed` and on terminal task failures.
3. Coordinator busy/idle tracking: only inject when the CLI is at its input prompt. Heuristic: quiet output for N seconds after its last turn; queue digests while busy, flush on idle. Keep it simple and observable (`coordinatorState: 'planning' | 'idle' | 'digesting'` on the store).
4. Fallback (per-provider flag in `providerMeta`): providers whose TUI rejects injected turns get the digest-relaunch path instead - fresh coordinator launch whose prompt embeds all outcomes/verdicts so far. Injection is the optimization; digest relaunch is the guarantee.
5. Coordinator crash mid-swarm: exit fallback detects it; auto-relaunch once with the digest prompt; second crash escalates to human.

**Done when:** a worker finishes and its summary visibly appears inside the coordinator's terminal within seconds, and the coordinator's next output reacts to it with prior context intact.

---

## Phase 4 - Automated review gate - DONE

Reviewer verdicts are machine-read and drive rework without a human click.

Shipped: `ingestPlan` now materializes a per-task review gate: every `review: true` plan task gets an auto-generated reviewer agent (fresh id + marker, `reviewTaskId`/`reviewTargetAgentId` tags, depending on the builder), and dependents of a reviewed task wait on the whole gate (`[builder, reviewer]`) via a task->gate map - "done" for a reviewed task now means built AND reviewed, so the existing blocked-cascade logic needed no changes. Reviewer prompts come from `buildReviewGatePrompt` (`swarmPrompts.ts`): the reviewed task's mission, the builder's outcome file path, an instruction to inspect the actual diff (never trust the claim), the verdict contract verbatim, and scoped completion markers. New `swarmStore.ingestVerdict(projectPath, taskId, { strict })` machine-reads `verdicts/<taskId>.json` via `parseVerdict`: `approve` records `lastVerdict` on the reviewed agent (its finished reviewer unblocks dependents through the gate), `reject` auto-calls the existing bounded `reworkAgent` with the feedback (budget exhausted -> parked in `review` for the existing human escalation UI; `manual` autonomy parks instead of reworking), and a missing/garbage verdict parks the task for a human - never guesses. Triggered strict from the reviewer's done transition in `updateAgentStatus` (primary; P13 recovery replays route through it too) and lenient from the `verdict` watcher event in `SwarmWorkspace` (fallback; never parks or reworks while the reviewer is still running; a per-task in-flight guard serializes the two). `relaunchAgent` re-arms a finished reviewer back to `waiting` (and kills its stale pane) whenever its target relaunches - so manual reworks re-run review too - and every reviewer (re)launch clears its verdict file first so a stale verdict can never be re-read. Plan task ids are now validated as filename-safe slugs in `parsePlan` (they become `verdicts/<id>.json` paths - trust boundary). Fixed along the way: `launchAgentProcess` no longer clobbers the agent's plan `taskId` with the session id and `relaunchAgent` no longer clears it (verdict routing and cross-wave dependency mapping key on it; sessions were already linked by `terminalId`). `npm run typecheck`, `npm test` (226), `npm run lint` (0 errors) green.

> Deviations from the step list: reviewers are per-task, not one-shared-per-wave - a shared reviewer would couple unrelated tasks' dependents (its gate would hold every reviewed task until the whole wave reviews), and the scheduler cap already bounds the extra panes. The autonomy dial's verdict behavior shipped (`manual` parks every transition for a click, `gated`/`auto` auto-rework); `gated`'s plan-approval-before-launch screen is Phase 7 UI. An `approve` in `manual` records the verdict without parking - approval causes no transition, so there is nothing for a human to click.

**Steps**

1. Task materialization: every plan task with `review: true` auto-generates a reviewer agent depending on it (one shared reviewer per wave by default; per-task when the wave is large). Reviewer prompt: the target task's mission + outcome file + instruction to inspect the diff scope + the verdict contract + its own scoped markers.
2. On reviewer completion (or `verdicts/*` watcher event): `parseVerdict`.
   - `approve` -> mark the reviewed task approved; dependents treat it as done.
   - `reject` -> call `reworkAgent(taskAgent, feedback)` automatically (existing bounded loop; budget exhausted -> existing human escalation UI).
   - missing/garbage verdict -> park the task in `review` for a human. Never guess.
3. Autonomy dial (stored per swarm, set at launch):
   - `manual` - verdicts recorded but every transition needs a human click (debug mode).
   - `gated` - auto-rework on reject, human approves the plan before launch (default).
   - `auto` - hands-free within budgets.
4. Dependents of a rejected task stay blocked until approval; the existing blocked-cascade logic already handles this once "done" is redefined as "done + approved (when review:true)".
5. Tests: verdict parse paths, auto-rework trigger, budget exhaustion, garbage verdict parking.

**Done when:** a reviewer rejection relaunches the builder with feedback embedded, with zero human clicks, at most `maxAttempts` times.

---

## Phase 5 - Acceptance and repair waves - DONE

`completed` becomes a verified state. Failures loop bounded repair waves through the same machinery.

Shipped: new Rust command `swarm::run_acceptance_command` (registered in `lib.rs`) runs `plan.acceptance.command` through the same shell runner as review verification (`review::run_shell_with_timeout`, project cwd, PowerShell/sh parity, truncated output) with a 600 s budget (a full suite/build, vs review's 90 s per-task check) and returns `{ exitCode, output, timedOut }` - a timed-out run reports `exitCode: null` so it can never read as a pass. The scheduler's wave-completion branch now forks: a wave where every worker is `done` (which, through the Phase 4 gate, already means built AND approved) with an acceptance command runs `swarmStore.runAcceptance` instead of the plain wave digest (a wave with failures keeps the old digest so the coordinator can replan). Pass -> `acceptanceStatus: 'passed'` and a synthesis digest (task lines + "write the final report as your structured outcome, then AGENT_DONE") delivered via the Phase 3 channel (injection or digest-relaunch); the final report flows through the existing outcome -> `completeSession` -> control-plane artifact path. Fail -> guard rails first: two consecutive failures with the same trimmed-output hash (`hashAcceptanceOutput`, djb2) or a failure at the `maxWaves` budget escalate; otherwise a repair digest (failing output tail embedded) asks for `PLAN_UPDATED` repair tasks, and the existing Phase 2 intake + Phase 3 wave bump run the repair wave. `completed` is now gated in the all-done branch: with an acceptance command in the plan the swarm only completes when `acceptanceStatus === 'passed'`; a coordinator that finishes after a failure without appending repair tasks trips the zero-new-tasks short-circuit. `escalateSwarm` writes a structured `SwarmEscalation` report (reason, waves attempted, acceptance command, failure output, best-effort coordinator diagnosis from its outcome file, proposed-but-unmaterialized plan tasks) to state.json AND `.saple/swarm/escalation.json`, and parks the swarm as `failed`. All new state (`acceptanceStatus`, `lastAcceptanceOutput`, `lastAcceptanceFailureHash`, `identicalAcceptanceFailures`, `escalation`) round-trips through `state.json`; a persisted mid-run `running` reconciles to `idle` on load and the all-done funnel re-runs acceptance. New digest builders (`buildAcceptanceDigest`) live in `swarmDigest.ts`. Tests: cargo (real exit codes, output capture), vitest for pass/fail transitions, repair digest, identical-failure short-circuit, max-waves escalation, escalation payload shape, timed-out-counts-as-failure, no-command-keeps-wave-digest. `cargo test` (72), `npm run typecheck`, `npm test` (238), `npm run lint` (0 errors) green.

> Deviations from the step list: the escalation's three human choices (one more wave / redirect / stop) are the Phase 7 escalation panel - today the report is on disk/state and the manual paths out are the existing per-agent Relaunch or editing the plan and resuming. The acceptance command's operator visibility before launch is the Phase 7 plan-approval screen; until then the trust posture is documented on the Rust command (the swarm's agents already hold interactive shells in the project dir, so executing the plan's command grants no new capability). "A wave producing zero new tasks" is detected in its observable form - the coordinator finishing while acceptance is still failed - since a live coordinator that silently ignores a repair digest is indistinguishable from one still thinking.

**Steps**

1. Acceptance runner: Bridge (not the coordinator - never trust an agent's claim) runs `plan.acceptance.command` in a headless PTY in the project dir on: all tasks done+approved. Exit 0 = pass. Command is operator-visible in the plan-approval UI before launch (same trust posture as the review verification command).
2. Pass -> inject a synthesis digest into the coordinator ("all tasks approved, acceptance passed, write the final report") -> coordinator writes the final report -> stored as a control-plane artifact -> swarm `completed`, report surfaced in the UI.
3. Fail -> inject the failure output digest -> coordinator appends repair tasks to `plan.json` + `[PLAN_UPDATED:token]` -> Phase 2 intake + Phase 4 gate run the repair wave. `wave` increments.
4. Guard rails:
   - `maxWaves` (default 3) per swarm.
   - A wave producing zero new tasks, or two consecutive identical acceptance failures (compare trimmed output hash), short-circuits to escalation.
   - Escalation = structured report artifact: waves attempted, remaining failures, coordinator's diagnosis, proposed next wave; human choices: one more wave / redirect (edit plan) / stop.
5. Tests: acceptance pass/fail transitions, wave counting, identical-failure short-circuit, escalation payload shape.

**Done when:** an intentionally broken build triggers a repair wave that fixes it, and an unfixable one escalates with a readable report instead of looping.

---

## Phase 6 - Subscription-aware provider layer

The swarm runs on the user's signed-in subscriptions, spread and capped per provider.

**Steps**

1. Extend `check_provider_signin` (`diagnostics.rs`) beyond codex/claude:
   - `gemini` - `~/.gemini/oauth_creds.json` exists.
   - `copilot` - `gh auth status` exit code.
   - `opencode` - `opencode auth list` output.
   - `cursor` / `droid` / `grok` / `pi` - probe their status commands or credential files where they exist; return `None` (honest unknown) where they do not.
2. Fix the silent prompt hole: providers failing `provider_accepts_prompt_pipe` (`cursor`, `copilot`) must not launch mission-less TUIs as workers. Either deliver the prompt via the Phase 3 stdin-write path, or refuse the assignment at plan-materialization time with a clear per-task status ("provider cannot run headless missions").
3. Provider assigner (`src/lib/providerAssign.ts`): resolves `provider: "auto"` plan tasks across ready providers (`installed && (signedIn || authenticated) && enabled`), round-robin weighted by per-provider caps; deterministic and unit-tested. Explicit provider in the plan wins if ready, else falls back to auto with a status note.
4. Per-provider concurrency caps (settings, sensible defaults, e.g. 2 per subscription CLI) layered under the global `maxParallel`: the scheduler counts running agents per provider and holds excess tasks in `waiting`.
5. Rate-limit awareness: detect provider rate-limit phrases in the signal tail (per-provider regex list in `providerMeta`); on hit, mark the provider cooling for N minutes, requeue the task to another ready provider or hold it, surface a badge in the UI.
6. Tests: assigner distribution, cap enforcement, rate-limit requeue.

**Done when:** a plan with `provider: "auto"` spreads tasks across every signed-in CLI, respects caps, and a rate-limited provider visibly cools down while work continues elsewhere.

---

## Phase 7 - Mission-first UI (replace the wizard)

Launching a swarm is one screen; watching it is a live timeline.

**Steps**

1. Launch composer (replaces `SwarmWizard` and all step components): one screen - mission textarea, autonomy dial, `maxParallel` / `maxWaves`, provider preference chips (auto-populated from readiness, unready providers greyed with the reason). Command Palette's `pendingWizardMission` seeds it.
2. Plan approval screen (shown in `manual`/`gated`): the parsed plan as editable cards - edit mission text, change provider/model, toggle `review`, delete tasks, see the acceptance command. Approve -> materialize + launch. `auto` skips straight through.
3. `SwarmWorkspace` rebuild:
   - Wave timeline header (plan -> build -> review -> acceptance per wave, with live states).
   - Agent cards: existing status colors (`swarmStatus.ts`) + verdict badges, outcome summaries, elapsed time; click -> its terminal pane.
   - Coordinator strip: live coordinator state (`planning / idle / digesting`) and its latest digest.
   - Escalation panel: the Phase 5 report with the three actions.
   - Graph view (`SwarmGraph`) reads the same materialized roster - kept, restyled for waves.
4. Delete: `SwarmWizard.tsx`, `wizard/steps/*`, `SwarmTemplateEditor.tsx`, `DEFAULT_TEMPLATES`, template persistence in the store partialize. Templates' one useful idea (role prompt presets) becomes a small `rolePresets.ts` the prompt builder uses.
5. Follow the no-new-nav rule: the swarm entry point stays exactly where it is today.

**Done when:** mission -> glance at proposed team -> launch in under a minute; the room shows a live, self-updating picture with zero manual refresh.

---

## Phase 8 - Patterns, hardening, telemetry

**Steps**

1. **Debate strategy:** `"strategy": "debate", "attempts": N` on a plan task -> N parallel builders (isolated by scoped worktree dirs or file-scope partitioning) + an auto-generated judge task; the judge writes a verdict picking/merging - the Phase 4 verdict contract reused verbatim.
2. Telemetry in `state.json`: waves used, rework counts per task, per-provider launch/failure/rate-limit counts, wall-clock per phase. Feeds the escalation report and future tuning; no external transmission.
3. Prompt-injection hardening pass: every agent-written file re-audited against its sanitizer; fuzz tests for `parsePlan`/`parseVerdict` with hostile strings; markers remain the only channel that can change status, and they stay scoped per agent.
4. Docs: update `CLAUDE.md` storage table (`plan.json`, `verdicts/`), `src/AGENTS.md`, `src-tauri/src/AGENTS.md` (watcher + interactive-prompt spawn mode).
5. Cleanup sweep: delete dead code from the old swarm (`parseWorkerRequests`, `resolveWorkerRequest`, requests polling, unused types), keeping `git rm` diffs reviewable per phase.

**Done when:** a debate task produces a judged merge; telemetry shows up in escalation reports; no orphaned old-swarm code remains.

---

## Rollout, risk, and testing

- **Phase order is dependency order.** 0-1 are invisible foundations; 2 is the breaking pivot (old wizard flow removed the same release 7 lands - between 2 and 7 the composer is a minimal mission box so the app never ships wizard-less AND composer-less).
- **Trust posture everywhere:** agent output is untrusted input. Sanitize-or-drop on every read; park-for-human on every ambiguity; markers scoped per agent; acceptance is executed by Bridge, never self-reported.
- **Containment:** all new files stay inside `.saple/swarm/*` via existing contained write commands. New Rust surface is small: swarm-dir watcher + interactive-prompt spawn mode, both validated like existing inputs.
- **Crash safety:** every new state field lives in `state.json` and round-trips through the existing reconciliation; a mid-wave restart resumes the wave, never restarts it.
- **Test strategy per phase:** vitest for every parser/scheduler/assigner path (existing patterns), `cargo test` for watcher and spawn-mode validators, and one real E2E swarm run on Windows before each phase merges.
