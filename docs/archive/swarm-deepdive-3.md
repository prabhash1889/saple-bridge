# Saple Bridge Swarm vs. Traycer: Multi-Agent Orchestration Deep Dive

## 1. Saple Bridge: How It Works

The swarm system lives in two layers - a **Rust backend** (Tauri) and a **TypeScript frontend** (Zustand store).

**Core architecture:**

| Layer | Files | Responsibility |
|-------|-------|---------------|
| Rust | `swarm.rs`, `control_plane.rs`, `pty.rs` | File I/O (atomic writes under cross-process lock), PTY lifecycle, dependency cycle detection, shell command execution for acceptance verification |
| TypeScript | `swarmStore.ts` (1871 lines), `agentSignals.ts`, `swarmPrompts.ts`, `swarmDigest.ts`, `swarmPlan.ts`, `controlPlane.ts` | State machine, scheduler, coordinator injection, plan parsing, prompt construction, result digests |
| UI | `SwarmWorkspace.tsx`, `SwarmComposer.tsx`, `SwarmAgentCard.tsx`, `SwarmGraph.tsx`, wizard steps | Visual DAG, agent cards, launch wizard, progress |

**Execution model:**

1. **Swarm v2 (current)**: A single coordinator agent is seeded. It writes a `plan.json` file with task definitions, dependency DAG, acceptance command, and per-task provider/model choices.
2. `ingestPlan()` reads `plan.json`, applies `diffPlan()` to deduplicate across waves, and materializes worker agents with dependency wiring.
3. `checkAndRunNextAgents()` / `runAgentScan()` is the scheduler: it marks blocked dependents, launches ready agents (respecting `maxParallel`), and fires wave completion digests.
4. Each agent runs as a **native PTY session** (provider CLI piped in a prompt file). The coordinator runs **live** on injection-capable providers (Codex, Claude Code) - Bridge injects result digests into its TUI as typed user turns.
5. **Completion detection** uses scoped marker tokens (`[AGENT_DONE:<hex>]`) matched against rolling per-pane terminal output tails.
6. **Review gate (Phase 4)**: Each `review: true` task spawns a reviewer agent. The reviewer writes `verdicts/<taskId>.json`. `ingestVerdict()` reads it and either approves, auto-reworks (bounded by `maxAttempts`), or parks for human approval.
7. **Acceptance (Phase 5)**: After a wave completes with all-green workers, Bridge runs the plan's acceptance command (`npm test`, etc.) itself - not trusting an agent's claim. Pass -> final report digest. Fail -> repair wave or escalation.
8. **Live coordinator injection (Phase 3)**: When the coordinator's PTY is quiet for 3s, queued digests are pasted via bracketed paste mode + Enter. Fallback: relaunch the coordinator with digest history embedded in its prompt.
9. **State persistence**: `.saple/swarm/state.json` (Rust atomic writes with `fs_lock`), plus `mailbox/*.md`, `handoffs/*.json`, `outcomes/*.json`, `verdicts/*.json` under `.saple/swarm/`.

**Built-in templates**: Full-Stack Feature, Bug Hunt, Review-Only, Scout-and-Plan, Test Hardening - each a static DAG of 2-4 agents with role prompts.

**Key design choices:**
- **File-mediated coordination**: agents communicate through the filesystem (plan.json, verdicts, outcomes, mailboxes, handoffs) rather than in-memory channels. This survives restarts.
- **Scoped markers**: each agent gets a random hex token so its completion signal can't be triggered by another pane's output.
- **Autonomy modes**: `manual` (human approves everything), `gated` (auto-rework but plan approval needed), `auto` (hands-free).
- **Wave-based repair loops**: maxWaves caps how many acceptance-failure cycles the swarm attempts before escalating.
- **Crash containment**: coordinator crashes auto-relaunch once with digest history; second crash escalates to human. Worker orphans are reconciled on project reload.

---

## 2. Traycer: How It Works

Traycer is a fundamentally different architecture - a **host-mediated agent orchestration platform**, not a file-based swarm scheduler.

**Core architecture:**

| Layer | Path | Responsibility |
|-------|------|---------------|
| Protocol | `protocol/src/` | Versioned RPC contracts (Zod schemas), wire format, upgrade/downgrade paths between CLI/host versions |
| CLI | `clients/traycer-cli/src/` | Host install, auth, agent CRUD commands, hook integration |
| Host (closed-source) | Not in repo | Agent runtime, session management, cross-device sync, provider harness management |
| Desktop | `clients/desktop/` | Electron shell, host lifecycle, tray, IPC |
| GUI | `clients/gui-app/` | Chat/terminal UI, canvas rendering, tabs |

