# Multi-Agent Swarm Orchestration: Saple Bridge vs. Traycer

## Executive Summary

Saple Bridge's swarm system is a **single-host, PTY-based orchestrator** built on Zustand state management and Tauri's Rust/TypeScript boundary. It is well-structured for its scope (a local-first AI dev workspace) and demonstrates strong design decisions around marker-scoped lifecycle detection, phased execution (plan → build → review → accept), and crash recovery. However, it is a **monolithic frontend store** with ~1,870 lines of orchestration logic in a single file, and it lacks the protocol-level abstractions, multi-surface support, subagent nesting, and cross-host coordination that Traycer provides.

Traycer is a **multi-surface agent platform** with a protocol layer (typed RPC contracts, versioned schema evolution, streaming RPC), a host runtime that manages agent lifecycles across GUI chat tabs and TUI terminal tiles, and a rich event/activity model. It is orders of magnitude larger (~2,385 source files, ~6,100 lines in the agent protocol layer alone) and designed for a product where agents are first-class citizens across multiple surfaces and hosts.

---

## 1. Architecture Comparison

### Saple Bridge Swarm

```
┌─────────────────────────────────────────────────────────┐
│  React UI (SwarmWorkspace, SwarmComposer, SwarmGraph)  │
│  SwarmWizard (DAG-based launch wizard)                  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  swarmStore.ts (Zustand, persisted)                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │  State: agents[], plan, wave, autonomy, status   │  │
│  │  Actions: startSwarm, ingestPlan, notifyCoordinator│ │
│  │          runAcceptance, escalateSwarm, reworkAgent │  │
│  │  Scheduler: checkAndRunNextAgents (dependency scan)│ │
│  │  PTY Launch: launchAgentProcess (spawn pane)      │  │
│  │  Digest Pump: inject results into live coordinator │  │
│  └───────────────────────────────────────────────────┘  │
                       │
┌──────────────────────▼──────────────────────────────────┐
│  Rust Layer (Tauri commands)                            │
│  ├─ read/write_project_file                             │
│  ├─ read/write_swarm_state                             │
│  ├─ write_mailbox_file, write_handoff_file              │
│  ├─ run_acceptance_command                              │
│  ├─ watch_swarm_dir (FS watcher)                       │
│  └─ ensure_workspace_dirs                               │
└─────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- **Single-host, single-surface**: All agents run as PTY panes in the same Electron/Tauri window.
- **Monolithic orchestrator**: The entire swarm lifecycle (plan ingestion, scheduling, PTY launch, digest injection, verdict processing, acceptance running, escalation) lives in one Zustand store.
- **File-based coordination**: Agents communicate via `.saple/swarm/` files (plan.json, outcomes/, verdicts/, mailbox, handoffs, requests.json). Bridge is the sole reader/writer of structured state.
- **Marker-based lifecycle detection**: Agents signal completion via `[AGENT_DONE:<token>]` markers in PTY output, detected via regex against a rolling signal tail.
- **Phased execution**: Plan → Build → Review → Accept → Escalate, with wave-based iteration.

### Traycer

```
┌─────────────────────────────────────────────────────────────┐
│  GUI App (React)          │  CLI (traycer-cli)             │
│  ├─ Chat tabs (GUI agents)│  ├─ agent create/list/send     │
│  ├─ Epic canvas (TUI tiles)│  ├─ agent configure            │
│  ├─ Active agents panel   │  └─ agent activity hooks       │
│  └─ Settings/agents panel │                                 │
└────────────┬──────────────┴──────────────┬──────────────────┘
             │                             │
