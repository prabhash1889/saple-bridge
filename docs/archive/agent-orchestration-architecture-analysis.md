# Saple Bridge Agent Orchestration - Architecture Analysis & Strategy

## Verdict on saple-mcp

**saple-mcp is not built for orchestration - it is built to be the shared state plane that orchestration *writes to*.** That's by design (decisions D1-D6, `docs/separate-repo-architecture.md`) and it's the right design. Concretely:

- It's a pure data plane: 58 tools, all CRUD over JSON/MD files. It "never executes shell commands or modifies user code" (`swarm.rs:1`, README:16).
- `runs`/`agents`/`run-events`/`artifacts` are **records**, not live processes. `create_run` just writes JSON (`tools/runs.rs:44`); something else is expected to drive `update_run`/`append_run_event`/`finish_run`.
- No LLM client, no tool dispatcher, no mission queue, no scheduler, no loop runner. It has the *blackboard*, not the agents that write on it.

So it's a necessary third of an orchestration system, and it's excellent at that third. The missing two-thirds: (1) an execution engine that runs an LLM in a tool-calling loop, and (2) an orchestration layer (queue, scheduler, dependency graph, mailbox delivery, concurrency).

## The gap inside the bridge today

The bridge already has a *second*, parallel data model that overlaps saple-mcp almost exactly but doesn't talk to it:

| Concept | Bridge (swarmStore) | saple-mcp | Synced? |
|---|---|---|---|
| Agents | `.saple/swarm/state.json` `activeAgents[]` | `.saple/agents.json` | No |
| Runs | (none - sessions.json is PTY sessions) | `.saple/runs.json` + `run-events.json` | No |
| Mailbox | `.saple/swarm/mailbox/<id>.md` | (not modeled) | - |
| Handoffs | `.saple/swarm/handoffs/<a>-to-<b>.json` | run links | No |
| Swarm status | `state.json` | `get_swarm_status` reads it read-only | One-way |

And critically: **the bridge never runs saple-mcp as a persistent process.** `test_mcp_tools` (`project.rs:602`) spawns it, sends one `tools/list`, kills it. The HTTP bridge on :8765 is unused by the bridge. So saple-mcp's 58 tools are effectively dark inside the app that ships it.

The bridge's actual agent execution is **terminal-orchestrated**: `launchAgentProcess` (`swarmStore.ts:257`) spawns a provider CLI in a PTY with a prompt file and detects completion by scraping `[AGENT_DONE:<marker>]` tokens out of terminal output. Clever, human-in-loop, but fundamentally limited: no structured tool calls, no mid-run context injection, no programmatic control, no retries, no parallel worktrees. That's the ceiling you're hitting.

## Recommended architecture

**Embed saple-mcp as a Rust library dependency of saple-bridge, and build a first-class orchestration core inside the bridge that uses it as the state plane.** This collapses three processes into one while keeping the conceptual three-repo boundary intact.

### 1. Embed saple-mcp (kill the sidecar for internal use)