**Execution model:**

1. **Host-centric**: The Traycer Host (a separate binary, provisioned from GitHub Releases) is the runtime. CLI and GUI are clients that talk to it via versioned RPC.
2. **Agent creation**: `agent.create` mints a child agent with a parent ID, surface (gui/tui), harness (Claude Code, Codex, Cursor, etc.), model, profile, and workspace bindings. Versioned negotiation (v1.0 -> v3.0) handles backward compatibility.
3. **Agent-to-agent communication**: `agent.sendMessage` is fire-and-forget (no streaming). Reply threads are keyed on (sender, receiver) pair with `--expect-reply` / `--response-id`.
4. **Role system**: Agents can claim scoped roles (e.g., `architect` over `repo-foo`), with overlap detection and awareness delivery to other agents (delivered/unreachable/prompt-pending).
5. **Transcripts**: `agent.getTranscript` flattens an agent's conversation into XML-tagged text for reading.
6. **Activity streaming**: `agent.activity.subscribe` provides real-time agent activity (working/turn state per epic) via a server-pushed state frame.
7. **Harness abstraction**: Agents are backed by "harnesses" (Claude Code, Codex, Cursor, OpenCode, Hermes, Devin, Pi, omp) with per-harness model lists and reasoning effort configuration.
8. **Cross-device sync**: Agent state syncs via Y.Doc (CRDT) across hosts.
9. **Worktrees**: `traycer worktree create` provisions git worktrees for isolated agent workspaces.

**Key design choices:**
- **Host is the authority**: All agent lifecycle goes through the host RPC. No file-based coordination.
- **Provider-agnostic harness layer**: Adding a new coding agent means implementing a harness, not changing orchestration logic.
- **Versioned protocol with explicit upgrade/downgrade paths**: Every RPC method has `major.minor` versioning with typed downgrade paths that can reject unsupported operations.
- **Epic-scoped organization**: Agents and activities are grouped by "epic" (a task/project).
- **No built-in DAG scheduler**: Traycer provides the plumbing (create, send, list, stop, role claims) but the orchestration logic (who calls whom, dependency ordering) is left to the agents themselves or external tooling.

---

## 3. Head-to-Head Comparison

| Dimension | Saple Bridge | Traycer |
|-----------|-------------|---------|
| **Orchestration model** | Centralized scheduler (swarmStore) with plan.json DAG | Decentralized (host RPC plumbing, agents orchestrate themselves) |
| **Agent execution** | Native PTY sessions (provider CLIs) | Host-managed sessions (harness abstraction) |
| **Inter-agent communication** | File-mediated (plan.json, verdicts, outcomes, mailboxes) + live PTY injection | RPC `agent.sendMessage` (fire-and-forget) + transcript reading |
| **Completion detection** | Terminal marker parsing (scoped `[AGENT_DONE:<token>]`) | Host-reported activity state |
| **Review/QA** | Built-in reviewer agents with verdict files, auto-rework loops | No built-in review gate (agents communicate via messages) |
| **Acceptance verification** | Bridge runs shell commands itself (trust boundary) | Not built-in |
| **State persistence** | `.saple/swarm/state.json` + file artifacts (atomic writes with cross-process lock) | Host-managed (Y.Doc CRDT for cross-device sync) |
| **Crash recovery** | Coordinator auto-relaunch with digest history; orphan reconciliation on reload | Host lifecycle management |
| **Provider support** | Codex, Claude Code (via CLI) | Claude Code, Codex, Cursor, OpenCode, Hermes, Devin, Pi, omp, native inference |
| **Versioning** | N/A (single-app) | Per-method `{major, minor}` RPC with typed upgrade/downgrade paths |
| **UI** | React/Tauri with SwarmWorkspace, DAG graph, agent cards, wizard | Electron with GUI canvas, chat tiles, tabs |
| **Scale** | Single-project swarm (one coordinator + N workers) | Multi-epic, multi-host, cross-device |

---

## 4. What Saple Bridge Does Well

