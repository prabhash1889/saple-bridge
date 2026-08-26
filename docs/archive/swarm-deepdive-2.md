# Saple Bridge Swarm: Deep Dive and Traycer Comparison

Status: Internal analysis (2026)
Scope: saple-bridge (React scheduler + Rust backend) vs Traycer (open-source protocol/CLI/GUI; Host engine is closed but the wire contract reveals the model)

I traced the full implementation in saple-bridge and the open-source half of Traycer. I also read the existing design/review docs (`docs/agent-orchestration-plan.md`, `swarm-update-new.md`, `swarm-update-review-1.md`) so the recommendations here are additive to what was already planned.

---

## Part 1 - How Saple Bridge's swarm is implemented today

### Layering

**React owns the control plane.** The entire scheduler and state machine live in `src/stores/swarmStore.ts` (1,870 lines, Zustand + persist). Rust (`src-tauri/src/swarm.rs`, 287 lines) is deliberately thin - it is file I/O, one DFS cycle check, and the acceptance command runner. This is the design already flagged in `agent-orchestration-plan.md` ("The real scheduler lives in the React renderer").

**Coordination is file-based plus an event backbone.** The agents and Bridge coordinate through `.saple/swarm/*` files, and a Rust watcher (`watcher.rs`) on that directory emits `swarm-file-changed` (150 ms debounce, 300 ms for the project watcher). A TS bus (`swarmEvents.ts`) classifies each relpath into `plan | verdict | outcome | mailbox | handoff | state | requests` and fans out to subscribers. So the old polling is gone - it is a real event backbone, just not a durable log.

### The data model (trust boundaries included)

| File | Writer | Reader | Trust boundary |
|---|---|---|---|
| `state.json` | Bridge only | Bridge | whole-file, per-project serialized writes |
| `plan.json` | coordinator agent | Bridge | `parsePlan` in `swarmPlan.ts` |
| `verdicts/<task>.json` | reviewer agent | Bridge | `parseVerdict` |
| `outcomes/<agent>.json` | worker agent | Bridge | `parseAgentOutcome` in `controlPlane.ts` |
| `requests.json` | coordinator agent | Bridge | `parseWorkerRequests` |
| `mailbox/<agent>.md` | human -> agent | agent (FS) | path-containment via Rust |
| `handoffs/<a>-to-<b>.json` | agent | agent (FS) | path-containment via Rust |

The sanitizers are genuinely hardened: `parsePlan` runs Kahn's algorithm to drop cyclic/unreachable tasks, validates task ids against a filename-safe regex (they become filenames), protects against `__proto__`/`constructor` keys, dedups, and filters deps to known ids. `parseVerdict` accepts only literal `approve`/`reject`. The trust posture everywhere is *drop, never throw*.

### The lifecycle model

Two launch paths exist: `startSwarmFromWizard` (a hand-built DAG of agents) and `startSwarm` (mission-first: seed ONE coordinator, its `plan.json` materializes workers via `ingestPlan`). The mission-first path is the real one.