saple-mcp is already a library crate (`Cargo.toml:9`, `[lib] name = "saple_mcp"`, `src/lib.rs` exposes `run_stdio_server()` and - you'd add - `handle_tool_call()`). The bridge's `src-tauri/Cargo.toml` depends on it via a path dependency:

```toml
saple-mcp = { path = "../../saple-mcp" }
```

Then `src-tauri/src/` gains a new `mcp.rs` module that holds a `SapleMcp` state (project path) and exposes Tauri commands thin-wrapping `saple_mcp::tools::handle_tool_call()`. Zero IPC, zero staging, zero version drift between sidecar and bridge, atomic shared state in-process. The README itself flags this as the planned convergence: *"A future shared `saple-core` crate would dedupe it against saple-bridge's copy."* (`README.md:147`)

External MCP clients (Claude Code, Cursor) still need a stdio entrypoint - so keep `saple-mcp` as a build artifact for `.mcp.json`, OR have the bridge spawn a stdio listener thread that forwards to the in-process handler. The latter is cleaner: one binary, one source of truth.

### 2. Build an orchestration core (`src-tauri/src/orchestrator.rs` + `src/stores/orchestratorStore.ts`)

This is the new module that replaces the ad-hoc `swarmStore` scheduler with a real engine. It owns:

- **Mission queue + scheduler** - FIFO with priority, `maxConcurrentRuns` cap, workspace serialization (serialize runs sharing a cwd) or `git worktree add` per run for true parallelism. This is Phase 5 of `plan.md` but living in the bridge, not artemis.
- **Pluggable agent runtime** - the key abstraction. Two backends behind one trait:
  - `PtyRuntime` - today's model (spawn provider CLI, marker-token completion). Keep it for human-in-loop / "agent-assisted" swarms where you want to watch the terminal.
  - `ToolCallingRuntime` - new. An actual LLM tool-calling loop running in-process (Rust, via `async-openai`/provider SDKs, or a spawned node sidecar reusing artemis's loop). Structured tool dispatch against saple-mcp tools + bridge tools (files, git, pty, shell). This is what "extremely capable" requires - no terminal scraping, real tool results, mid-run context injection, retries, parent/child spawning.
- **Spawn tree** - `spawn_mission(mission, agentId?, parentRunId?)` with hard bounds: depth <= 2, children <= `maxConcurrentRuns`, recorded via `run.metadata.parentRunId`. This is the swarm-lite coordinator pattern.
- **Mailbox delivery into context** - mailbox writes go through saple-mcp (as artifacts tagged `mailbox`, or extend the schema), and the tier-2 context builder injects unread messages into the next turn/run context.

### 3. Migrate the swarm model into saple-mcp's schema

Stop writing `.saple/swarm/state.json` as the source of truth. Instead:

- `activeAgents` -> `create_agent`/`update_agent`/`set_agent_status` against `.saple/agents.json`.
- Each agent run -> `create_run` (with `agentId`, `taskId`, `mission`) + `append_run_event` timeline + `finish_run`.
- Mailbox `.md` files -> `create_artifact` with `kind: "mailbox"`, or add a dedicated mailbox collection to saple-mcp (it's a 1-file addition in `tools/`).
- Handoffs -> run links (`metadata.handoffTo`/`handoffFrom`).
- `swarmStore.ts` becomes a **view store**: it loads agents + their active runs from saple-mcp (via the new in-process commands) and presents the swarm grid, but it no longer owns the writes.

This kills the dual-data-model problem permanently. The `get_swarm_status` read-only tool in saple-mcp (`tools/swarm.rs`) can be retired or repurposed to aggregate from `agents.json` + `runs.json`.

### 4. Keep the boundary, collapse the process

The conceptual rule "saple-mcp is state, artemis is execution, sentry is incidents" still holds. But for the **bridge's** local-first use case, the bridge *is* the host for state (embedded saple-mcp) *and* execution (the new orchestrator). artemis remains valuable as an optional external autonomous engine for headless/CI/sentinel scenarios - it talks to the bridge-hosted saple-mcp over HTTP (:8765), which the bridge now actually runs persistently. You don't *need* artemis to ship capable orchestration in the desktop app.

## Implementation strategy (phased)

| Phase | What | Effort | Depends |
|---|---|---|---|
| **O1** | Path-depend on `saple-mcp` lib in `src-tauri/Cargo.toml`; add `mcp.rs` exposing `handle_tool_call` as Tauri commands; replace `test_mcp_tools` sidecar spawn with in-process call. Keep sidecar binary build for external `.mcp.json` clients. | 1-2 d | - |
| **O2** | Run saple-mcp's HTTP bridge on :8765 from inside the bridge process (a `tokio` task on app startup) so external attachers (artemis, Claude Code) work. Health route in the dashboard. | 1 d | O1 |
| **O3** | Define `AgentRuntime` trait in `src-tauri/src/orchestrator.rs`; port the existing PTY launch path (`launchAgentProcess`) behind `PtyRuntime`. Behavior unchanged, but now goes through the trait. | 2-3 d | O1 |
| **O4** | Migrate `swarmStore` writes to saple-mcp tools: `create_agent`/`set_agent_status`/`create_run`/`finish_run`. `state.json` becomes a cache/view. Add a one-time migration for existing swarms. | 3-4 d | O1, O3 |
| **O5** | Mission queue + scheduler in Rust: FIFO, `maxConcurrentRuns`, workspace serialization. Replace the TS `runAgentScan`/`checkAndRunNextAgents` loop (the `agentScanInFlight` re-entrancy guard at `swarmStore.ts:254` is a symptom of needing this in Rust). | 3-4 d | O4 |
| **O6** | `ToolCallingRuntime`: in-process LLM loop with structured tool calls against saple-mcp + bridge tools. Provider config reuses `keychain.rs` + `providerStore`. Start with one provider (the one you use most), expand later. | 5-7 d | O5 |
| **O7** | `spawn_mission` (parent/child, depth <= 2), mailbox delivery into tier-2 context, `recall(query)` tool wiring to `search_memories`. | 3-4 d | O6 |
| **O8** | Tiered context builder (tier-1 always / tier-2 per-invocation / tier-3 on-demand `recall`), replacing flat prompt assembly in `launchAgentProcess`. | 2-3 d | O7 |

Critical path to "extremely capable": **O1 -> O4 -> O5 -> O6 -> O7**. O3 is a safe no-op refactor that unblocks O5. O8 is polish that pays off most for long playbooks.

## Key decisions and risks

1. **Embedding vs sidecar.** Embedding wins on every axis for the bridge's own consumption (no IPC, no staging, no drift, atomic state). The only loss is binary size (~1-2MB of Rust) and tighter coupling - both acceptable. Keep the standalone binary build for external clients.

2. **Don't make saple-mcp execute.** Resist the temptation to add "run agent" tools to saple-mcp itself. It stays a pure data plane. The orchestrator lives in the bridge and *calls* saple-mcp. This preserves the property that artemis/sentry/external clients can still attach to the same state plane without depending on the bridge's orchestrator.

3. **The PTY runtime stays.** Don't delete it. The terminal-orchestrated model is genuinely good for human-in-loop swarms where you want to watch and intervene. The new `ToolCallingRuntime` is for autonomous missions. The trait lets you pick per-mission.

4. **Schema migration risk.** Existing users have `.saple/swarm/state.json`. O4 must include a read-once migration that ingests existing agents/runs into saple-mcp's collections. Keep `state.json` as a fallback read for one release.

5. **Concurrency correctness.** The current TS scheduler has a hand-rolled re-entrancy guard (`agentScanInFlight`/`agentScanQueued`, `swarmStore.ts:254-256`) precisely because doing this in JS across `await` boundaries is hard. Moving the scheduler to Rust (O5) eliminates that entire class of bugs - `fs_lock.rs` already gives you serialized atomic writes, and saple-mcp's `collection::mutate` already does upsert-under-lock. This alone justifies the rewrite.

6. **artemis's future.** This doesn't kill artemis - it makes artemis optional for the desktop case. If you later want a headless autonomous runner (e.g. for sentry's incident->fix loop running while the laptop is open but the GUI is closed), artemis still fills that niche, talking to the bridge-hosted saple-mcp over HTTP. The `plan.md` Phase 1 (finish sentry) and Phase 2 (cross-repo E2E) still make sense unchanged.

## TL;DR

saple-mcp is the right state plane but it's not - and shouldn't become - the orchestrator. The bridge already ships saple-mcp but doesn't actually use it (spawns it only for a one-shot catalog preview) and maintains a parallel, weaker swarm model. The best move: **embed saple-mcp as a library dependency, build a real orchestration core in the bridge with a pluggable runtime (PTY + in-process tool-calling), and migrate the swarm state into saple-mcp's schema.** That gives you "extremely capable orchestration" as a native local-first feature without running three daemons, while keeping the door open for artemis as an external attacher.
