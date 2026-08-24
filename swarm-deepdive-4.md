# Deep Dive: Saple-Bridge Swarm Orchestration vs. Traycer

> Comparative analysis of the multiagent swarm orchestration system in saple-bridge (`src/stores/swarmStore.ts`, `src-tauri/src/swarm.rs`) against the traycer orchestration system (`D:/project/repos/traycer` — protocol, CLI, GUI app, Electron shell).

---

## 1. Saple-Bridge: Architecture at a Glance

### Design Philosophy: Bridge-as-Director

Saple-Bridge implements a **fixed-pipeline orchestrator**. The React frontend (`swarmStore.ts`, ~1870 lines) is the active director. It owns an opinionated, multi-phase orchestration lifecycle that the coordinator agent participates in but does not control. Rust (`src-tauri/src/swarm.rs`, `pty.rs`, `watcher.rs`, `review.rs`, `control_plane.rs`, `project.rs`) provides the substrate: PTY sessions, file I/O, file watching, atomic writes, and shell command execution — but the orchestration *logic* lives entirely in TypeScript.

### The Five-Phase Pipeline

The code documents itself as "Swarm v2" with explicit phases:

| Phase | Component | What It Does |
|-------|-----------|-------------|
| **P2** | `startSwarm` + `ingestPlan` | Seeds ONE coordinator from a mission prompt. Coordinator writes `plan.json`; Bridge parses, sanitizes (drops cycles/malformed tasks), and materializes workers wired by dependency. |
| **P3** | `notifyCoordinator` + `pumpDigests` | Live coordinator (Claude/Codex interactive TUI) receives results digests via bracketed-paste injection. Falls back to digest-relaunch (fresh prompt with digest history embedded) for non-injectable providers or crashed coordinators. |
| **P4** | `ingestVerdict` + `reworkAgent` | Auto-generated review-gate reviewers. Machine-read `verdicts/*.json`. Approve unblocks; reject triggers bounded rework (budget: `maxAttempts`, default 1). Past budget, parks for human. |
| **P5** | `runAcceptance` + `escalateSwarm` | **Verified completion** — Bridge runs the acceptance command itself (never trusts agent claims). Guards: identical-failure short-circuit (hash), max-waves escalation, no-new-tasks escalation. Writes `escalation.json`. |
| **P6** | `resolveWorkerRequest` | Agents append worker requests to `requests.json`; Bridge surfaces them to the operator for approval before launch. |

### Key Mechanisms

**Signal-based completion** (`src/lib/agentSignals.ts`): Agents emit bracketed markers — `[AGENT_DONE:<token>]`, `[AGENT_FAILED:<token>]`, `[REVIEW_REQUESTED:<token>]`, `[PLAN_READY:<token>]`, `[PLAN_UPDATED:<token>]` — detected from rolling PTY output tails (512-char window, line-anchored regexes). Each agent gets a **unique scoped token** (8 hex chars minted at seed time) so one agent can't spoof another's completion. The Rust emitter coalesces PTY output at 16ms intervals to prevent IPC saturation.

**File-based IPC**: All inter-agent communication happens through files under `.saple/swarm/`:
- `plan.json` / `state.json` — coordinator output / Bridge state
- `mailbox/<agentId>.md` — operator-to-agent and agent-to-agent notes
- `handoffs/<from>-to-<to>.json` — dependency-edge handoff payloads
- `verdicts/<taskId>.json` — reviewer judgment
- `outcomes/<agentId>.json` — structured outcomes
- `requests.json` — agent-requested workers

**Trust boundary** (`src/lib/swarmPlan.ts`): Every agent-written file is sanitized with a strict "drop, never throw" policy. Plan tasks need filename-safe slug ids (used as verdict file paths). Kahn's algorithm drops cyclic tasks. Verdicts accept only `approve`/`reject`; anything else parks for a human.

**Restart recovery** (P13): State.json reconciliation on load detects orphaned (running status, dead PTY) agents and recovers scoped markers still in the signal tail. A cross-project mechanism (`pendingAgentExits` map, module-level in `swarmStore.ts`) records PTY exits that fire while the agent's project isn't loaded, replayed on project switch-back.

