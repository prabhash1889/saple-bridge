# Swarm Redesign - Plan-Driven Orchestration

From a wizard-authored static DAG to coordinator-driven orchestration:
**plan -> build -> review -> integrate -> verify -> (repair waves)* -> done or escalate**,
running entirely on subscription provider CLIs in PTYs.

## Keep vs replace

| Keep (proven substrate) | Replace |
| --- | --- |
| PTY-CLI launch (`pty.rs spawn_pty`, prompt piping, headless exit codes) | Wizard roster as the source of truth for the DAG |
| Scoped lifecycle markers (`agentSignals.ts`) + pty-exit fallback | "All agents done = completed" terminal condition |
| Crash reconciliation, P13 cross-project recovery (`loadSwarmState`) | Human-only rework trigger |
| Bounded rework plumbing (`reworkAgent`, `maxAttempts`) | Prompt-only `tasks.json` convention nobody parses |
| Control-plane records (`controlPlane.ts`: agents/runs/artifacts) | Human-approval-only dynamic workers (P6 requests) |
| Mailboxes, handoffs, outcomes, workspace pinning (P11) | |
| Provider readiness + subscription sign-in detection (`providerStore`) | |

Constraint that shapes everything: agents are subscription CLIs. Bridge enforces its side of
every contract; agent output is untrusted and always sanitized-or-escalated (the existing
`parseWorkerRequests` / `parseAgentOutcome` pattern, applied everywhere).

---

## Contracts (the data model)

All files live under `.saple/swarm/`, written through existing contained commands.

### `plan.json` (coordinator-owned, Bridge-sanitized)
```json
{
  "version": 2,
  "acceptance": { "command": "npm test", "description": "suite green" },
  "tasks": [
    {
      "id": "fe_auth",
      "mission": "Implement login form + token storage",
      "role": "builder",
      "dependsOn": ["design"],
      "provider": "codex",
      "model": "default",
      "review": true
    }
  ]
}
```
Rules: unknown fields dropped, missing id/mission -> task dropped, unknown deps filtered,
cycles rejected (reuse `hasDependencyCycle`), task ids are append-only dedup keys.

### `verdicts/<taskId>.json` (reviewer-owned)
```json
{ "taskId": "fe_auth", "verdict": "reject", "feedback": "token stored in localStorage, move to keychain" }
```

### `outcomes/<agentId>.json` - existing P3 contract, unchanged.

### New markers (same scoped-token scheme as `[AGENT_DONE:<token>]`)
- `[PLAN_READY:<token>]` - coordinator finished initial planning
- `[PLAN_UPDATED:<token>]` - coordinator appended tasks mid-run (dynamic growth / repair wave)

### Internal events (TS-level in swarmStore, not IPC)
`plan_ready`, `plan_updated`, `task_completed`, `task_failed`, `verdict_recorded`,
`wave_completed`, `acceptance_passed`, `acceptance_failed`.

---

## Phase 0 - Contracts and parsers (pure lib, no behavior change)

- `src/types/swarmPlan.ts` - Plan, PlanTask, Verdict types.
- `src/lib/swarmPlan.ts` - `parsePlan(raw)`, `parseVerdict(raw)`, `diffPlan(applied, incoming)`
  (returns only new valid tasks), cycle check against the live roster.
- `agentSignals.ts` - add scoped `PLAN_READY` / `PLAN_UPDATED` regexes to the cached battery.
- Vitest coverage for every malformed-input path (mirrors `swarmStore.test.ts` style).

Done when: tests pass; nothing user-visible changes.

## Phase 1 - Plan-driven scheduler (the pivot)

- New launch mode: swarm starts with **coordinator only**. Its prompt carries the plan
  contract + acceptance requirement.
- On `PLAN_READY`/`PLAN_UPDATED`: read `plan.json`, `diffPlan` against `appliedPlanTaskIds`
  (persisted in state.json, generalizing `resolvedWorkerRequests`), materialize each new task
  as a `SwarmAgent` (fresh id + `createMarker()`, prompt generated from the task entry),
  then let the existing `checkAndRunNextAgents` scan schedule them under the parallel cap.
- Worker prompts: mission = task.mission, plus outcome/signal/mailbox sections already built
  in `launchAgentProcess`. `tasks.json` convention dies; the plan IS the assignment.
