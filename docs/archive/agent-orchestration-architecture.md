# Saple Bridge Agent Orchestration Architecture

Date: 2026-07-13  
Scope: `saple-bridge` and sibling `saple-mcp` working trees  
Status: architecture recommendation; no implementation changes included

## Executive decision

Saple-MCP is a strong local context and control-plane foundation, but it is not currently an agent orchestration engine.

The recommended architecture is to integrate Saple-MCP into the Saple-Bridge repository and product while keeping orchestration in an automatically managed, per-workspace engine process. In short:

> Built-in source, packaging, installation, and UX; separate headless runtime.

MCP should be an adapter into the orchestration engine. It should not be the engine's internal architecture or state machine.

```text
Bridge UI ------------------+
External MCP stdio clients -+--> managed Saple engine
Headless automation --------+       |-- orchestration state machine
                                    |-- process supervisor
                                    |-- durable workspace state
                                    `-- scoped agent runtime tools
```

This design gives Saple Bridge a built-in experience while retaining:

- One authoritative writer per workspace.
- Headless execution when the UI is closed.
- Crash isolation between the UI and active workflows.
- A common engine for Bridge, MCP clients, and automation.
- Durable recovery, ordered events, and reconnectable observation.

## Investigation method

The analysis traced both repositories rather than relying on their READMEs alone. Two independent architecture investigations were run:

1. An embedded-kernel design optimized for the smallest interface and maximum in-process reuse.
2. A standalone-engine design optimized for durability, headless operation, multi-client access, and single-writer correctness.

The runtime did not expose a subagent model selector, so the requested GPT-5.6 Terra High label could not be guaranteed.

The current MCP standard was checked against official Model Context Protocol documentation because Saple-MCP advertises an older protocol revision.

## Repository state observed

### Saple Bridge

Saple Bridge is a Tauri 2 desktop application with a React 19/TypeScript frontend and Rust backend. Its current orchestration stack spans:

- [`src/stores/swarmStore.ts`](src/stores/swarmStore.ts) for scheduling and run state.
- [`src/stores/terminalStore.ts`](src/stores/terminalStore.ts) for PTY output and lifecycle interpretation.
- [`src/stores/agentSessionStore.ts`](src/stores/agentSessionStore.ts) for session persistence.
- [`src/lib/agentSignals.ts`](src/lib/agentSignals.ts) for completion-marker parsing.
- [`src-tauri/src/pty.rs`](src-tauri/src/pty.rs) for provider validation, process spawning, I/O, and teardown.
- [`src-tauri/src/swarm.rs`](src-tauri/src/swarm.rs) for swarm file access and cycle validation.
- [`src-tauri/src/watcher.rs`](src-tauri/src/watcher.rs) for reloading externally modified project state.
- [`src-tauri/src/project.rs`](src-tauri/src/project.rs) for MCP sidecar configuration and discovery.

The Bridge working tree already had a modified `README.md`. That change was treated as user-owned and was not altered during the analysis.

### Saple-MCP

Saple-MCP is a Rust binary and library that serves one project per process over newline-delimited stdio JSON-RPC and an optional custom HTTP bridge.

Its working tree contains substantial modified and untracked work, including newer agent, artifact, permission, prompt, resource, seed, and integration-test functionality. This must be checkpointed before any repository move or architectural migration.

All existing Saple-MCP tests passed during the investigation:

```text
118 passed; 0 failed
```

The suite covers protocol behavior, tools, HTTP parity, storage containment, concurrency within one process, seed behavior, prompts/resources, and an incident-to-fix integration flow.

## What Saple-MCP currently does well

Saple-MCP is already useful as a context/control plane:

- Local-first JSON and Markdown storage under `.saple/`.
- Project path containment.
- Atomic temp-file-and-rename replacement.
- Per-path serialization inside one process.
- Shared tool handlers used by stdio and HTTP.
- Memory graph and context aggregation.
- Kanban task access compatible with Bridge's `tasks.json` array shape.
- Incident, run, agent, artifact, mapping, and permission records.
- MCP tools, prompts, and resources.
- Structured error categories suitable for both MCP and HTTP adapters.
- A library entry point beneath the executable.

Important implementation locations:

- [`../saple-mcp/src/lib.rs`](../saple-mcp/src/lib.rs): synchronous stdio server loop.
- [`../saple-mcp/src/tools/mod.rs`](../saple-mcp/src/tools/mod.rs): central string-based tool dispatch.
- [`../saple-mcp/src/storage/collection.rs`](../saple-mcp/src/storage/collection.rs): generic JSON-array collections.
- [`../saple-mcp/src/storage/fs_lock.rs`](../saple-mcp/src/storage/fs_lock.rs): process-local locks and atomic writes.
- [`../saple-mcp/src/http.rs`](../saple-mcp/src/http.rs): custom Axum HTTP routes.
- [`../saple-mcp/src/protocol/jsonrpc.rs`](../saple-mcp/src/protocol/jsonrpc.rs): MCP/JSON-RPC method routing.

## Why Saple-MCP is not an orchestration engine yet

Its own implementation states the limitation clearly:

- [`../saple-mcp/src/tools/swarm.rs`](../saple-mcp/src/tools/swarm.rs) exposes read-only swarm visibility.
- [`../saple-mcp/src/tools/agents.rs`](../saple-mcp/src/tools/agents.rs) stores registry metadata and never launches agents.
- [`../saple-mcp/src/tools/runs.rs`](../saple-mcp/src/tools/runs.rs) records and correlates runs but never executes them.
- Permissions are advisory; the server does not mediate provider side effects.

Missing orchestration capabilities include:

- Process supervision and provider execution ownership.
- An enforced workflow transition table.
- Durable scheduling and crash recovery.
- Idempotent commands and optimistic revision checks.
- Attempt identities that reject stale process output.
- Retry policies, deadlines, backoff, and cancellation propagation.
- Durable approvals and input-required states.
- Dynamic graph expansion and nested delegation.
- Worktree or equivalent write isolation for parallel coding agents.
- Structured agent completion and messaging.
- Resumable ordered event observation.
- Budget, quota, and resource accounting.
- A single mutation owner shared by Bridge and external clients.

### Tool surface drift

Documentation says Saple-MCP exposes 58 tools, but the implemented catalog contains 59:

```text
12 memory
 6 task
 1 swarm
