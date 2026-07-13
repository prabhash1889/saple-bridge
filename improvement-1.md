# SAPLE Bridge Improvement Plan 1

> A minimal, implementation-ready roadmap derived from the CNVS comparison. Ordered by leverage, not novelty.

## Objective

Make SAPLE Bridge's existing agent-control infrastructure feel immediate and coherent while preserving its local-first storage, explicit review, and safety boundaries.

The plan deliberately avoids an infinite canvas, a new memory engine, and a general workflow framework. SAPLE already has the primitives it needs.

## Guiding constraints

- Reuse the existing stores, PTY layer, `.saple/` files, Swarm scheduler, Command Palette, Review room, and Saple MCP sidecar.
- Do not add a second source of truth for agents, runs, tasks, or artifacts.
- Keep API keys in the OS keychain.
- Keep project-path validation in Rust.
- Preserve bounded concurrency and human review defaults.
- Add one runnable check for each non-trivial behavior.
- Prefer a prompt/tool contract over a new service.

---

## Priority 0 — Connect the existing control plane

### Problem

Bridge sessions, Swarm state, and Saple MCP's agents/runs/artifacts are only partially connected. `AgentSession.artifacts` exists, and Review looks for test artifacts, but Bridge initializes sessions with an empty list and does not complete the lifecycle.

### Implement

Create one integration path for these events:

```text
Bridge launch       → register agent + create run
Status transition   → update agent + append run event
Agent completion    → create artifacts + finish run
Review decision     → record final run/review outcome
```

Do not create a new event bus. Route the events through the existing session and status transition functions.

### Likely touchpoints

- `src/stores/agentSessionStore.ts`
- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- `src/types/agent.ts`
- `src-tauri/src/review.rs`
- `../saple-mcp` agent, run, artifact, and context tools

### Acceptance criteria

- Launching a Kanban or Swarm agent creates one agent record and one run record.
- Status changes update the same records rather than creating duplicates.
- Completion stores a summary and test result when supplied.
- Review can display the recorded completion evidence.
- Restart reconciliation does not duplicate an existing run.
- One integration test covers launch → completion → review evidence.

---

## Priority 1 — Automatic on-demand context briefs

### Problem

SAPLE already has project, task, incident, and agent context tools, but launch prompts mostly provide mission text and attached files. Agents are not consistently directed toward the smallest relevant brief.

### Implement

Extend launch prompts with a short context contract:

- Coordinator: call `get_project_brief` before planning.
- Task agent: call `get_task_context` before editing.
- Registered agent: call `get_agent_brief` when role-specific context is needed.
- Search individual memories only when the brief points to them.
- Record durable decisions and lessons through the existing MCP tools.

Do not inject the complete memory graph into prompts.

### Likely touchpoints

- `src/stores/swarmStore.ts`
- `src/components/kanban/TaskCard.tsx`
- `src/components/kanban/TaskDetailDrawer.tsx`
- `src/components/common/CommandPalette.tsx`

### Acceptance criteria

- Every agent launch identifies its task, role, and relevant MCP brief tool.
- Prompts do not inline all project memories.
- A test asserts the generated task and swarm prompts contain the correct brief instruction.
- The application behaves normally when the MCP sidecar is unavailable and surfaces a clear diagnostic.

---

## Priority 2 — Universal agent composer

### Problem

Bridge can already launch terminals, launch tasks, switch rooms, and post to Swarm mailboxes, but these actions live in different interfaces.

### Implement

Extend the existing Command Palette into a composer with a target selector:

- Selected agent
- All running agents
- Reviewer
- New terminal agent
- Existing Kanban task
- New swarm
- Project memory

Reuse `writeMailbox`, `addPane`, existing task launch logic, and the Swarm wizard. Do not create a second command store.

Support normal text entry first. OS dictation already works at the text-input layer on Windows and macOS; treat that as the first voice implementation.

### Likely touchpoints

- `src/components/common/CommandPalette.tsx`
- `src/stores/swarmStore.ts`
- `src/stores/terminalStore.ts`
- `src/stores/projectStore.ts`

### Acceptance criteria

- One global shortcut opens the composer.
- The current target is always visible before sending.
- Sending to an agent appends to its existing mailbox.
- Launch actions use existing provider readiness checks and pane limits.
- Keyboard-only operation is complete and focus returns predictably.
- No new dependency is introduced.

---

## Priority 3 — Structured agent outcomes

### Problem

Terminal completion markers communicate status but not enough evidence. Review, handoffs, history, and notifications need a predictable summary of what happened.

### Implement

Use the existing artifact model and Saple MCP artifact tools to record:

```json
{
  "summary": "Fixed the authentication race",
  "changedFiles": ["src/auth.ts"],
  "tests": {
    "command": "npm test",
    "passed": true
  },
  "decisions": ["Retained refresh-token locking"],
  "needsReview": true
}
```

Keep scoped terminal completion markers as the fallback when no structured outcome is supplied.

### Likely touchpoints

- `src/types/agent.ts`
- `src/stores/agentSessionStore.ts`
- `src/stores/terminalStore.ts`
- `src/components/swarm/SwarmAgentCard.tsx`
- `src/components/review/*`

### Acceptance criteria

- A completed agent can have summary, changed-file, test-result, decision, and handoff artifacts.
- Swarm inspection shows the summary without opening a terminal.
- Review shows the test command and result.
- Invalid or incomplete outcome data cannot break completion handling.
- Existing agents that only emit markers continue to work.

---

## Priority 4 — Bounded review-and-rework loop

### Problem

The current dependency graph is intentionally acyclic. A reviewer can reject work, but a safe automatic route back to the responsible builder is missing.