- Manual roster + templates remain as the Advanced path (same `startSwarmFromWizard`).

Done when (E2E): type a mission -> coordinator plans -> workers spawn from plan.json ->
complete -> dependents cascade. Kill the app mid-run -> reconciliation still works.

## Phase 2 - Automated review gate

- Every plan task with `review: true` gets a generated reviewer task depending on it
  (shared reviewer per wave by default; per-task for large waves).
- Reviewer prompt: target task's outcome + `git diff` scope + verdict contract.
- On reviewer completion Bridge reads the verdict file:
  - `approve` -> mark the built task approved; dependents unblock.
  - `reject` -> auto-call `reworkAgent(taskAgent, feedback)` (existing bounded loop;
    budget exhausted -> existing human escalation UI).
  - missing/garbage verdict -> park in `review` for a human (never guess).
- Autonomy dial (workspace setting): `manual` (today's behavior) | `gated`
  (auto-rework, human approves plan) | `auto` (hands-free within budgets).

Done when: a reviewer rejection relaunches the builder with feedback and no human click.

## Phase 3 - Coordinator wake and synthesis

- Session resume: `claude --resume <uuid>` / `codex resume` (validated invocations in
  `pty.rs`, same allowlist style). Fallback for every other provider: fresh launch with a
  results digest in the prompt. Resume is an optimization, digest is the guarantee.
- Wake triggers: a wave completes, or all tasks approved -> **synthesis turn**: coordinator
  receives all outcomes/verdicts, merges, writes the final report (control-plane artifact).

Done when: coordinator demonstrably reacts to worker results with prior context intact.

## Phase 4 - Acceptance and repair waves

- After synthesis the coordinator must run `plan.acceptance.command` for real.
  - Pass -> `[AGENT_DONE:token]` -> swarm `completed`, final report shown.
  - Fail -> appends fix tasks to plan.json + `[PLAN_UPDATED:token]` -> Phase 1/2 machinery
    runs the repair wave.
- Guard rails: `maxWaves` (default 3) per swarm; a wave with zero new tasks or a repeated
  identical failure short-circuits to escalation; escalation = structured report
  (waves attempted, remaining failures, coordinator's diagnosis + proposed next wave) with
  human choices: one more wave / redirect / stop.
- `completed` now means "acceptance passed", not "markers printed".

Done when: an intentionally-broken build triggers a repair wave that fixes it, and an
unfixable one escalates with a readable report instead of looping.

## Phase 5 - Mission-first UI

- New default launch flow: **mission + limits (parallel cap, wave budget, autonomy) +
  provider prefs** -> coordinator plans -> **Plan Approval screen** (edit/trim tasks, change
  providers, cap agents) -> launch. `auto` dial skips approval.
- Provider auto-assignment from signed-in subscriptions (`providerStore` readiness),
  spread across providers to respect per-plan rate limits.
- SwarmWorkspace additions: plan/wave timeline, verdict badges on agent cards, escalation
  panel. Existing graph/grid views read the same state.
- Old wizard demoted to "Advanced: manual roster"; templates become reusable policies.

Done when: mission -> glance at proposed team -> launch, in under a minute.

## Phase 6 - Patterns and hardening

- **Debate**: `"strategy": "debate", "attempts": N` on a plan task -> N parallel builders on
  isolated copies + an auto-generated judge task that picks/merges (verdict contract reused).
- Per-provider concurrent-agent caps (subscription rate-limit awareness) layered under the
  global parallel cap.
- Telemetry in state.json: waves used, rework rates, per-provider counts (feeds escalation
  reports and future tuning).
- Docs + AGENTS.md updates.

---

## Rollout and risk

- Each phase ships independently behind the existing swarm entry point; manual mode never
  breaks (it is the Phase 1 fallback and the Advanced path forever).
- Every contract point assumes model non-compliance: sanitize, fall back, or escalate to a
  human - never trust, never hang. Missing plan after coordinator exits -> park swarm in
  review with the terminal tail visible.
- All new files stay inside `.saple/swarm/*` via existing contained write commands; no new
  Rust surface except the resume invocations (validated like model/prompt-file inputs).
- Test strategy per phase: vitest for parsers/scheduler logic (existing patterns), one real
  E2E swarm run on Windows before each phase merges.