1. **Coordinator** runs *live* as an interactive TUI (for injection-capable providers). It writes `plan.json`, emits a scoped `[PLAN_READY:<marker>]`, and Bridge materializes one builder per task (plus an auto-generated reviewer per `review: true` task), wired by `dependsOn`.
2. **Scheduler** (`checkAndRunNextAgents` -> `runAgentScan`): dependency blocking, parallelism cap (`maxParallel` or global pane limit), and a working-copy-then-commit pattern to avoid clobbering concurrent launches. Each agent is a PTY session running a provider CLI with the prompt piped in.
3. **Completion** is inferred by regex-scraping the PTY rolling tail for *scoped* markers (`[AGENT_DONE:<marker>]`) so one agent can't be completed by another pane's output (`agentSignals.ts`). A PTY-exit fallback guarantees a terminal state if no marker ever prints.
4. **Live coordinator feedback**: Bridge injects results digests into the coordinator's PTY as bracketed-pasted user turns, gated on an idle/quiet heuristic (`pumpDigests`). Workers' failures are pushed to it mid-wave; the fallback provider path relaunches the coordinator with the `digestLog` embedded in its prompt (`notifyCoordinator`).
5. **Review gates**: the finished reviewer's `verdicts/*.json` is machine-read (`ingestVerdict`); `approve` unblocks dependents, `reject` auto-reworks the builder with bounded `maxAttempts`, garbage verdicts park for a human.
6. **Acceptance** (`runAcceptance`): Bridge runs `plan.acceptance.command` **verbatim** with a 10-minute timeout, and `completed` is only ever set when it exits 0. It has an identical-failure short-circuit (two same-hash failures escalate) and a `maxWaves` budget, then hands off via a structured `SwarmEscalation`.
7. **Recovery**: crash/restart reconciliation downgrades zombies, replays pending PTY exits, auto-relaunches the coordinator once, and reconciles a stale `running` acceptance to `idle`.

There is also a **control plane** (P0/P3): canonical `agents.json`/`runs.json`/`artifacts.json` written atomically via Rust `canonical_record_write`, cross-referenced to `sessions.json`.

### What Saple genuinely does well