10 incident
 6 run
 6 context
 6 agent
 5 artifact
 3 mapping
 4 permission
--
59 total
```

`add_task_event` is implemented and tested but absent from the documented count. This is a small symptom of a broader issue: the 59-tool CRUD-oriented interface should remain a compatibility surface, not become the orchestration module's interface.

## Where orchestration currently lives

The real scheduler is renderer-owned.

### Existing capabilities

Bridge currently provides:

- A static dependency graph.
- Cycle validation.
- Parallel-agent limits.
- Dependency-based launching.
- Transitive failure blocking.
- Manual and automatic review gates.
- Pause, resume, stop, relaunch, and force-complete controls.
- Provider/model selection.
- Prompt generation with skills and context files.
- Mailbox and handoff files.
- Per-agent scoped completion markers.
- PTY exit fallback into review or failure.
- Basic restart reconciliation.

The central paths are:

- `launchAgentProcess` in [`src/stores/swarmStore.ts`](src/stores/swarmStore.ts).
- `checkAndRunNextAgents` and `runAgentScan` in the same store.
- PTY marker interpretation in [`src/stores/terminalStore.ts`](src/stores/terminalStore.ts).
- Marker parsing in [`src/lib/agentSignals.ts`](src/lib/agentSignals.ts).
- Process ownership in [`src-tauri/src/pty.rs`](src-tauri/src/pty.rs).

### Structural limitations

The scheduler is spread across React state, asynchronous writes, terminal events, session state, and Rust process management. That creates several failure modes:

- Closing or restarting Bridge kills or loses orchestrated PTYs.
- Restart reconciliation marks lost agents failed rather than resuming work.
- Renderer scheduling can race with terminal output and persistence.
- Lifecycle completion depends primarily on parsing terminal text.
- The workflow source of truth is duplicated among `swarm/state.json`, agent sessions, MCP runs, MCP agents, tasks, and in-memory stores.
- Multiple agents edit the same checkout unless users manually constrain them.
- An agent can finish after a retry and accidentally report against the wrong logical attempt unless every event is attempt-scoped.

The current code contains careful local fixes for several of these races. Those fixes are good engineering, but their number is evidence that the orchestration seam is in the wrong place.

## Cross-process storage correctness finding

Both projects use atomic replacement, which prevents readers from observing partial files. It does not prevent lost updates across processes.

Saple-MCP's lock registry is process-local. Bridge has a separate process-local registry. A possible race is therefore:

1. Bridge reads `tasks.json` at revision A.
2. Saple-MCP reads the same revision A.
3. Bridge writes A plus change B.
4. Saple-MCP writes A plus change C.
5. Change B is lost, even though both writes were atomic.

Bridge's file watcher reduces stale overwrites by reloading selected files, but it cannot make a concurrent read-modify-write transaction serializable.

The architectural fix is a single mutation owner, not more watchers.

## MCP standards finding

Saple-MCP currently advertises protocol version `2024-11-05` in [`../saple-mcp/src/protocol/jsonrpc.rs`](../saple-mcp/src/protocol/jsonrpc.rs).

As of this report, the official current MCP revision is `2025-11-25`:

- [MCP versioning](https://modelcontextprotocol.io/docs/learn/versioning)
- [MCP lifecycle and negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

The current standard HTTP transport is Streamable HTTP, using a single MCP endpoint with HTTP POST and optional SSE behavior:

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Saple-MCP's `/tools/:toolName` REST bridge is useful internally but is not MCP Streamable HTTP.

MCP Tasks can represent long-running, pollable operations and input-required states, but the feature remains experimental and client support varies:

- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [MCP Tasks extension overview](https://modelcontextprotocol.io/extensions/tasks/overview)

Consequences:

- Upgrade version negotiation and schemas.
- Implement a real Streamable HTTP `/mcp` endpoint if HTTP MCP access is required.
- Preserve stdio compatibility for existing clients.
- Treat MCP Tasks as an optional adapter capability.
- Do not make orchestration correctness depend on MCP Tasks being supported by a host.

## Architecture option 1: embedded Bridge kernel

The embedded design places a deep Rust orchestration module inside the Tauri process.

Illustrative interface:

```rust
pub struct OrchestratorHub;