┌────────────▼─────────────────────────────▼──────────────────┐
│  Protocol Layer (@traycer/protocol)                        │
│  ├─ agent/contracts.ts (versioned RPC: agent.create/list/  │
│  │   sendMessage/getTranscript/stop)                        │
│  ├─ agent/gui/contracts.ts (GUI surface: listHarnesses,    │
│  │   listModels, chat subscribe)                            │
│  ├─ agent/tui/contracts.ts (TUI surface: prepareLaunch,    │
│  │   turnEnded, recordActivity, generateTitle)             │
│  ├─ agent/shared.ts (harness IDs, schemas)                 │
│  ├─ agent/activity.ts (per-user activity stream)           │
│  ├─ agent/profiles.ts (provider profile management)        │
│  ├─ agent/roles.ts (role claim/relinquish with awareness) │
│  ├─ agent/inbox.ts (inter-agent messaging)                 │
│  └─ agent/a2a-message-format.ts (agent-to-agent messages) │
└─────────────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────┐
│  Host Runtime (Rust)                                       │
│  ├─ agent-runtime.ts (GUI: SDK-driven harness execution)   │
│  ├─ agent-runtime-accumulator.ts (event → content blocks) │
│  ├─ TUI agent launch (PTY preparation, fork support)      │
│  ├─ Subagent nesting policy (suppress/nest events)        │
│  ├─ Activity stream (local/cloud served by)                │
│  └─ Priority scheduler (interactive vs bulk, credits)     │
└─────────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- **Multi-surface**: GUI chat tabs and TUI terminal tiles are first-class surfaces with separate protocol contracts.
- **Protocol-layer abstraction**: Typed RPC contracts with versioned schema evolution (upgrade/downgrade bridges), streaming RPC for chat, and unary RPC for controls.
- **Harness abstraction**: A "harness" is a coding-agent CLI (Claude Code, Codex, OpenCode, etc.) with a canonical ID. The host drives harnesses via SDK (GUI) or PTY (TUI).
- **Subagent nesting**: A formal policy for how child-agent events are parented under their spawn card, with suppression of narration/turn-lifecycle events.
- **Activity stream**: Per-user agent activity (working/turn buckets per epic) streamed to all connected surfaces.
- **Priority scheduler**: Interactive (keystrokes, live output) vs. bulk (large transfers) with credit-based flow control.
- **Profile management**: Provider profiles (auth status, rate limits, last-used) with multi-profile selection for agent creation.
- **Role claims**: Agents claim roles over scopes with awareness delivery (who was notified of the claim change).

---

## 2. Detailed Feature Comparison

### 2.1 Agent Lifecycle

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Launch** | `launchAgentProcess()` spawns a PTY pane via `addPane()`, writes a prompt file, and records the session. | `agent.create` RPC spawns a GUI agent (SDK-driven) or prepares a TUI launch (PTY + fork support). |
| **Status tracking** | `AgentStatus` enum: idle/queued/starting/running/waiting/review/blocked/done/failed/stopped. | `AgentStatus` in `AgentSession` + `RuntimeEvent` stream (text.delta, tool_call.started/completed, turn.started/completed, etc.). |
| **Completion detection** | Marker regex (`[AGENT_DONE:<token>]`) against rolling PTY tail. Fallback: PTY exit code. | SDK events (`turn.completed`, `turn.stopped`, `turn.interrupted`) + PTY exit for TUI agents. |
| **Re-launch** | `relaunchAgent()` resets agent to `starting`, kills old pane, re-launches. | `agent.create` with `forkSourceTuiAgentId` for TUI fork; GUI agents re-run via new `agent.create` call. |
| **Stop** | `stopSwarm()` kills all linked panes, sets status to `stopped`. | `agent.stop` RPC with optional subtree halt; `stopBackgroundItem` for background tasks. |
| **Structured outcome** | `AgentOutcome` (summary, changedFiles, tests, decisions, needsReview) written to `.saple/swarm/outcomes/<id>.json`. | `AgentOutcome` via MCP artifact tools; `AgentArtifact` type with id/type/path/content/createdAt. |

**Assessment**: Saple Bridge has a clean, well-implemented lifecycle with marker-based detection and exit fallback. Traycer's SDK-driven GUI runtime provides richer event granularity (per-tool-call events, reasoning deltas, token usage) but is significantly more complex. Saple Bridge's approach is appropriate for its scope; Traycer's is necessary for a multi-surface product.