### Implement

Add one explicit rework behavior rather than arbitrary cycles:

```text
Builder → Reviewer
             │ reject
             ▼
      feedback to mailbox
             │
             ▼
       Builder retry
```

Suggested fields:

- `attempt`
- `maxAttempts`, default `1`
- `lastReviewFeedback`

The reviewer rejection should append feedback to the builder mailbox and offer a relaunch. Automatically exceeding `maxAttempts` must require human approval.

### Likely touchpoints

- `src/types/agent.ts`
- `src/stores/swarmStore.ts`
- `src/components/swarm/SwarmWorkspace.tsx`
- `src/components/swarm/SwarmAgentCard.tsx`
- `src/stores/swarmStore.test.ts`

### Acceptance criteria

- Reviewer feedback reaches the correct builder mailbox.
- The builder relaunches with the previous context and review feedback.
- Attempts are persisted across restart.
- The configured limit cannot be bypassed by repeated completion signals.
- Dependency scheduling still rejects real graph cycles.

---

## Priority 5 — Local development preview and screenshot context

### Problem

Terminal URLs currently open in the system browser. The agent cannot receive a visual screenshot feedback loop from inside Bridge.

### Implement

Add a small localhost-only Preview panel:

- User-entered or detected local URL
- Refresh
- Open externally
- Capture screenshot
- Attach screenshot to a task, swarm context, or selected agent mailbox

Start with `localhost`, `127.0.0.1`, and `[::1]`. Do not create a general browsing or automation system.

### Likely touchpoints

- New `src/components/preview/PreviewPanel.tsx`
- `src/App.tsx`
- `src/stores/projectStore.ts`
- Existing context-file and mailbox paths
- Tauri capability configuration if screenshot capture requires it

### Acceptance criteria

- Only loopback URLs are accepted in the first release.
- Preview failure explains whether the server is unavailable or embedding is blocked.
- Captured images are stored inside the project context area.
- The selected destination is visible before attachment.
- Keyboard navigation and a meaningful screenshot alternative label are provided.

---

## Priority 6 — Approved dynamic worker requests

### Problem

Swarm topology is mostly fixed before launch. A coordinator cannot safely request another specialist during execution.

### Implement

Allow an agent to create a durable worker request:

```json
{
  "role": "builder",
  "provider": "codex",
  "mission": "Fix the mobile layout",
  "dependsOn": ["frontend-agent"]
}
```

Bridge displays the request and requires human approval. Approved requests are inserted through the existing scheduler and remain subject to provider readiness and parallel-agent limits.

Do not allow the MCP sidecar to execute shell commands. It should record the request; Bridge remains the executor.

### Likely touchpoints

- `../saple-mcp` request tool and storage
- `src/stores/swarmStore.ts`
- `src/components/swarm/SwarmWorkspace.tsx`
- Existing confirm dialog

### Acceptance criteria

- A coordinator can request, but cannot directly execute, a new worker.
- The user sees provider, model, mission, dependencies, and estimated new pane count.
- Rejected requests never spawn a process.
- Approved requests obey the existing concurrency cap.
- Duplicate request IDs cannot launch duplicate workers.

---

## Priority 7 — SSH terminal presets

### Problem

Custom commands can run SSH manually, but remote setup is repetitive and not represented as a reusable terminal configuration.

### Implement

Add saved terminal presets containing:

- Display name
- SSH host alias
- Remote working directory
- Remote provider command

Launch the preset through the existing custom-command PTY path. Store no passwords; rely on the user's SSH agent and configuration.

This is not a remote SAPLE workspace. Files, Git, memory, Kanban, and Review remain local.

### Likely touchpoints

- Existing terminal preset/session state
- `src/components/terminal/TerminalGrid.tsx`
- `src/stores/terminalStore.ts`
- Settings diagnostics

### Acceptance criteria

- Presets never persist passwords or private keys.
- The final command is visible before launch.
- Existing custom-command validation remains active.
- Failed authentication leaves the terminal available for normal SSH interaction.
- Documentation clearly distinguishes a remote terminal from a remote workspace.

---

## Deferred deliberately

### Infinite canvas

The existing Terminal grid, Swarm graph, Memory graph, resizable panes, and room navigation already cover the functional requirement. Revisit only if user testing shows navigation—not orchestration—is the dominant problem.

### Bundled Parakeet or Whisper

Use the universal composer with OS dictation first. Add a local model only if measured usage demonstrates demand for push-to-talk routing, command latency, or offline transcription.

### GPT Realtime

Adds recurring cost, conversational state, audio permissions, and a new trust boundary. Revisit after local/OS voice proves valuable.

### True remote workspaces

Do not scatter SSH branches across Bridge's local filesystem, Git, memory, and review commands. Build a remote Saple sidecar/protocol as a separate milestone if remote workspace demand is validated.

### Arbitrary loops and autonomous spawning

Bounded rework and approved worker requests cover the real workflows while retaining cost and safety controls.

---

## Delivery sequence

| Phase | Work | Outcome |
|---|---|---|
| A | Priorities 0–1 | One durable control plane and context-aware launches |
| B | Priorities 2–3 | Faster direction and evidence-rich completion |
| C | Priority 4 | Safe iterative review workflow |
| D | Priorities 5–6 | Visual feedback and dynamic orchestration |
| E | Priority 7 | Convenient remote terminals without architectural overreach |

## Definition of success

The plan succeeds when a user can open one composer, launch or redirect an agent, have that agent retrieve only the context it needs, see a structured outcome without reading the entire terminal, send rejected work through one bounded retry, and review the resulting evidence—all while `.saple/` remains the durable source of truth.