impl OrchestratorHub {
    pub async fn dispatch(
        &self,
        project: ProjectRoot,
        command: Command,
    ) -> Result<Snapshot, OrchestrationError>;

    pub fn snapshot(
        &self,
        project: ProjectRoot,
        workflow: WorkflowId,
    ) -> Result<Snapshot, OrchestrationError>;

    pub fn events(
        &self,
        project: ProjectRoot,
        workflow: WorkflowId,
        after: EventSeq,
    ) -> Result<Vec<Event>, OrchestrationError>;
}
```

Advantages:

- Smallest initial implementation diff.
- Direct reuse of `PtyRegistry`, keychain access, and Tauri events.
- No local IPC latency or daemon lifecycle.
- Removes scheduling from React immediately.
- One writer while Bridge is the only running process.

Disadvantages:

- Workflows cannot continue without Bridge.
- A Bridge crash or update interrupts orchestration.
- External MCP clients require Bridge to be open.
- Retaining a standalone MCP binary risks two runtime owners and semantic drift.
- Headless automation becomes awkward.

This is a reasonable architecture for UI-bound swarms, but it does not meet the stronger durability implied by “extremely capable.”

## Architecture option 2: managed per-workspace engine

The standalone design evolves Saple-MCP into a per-workspace engine process managed invisibly by Bridge.

Advantages:

- One mutation owner for Bridge and external clients.
- Workflows can survive UI closure and reconnection.
- Natural headless operation.
- UI crashes do not directly kill the scheduler.
- Centralized process supervision, permissions, events, and recovery.
- External MCP clients reach the same state machine.

Costs:

- Daemon startup, discovery, update, and shutdown behavior.
- Authenticated local communication.
- Version handshakes between Bridge and engine.
- Careful Windows/macOS descendant-process management.
- More release and recovery scenarios to test.

The existing sidecar packaging means much of the distribution machinery already exists. The new complexity is primarily lifecycle correctness, which is exactly the capability the orchestration system needs.

## Recommended synthesis: built-in managed engine

Use the standalone runtime design, but eliminate the separate sibling-repository dependency.

Recommended repository shape:

```text
saple-bridge/
  crates/
    saple-engine/       # current saple-mcp source, orchestration owner, MCP adapters
  src-tauri/            # Bridge desktop shell and interactive terminals
  src/                  # React projection and operator controls