### 2.2 Coordination & Scheduling

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Dependency resolution** | `checkAndRunNextAgents()` scans agents, marks blocked dependents, starts ready agents bounded by `maxParallel`. | No built-in DAG scheduler; agents are created independently and their dependencies are managed by the agent itself (subagent nesting). |
| **Parallelism** | Configurable `maxParallel` (swarm-level) or global pane limit. | No swarm-level parallelism cap; each agent runs in its own session/tab. |
| **Wave-based iteration** | Yes: `wave` increments on each digest, `maxWaves` limits repair loops, acceptance gating between waves. | No wave concept; agents run continuously and the host manages turn-based execution. |
| **Coordinator pattern** | Single coordinator agent that writes `plan.json`, workers materialize from it. Live coordinator gets digest injection. | No coordinator role; each agent is independent. The "coordinator" pattern is replaced by the host's agent creation API and subagent nesting. |
| **Digest injection** | PTY bracketed paste into live coordinator's pane when idle. Fallback: relaunch with digest in prompt. | Not applicable; GUI agents receive messages via `agent.sendMessage` RPC, not PTY injection. |

**Assessment**: Saple Bridge's wave-based DAG scheduler is a strong design for its use case (iterative build-review-accept cycles). Traycer's approach is more flexible (agents are independent, communicate via messaging) but lacks the structured iterative loop that makes swarms effective for build-review cycles. Traycer compensates with subagent nesting and the host's turn-based execution model.

### 2.3 Review & Verdict

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Review gate** | Auto-generated reviewer agent per `review: true` task. Reads verdict file, approves or rejects with feedback. | No built-in review gate; agents use `approval_request` tool calls and the host manages approval state via `RuntimeApprovalDecision`. |
| **Bounded rework** | `maxAttempts` on each agent; rejections trigger relaunch with feedback. Budget exhaustion escalates to human. | No built-in rework budget; agents are stopped/restarted by the user or the host's `stop`/`create` flow. |
| **Verdict format** | Machine-readable JSON: `{ taskId, verdict: "approve"|"reject", feedback? }`. | Approval is a tool call with `approved: boolean` and `reason?`, managed by the host's approval state machine. |
| **Auto-approve** | `autoApprove` flag on agents advances from review to done without human click. | `runtimePermissionModeSchema` (`supervised`/`auto_accept_edits`/`full_access`) controls tool execution, not review. |

**Assessment**: Saple Bridge's review gate is a distinctive and well-implemented feature for its domain (code review as part of swarm execution). Traycer's approval system is more general-purpose (tool-level approvals) but doesn't have the same structured review→rework→escalation loop.

### 2.4 Communication & Messaging

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Inter-agent messaging** | Mailbox files (`.saple/swarm/mailbox/<id>.md`) and handoff files (`.saple/swarm/handoffs/<from>-to-<to>.json`). | `agent.sendMessage` RPC (fire-and-forget) with `expectsReply` and `responseId` for threaded replies. |
| **Operator messaging** | `postToMailbox()` appends operator notes to agent mailboxes. | No operator-to-agent messaging in the protocol; the host manages this through the chat UI. |
| **Agent-to-agent A2A** | Not implemented. | `a2a-message-format.ts` with GUI/CLI formatters for agent-to-agent messages. |
| **Activity stream** | Not implemented. | `agent.activity.subscribe` stream with per-epic working/turn buckets, served by local or cloud. |

**Assessment**: Saple Bridge's mailbox/handoff system is simple and effective for its scope. Traycer's A2A messaging and activity streams are more sophisticated but add significant protocol complexity.

### 2.5 Protocol & Extensibility

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Protocol layer** | None. All coordination is through direct Rust→TypeScript Tauri commands and file I/O. | Full protocol layer with `@traycer/protocol` package: versioned RPC contracts, streaming RPC, schema validation via Zod. |
| **Schema versioning** | None. State shapes change ad-hoc. | Major/minor versioning with upgrade/downgrade bridges between frozen versions. |
| **Harness abstraction** | Hardcoded provider CLI mapping (`codex`, `claude`, etc.). | Canonical `harnessId` registry with GUI/TUI surface subsets, versioned per-surface catalogs. |
| **Plugin/extensibility** | Templates (predefined agent rosters) and skills (prompt snippets). | Protocol extension via new RPC methods, new content block types, new event types. |
| **Cross-host** | Not applicable (single Tauri app). | Protocol designed for cross-host: `host-transport` layer with Noise encryption, priority scheduler, remote host support. |