**Workspace isolation** (P11): Each swarm gets its own workspace instance (same folder, separate sidebar entry named `"base (swarm)"`) so agent panes don't mix with the user's interactive terminals. Panes are pinned to this instance ID via `addPane`'s 6th argument.

**Control plane integration** (P0/P3): Agent runs are also recorded as canonical `.saple/{agents,runs,artifacts}.json` via `canonical_record_write` (Rust), locked cross-process so the saple-mcp sidecar can't clobber Bridge writes.

### Rust Backend (`src-tauri/src/swarm.rs`)

5 Tauri commands registered in `lib.rs`:
- `read_swarm_state` / `write_swarm_state` — full state.json round-trip
- `read_mailbox_file` / `write_mailbox_file` — per-agent mailbox
- `read_handoff_file` / `write_handoff_file` — from→to handoff JSON
- `validate_dependency_graph` — cycle detection via 3-color DFS (tested)
- `run_acceptance_command` — shell command with 600s timeout via `review::run_shell_with_timeout`

Key Rust modules:
- `fs_lock.rs` — per-path mutex + temp-file-rename atomic writes
- `project.rs` — `get_project_file_path` (symlink-safe containment: rejects absolute paths, `..` segments, `Prefix`/`RootDir` components; canonicalizes parents before create_dir_all)
- `pty.rs` — 3-thread PTY architecture (reader/emitter/writer), 16ms output coalescing, Windows Job Objects for process-tree killing, provider allowlisting, model name validation, prompt file path traversal prevention, bracketed-paste interactive delivery
- `watcher.rs` — two independent watchers: 300ms debounce for `.saple/` (state/tasks/sessions), 150ms for `.saple/swarm/` (plan/verdicts/outcomes/mailbox/handoffs/requests), echo-suppression via `is_last_own_write`

### Test Coverage