- **Adversarial hardening of untrusted agent output.** Every agent-authored file is sanitized; this is more defensively thorough than what's visible in Traycer's protocol (which uses zod validation but doesn't show the same hostile-input posture for agent-authored state).
- **Verified completion.** Acceptance is executed by Bridge, never self-reported by an agent. That's a strong trust property.
- **Bounded repair.** Attempt budgets, `maxWaves`, and the identical-failure short-circuit prevent infinite loops.
- **Crash/restart recovery.** Orphan reconciliation, pending-exit replay, coordinator auto-relaunch - genuinely thoughtful.
- **Machinery hygiene.** Marker scoping, the event backbone, per-project write serialization, `in-flight`/`queued` guards on the scheduler.

---

## Part 2 - How Traycer orchestrates (from the protocol)

Traycer's `protocol/` package exposes the full client<->Host wire contract. The Host (the actual engine) is closed, but the contract makes the architecture unambiguous - and it is a *fundamentally different coordination paradigm* from Saple's.

### 1. Agent-to-agent messaging is the first-class primitive

`a2a-message-format.ts` and `agent/inbox.ts` describe a **message broker** built for A2A:
- Sending is a broker operation (`agent.sendMessage`), not an agent writing a file.
- Every receiver gets a **per-agent inbox queue** (RAM, with a retained ring for re-read).
- Messages are **threaded** via `responseId`. A sender can say `expectsReply: true`; a *reply* that echoes the `responseId` completes the thread (distinct from a fresh message). One reply answers the whole thread.
- Delivery is **streamed to a live monitor** (`agent.inbox.subscribe`) with queue-and-replay-on-connect.
- The broker runs an **inactivity sweep** that emits typed stalls: `turn-ended`, `exited`, `quiet` (watchdog backstop), `user-stopped`, `errored`, `awaiting-input`, `receiver-cancelled` - with explicit definitive-vs-advisory semantics. A sender waiting on a reply learns *why* its counterparty went silent.

This is what enables "automated loops where agents debate architecture or peer-review code" - the README's headline use case.

### 2. Self-organization via role claims

`roles.ts`: any agent can `claim` a role over a Task-local `scope` (`agent.roles.claim`), `list` the registry, and `relinquish` it. Peers read the registry to *divide work without a central planner*. Overlap is allowed but surfaced; a claimed role is **durable responsibility independent of any broadcast**, and awareness (delivered/unreachable/failed/prompt-pending) is best-effort courtesy on top.

There is no "coordinator writes a plan.json that Bridge materializes." Agents claim ownership of work and collaborate through messages.

### 3. Lineage - agents create agents

`agent-list-format.ts` renders agents grouped by **parent / siblings / children**, and the communication graph records `agent_created` events. "Every agent can be referenced; reading a transcript and delivering a message are narrower and depend on user, Host, and runtime." So the roster is a dynamic tree with recursive delegation, not a fixed DAG.

### 4. Durable observable communication graph

`epic/communication-graph.ts`: an append-only SQLite event log (`a2a_message`, `a2a_notice`, `agent_created`) with autoincrement-id **resume cursors**, snapshot+event streaming, exactly-once gap-free delivery, and a GUI tile that plays back who-said-what-to-whom. Message-passing causality is preserved because A2A is host-local.

### 5. Epics, harnesses, and provider-richness

- **Epics** are the durable multi-agent grouping unit: workspace + boards + tickets + real-time collaboration, and agents are epic-scoped and host-verified.
- **Harnesses** abstract the coding agents (`claude`, `codex`, `cursor`, `opencode`, native) - BYOA without paying twice.
- **Provider profiles + rate limits**: `agent.configure` and `agent.listProviderProfiles` surface per-provider subscription state, usage windows, and limits directly *to the agents* so they can self-throttle.
- **Unified context**: the headline feature - switch models/providers within the *same* durable agent session while sharing the context window.

### 6. Runtime rigor

Per-method **versioned RPC negotiation** (`{ major, minor }` at handshake), `subagent-nesting.ts` (a total classification so child events nest or suppress, never leak to the parent), runtime-capability negotiation, and frozen wire contracts with explicit upgrade paths.

---

## Part 3 - How Saple fares in direct comparison

| Dimension | Saple Bridge | Traycer |
|---|---|---|
| Coordination paradigm | Centralized: coordinator plans a static DAG, Bridge schedules it | Decentralized + centralized: broker message passing + role claims + lineage |
| Agent to agent comms | File handoffs (nominal) + human mailbox; *no real A2A* | Broker, inbox queues, threads (`responseId`), reply semantics |
| Dynamic roster | Fixed wizard DAG, or plan.json waves; P6 worker requests need *human* approval | Agents create agents (lineage tree) |
| Feedback on stalls | `failed` status / escalation only | Typed broker notices (errored, awaiting-input, quiet, user-stopped...) |
| Communication trail | ephemeral event fan-out only | durable append-only log + replay + graph view |
| Division of labor | coordinator predecomposes | self-organizing via role claims (plus optional structure) |
| Context | one provider/model per PTY session | unified context across models/providers in one agent |
| Trust hardening | excellent (sanitizers, markers) | protocol validation (host-side hardening not visible) |
| Verified completion | excellent (Bridge runs acceptance) | not visible in protocol |
| Versioning of orchestration contract | ad-hoc (`version: 2`, marker tokens) | per-method versioned RPC + negotiation |

**The headline finding:** Saple has a *strong, trust-hardened, well-recovered centralized workflow scheduler*. Traycer has a *distributed agent communication substrate* on which self-organizing workflows run. Saple's biggest gap is not quality - it is that **agents cannot actually talk to each other**, so the only coordination patterns it can express are the ones Bridge pre-schedules (build -> review -> accept). Debate, autonomous peer-review loops, dynamic re-planning by peers, and self-dividing work are structurally impossible in Saple's current model, and those are exactly Traycer's headline capabilities.

---

## Part 4 - How to improve your implementation

Ordered roughly by leverage, aligned with (and extending) `docs/agent-orchestration-plan.md`. No code here - just direction.

### 1. Add a real agent-to-agent message layer (the highest-leverage gap)

You already have the mailbox machinery and the event backbone. Promote it into a proper broker:
- Give agents a **write-to-peer** path (not just human->agent mailbox). You already have `postToMailbox` and a Rust `write_mailbox_file`; add an inbox per agent that peers can address.
- Add **thread semantics** (`responseId` + `expectsReply`) so a request and its reply are distinguishable, and one reply completes a thread.
- Add **typed stall notices**. You already detect PTY exit codes, `awaiting-input` (an agent waiting on review), and errors. Route these to the waiting party as *typed* notices (`errored`, `awaiting-input`, `exited`, `user-stopped`) instead of a generic `failed` status. This is what lets a coordinator distinguish "the worker is blocked on a human" from "the worker crashed."

This unlocks debate/peer-review patterns with minimal new infrastructure, because your scheduler and trust tooling are already in place.

### 2. Decouple the roster from the static DAG: support self-organization too

Keep the mission-first coordinator/plan mode (it is good), but add a **role-claim** primitive so agents can also divide work themselves:
- An agent declares "I claim role `X` over scope `Y`"; peers query a registry to avoid duplicating responsibility.
- The claim is **durable responsibility even if the broadcast fails** - decouple the registry write from the awareness fan-out (you already model this in `escalation`/`state.json`).
- Keep the DAG as one *strategy*, not the only container for "what is a swarm."

### 3. Enable dynamic lineage - agents spawn agents

Your P6 worker requests are agent -> human -> Bridge. Let a coordinator (or a builder) **spawn a child agent directly and message it**, producing a parent/children tree. You already materialize workers from `plan.json`; the change is letting an *agent* author that request and having Bridge approve-or-execute rather than always requiring a human click. Track `parent` on the agent so lineage is visible and attributable.

### 4. Make the communication trail durable and replayable

Today `swarmEvents.ts` is fan-out, not a log. Add an **append-only interaction log** (a `communications.json` with monotonic ids) that records: messages sent, agent creations, verdicts, and notices. Use it for:
- Resume/replay (you already have the cursor pattern in `digestLog` and `escalation.json`).
- A "communication graph" view (who wrote to whom, which threads are open - derivable as "an `expectsReply` send with no later reply").
Keep the log separate from `state.json` (which is your Bridge-owned snapshot) so agents' writes don't trigger full-state saves.

### 5. Strengthen liveness and failure routing

You already have per-pane signal tails and exit fallbacks. Extend them into the stall-notice vocabulary above, so the coordinator and dependents get *why*-level signals. This directly addresses the "awaited but silent" failure mode that currently surfaces only as a parked `review` or `failed` card with a `statusReason`.

### 6. Keep pushing the scheduler out of React (already planned, reinforced)

Traycer's advantage is a durable engine (Host) behind a versioned protocol; React determines nothing. Your `agent-orchestration-plan.md` Phase 2 (single-writer broker) and Phase 3 (Rust engine) are the right answer. The Traycer comparison adds two specific motivators:
- **One mutation owner.** A message broker and interaction log mean even *more* concurrent writers to `.saple/`; the single-writer broker is no longer optional once agents write to each other.
- **Versioned orchestration contract.** Once agents send messages and claim roles, you want a negotiated, versioned wire contract (your `plan.json version: 2` and marker tokens are a start; formalize the message/registry shapes and negotiate at start like Traycer's `{ major, minor }`).

### 7. (Deep, optional) Unified context across providers within one agent

This is Traycer's flagship and the hardest. It means decoupling the **durable agent session/context thread** from the **harness/model** executing a turn, so a swarm agent can switch models/providers without losing its working context. This is architecturally deep (it changes what a PTY session *is*) and should stay behind the single-writer/crate boundary. Do it only after 1-4, and only if mid-swarm model switching becomes a real product requirement.

---

## Bottom line

Your implementation is **more trust-hardened and crash-safe than what Traycer exposes in its protocol**, particularly around sanitizing hostile agent output, verified completion, and bounded repair. What it lacks is the *coordination substrate*: real agent-to-agent message passing with thread/reply/stall semantics, self-organization via role claims, dynamic agent lineage, and a durable replayable communication log. The good news is that most of those are additive to what you already built - you have the trust boundary, the event backbone, the recovery machinery, and the control plane. The single biggest step is giving agents a genuine way to talk to each other and know when their counterparty went quiet, which then unlocks the debate/peer-review/self-organizing patterns that are currently impossible in your model.