1. **Complete orchestration loop**: Plan -> build -> review -> acceptance -> repair/complete. Traycer has no equivalent closed loop.
2. **Trust boundary enforcement**: Bridge runs acceptance commands itself; it never trusts an agent's self-reported "I'm done." This is a security-critical design choice.
3. **Scoped completion markers**: The hex-token system prevents cross-pane signal contamination. Elegant and robust.
4. **Wave-based repair with guard rails**: maxWaves, identical-failure detection, and structured escalation prevent infinite repair loops.
5. **File-mediated state**: Survives restarts, is inspectable by humans, and works across processes (sidecar + Bridge).
6. **Built-in templates**: Pre-configured swarms for common workflows (full-stack, bug-hunt, test-hardening).

---

## 5. Where Traycer Is Stronger

1. **Provider breadth**: 8+ harnesses vs. 2. The harness abstraction is well-designed for extension.
2. **Protocol maturity**: Versioned RPC with explicit backward compatibility. Saple Bridge has no equivalent wire contract.
3. **Cross-device sync**: Y.Doc CRDT sync. Saple Bridge is single-machine.
4. **Agent-to-agent messaging**: `agent.sendMessage` with reply threads. Saple Bridge's mailbox system is one-directional (operator -> agent).
5. **Role system**: Scoped, claimable roles with overlap detection and awareness delivery. Saple Bridge has roles but no claim/overlap mechanism.
6. **Separation of concerns**: Host (runtime) vs. CLI (client) vs. GUI (renderer). Saple Bridge mixes orchestration logic into the frontend store.
7. **Activity streaming**: Real-time agent activity state via server-pushed frames. Saple Bridge polls terminal output.

---

## 6. Recommendations for Saple Bridge

### High-impact improvements

1. **Extract the scheduler into a dedicated module** (or Rust). The 1871-line `swarmStore.ts` mixes state management, scheduling, prompt construction, digest formatting, and coordinator injection. Splitting these into `swarmScheduler.ts`, `swarmCoordinator.ts`, `swarmPrompts.ts` (already partially done), and `swarmDigest.ts` (done) would improve testability. The scheduler logic (`runAgentScan`) is the most critical piece and would benefit from being a pure function tested against state snapshots.

2. **Add bidirectional agent-to-agent messaging**. The mailbox system is write-only from the operator side. Agents should be able to send messages to each other's mailboxes (with approval gating). This unlocks patterns like "builder asks reviewer a clarifying question" without going through the coordinator.

3. **Implement a harness abstraction**. Currently, provider support is hard-coded (`providerSupportsTurnInjection`). A harness registry (like Traycer's) would make adding new providers (Cursor, Aider, etc.) a configuration task rather than a code change.

4. **Version the plan.json contract**. The plan format is already at `version: 2` but there's no upgrade/downgrade path. If you change the schema, older swarms break. Adding Zod validation (like Traycer's protocol schemas) with explicit migration paths would prevent this.

5. **Move orchestration state out of localStorage**. The `partialize` in the persist config already limits what goes to localStorage, but the full state still rehydrates from it on load. The `.saple/swarm/state.json` file is the real source of truth - the Zustand store should be treated as a cache, not a root.

### Medium-impact improvements

6. **Add an activity streaming layer**. Instead of polling terminal output tails for markers, push agent state changes through a Tauri event channel. This would make the UI more responsive and reduce the regex-matching hot path.

7. **Implement role claiming with overlap detection**. Like Traycer's `agent.claimRole` / `agent.relinquishRole`. This prevents two agents from working on the same file simultaneously.

8. **Add transcript flattening**. `agent.getTranscript` in Traycer converts a conversation to XML-tagged text. Saple Bridge could offer this for reviewing what an agent actually did (vs. its self-reported outcome).

9. **Structured escalation panel (Phase 7)**. The escalation data is already written to `.saple/swarm/escalation.json` - build a UI panel that lets humans choose: one more wave, redirect, or stop.

10. **Add a debate strategy**. The `TaskStrategy` type already has `'debate'` but it's not implemented. Multiple parallel builders + a judge would improve code quality for critical tasks.

### Lower-priority but valuable

11. **Cross-workspace swarm orchestration**. Currently one swarm per project. Supporting a swarm that spans multiple project directories (microservices) would be a significant capability.

12. **Agent capability negotiation**. Instead of hard-coding `providerSupportsTurnInjection`, agents should declare their capabilities at creation time (injection, file access, shell access, etc.).

13. **Swarm templates from plan.json**. After a successful swarm, offer to save the coordinator's plan as a reusable template. This turns every successful run into a potential template.

14. **Observability dashboard**. A real-time view of all agent PTY outputs, digest queue, scheduler decisions, and state transitions. The `coordinatorState` field is a start but there's no equivalent for workers.