**Assessment**: This is the largest gap. Saple Bridge has no protocol layer, which means extending it (new agent types, new surfaces, cross-host support) requires modifying the Rust command layer directly. Traycer's protocol layer is a significant architectural investment that enables its multi-surface, multi-host architecture.

### 2.6 Crash Recovery & Resilience

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **App restart recovery** | `loadSwarmState()` reconciles running agents: checks live PTY sessions, signal tails, and pending exits. Orphaned agents are marked `failed`. | Not explicitly visible in the protocol; the host's persistence layer (Y.Doc epic snapshots) provides recovery. |
| **Coordinator crash** | Single free auto-relaunch; second crash escalates to human. Digest log survives relaunch. | Not applicable (no coordinator pattern). |
| **Identical failure detection** | `hashAcceptanceOutput()` djb2 hash of trimmed output; 2 identical failures trigger escalation. | Not implemented. |
| **Wave budget** | `maxWaves` limits repair loops; escalation when exhausted. | Not applicable (no wave concept). |
| **Priority scheduler** | Not applicable (single-host, no congestion). | `PriorityScheduler` with interactive (uncredit-gated) vs. bulk (credit-gated) queues; `InboundCreditTracker` for flow control. |

**Assessment**: Saple Bridge has thoughtful crash recovery for its single-host scenario. Traycer's resilience is at the protocol/transport layer (Noise encryption, session recovery, credit-based flow control) rather than the agent lifecycle level.

### 2.7 UI & Visualization

| Aspect | Saple Bridge | Traycer |
|--------|-------------|---------|
| **Swarm graph** | `SwarmGraph.tsx` (354 lines) - visualizes agent dependency DAG. | No swarm graph; agents are organized in the epic canvas as tiles. |
| **Agent cards** | `SwarmAgentCard.tsx` (633 lines) - shows agent status, role, provider, model, dependencies, review state. | `tui-agent-tile.tsx` (1229 lines) - TUI agent tile with xterm integration, fork support, crash notification. |
| **Active agents panel** | Not implemented as a separate panel. | `chat-active-agents-panel.tsx` - collapsible panel showing running agents with stop controls. |
| **Review tile** | Review is embedded in the swarm card (verdict status, rework count). | `review-tile.tsx` - dedicated collab tile for review sessions. |
| **Comm graph** | Not implemented. | `comm-graph-agent-node.tsx` / `comm-graph-agent-detail-panel.tsx` - communication graph between agents. |

**Assessment**: Saple Bridge's swarm-specific UI is well-designed for its domain. Traycer's UI is more general-purpose and integrates agents into the broader epic/chat workspace.

---

## 3. Saple Bridge Strengths (What It Does Well)

1. **Marker-scoped lifecycle detection**: The `[AGENT_DONE:<token>]` pattern with regex caching is a clean, robust approach that prevents cross-agent signal interference. The rolling tail approach handles split markers across PTY bursts.

2. **Phased execution model**: Plan → Build → Review → Accept → Escalate is well-suited for code generation swarms. The wave-based iteration with `maxWaves` and identical-failure detection prevents infinite loops.

3. **Crash recovery**: The reconciliation logic in `loadSwarmState()` handles app restarts mid-run by checking live PTY sessions, signal tails, and pending exits. Orphaned agents are properly downgraded.