```

Keep the `saple-mcp` binary name and legacy CLI behavior during migration. Do not create a separate `saple-core` crate until two in-repository consumers genuinely need the same implementation.

The engine should run once per workspace and expose:

- A typed internal orchestration module.
- Authenticated local Streamable HTTP for Bridge and owned clients.
- A stdio MCP connector for existing hosts.
- Optional headless CLI commands.
- Scoped runtime MCP sessions for child agents.

## Deep orchestration interface

Three operations are sufficient:

```text
submit(spec, requestId) -> WorkflowRef

command(
  workflowId,
  expectedRevision,
  requestId,
  command
) -> WorkflowRef

observe(
  workflowId,
  afterSequence
) -> SnapshotAndEvents
```

`command` should represent:

- Pause, resume, and cancel.
- Approve and reject.
- Retry an unsuccessful step.
- Send steering or mailbox messages.
- Supply requested human input.
- Extend the graph with a validated subtask.
- Change explicitly mutable policy fields.

Avoid a public method for each verb and avoid exposing provider CLI arguments, queue structures, storage tables, or scheduler implementation details.

### Typed errors

The module should retain typed errors until an adapter translates them:

- `InvalidPlan`
- `InvalidTransition`
- `Conflict`
- `NotFound`
- `Unauthorized`
- `PermissionDenied`
- `ApprovalRequired`
- `Capacity`
- `ProviderUnavailable`
- `LaunchFailed`
- `Persistence`
- `StorageCorrupt`
- `Unavailable`

Do not collapse these into strings inside the orchestration module.

## Canonical domain model

### Workflow

Contains mission, immutable initial specification, revision, state, policies, steps, event sequence, and outstanding approvals.

Suggested states:

```text
queued running paused succeeded failed cancelled
```

### Step

Represents one schedulable unit and its dependencies, runtime configuration, approval policy, retry policy, write-isolation policy, and current outcome.

Suggested states:

```text
blocked ready starting running waiting_for_input waiting_for_review
succeeded failed cancelled
```

### Attempt

Every launch creates an immutable attempt. An attempt contains provider/model selection, process correlation, timestamps, exit information, artifacts, and outcome.

Suggested states:

```text
starting running succeeded failed cancelled interrupted
```

Retries create new attempts; they never reopen completed attempts.

### Event

Every accepted command and runtime callback appends an event with a monotonically increasing sequence number. Consumers reconnect using `afterSequence`.

### Capability

An agent attempt receives a short-lived identity scoped to its workflow, step, workspace, allowed runtime tools, and expiry. It must not receive the operator/Bridge credential.

## State-machine invariants

- Project roots are canonical and contained.
- Agent and step IDs are unique.
- Every dependency references an existing step.
- Dependency graphs remain acyclic.
- Completed workflow history cannot be rewritten.
- Only the engine actor changes lifecycle state.
- Each runtime callback names a workflow, step, and attempt.
- Events from stale attempts are ignored and audited.
- Starting plus running attempts never exceed the configured cap.
- Paused workflows launch nothing.
- Cancellation is persisted before process teardown begins.
- A step becomes ready only after every dependency has succeeded.
- A failed dependency blocks dependants unless an explicit policy permits recovery.
- Permission decisions occur immediately before engine-mediated side effects.
- Commands are idempotent through `requestId`.
- Mutating commands require `expectedRevision` and return `Conflict` when stale.

## Mutation ordering and crash safety

For each accepted command:

1. Authenticate the caller and validate its capability.
2. Deduplicate `requestId`.
3. Check `expectedRevision`, graph invariants, transition legality, and policy.
4. Persist the updated workflow, ordered events, and pending side-effect intent atomically.
5. Execute the side effect after the state commit.
6. Feed `Started`, `LaunchFailed`, `OutputSignal`, `Exited`, or `Cancelled` back through the same actor.
7. Persist the resulting transition.
8. Schedule newly ready steps.
9. Publish only committed events to Bridge and other subscribers.

On restart, pending intents and running attempts are reconciled. The engine decides whether each attempt is still alive, interrupted, retryable, or awaiting review.

## Storage recommendation

Do not add SQLite in the first orchestration change.

Start with a single engine owner and one atomic per-workflow document:

```text
.saple/orchestration/<workflow-id>.json
```

The document can contain:

- Revision and workflow state.
- Step graph and attempts.
- Ordered orchestration events.
- Idempotency keys.
- Pending side-effect intents.
- Approvals and structured messages.

Large process output and artifact bodies remain separate files. Artifact metadata is committed only after its body is safely stored; orphan cleanup can remove bodies that were never referenced.

Existing files such as `swarm/state.json`, `runs.json`, `run-events.json`, and agent session files should become compatibility projections during migration, not competing writable sources of truth.

Move to SQLite only when whole-document rewrites, event volume, or multi-record query requirements become a measured limitation. A database is justified then; it is not required to establish the correct seam.

## Runtime and adapter strategy

### In-process implementation

Keep these inside the engine module:

- Workflow transition table.
- DAG validation and runnable selection.
- Retry/deadline/cancellation policy.
- Prompt planning.
- Approval state.
- Event projection.

### Local-substitutable dependencies

Test these through the engine interface using temporary projects or deterministic substitutes:

- Filesystem state.
- Clock.
- Process supervisor.
- Artifact storage.

### Agent runtime seam

A private `AgentRuntime` seam is justified by two adapters:

- Production runtime that launches and supervises provider CLIs.
- Fake deterministic runtime used by state-machine tests.

Do not create a provider plugin framework. Keep the current allowlisted provider branching until a second genuinely different provider implementation requires a deeper seam.

### Transport adapters

- Bridge adapter: typed wrapper over authenticated local Streamable HTTP.
- MCP stdio adapter: connects to the workspace engine and translates JSON-RPC.
- MCP Streamable HTTP adapter: exposes the same tool semantics through the standard transport.
- Headless CLI adapter: submits and observes workflows without Bridge.

All adapters call the same engine interface and contain no scheduling or storage policy.

## Structured child-agent control

Terminal markers are a useful compatibility mechanism but should not be the primary control protocol.

Give each launched agent a scoped MCP session advertising only runtime tools relevant to that attempt:

```text
saple_step_report
saple_message_send
saple_message_receive
saple_artifact_publish
saple_subtask_request
saple_approval_request
```

`saple_step_report` should accept structured states such as progress, waiting-for-input, waiting-for-review, success, and failure. Every call is bound to the authenticated attempt, so an agent cannot complete a sibling step.

Retain scoped terminal markers and PTY exit fallback for providers that cannot invoke MCP tools.

## Security findings and requirements

### Current strengths

- Project path containment.
- Provider command allowlisting in Bridge.
- Keychain-backed provider secrets.
- Atomic writes.
- Process-tree teardown.
- Default denial patterns for sensitive files.

### Current gaps

- Saple-MCP HTTP authentication is optional and disabled by default.
- Permission records are advisory.
- A project-wide bearer token would be readable by any agent with project filesystem access.
- Provider CLIs may execute commands independently of engine-mediated tools.

### Required posture

- Managed-engine authentication is enabled by default.
- Store operator credentials in per-user application data or the OS secret store, not the project.
- Give child agents separate, short-lived, attempt-scoped capabilities.
- Enforce authorization for every workflow mutation and event query.
- Enforce permissions for actions mediated by the engine.
- Use provider-native sandbox flags and isolated worktrees for direct provider execution.
- Be explicit that an advisory application rule cannot sandbox a fully trusted provider CLI by itself.
- Fail closed on invalid capabilities, corrupt state, and version mismatch.

## Parallel editing and worktree isolation

Parallel coding agents in one checkout can overwrite each other even when scheduler state is perfect.

Editing steps should therefore support an isolation policy:

- Read-only steps may share the main checkout.
- Editing steps default to an isolated Git worktree once multi-agent writing is enabled.
- Each attempt records its base commit and worktree path.
- A separate integration/review step applies or merges results.
- Cancellation removes only engine-owned worktrees after verifying containment.

Do not implement a custom merge engine. Use Git worktrees, diffs, and ordinary merge/rebase operations.

## Implementation roadmap

### Phase 0: checkpoint and baseline

- Commit or otherwise checkpoint the extensive current Saple-MCP working tree.
- Separate existing feature work from orchestration changes.
- Correct the documented tool count.
- Preserve the 118-test passing baseline.
- Add compatibility fixtures for existing Bridge task, swarm, and session files.

### Phase 1: repository integration

- Move Saple-MCP into the Saple-Bridge repository without behavioral changes.
- Update `scripts/prepare-sidecar.mjs`, Cargo paths, CI, and release packaging.
- Keep the existing binary name and MCP configuration compatibility.
- Remove the mandatory sibling checkout only after release builds pass.

### Phase 2: managed engine lifecycle

- Add an explicit engine/serve mode.
- Enforce one engine owner per workspace with an OS-level workspace lock.
- Use a dynamic local port or protected local endpoint.
- Add authenticated discovery and a Bridge/engine version handshake.
- Make stdio mode connect to the existing engine rather than opening another storage owner.
- Upgrade MCP negotiation and add a standard Streamable HTTP endpoint.

### Phase 3: Rust orchestration state machine

- Port the existing scheduler behaviors and tests from `swarmStore.ts`.
- Add typed commands, snapshots, events, revisions, and attempt IDs.
- Keep the current marker and PTY behavior as compatibility adapters.
- Persist state before spawning or killing processes.
- Make Bridge consume snapshots/events instead of scheduling.

### Phase 4: process supervision and reliability

- Move orchestrated provider process ownership into the engine.
- Keep ordinary interactive terminals in Bridge.
- Add retry policies, deadlines, cancellation, and restart reconciliation.
- Add durable approvals and input-required states.
- Add output spooling and log-retention limits.
- Add worktree isolation for editing attempts.

### Phase 5: structured agent runtime

- Add scoped runtime MCP sessions.
- Replace normal marker completion with structured reports.
- Add durable messages, artifacts, steering, and approval requests.
- Keep marker parsing as provider compatibility fallback.

### Phase 6: source-of-truth cutover

- Make the engine authoritative for workflows, attempts, events, and runtime agents.
- Convert existing swarm/run/session files into read-only projections or migrate them once.
- Remove renderer scheduling and lifecycle mutation.
- Remove duplicate cycle validation and file CRUD paths.
- Proxy or redirect mutating context tools to the engine owner.

### Phase 7: advanced orchestration

Add only after the durable static workflow is reliable:

- Dynamic subtask creation.
- Nested teams.
- Conditional branches.
- Per-provider and per-workflow budgets.
- Fair scheduling across workflows.
- Richer artifact validation.
- Policy-driven automatic integration and review.

## What to reuse

From Bridge:

- Provider allowlisting and safe model validation.
- PTY/process-tree lifecycle code where it fits the engine runtime.
- Keychain integration.
- Scoped marker semantics and exit fallback.
- Existing scheduler tests as behavioral specifications.
- Desktop notifications and operator UI.
- Git status/diff/review capabilities.

From Saple-MCP:

- Path containment.
- Atomic write helpers after selecting one canonical implementation.
- Collection and memory storage code.
- Structured `SapleError` categories.
- Context aggregation.
- Tasks, runs, events, artifacts, prompts, and resources.
- stdio JSON-RPC compatibility.
- HTTP/Axum dependencies and transport tests.
- The existing end-to-end incident workflow tests.

## What to delete after cutover

- Scheduling and agent launch logic from `src/stores/swarmStore.ts`.
- Swarm status mutation from `src/stores/terminalStore.ts`.
- Duplicate agent-session lifecycle persistence.
- Rust swarm string CRUD commands that merely mirror files.
- Duplicate Bridge/MCP path, lock, memory, and cycle-validation implementations.
- Independent sidecar mutation paths that bypass the engine owner.
- The custom HTTP business surface if no external consumer still needs it after Streamable HTTP is available.

Deletion should follow successful migration and compatibility tests, not precede them.

## Principal risks and mitigations

### Dirty-tree migration risk

Risk: moving Saple-MCP while substantial work is uncommitted makes provenance and rollback unclear.  
Mitigation: checkpoint first and move mechanically before architectural edits.

### Split-brain engine risk

Risk: Bridge and an MCP client start independent owners for one workspace.  
Mitigation: exclusive workspace ownership, discovery, version handshake, and stdio connector mode.

### Spawn-before-persist crash

Risk: an agent process starts without durable state.  
Mitigation: persist `LaunchRequested` and the attempt ID before spawning, then reconcile.

### Persist-before-spawn crash

Risk: state says starting but no process exists.  
Mitigation: pending side-effect intents are replayed or marked interrupted during recovery.

### Stale attempt completion

Risk: output from a killed attempt completes its replacement.  
Mitigation: every callback and capability is attempt-scoped.

### Provider process-tree risk

Risk: cancelling the supervisor leaves grandchildren running.  
Mitigation: retain Windows Job Object/process-group termination and verify on each supported OS.

### Compatibility risk

Risk: older MCP hosts or project configs stop working.  
Mitigation: retain stdio, negotiate supported protocol versions, keep the binary name, and migrate configuration additively.

### Permission overclaim

Risk: UI rules are presented as a sandbox although provider CLIs can act directly.  
Mitigation: distinguish engine authorization from OS/provider sandboxing and fail closed where enforcement is possible.

### Storage growth

Risk: per-workflow documents become expensive to rewrite.  
Mitigation: measure first; migrate the storage implementation behind the same deep interface when necessary.

## Acceptance criteria for a capable first release

- One engine owner per workspace.
- Bridge can close and reopen without losing workflow history.
- Every command is idempotent and revision-checked.
- Every process event is bound to an immutable attempt.
- Static DAG scheduling, review gates, pause/resume/cancel, retries, and parallel caps are Rust-owned and tested.
- A crash between intent and side effect is recoverable.
- Bridge is a command/event client, not a scheduler.
- External stdio MCP clients reach the same engine owner.
- Standard MCP negotiation and Streamable HTTP are supported where advertised.
- Child-agent mutation tools use scoped capabilities.
- Editing agents can run in isolated worktrees.
- Existing context tools and project data remain readable during migration.
- The original scheduler and marker test behaviors remain covered.

## Deliberate non-goals

The first implementation should not add:

- Kafka, NATS, RabbitMQ, or another message broker.
- Temporal or another workflow platform.
- gRPC.
- Postgres or a remote database.
- A multi-machine scheduler.
- A provider plugin marketplace.
- A generalized distributed lease system.
- A custom Git merge engine.
- SQLite before storage behavior demonstrates the need.

The shortest reliable path is one local engine, one writer, a small typed interface, standard MCP adapters, and the existing provider/process capabilities reused behind it.

## Final recommendation

Do not embed the existing 59-tool Saple-MCP runtime directly into React or make MCP tool calls the internal orchestration interface.

Move Saple-MCP into the Saple-Bridge repository, evolve it into the single per-workspace orchestration engine, and let Bridge manage it invisibly. Preserve stdio MCP as a compatibility connector, implement current Streamable HTTP, and expose only a small orchestration interface over a durable Rust state machine.

That is the architecture with the best depth and locality: callers learn three operations, while scheduling, attempts, recovery, permissions, process supervision, messaging, persistence, and provider quirks remain hidden behind one seam.