- **`swarmStore.test.ts`** (1,080 lines): Scheduling (launch order, blocking transitivity, parallel caps), restart reconciliation (zombie detection, live-terminal preservation, state reset), plan ingestion (materialization, dependency mapping, idempotency, cycle/malformed dropping), live coordinator (wave digests, crash auto-relaunch, second-crash escalation), acceptance & repair waves (pass/fail, identical-failure short-circuit, max-waves escalation, no-new-tasks escalation, timed-out=failure), automated review gates (approve/reject, bounded rework, budget exhaustion, garbage verdicts, lenient watcher path), P13 cross-project recovery (marker tail, pending exit, tail-wins-over-exit, anti-spoofing), P11 workspace isolation, P6 worker requests
- **`agentSignals.test.ts`** (165 lines): Marker detection, scoping/anti-spoofing, plan signals, exit fallback, pre-filters
- **`swarmPlan.test.ts`** (224 lines): Sanitization, acyclicity (Kahn's), diffing, prototype-pollution resistance, filename-safe id validation
- **`swarmDigest.test.ts`** (110 lines): Digest formatting, hash acceptance
- Rust tests: dependency graph validation (acyclic, direct cycle, self-dep, transitive cycle, unknown deps, empty), acceptance exit codes, path containment (traversal, absolute, symlink)

---

## 2. Traycer: Architecture at a Glance

### Design Philosophy: Host-as-Platform

Traycer is a **collaborative multi-agent platform**. The actual orchestration host (Rust/Cloud, **closed-source binary not in this repo** — `docs/DEVELOPMENT.md` confirms: "The Traycer Host and cloud backends are not here") is the broker and state manager. The open-source repo provides:
- `@traycer/protocol` — a formally versioned wire contract (Zod schemas, per-method `{major, minor}` RPC versioning with upgrade/downgrade paths)
- `traycer-cli` — host lifecycle (download/verify signed host, auth, agent/workspace commands)
- `gui-app` — React renderer
- `desktop` — Electron shell

### The A2A Communication Model

Traycer's multi-agent story centers on **Agent-to-Agent (A2A) messaging** — a broker-mediated model where agents spawn peers and message each other directly:

```
agent.create  →  agent.sendMessage  →  agent.getTranscript
     ↓
agent.inbox.subscribe (streaming, TUI agents via `traycer monitor`)
agent.roles.claim (role-based coordination)
epic.communicationGraph.subscribe (audit trail)
```

**How A2A works:**
- `agent.create` (`clients/traycer-cli/src/commands/agent-create.ts`): An agent spawns a child agent (GUI chat or TUI terminal), establishing a `parentId` lineage. Surface + harness + profile are resolved at creation via `createAgentRequestSchemaV30`.
- `agent.sendMessage` (`clients/traycer-cli/src/commands/agent-send.ts`): Fire-and-forget or threaded (reply-expected with `responseId`). The host's broker enqueues messages on the receiver's per-agent inbox queue (RAM-only ring buffer).
- `agent.inbox.subscribe` (`protocol/src/host/agent/inbox.ts`): A **streaming RPC** that pushes inbox messages to the agent in real-time. For TUI agents, `traycer monitor` (`clients/traycer-cli/src/commands/monitor.ts`) runs inside the agent's session (e.g., as a Claude Code background command) as a WebSocket client that subscribes to the inbox stream and prints messages to stdout. Features: reconnection with exponential backoff (500ms→30s), proactive + reactive auth refresh, endpoint polling for host restarts.
- **Inactivity notices**: The broker detects stalled A2A threads with 7 reason codes (`turn-ended`, `exited`, `quiet`, `user-stopped`, `errored`, `awaiting-input`, `receiver-cancelled`). These are the only durable record for TUI-to-TUI messages (which have no shared transcript).
- `agent.roles.claim` (`protocol/src/host/agent/roles.ts`): Agents claim roles over task scopes; peers get awareness delivery (delivered / unreachable / deferred-to-prompt / failed). `deferredToPrompt` (v1.1) names agents whose next fresh prompt will carry the update. This is coordination signaling, not authorization.

**The communication graph** (`protocol/src/host/epic/communication-graph.ts`): An **append-only event log** in the host's SQLite, streamed via `epic.communicationGraph.subscribe@1.0`:
- Exactly-once, gap-free delivery relative to the client cursor
- Bounded snapshot batch (transport optimization, NOT a completeness claim)
- Multi-host merge: A2A is host-local (cross-host sends rejected); the tile opens one subscription per host and merges client-side by `timestamp`
- Resume by cursor (`sinceCursor`). Because ids are monotonic and immutable, resume is dedup-free
- Representability exception: rows whose `kind` the serving host can't represent are SKIPPED (not held back, not retried) — this prevents one corrupt row from wedging an entire epic's graph

**TUI agent lifecycle** (`protocol/src/host/agent/tui/contracts.ts`): The host tracks agent activity via hooks. Key RPCs:
- `agent.tui.prepareLaunch` — prepare a TUI agent launch (harness-specific session allocation)
- `agent.tui.recordActivity` — activity tracking with `start`/`stop` edges (v1.1 adds Claude session-id resync)
- `agent.tui.turnEnded` — detects when an agent's turn ends (via Stop hook)
- `agent.tui.generateTitle` — generates a title for an agent

Profiles are version 3.0+ with rich selection semantics: `last_used`, `ambient`, `profile` (managed), `inherit_sender` (compatibility-only). The v1.0→v2.0→v3.0 upgrade paths are explicitly defined and tested.

### Protocol Rigor

Traycer's protocol is **formally versioned** with three independent versioning systems (documented in `protocol/README.md`):
1. **npm semver** (`package.json` `version`) — distribution
2. **Per-method `{major, minor}` RPC schema versions** (`protocol/src/framework/versioned-rpc.ts`) — handshake-negotiated at runtime, NOT npm semver. A patch bump to npm version does not imply a schema change.
3. **Per-record persistence `{major, minor}` schema versions** (`protocol/src/persistence/registry.ts`) — on-disk Yjs/SQLite shape compatibility, negotiated separately from RPC versions.

The protocol ships explicit `defineUpgradePath` / `defineDowngradePath` for every released method version transition. The downgrade paths are carefully engineered (e.g., `agentCreateDowngradeV20ToV10` rejects `ambient` and `last_used` selections that v1.0 cannot represent, rather than silently falling back). Compatibility is checked at CI via `released-floor.test.ts` and `two-sided-release-invariant.test.ts`.

### Collaboration & Transport

- **Real-time shared state**: Yjs CRDTs for cross-device sync of chats, agents, tasks, comments
- **WebSocket streaming RPC**: `WsStreamClient` with full transport resilience (dial timeout, open-ack, ping/pong, reconnect with backoff)
- **Shared code**: Transport/auth formatting in `clients/shared/`; wire contract in `protocol/`. The AGENTS.md explicitly says "don't duplicate"
- **Multi-synchronous surfaces**: GUI (SDK-driven, streamed `RuntimeEvent` chunks) and TUI (real PTY, host prepares launch, CLI runs interactively). Cross-surface A2A is mediated by the host
- **Surface-narrow harness enums**: `guiHarnessIdSchema` and `tuiHarnessIdSchema` derived from `harnessIdSchema` via `.extract()`, so adding a vendor to one surface without the other is a compile error

### Agent Identity & Security

- **Host identity**: `hostId` is canonical; "device" is UI copy only (no parallel `deviceId`)
- **Role claims are attribution, not authorization**: `claimantAgentId` is verified against the authenticated user and epic before being honored
- **Reserved system sender**: `traycer:system` is a reserved agent id enforced by the host, used for system notices
- **A2A participation gate**: `canParticipateInA2A()` — every GUI agent + only Claude Code TUI agents (other TUI harnesses have no inbox transport)
- **A2A is host-local**: cross-host sends are rejected (clone-not-migrate instead)

---

## 3. How Saple-Bridge Fares Against Traycer

### Where Saple-Bridge Excels

1. **Batteries-included orchestration pipeline** — You get a complete, opinionated journey from "here's a mission" to "verified completion" with bounded repair waves, escalation, and structured reports. Traycer gives you primitives (create, send, claim roles) and expects agents/users to compose them. Saple-Bridge's pipeline is more of a "guardrail" system where Bridge itself enforces completion verification, review gates, and rework budgets.

2. **Verified completion (Phase 5)** — Arguably the strongest design decision. Bridge runs the acceptance command itself with a 600s timeout (`run_acceptance_command` → `review::run_shell_with_timeout`), never trusting an agent's "I'm done" claim. The identical-failure short-circuit (djb2 hash of trimmed output compared across consecutive failures) and max-waves budget prevent infinite repair loops. Traycer has no equivalent — an agent claiming completion is just taken at its word (or the user's).

3. **Deterministic crash recovery** — The P13 cross-project signal recovery is sophisticated:
   - Rolling 512-char signal tail per pane (catches markers split across PTY bursts)
   - `pendingAgentExits` map records PTY exits that fire while the agent's project isn't loaded
   - Marker tail wins over pending exit (fast path vs. safety net priority)
   - Bare markers cannot complete scoped agents (anti-spoofing on recovery)
   - Digest-log persists across coordinator crashes; one free auto-relaunch, second crash escalates
   - `coordinatorState` is transient observability: what the live coordinator is doing right now

4. **Scoped anti-spoofing markers** — Per-agent token-based signal matching (`[AGENT_DONE:abc12345]`) is a genuinely clever mechanism. The `MARKER_TOKEN_RE = /^[A-Za-z0-9_-]+$/` charset restriction ensures tokens can be interpolated into regexes safely. A bare marker (`[AGENT_DONE]`) never advances a scoped agent. This is more robust than Traycer's thread-based reply model, which relies on the broker for delivery guarantees.

5. **Test coverage is excellent** — 1,080 lines of `swarmStore.test.ts` that read like a specification (given a state, when an event fires, then transitions happen). Every phase is tested: scheduling, reconciliation, plan intake, live coordinator, acceptance waves, review gates, cross-project recovery, workspace isolation, worker requests. The tests even cover edge cases like "marker tail wins over pending exit when both exist" and "bare marker from another pane cannot complete a scoped agent on recovery." Traycer's protocol has tests but they're mostly contract-compatibility tests (version upgrade/downgrade), not behavioral orchestration tests (the host is closed-source).

6. **Rust security hardening** — Provider allowlisting (`provider_command` returns `None` for unknown providers), model name validation (`is_safe_model` rejects shell metacharacters), prompt file path traversal prevention (`validate_prompt_file` rejects `"`, `'`, `` ` ``, `$`, `<`, `>`, `|`, `;`, `&`, `\n`, `\r`, `..`, absolute paths), Windows Job Objects for process-tree killing, 16ms PTY output coalescing with 64KiB flush threshold, bracketed-paste delivery, per-path atomic write locking with cross-process temp-file-rename.

7. **Concurrency control** — `checkAndRunNextAgents` is serialized via `agentScanInFlight`/`agentScanQueued` flags to prevent re-entrant scheduler invocations from launching duplicates. The scan commits changes by agent id (not whole-array overwrite) to avoid reverting agent states that `launchAgentProcess` advanced during the scan's awaits.

### Where Traycer Surpasses

1. **Protocol versioning rigor** — Traycer's per-method `{major, minor}` RPC versioning with hand-tested upgrade/downgrade paths is a gold standard. `saple-bridge`'s `plan.json` has a `version: 2` field but no systematic compatibility story. As the plan format evolves, there's no mechanism to handle old vs. new versions. The `parsePlan` function defaults version to 2 and silently parses — if a v3 coordinator writes a plan with a new field the v2 parser doesn't understand, it's dropped with no signal that anything was lost.

2. **Agent-to-agent messaging as a primitive** — Traycer's `agent.sendMessage` with threading, reply-expected semantics, and the broker with inactivity notices is a richer inter-agent communication model than saple-bridge's file-based mailbox/handoff. A2A lets agents dynamically decide to communicate, ask questions, request help — not just pass structured artifacts through files. The `traycer monitor` background command is a particularly elegant solution for delivering messages to TUI agents.

3. **Cross-device collaboration** — Traycer's Yjs-based shared state and multi-host communication graph merge give real team collaboration. Saple-Bridge is strictly local-first with no sync story. This is a design choice (local-first), not a bug, but it means saple-bridge can't do what Traycer does for teams.

4. **Streaming infrastructure** — Traycer's `WsStreamClient` with reconnection, auth refresh (proactive + reactive), exponential backoff, ping/pong health checks, and endpoint polling for host restarts is a full transport layer. Saple-Bridge relies on Tauri events + file watchers, which is simpler but less robust for scenarios where the host might disappear and reappear (which doesn't happen in saple-bridge's local-only model, but would matter if it ever added networking).

5. **Activity & awareness tracking** — Traycer tracks agent activity levels (`hasActivity` from `agent.tui.recordActivity`), turn state, and role awareness with delivery status. Saple-Bridge tracks status (running/done/failed/review/waiting/blocked) but has no concept of "agent is actively producing output" vs. "agent is idle at its prompt." The Phase 3 code has a prototype of this (`coordinatorLastOutputAt`, `IDLE_QUIET_MS = 3000`) but it's only used for coordinator digest injection, not surfaced to the UI.

6. **Event log / audit trail** — Traycer's append-only communication graph with exactly-once delivery and cursor-based resume is an audit-quality event log. Saple-Bridge's `digestLog` is a transient list of prompt-delivery texts stored in `state.json`, conflated with the prompt-injection mechanism. There's no durable, queryable record of what happened during a swarm run for post-hoc analysis.

7. **Agent lifecycle hooks** — TUI agents report `turnEnded`, `recordActivity`, `generateTitle` via host RPCs (`agent.tui.*`). This gives the host fine-grained visibility into what agents are doing. Saple-Bridge infers completion only from PTY output markers and process exit — it can't tell if an agent is mid-turn or waiting at a prompt.

8. **Enterprise concerns** — Profile management (multi-profile, ambient login, last-used, per-user/per-provider), auth (PKCE/device flow), rate limiting, team permissions, sharing, crash reporting (Sentry), analytics. Saple-Bridge has none of this (appropriately — it's a local dev tool).

### Fairness Check: Traycer's Blind Spots (relative to saple-bridge)

It's worth noting that Traycer's model has its own limitations that saple-bridge handles better:

- **No completion verification**: Traycer has no equivalent of saple-bridge's acceptance command. An agent in Traycer can claim it's done and the system takes it at its word (or the user's).
- **No bounded rework**: Traycer agents can endlessly message each other in loops. Saple-bridge's `maxAttempts` + `maxWaves` + identical-failure short-circuit provides explicit guardrails against this.
- **No crash recovery with state reconstruction**: Traycer's event log lets you *see* what happened, but it doesn't actively *recover* a crashed coordinator with digest replay. Saple-Bridge's P13 recovery and coordinator auto-relaunch are more proactive.
- **No workspace isolation**: In Traycer, agent panes share the same workspace instance. Saple-Bridge's P11 workspace isolation keeps agent terminals separate from the user's interactive terminals.

---

## 4. Improvement Recommendations for Saple-Bridge

### A. Add Protocol Versioning to Agent-Written Contracts (High Priority)

**Problem**: `plan.json`, `verdicts/*.json`, `outcomes/*.json`, and `requests.json` are sanitized but lack version fields. The `parsePlan` function defaults `version` to 2 and silently parses. If a v3 coordinator writes a plan with a new field the v2 frontend doesn't understand, it's dropped with no signal that anything was lost. There's no upgrade path or compatibility negotiation.

**Fix**: Add explicit `version` fields to every agent-written contract file (plan, verdict, outcome, request). Implement versioned parsers that can handle version skew gracefully — e.g., a v3 plan that a v2 frontend can partially understand (parse known fields, warn on unknown). Mirror Traycer's approach: define per-contract `{major, minor}` versions with explicit upgrade/downgrade logic. At minimum, reject plans with a version the parser can't handle (return an empty plan + log a warning) rather than silently parsing a foreign format as v2. This should be applied to `parsePlan`, `parseVerdict`, `parseAgentOutcome`, and `parseWorkerRequests`.

### B. Add Direct Agent-to-Agent Messaging (High Priority)

**Problem**: Inter-agent communication is entirely file-based (mailbox, handoffs). This is slow (agents must poll/read files), implicit, and limited to structured handoff data. There's no way for Agent A to ask Agent B a question mid-task — it requires the operator to post to a mailbox, or for one agent to write a file the other might not check.

**Fix**: Leverage the live PTY injection mechanism (already built for Phase 3 digest delivery in `pumpDigests`) to create a lightweight **inter-agent message bus**. An agent writes a message envelope to `.saple/swarm/messages/<to-agentId>.json` (or `.jsonl` for append-only); the Rust `swarm-file-changed` watcher detects it and emits a Tauri event to Bridge; Bridge injects it into the recipient's PTY as a bracketed-paste user turn (if the provider supports injection and the pane is idle, using the existing `providerSupportsTurnInjection` + idle-quiet heuristic) or queues it in `digestLog` for the next relaunch (the existing digest-relaunch fallback). This mirrors Traycer's `agent.sendMessage` but uses the PTY as the delivery channel for live agents and files as the durable record.

### C. Add Activity Awareness to Agent Status (Medium Priority)

**Problem**: Agent status is inferred only from lifecycle markers and process exit. There's no way to know if a "running" agent is actively producing output or stuck at a prompt. The `ElapsedTime` badge shows how long it's been running, but not whether it's alive. Operators can't distinguish "thinking hard" from "frozen."

**Fix**: Generalize the Phase 3 `coordinatorLastOutputAt` / `IDLE_QUIET_MS` pattern to all swarm agents. Track per-pane last-output timestamps in the terminal output listener (where `appendSignalTail` already runs). Expose an `active` boolean and `lastOutputAt` timestamp on each `SwarmAgent`. Surface this in `SwarmAgentCard` and `SwarmGraph` as an "active/idle" indicator. When a "running" agent has been quiet for >30s, dim the node or add an idle badge, signaling the operator to check on it. This is a subset of Traycer's `agent.tui.recordActivity` but implemented via the existing PTY output stream — no new hooks needed.

### D. Add an Append-Only Swarm Event Log (Medium Priority)

**Problem**: The `digestLog` is a transient list of prompt-delivery texts stored in `state.json`. It's not queryable, not auditable, and conflated with the prompt-injection mechanism. There's no durable record of what happened during a swarm run for post-hoc analysis or for the escalation report to cite specific events.

**Fix**: Introduce an append-only `.saple/swarm/events.jsonl` log (one JSON event per line). Every significant state transition writes an event with a monotonic sequence number, ISO timestamp, agent id, and a typed payload: `agent_launched`, `marker_detected` (done/failed/review/plan_ready/plan_updated), `plan_ingested` (new task count), `verdict_processed` (taskId, decision, feedback?, automated), `reviewer_completed`, `acceptance_run` (exitCode, timedOut), `wave_advanced`, `digest_delivered` (kind, injection vs. relaunch), `coordinator_crashed` (crashCount), `rework_triggered` (attempt, maxAttempts), `escalation` (reason, wavesAttempted), `worker_request_resolved` (approved/rejected). This mirrors Traycer's communication graph but covers the entire swarm lifecycle. Benefits: auditors can replay what happened, the escalation report can cite specific events, and a future "timeline" UI view becomes trivial. The Rust watcher can emit these events; the TS store can consume them for state transitions (decoupling signal detection from state mutation).

### E. Make P6 Worker Requests Auto-Approvable Within Budget (Medium Priority)

**Problem**: P6 worker requests require explicit human approval for every one. While safe, this creates friction — an agent that identifies a clear need for a specialist worker must pause and wait for the operator.

**Fix**: Extend the autonomy model to worker requests. In `auto` mode, auto-approve requests that pass validation (valid role, known/empty dependencies, within `maxParallel` cap). In `gated` mode (current default), auto-approve requests from agents whose own task has been approved (reputation-based — if you were trusted to do the work, your request for a specialist is reasonable). Keep `manual` mode as the conservative path (all requests require approval). This mirrors how Traycer lets agents spawn peers freely, but retains saple-bridge's guardrail philosophy via the parallelism cap and the existing request validation in `parseWorkerRequests`.

### F. Version the State File and Add Migration (Low Priority)

**Problem**: `.saple/swarm/state.json` is written and read with ad-hoc field defaults (`parsed.field || default` or `parsed.field ?? default`). There's no explicit version on the state file itself, so a future schema change (renaming a field, changing a type) could silently misparse old state. The `loadSwarmState` catch block resets to defaults on any parse error, which means any corruption or incompatible change loses the entire swarm's state.

**Fix**: Add a `stateVersion: 1` field to `state.json`. On load, if the version is older, apply a migration function chain (v1→v2, v2→v3, etc.) before deserializing. This is straightforward given the existing sanitization pattern and would make future schema evolution safe. The migration functions should be pure and tested (like `parsePlan`).

### G. Add Dynamic Role Claims (Low Priority)

**Problem**: Agent roles (coordinator/builder/scout/reviewer) are fixed at materialization time from the plan task's `role` field. There's no way for an agent to dynamically declare or signal a role mid-task (e.g., "I'm now taking on the reviewer role for task X because the auto-reviewer failed").

**Fix**: Add a lightweight `.saple/swarm/roles/<agentId>.json` file that agents can write to claim or relinquish roles over specific task scopes. The Rust swarm watcher detects changes and emits a Tauri event; Bridge updates an in-memory role registry and notifies relevant peers (the agent they're reviewing, the swarm room). This is a subset of Traycer's `agent.roles.claim` — saple-bridge doesn't need the full awareness delivery network (delivered/unreachable/deferred-to-prompt/failed), just the ability to detect and surface dynamic role assignments. The existing `reviewTaskId`/`reviewTargetAgentId` fields on `SwarmAgent` are a prototype of this.

### H. Add a Communication Timeline Tab (Low Priority)

**Problem**: The SwarmWorkspace has two views: "Dependency Graph" (static DAG of task dependencies) and "Agent Cards Grid" (individual agent inspection). There's no view of what agents have communicated with each other — mailbox exchanges, handoff transfers, review feedback cycles, digest deliveries.

**Fix**: Add a "Timeline" tab that renders the event log from recommendation D. Show: agent launches, marker detections, plan ingestions, verdicts, acceptance runs, digest deliveries, escalations — as a vertical timeline with agent avatars, timestamps, and click-through to source (terminal, plan file, verdict file). This mirrors Traycer's communication graph tile but covers the full swarm lifecycle, not just A2A messages.

---

## 5. Summary Comparison

| Dimension | Saple-Bridge | Traycer | Assessment |
|-----------|-------------|---------|------------|
| **Orchestration model** | Fixed pipeline (coordinator→plan→workers→review→acceptance) | Open mesh (agents spawn peers, message each other) | Both valid; saple-bridge's pipeline is more prescriptive, traycer's is more flexible |
| **Agent communication** | File-based (mailbox, handoffs, markers in PTY) + PTY injection (digests) | Broker-mediated A2A (streaming inbox, threading, inactivity notices) | Saple-bridge could benefit from a direct messaging layer (Rec B) |
| **Completion verification** | Bridge runs acceptance command (gold standard) | Agent claims trusted; no verification | **Saple-Bridge wins decisively** |
| **Crash recovery** | Signal tail replay, pending-exit map, digest-log relaunch, P13 cross-project recovery | Event log with cursor resume, reconnect with backoff | Both strong; saple-bridge's recovery is more proactive, traycer's is more durable |
| **Protocol versioning** | Informal `version: 2` on plan.json; ad-hoc sanitization | Per-method `{major,minor}` RPC + per-record persistence versions with upgrade/downgrade paths | **Traycer wins decisively** — saple-bridge needs versioned contracts (Rec A, F) |
| **Cross-device/collaboration** | Local-first only | Yjs shared state, multi-host merge, team sharing | Traycer by design; saple-bridge is appropriately local-first |
| **Transport** | Tauri events + file watchers (Rust-side, 150-300ms debounce) | WebSocket streaming RPC (reconnect, backoff, ping/pong) | Traycer's is more robust for distributed scenarios |
| **Activity awareness** | Status from markers/exit only; idle heuristic only for coordinator injection | `agent.tui.recordActivity` with start/stop/turn-ended; `hasActivity` tracking | Saple-bridge should surface activity state (Rec C) |
| **Audit trail** | `digestLog` (transient, prompt-delivery conflated) | Append-only event log (exactly-once, cursor resume, multi-host merge) | **Traycer wins** — saple-bridge needs an event log (Rec D) |
| **Trust model** | Sanitize-and-drop all agent writes; verified completion; PTY exit fallback | Version-negotiated protocol; identity-verified claims; A2A is host-local only | Both solid; different threat models |
| **Test coverage** | 1,080 lines of behavioral tests covering every phase + edge cases | Contract/compat tests (host is closed-source, no orchestration behavior tests) | **Saple-Bridge wins for orchestration logic coverage** |

### Bottom Line

Saple-Bridge's swarm system is a **mature, opinionated, guardrails-first orchestrator** with exceptional attention to edge cases: crash recovery, cross-project continuity, anti-spoofing, bounded autonomy, and verified completion. Its strongest unique advantage is that **Bridge never trusts an agent's claim of completion** — it runs the acceptance command itself.

Its main gaps relative to Traycer are **protocol versioning rigor**, **direct agent-to-agent messaging**, **activity awareness**, and **auditability**. The four highest-impact improvements are:

1. **Versioned contracts** (Rec A) — prevents silent data loss as formats evolve
2. **Direct A2A messaging** (Rec B) — unlocks richer inter-agent collaboration using the existing PTY injection infrastructure
3. **Activity awareness** (Rec C) — surfaces "alive vs. idle" state to operators
4. **Event log** (Rec D) — creates an auditable, queryable record for post-hoc analysis and a future timeline UI
