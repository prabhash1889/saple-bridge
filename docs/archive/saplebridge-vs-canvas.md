# SAPLE Bridge vs CNVS

> Research and codebase comparison, prepared July 13, 2026.

## Executive finding

SAPLE Bridge and CNVS solve the same top-level problem: give one developer a practical way to direct several coding agents without living in disconnected terminal tabs.

They approach that problem from opposite directions:

- **SAPLE Bridge is a structured, local-first workflow and control plane.** It emphasizes durable project state, explicit agent lifecycles, dependency graphs, review gates, Git operations, and inspectable files under `.saple/`.
- **CNVS is an interaction-first agent desktop.** It emphasizes a native infinite canvas, voice control, spatial organization, built-in visual feedback, and remote agents that remain active when the laptop disconnects.

The clearest product opportunity is not to turn SAPLE Bridge into a CNVS clone. SAPLE already has deeper workflow machinery in several areas. The opportunity is to make that machinery feel as immediate and visible as CNVS.

---

## 1. What CNVS is

CNVS is a native macOS application, built in Swift, that places multiple coding agents and their tools on an infinite visual canvas. Its public positioning is “command an army of agents with your voice.”

It is not a foundation model. It orchestrates existing tools and subscriptions such as Claude Code, Codex, Cursor, and other agent CLIs exposed through terminal, CLI, or MCP integrations.

### Publicly demonstrated or announced capabilities

- Run Claude Code, Codex, Cursor, and other agents concurrently.
- Direct agents with typed prompts, keyboard shortcuts, or voice.
- Use NVIDIA Parakeet locally for fast speech-to-text commands.
- Optionally use OpenAI GPT Realtime for conversational voice control.
- Let agents reportedly spawn and prompt other agents.
- Share project knowledge through an on-demand cross-agent memory system.
- Place terminals, browser previews, files, screenshots, Markdown, tasks, and diagrams on one canvas.
- Let agents operate terminals, browsers, screenshots, and development servers.
- Create local projects or SSH/VPS-backed remote canvases.
- Keep remote agents working after the Mac disconnects.
- Drop screenshots and files into remote sessions as agent context.
- Use keyboard-first search, agent spawning, and prompting.
- Use MCP and a CLI surface for agent interoperability.
- Organize work with Kanban-style task management.
- Create agent loops and Excalidraw-style diagrams.
- Use themes and a native Liquid Glass-style visual treatment.

### Likely operating model

```text
Voice / keyboard / prompt / screenshot
                  │
                  ▼
        CNVS native Swift canvas
      routing · layout · orchestration
          │                     │
          ▼                     ▼
 Local project sessions     SSH / VPS sessions
          │                     │
          └──────────┬──────────┘
                     ▼
  Claude Code · Codex · Cursor · other agent CLIs
                     │
       terminals · browser · files · servers
                     │
             shared memory / canvas
```

The feature set is visible in product demonstrations and creator posts, but the precise persistence, routing, memory retrieval, and permission architecture is not publicly documented.

### CNVS strengths

- Voice and keyboard control reduce interaction friction.
- The canvas makes parallel work spatially understandable.
- Agents, browser output, diagrams, and prompts share one surface.
- Remote sessions separate agent uptime from laptop uptime.
- On-demand memory addresses context bloat.
- Agent-to-agent prompting supports more fluid orchestration.
- Native Swift implementation gives the product a tactile macOS advantage.

### CNVS limitations and unknowns

- No public source repository was found.
- No comprehensive public architecture or API documentation was found.
- The compatibility boundary between native integrations and generic terminal commands is unclear.
- Shared-memory schema, retrieval, export, and correction behavior are undocumented.
- SSH key storage, agent permissions, audit logs, and production safeguards are undocumented.
- It is macOS-focused rather than cross-platform.
- It is a young product with a rapid update cadence and a likely learning curve.
- Several features, including the iOS companion, were announced as future work rather than verified as generally available.

### Business and creator-channel findings

CNVS uses a one-time-license model and expects users to bring their existing AI subscriptions or API keys. At research time the official site advertised a $99 founder price, later price steps, and all 1.x updates.

Max Blade's YouTube and live-stream presence functions as both development log and distribution channel. The content is primarily long-form build-in-public work rather than orderly product documentation:

- CNVS is used to build CNVS.
- Streams cover feature implementation, bugs, user feedback, model testing, and product marketing.
- Short clips are redistributed through X and creator-indexing sites.
- The material is useful for observing real workflows but inefficient as a reference manual.

### Public CNVS sources