4. **Digest injection**: The live coordinator pattern (injecting results digests into the coordinator's PTY when idle, with fallback relaunch) is an elegant approach for keeping the coordinator informed without disrupting its workflow.

5. **Bounded rework**: `maxAttempts` with auto-approve and escalation provides a clean feedback loop that prevents infinite rework cycles.

6. **Control plane separation**: The `controlPlane.ts` module provides a clean abstraction for canonical record writing (agents, runs, artifacts) with best-effort error handling.

7. **Context brief integration**: The `contextBrief.ts` module provides a clean contract for agents to pull only the context they need via MCP tools.

---

## 4. Saple Bridge Weaknesses (Where Traycer Is Stronger)

### 4.1 No Protocol Layer
The most significant gap. Saple Bridge has no typed protocol layer between the Rust and TypeScript sides. All communication is through ad-hoc Tauri commands (`invoke()`) and file I/O. This means:
- No schema validation on the boundary (untrusted agent output is parsed manually in `swarmPlan.ts`)
- No versioning or backward compatibility guarantees
- No streaming RPC for real-time events (relies on FS watcher + polling)
- No cross-host or cross-process coordination

### 4.2 Monolithic Store
The `swarmStore.ts` file is 1,870 lines and contains all orchestration logic: state management, scheduling, PTY launch, digest injection, verdict processing, acceptance running, escalation, and worker request handling. This makes it hard to test individual components in isolation and creates a single point of failure.

### 4.3 No Subagent Nesting
Saple Bridge has no concept of subagents or nested agent hierarchies. All agents are flat members of a swarm with dependency edges. Traycer's subagent nesting policy (suppress narration, nest tool activity under parent card) provides a richer model for agent delegation.

### 4.4 No Activity Stream
There is no real-time activity feed for agents. The FS watcher (`watch_swarm_dir`) provides file-level change notifications, but there is no structured activity stream (working/turn buckets, per-epic activity) that could power UI features like "what agents are doing right now."

### 4.5 No Multi-Surface Support
All agents run as PTY panes in the same Tauri window. There is no GUI chat surface for agents (like Traycer's chat tabs) and no TUI surface for interactive agent sessions (like Traycer's terminal tiles). The `providerSupportsTurnInjection()` check is a partial step toward multi-surface, but it's a boolean rather than a protocol-level surface abstraction.

### 4.6 No Profile/Provider Management
Saple Bridge has a simple `AgentProvider` type and model picker. Traycer's profile system (auth status, rate limits, last-used, multi-profile selection) is much more sophisticated and handles the complexity of real-world provider usage.

### 4.7 No Role Claims
Saple Bridge has fixed roles (coordinator, builder, scout, reviewer). Traycer's role claim system (claim/relinquish with awareness delivery) allows dynamic role assignment and cross-agent coordination.

### 4.8 No Inbox/Messaging Protocol
Saple Bridge's mailbox is a simple file. Traycer's `agent.sendMessage` RPC with `expectsReply` and `responseId` threading provides a proper messaging protocol for inter-agent communication.

---

## 5. Recommendations for Improving Saple Bridge's Swarm System

### 5.1 High Priority (Architectural)

**1. Extract the orchestrator into a dedicated module layer**

The 1,870-line `swarmStore.ts` should be split into:
- `swarmScheduler.ts` - dependency resolution, parallelism bounding, wave management
- `swarmLauncher.ts` - PTY launch, prompt file creation, session recording
- `swarmCoordinator.ts` - digest injection, crash recovery, coordinator lifecycle
- `swarmReviewer.ts` - verdict processing, rework budget, review gate
- `swarmAcceptance.ts` - acceptance command execution, identical-failure detection, escalation

This would make the codebase testable, maintainable, and easier to extend.

**2. Add a protocol layer between Rust and TypeScript**

Even a lightweight one: define the swarm-specific RPC methods in a `swarmProtocol.ts` file with Zod schemas (or a simple TypeScript interface + validation function). This would:
- Provide type safety on the boundary
- Enable future cross-host coordination
- Make it clear what data crosses the Rust/TS boundary

**3. Implement streaming events for agent status changes**

Replace the FS watcher + polling model with a proper event stream. The Rust side should emit structured events (agent status change, task completed, verdict recorded, wave completed) that the TypeScript side subscribes to. This would enable:
- Real-time UI updates without polling
- Activity feeds
- Better crash recovery (events are durable)

### 5.2 Medium Priority (Feature)

**4. Add subagent/nesting support**

Implement a lightweight subagent model where an agent can spawn child agents that are nested under its card in the UI. Key elements:
- `parentAgentId` field on `SwarmAgent`
- Event suppression for child agent narration (don't show child's turn lifecycle in parent's timeline)
- Tool activity nesting under parent card
- Child agent status aggregation (a parent is "running" if any child is running)

**5. Add an activity stream**

Implement a per-swarm activity stream that tracks:
- Which agents are working on what (working bucket)
- Which agent is currently in a turn (turn bucket)
- When agents start/stop working

This would power a "what's happening now" UI panel and improve the user experience for long-running swarms.

**6. Add provider profile management**

Extend the `AgentProvider` type to include profile information (auth status, rate limits, last-used). This would:
- Prevent rate-limit surprises during swarm execution
- Allow profile selection per agent (like Traycer's `--profile` flag)
- Show profile status in the swarm UI

### 5.3 Lower Priority (Nice-to-Have)

**7. Add role claims**

Implement a lightweight role claim system where agents can claim roles (e.g., "reviewer for task X") with awareness delivery. This would enable:
- Dynamic role assignment (not just the fixed coordinator/builder/scout/reviewer roles)
- Cross-agent coordination (agents can see who is doing what)
- Conflict detection (two agents can't claim the same role simultaneously)

**8. Add A2A messaging**

Implement inter-agent messaging via a lightweight protocol (not just file-based mailboxes). This would enable:
- Agents to request information from each other directly
- More complex coordination patterns (e.g., a scout agent requesting a builder to check a specific file)
- Structured message threading with reply expectations

**9. Add a swarm graph visualization**

The `SwarmGraph.tsx` component exists but is relatively simple. Consider adding:
- Real-time graph updates as agents are materialized
- Visual indicators for dependency status (blocked, waiting, running, done, failed)
- Click-to-focus on agent cards from the graph
- Wave boundaries shown as graph layers

---

## 6. Summary Metrics

| Metric | Saple Bridge | Traycer |
|--------|-------------|---------|
| Swarm orchestration code | ~1,870 lines (swarmStore.ts) | ~6,100 lines (protocol layer alone) |
| Source files | ~50 swarm-related files | ~2,385 total source files |
| Protocol layer | None | Full typed RPC with versioning |
| Surfaces | TUI (PTY panes) only | GUI (chat) + TUI (terminal tiles) |
| Agent roles | 4 fixed (coordinator, builder, scout, reviewer) | Dynamic (role claims) |
| Lifecycle detection | Marker regex + PTY exit | SDK events + PTY exit |
| Crash recovery | Yes (reconciliation on load) | Y.Doc persistence + host recovery |
| Review gate | Built-in (auto-generated reviewers) | Tool-call based (approval_request) |
| Bounded rework | Yes (maxAttempts) | No (user-managed) |
| Wave-based iteration | Yes (maxWaves, acceptance gating) | No (turn-based) |
| Digest injection | Yes (PTY bracketed paste) | N/A (message-based) |
| Activity stream | No | Yes (agent.activity.subscribe) |
| Subagent nesting | No | Yes (formal policy) |
| Multi-host | No | Yes (cross-host entries) |
| Priority scheduling | No | Yes (interactive vs bulk) |
| Profile management | Basic (provider + model) | Full (profiles, rate limits, auth) |

---

## 7. Conclusion

Saple Bridge's swarm system is a **well-designed, fit-for-purpose implementation** for a local-first AI dev workspace. Its marker-based lifecycle detection, phased execution model, crash recovery, and bounded rework are all strong design decisions that demonstrate good judgment about what matters for its use case.

Traycer is a **much more extensive and architecturally sophisticated system** designed for a multi-surface, multi-host product where agents are first-class citizens. Its protocol layer, subagent nesting, activity streams, and multi-surface support are necessary for that product's complexity.

The key takeaway for improving Saple Bridge is not to copy Traycer's architecture wholesale, but to **extract the orchestrator into proper modules, add a typed boundary layer, and implement streaming events**. These changes would make the system more maintainable, testable, and extensible without adding unnecessary complexity.