- [CNVS product site](https://cnvs.dev/)
- [Max Blade on X](https://x.com/_MaxBlade)
- [Max Blade on YouTube](https://www.youtube.com/@MaxBladeTv)
- [Indexed creator updates](https://vibin.live/creators/max-blade)
- [Voice-controlled launch summary](https://vibin.live/creators/max-blade/cnvs-launches-voice-controlled-dev-environment-for-claude)
- [Persistent remote-canvas summary](https://vibin.live/creators/max-blade/cnvs-launches-voice-controlled-vibe-coding-tool-with)
- [TrustMRR profile](https://trustmrr.com/startup/cnvs)

---

## 2. What SAPLE Bridge already is

SAPLE Bridge is a local-first desktop workspace for driving coding agents against a repository. It is built with Tauri 2 and Rust, with a React, TypeScript, Zustand, Vite, CodeMirror, and xterm.js frontend.

Windows is the primary packaging target and macOS 11+ is supported. Project artifacts are persisted under `.saple/`; the documented product model has no application server, account, or telemetry.

### Current Bridge capabilities

- Native PTY-backed terminal panes.
- Multiple provider CLIs and custom commands.
- Persistent terminal layouts and agent sessions.
- Kanban tasks with priority, checklists, acceptance criteria, target files, and agent configuration.
- One-click launch of an agent from a task.
- Markdown project memory with frontmatter and wikilink graphs.
- Memory snapshots, restore, full-text search, backlinks, and suggestions.
- Swarm templates with coordinator, builder, scout, and reviewer roles.
- Dependency-graph scheduling and bounded parallelism.
- Swarm pause, resume, stop, relaunch, failure propagation, and restart reconciliation.
- Scoped completion markers to prevent cross-agent status collisions.
- Human review gates and optional per-agent auto-approval.
- Human-to-agent mailbox messages.
- Agent-to-agent handoff files.
- Live terminal-output tails inside the Swarm inspector.
- Integrated Git status, diff, stage, unstage, verification, review, commit, and rejection feedback.
- File tree, code editor, syntax highlighting, and Markdown preview.
- Command Palette search across rooms, tasks, and memories.
- Keychain-backed secrets, path containment, atomic writes, and desktop notifications.
- Windows in-app updates with signature verification.

### SAPLE MCP control plane

The sibling `saple-mcp` project is more capable than the Bridge UI currently communicates. It is a Rust context/control plane with 58 tools exposed over stdio MCP and an optional HTTP bridge.

Its domains include:

- Memory graph
- Tasks
- Swarm status
- Incidents
- Runs
- Workspace context and project briefs
- Agent registry and agent context
- Artifacts
- External mappings
- Advisory permissions

It stores durable state in the same `.saple/` workspace and deliberately does not execute shell commands or modify user code.

Relevant local references:

- [Bridge README](README.md)
- [Frontend architecture](src/AGENTS.md)
- [Rust boundary](src-tauri/src/AGENTS.md)
- [Swarm scheduler](src/stores/swarmStore.ts)
- [Swarm workspace](src/components/swarm/SwarmWorkspace.tsx)
- [Agent session model](src/types/agent.ts)
- [Review backend](src-tauri/src/review.rs)
- [Saple MCP README](../saple-mcp/README.md)

---

## 3. Similarities

Both products provide or aim to provide:

- A single desktop environment for multiple coding agents.
- Concurrent Claude, Codex, Cursor, or equivalent agent sessions.
- Bring-your-own provider accounts or credentials.
- Terminal-backed execution.
- Project-scoped task organization.
- Shared context across agents.
- Visual agent status and coordination.
- Human intervention during autonomous work.
- Persistent project state.
- MCP-based interoperability.
- A way to progress from a high-level mission to implementation and review.

SAPLE's Swarm room is already close to the multi-agent core of CNVS. It includes the dependency graph, selected-agent inspector, live terminal tail, mailbox composer, handoffs, review state, and terminal navigation that a CNVS-style control surface needs.

---

## 4. Differences

| Area | SAPLE Bridge | CNVS |
|---|---|---|
| Core metaphor | Separate workflow rooms with grids and graphs | Infinite spatial canvas |
| Product emphasis | Durable execution, state, review, and governance | Fast, fluid, visible agent interaction |
| Platform | Windows-first; macOS supported | Native macOS / Apple Silicon |
| Technology | Tauri, Rust, React | Swift-native macOS |
| Providers | Codex, Claude, Gemini, Cursor, OpenCode, Droid, Copilot, Pi, OpenRouter, custom | Publicly emphasizes Claude Code, Codex, Cursor, and other CLI/MCP agents |
| Orchestration | Explicit DAG, templates, dependencies, bounded concurrency | Freeform spatial orchestration and reported agent-initiated spawning |
| Memory | Inspectable Markdown graph plus MCP context tools | On-demand cross-agent memory; internals unpublished |
| Voice | No native command system | Local Parakeet and optional GPT Realtime |
| Remote work | Local workspace assumptions; manual SSH possible in a terminal | First-class persistent SSH/VPS canvases |
| Browser loop | URLs open externally | Built-in browser, previews, and screenshot feedback |
| Git/review | Structured diff, verification, approval/rejection, staging, commit | No equivalent structured review workflow publicly documented |
| Persistence | Transparent `.saple/` JSON and Markdown | Canvas persistence details unpublished |
| Privacy | Explicit no server/account/telemetry model | Local voice available; broader policy details sparse |
| Extensibility | Documented 58-tool MCP/HTTP control plane | MCP and CLI support without a public tool catalog |
| Safety | Keychain, containment, atomic writes, review gates; verification is unsandboxed | Public guardrail details unavailable |

### Conceptual difference

SAPLE behaves like a structured agent operating system backend with a desktop console. CNVS behaves like a visual agent desktop with an orchestration runtime behind it.

That distinction should remain. It gives SAPLE a credible position instead of forcing it into a feature-for-feature clone race.

---

## 5. Where SAPLE is stronger

### Explicit agent lifecycle

SAPLE models idle, queued, starting, running, waiting, review, blocked, done, failed, and stopped states. Dependencies unblock only when their prerequisites finish, failures propagate, parallel execution is capped, and an interrupted desktop session is reconciled on restart.

### Human-controlled review

SAPLE's Review room provides a clear quality boundary: inspect diffs, mark files viewed, stage selected changes, run a verification command, approve or reject, supply feedback, and commit.

### Inspectable local state

Tasks, memories, agent sessions, swarm state, handoffs, reviews, and snapshots are normal project files. They can be versioned, inspected, backed up, migrated, or repaired outside the application.

### Control-plane depth

Saple MCP already has structured agents, runs, incidents, artifacts, permissions, project briefs, and task context. CNVS has not publicly documented an equivalent catalog.

### Provider breadth and platform reach

Bridge supports a wider explicit list of provider CLIs and is not confined to macOS.

---

## 6. Where CNVS is stronger

### Interaction speed

CNVS reduces the distance between intention and execution. Voice, keyboard actions, direct manipulation, and spatial placement make spawning and redirecting agents feel immediate.

### Unified visual feedback

Agents, terminals, browser output, screenshots, diagrams, and tasks remain visible in one place instead of requiring navigation between rooms.

### Remote continuity

A remote canvas can continue working on a VPS when the laptop is closed. SAPLE's current file, memory, Git, and review commands assume a local project path.

### Dynamic orchestration

CNVS publicly demonstrates or claims more fluid agent-to-agent spawning and prompting. SAPLE can coordinate mailboxes and predefined dependencies, but topology is mainly fixed before launch.

### Native product feel

CNVS invests heavily in voice latency, animation, themes, and macOS-native visual polish. SAPLE's advantage is operational structure rather than tactile presentation.

---

## 7. The most important SAPLE gap

The largest gap is integration, not missing subsystems.

Bridge currently creates agent sessions and includes an `artifacts` field. The review backend looks for test-result artifacts, but new Bridge sessions initialize with an empty artifact list and no clear Bridge path populates it. At the same time, Saple MCP independently supports agents, runs, artifacts, and structured context.

The desired lifecycle is:

```text
Launch agent
  → register agent
  → create run
  → retrieve an on-demand brief
  → execute and append run events
  → record changed-file, test, decision, and summary artifacts
  → finish run
  → open review with complete evidence
```

Connecting this loop would make SAPLE's existing depth visible and useful.

---

## 8. Recommended additions

### Build first

1. **Connect Bridge sessions to Saple MCP agents, runs, and artifacts.** Eliminate disconnected records and make completion evidence available to Review.
2. **Add automatic on-demand context briefing.** Coordinators should use `get_project_brief`; task agents should use `get_task_context`; registered agents should use `get_agent_brief`.
3. **Add a universal agent composer.** Extend the existing Command Palette so one shortcut can message a selected agent, all running agents, a reviewer, a task, a new terminal, or a new swarm.
4. **Capture structured completion results.** Record summary, changed files, tests, decisions, and review needs through existing artifact types and MCP tools.

### Build next

5. **Add one bounded reviewer-to-builder rework loop.** Use explicit attempt limits and human approval rather than arbitrary cyclic graphs.
6. **Add a localhost development preview with screenshot-to-context.** Attach captured screenshots to a task, swarm, or agent mailbox.
7. **Add approved dynamic worker requests.** Let a coordinator request a worker, but require Bridge approval and preserve concurrency limits.
8. **Add lightweight SSH terminal presets.** Treat this as remote terminal convenience, not as a full remote workspace.

### Defer

- A full infinite canvas.
- A bundled local speech model before OS dictation validates demand.
- GPT Realtime conversational control.
- True remote workspaces until a remote Saple sidecar/protocol exists.
- An iOS companion before desktop-independent remote operation exists.
- Arbitrary autonomous spawning or unlimited loops.
- Live backgrounds and decorative theme work that does not improve execution.

---

## 9. Recommended product position

SAPLE should not position itself as “CNVS, but cross-platform.” A stronger position is:

> **CNVS-like control with a durable local control plane, explicit review, and inspectable project state.**

CNVS can remain the reference for interaction quality: voice, spatial visibility, visual feedback, and remote continuity. SAPLE should borrow those interaction lessons while preserving its differentiators:

- Local ownership
- Structured context
- Explicit lifecycles
- Review and Git governance
- Multi-provider reach
- Transparent files
- A documented MCP control plane

The goal is to make SAPLE's depth feel immediate—not to replace it with a canvas.

---

## 10. Research limitations

CNVS is closed and its public landing page is deliberately sparse. The interactive YouTube channel could not be directly audited in the research environment, so video findings rely on indexed titles, cross-posted creator summaries, the official site, and public creator posts. Claims about CNVS internals are therefore labeled as demonstrated, announced, or inferred rather than treated as verified implementation detail.
