# Swarm v2: Cross-Provider Agent Orchestration

Findings and implementation plan

| Field | Value |
| --- | --- |
| **Status** | **v2 Phases A-F: not started.** v1 usability hardening (completion fallback, review controls, recovery, tests) is already on `main` - do not re-build it. |
| **Date** | 2026-07-14 (accuracy pass same day) |
| **Scope** | saple-bridge swarm feature + saple-mcp sidecar |

### Related docs

| Doc | Role |
| --- | --- |
| `docs/agent-orchestration-plan.md` | Durability / single writer / Rust engine rearchitecture (Draft v1 2026-07-13). This swarm plan feeds it; it does not replace it. |
| `all-other-files/swarm-update-1.md` | Historical usability diagnosis (silent stalls, review deadlock, discovery). **Mostly shipped** - treat as archive for v1 fixes, not the v2 backlog. |

---

## Already shipped (do not re-build)

These landed under the **current** one-shot pipeline. They make a swarm finish and stay operable; they do **not** make it a real multi-turn swarm. Phase A+ work still starts from a green baseline.

| Area | What exists now |
| --- | --- |
| Completion safety net | `pty-exit` + `exitFallbackTransition` (exit 0/`null` -> `review`, non-zero -> `failed`); headless panes omit PowerShell `-NoExit` so exit fires |
| Scoped markers | Per-agent `[AGENT_DONE:<token>]` (etc.); bare markers ignored for scoped agents |
| Review controls | Approve / Reject with bounded rework (`reworkAgent`); auto-approve option; review gates dependents by design |
| Observability | In-room terminal tail (~4k chars), `statusReason`, optional outcome JSON on the agent card |
| Restart recovery | Orphan PTY reconciliation on load; P13 pending-exit + marker-tail replay when the project was not loaded |
| Dynamic workers | P6 `requests.json` + human approve/reject inserts a worker into the existing scheduler |
| Workspace isolation (weak) | P11 second workspace **instance** of the same folder (`<project> (swarm)`) - not a git worktree |
| Control plane | Session launch registers agents/runs/artifacts via `controlPlane.ts` (partial dual-store bridge, not source of truth for scheduling) |
| Tests | `swarmStore.test.ts`, `agentSignals.test.ts`, related status tests |

---

## Verification methodology

This report merges two investigations:

1. A full codebase deep dive of the current swarm stack (`swarmStore.ts`, `agentSignals.ts`, `terminalStore.ts`, `pty.rs`, `swarm.rs`, the wizard, `SwarmWorkspace.tsx`, `projectStore.ts`).
2. A web research pass (20 sources, ~100 extracted claims) whose automated verification failed mid-run; the load-bearing claims were then re-verified manually against primary sources (official Claude Code / Codex / Gemini / Cursor / Factory docs, the claude-code issue tracker, orchestrator repos).

Each external claim below is tagged:

- **[VERIFIED]** - read directly from a primary source during this research.
- **[SINGLE-SOURCE]** - extracted from one source, not independently confirmed. Treat numbers as directional.
- **[CORRECTED]** - the initial research overstated this; the corrected version is what appears here.

---

## 1. Executive summary

The goal: a swarm where a coordinator agent from one provider (e.g. Claude) iteratively divides work, hands tasks to worker agents from **other** providers (Codex, Grok, Gemini, Droid...), collects their findings, and loops - replicating Claude Code's own Task-tool pattern, but heterogeneous across vendors. If it were same-vendor, the feature would be pointless: one Claude session can already spawn its own subagents.

Three headline findings:

1. **Separate CLI processes are the technically correct architecture, not a compromise.** Claude's own in-session subagents return all results into the parent's single finite context, and returned results are size-capped. Separate processes give every agent an independent context budget and let large outputs bypass the coordinator via files. You get vendor diversity *and* escape the context-exhaustion trap.
2. **Today's swarm cannot do this by construction.** Agents launch as one-shot pipes into **bare** provider binaries (`Get-Content prompt.md | codex` - not `codex exec`, not `claude -p`, no permission profile, no structured JSON). Stdin is consumed, the process exits, and there is no channel to deliver anything into a running agent. The coordinator is *prompted* to write `tasks.json` and dies before any builder starts. All "communication" is dead-drop files that Bridge does not inject and one-shot agents never re-read.
3. **Every provider CLI that matters now supports resumable multi-turn headless sessions with structured JSON output.** The one-shot pipe can be replaced with a real orchestration loop using documented flags (`claude -p --resume`, `codex exec resume`, `droid exec -s`). A working open-source reference for the full pattern exists (`claw-orchestrator`).

The implementation plan (section 8) is six phases, A-F, that keep the product working at every step and slot into the existing `agent-orchestration-plan.md` engine phases. **Phase C non-goal:** do not grow a large TypeScript Autoloop that plan Phase 3 will delete - keep the renderer loop minimal, then port it as the first engine consumer.

---

## 2. How the current swarm works (codebase findings)

### Launch pipeline

1. The 6-step wizard (roster, mission, directory, context, name, launch) collects a DAG of agents.
2. `startSwarmFromWizard` creates a **second workspace instance of the same folder**, renamed `<project> (swarm)`, and pins all agent panes to it (`swarmStore.ts` P11). Same physical folder - not an isolated copy.
3. A dependency scan (`runAgentScan`, `swarmStore.ts:823`) launches agents whose dependencies are all `done`, capped by `maxParallelAgents`. The scheduler lives entirely in the React renderer.
4. Each agent gets a generated prompt file (mission + role prompt + skills + context files + mailbox/handoff **path conventions** + completion markers) which is **piped into the provider CLI via stdin** (`pty.rs:424`, Windows: `Get-Content "<file>" -Raw | codex --model "<m>"`). The shell exits when the CLI finishes.
5. **Important:** the invocation is the bare binary (`codex`, `claude`, `gemini`, ...), not provider-native headless/exec modes (`codex exec`, `claude -p`, `droid exec`) and not structured JSON output flags. There is no explicit permission posture (`--sandbox`, `--auto`, `--always-approve`). That is why Phase A is load-bearing, not polish - today's pipe is not production headless orchestration.

### Completion detection

- Primary: regex-scraping terminal output for scoped markers `[AGENT_DONE:<token>]` / `[AGENT_FAILED:<token>]` / `[REVIEW_REQUESTED:<token>]` against a 512-char rolling tail per pane (`agentSignals.ts`, `terminalStore.ts`).
- Fallback (already shipped): `pty-exit` event - clean or unknown exit parks the agent in `review` (auto-approve agents advance to `done`); non-zero exit fails it (`exitFallbackTransition`).
- Elaborate recovery machinery exists (P13 pending-exit replay, orphan reconciliation on restart) precisely because the renderer is the brain and can die.

### Communication primitives (all dead-drop files)

Bridge does **not** inject handoff or `tasks.json` content into dependent prompts. Agents are only *instructed* (via template / system-prompt text) to open those paths. If the model never opens the file, the edge is empty.

| File | Written by | Read by | When read |
| --- | --- | --- | --- |
| `.saple/swarm/mailbox/<id>.md` | agent + operator | agent (in theory); Bridge UI polls | never re-read by a running one-shot agent; operator `postToMailbox` is theater until rework relaunches |
| `.saple/swarm/handoffs/<from>-to-<to>.json` | upstream agent before exit (if it bothers) | dependent agent (if it opens the path) | **not** injected by Bridge at launch; path convention only |
| `.saple/swarm/tasks.json` | coordinator before exit (if it bothers) | builders (if they open the path) | **not** injected by Bridge; template convention only |
| `.saple/swarm/requests.json` | coordinator | Bridge (poll, human approval) | every 5s while active - only primitive Bridge actually drives |
| `.saple/swarm/outcomes/<id>.json` | agent before exit (optional) | Bridge at completion | optional; completion works without it |

### Root causes of "doesn't feel good"

1. **Batch pipeline wearing a swarm costume.** Coordinator plans, exits; builders run, exit; reviewer runs. No supervision, no conversation, no course correction until the review gate.
2. **No inbound channel to a live agent.** The stdin pipe kills live steering, live A2A, and makes the mailbox write-only theater.
3. **All agents edit the same working tree simultaneously.** Two parallel builders are a merge-conflict generator with no isolation and no merge/review step.
4. **Renderer-owned scheduler.** Swarm state machine scattered across renderer stores, marker regexes, and pty-exit fallbacks.
5. **Keyhole observability.** A 4,000-char ANSI-stripped text tail of one selected agent, mailboxes polled every 5s.

---

## 3. The pattern to replicate: Claude Code's Agent (Task) tool

From the official docs **[VERIFIED]**:

- The coordinator calls the **Agent tool** (renamed from "Task" in v2.1.63). Each subagent runs in **its own context window**; the parent passes only a delegation prompt.
- Intermediate tool calls and file reads stay inside the subagent. **Only the final message returns to the parent** as the tool result.
- Parallelism: the coordinator issues multiple Agent calls in one turn without awaiting each.
- The coordinator folds results into its context and decides the next round. That is the loop.

**[CORRECTED]** An earlier draft repeated a user claim (claude-code issue #10212) that subagents "share the parent's 200K budget" with no isolation. Official docs contradict this: each subagent has its own context window. What *is* true from both sources: **every subagent's result flows back into the parent's finite context** (wide fan-out still bloats the coordinator), and returned results are size-capped (the issue reports an 8192 output-token cap, with failed large-output delegations still consuming 10-15K parent tokens). The issue author's validated workaround - and the design principle for Swarm v2: *separate terminal processes give each agent an independent budget*; have workers write large output to files and return only a summary.

Why the Claude Agent SDK is not the answer: it spawns the Claude Code CLI as a subprocess and is **locked to Claude models** [SINGLE-SOURCE, consistent with its architecture]. Cross-vendor workers must be orchestrated outside the SDK - which is exactly the layer Saple Bridge occupies.

Competitive note **[VERIFIED]**: Claude Code now documents **background agents** (many parallel sessions, one monitor) and **agent teams** (sessions that message each other). Anthropic is building the single-vendor version of this feature. The cross-vendor coordinator remains the defensible differentiator - but the bar is "better than Claude's own teams at the one thing they can't do."

---

## 4. Per-CLI capability matrix

Ranked by orchestration-friendliness. "Multi-turn" = resumable session for iterative back-and-forth.

| CLI | Headless | Structured output | Multi-turn / resume | MCP client | Verification |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** `claude` | `-p` / `--print` | `--output-format json\|stream-json`; `--json-schema` fills `structured_output`; envelope has `result`, `session_id`, `total_cost_usd`, `is_error` | `--continue`, `--resume <id>`; `--input-format stream-json` (streaming stdin turns); session lookup scoped to project dir + its worktrees | Yes (`--mcp-config`); also MCP server | [VERIFIED] |
| **Factory Droid** `droid` | `droid exec` (positional, `-f file`, stdin) | `-o text\|json\|stream-json\|stream-jsonrpc` | `-s/--session-id <id>`, `--fork <id>`; `--input-format stream-jsonrpc` for multi-turn | Yes (`droid mcp add --type http\|sse\|stdio`) | [VERIFIED] |
| **Codex** `codex` | `codex exec` | `--json` (JSONL events), `--output-last-message` | `codex exec resume <id> "msg"`, `codex exec resume --last`, `--all` for any-directory sessions | Yes (`codex mcp`, `~/.codex/config.toml`); also MCP server | [VERIFIED] |
| **Grok Build** `grok` | `grok -p` | `--output-format json\|streaming-json` | not confirmed (has subagents + plan mode) | not confirmed | [SINGLE-SOURCE] (official docs domain) |
| **Gemini CLI** `gemini` | `-p` / `--prompt` (or non-TTY) | `--output-format json` (`response`, `stats`, `error`); JSONL streaming; exit codes 0 / 1 / 42 input / 53 turn-limit | resume not confirmed | Yes (`~/.gemini/settings.json`) | [VERIFIED] (headless page) |
| **OpenCode** `opencode` | `opencode run`; `opencode serve` (HTTP server) | via run/serve | HTTP server holds sessions | Yes | [SINGLE-SOURCE] |
| **cursor-agent** | `cursor-agent -p` (requires `--trust`) | `--output-format json` (single final object, no deltas) | limited | partial | [VERIFIED] docs + **known hangs on 2026.07 builds** (Cursor forum) |
| **gh copilot** | weak, interactive-oriented | limited | no | no | matches app's current non-headless classification |

Additional verified flags that matter:

- **Claude** `--bare` **[VERIFIED]**: skips auto-discovery of hooks/skills/plugins/MCP/CLAUDE.md for reproducible scripted runs; context injected explicitly via `--mcp-config`, `--agents <json>`, `--settings`, `--append-system-prompt`. Anthropic states it will become the default for `-p`. Piped stdin capped at 10MB (v2.1.128+).
- **Claude** cost/loop guards: `--max-turns`, `--max-budget-usd` [SINGLE-SOURCE].
- **Codex** `--full-auto` is **deprecated** (v0.128) **[VERIFIED]** - migrate to `codex exec --sandbox workspace-write` or permission profiles `:read-only` / `:workspace` / `:danger-full-access`.
- **Droid** autonomy: `--auto low|medium|high` (default read-only); `--skip-permissions-unsafe` for sandboxes only; exit codes 0 / 1 / 2. Native worktrees: `-w/--worktree [name]` creates `../<repo>-wt-<branch>/`.
- **Grok** CI: `--always-approve` (or `permission_mode = "always-approve"` in `~/.grok/config.toml`), `--no-auto-update`, `--mode plan` [SINGLE-SOURCE, official docs domain].

Provider role fit for Saple Bridge:

- **Coordinator**: Claude (schema-validated structured output + cleanest resume + cost telemetry).
- **Strongest workers**: Droid (worktree + fork + exit codes native) and Codex (exec resume + JSONL + MCP both directions).
- **Keep interactive-only**: cursor-agent (headless hang reports) and gh copilot. Do not build worker loops on them.

---

## 5. How findings return to the coordinator (cross-process patterns)

1. **Orchestrator-mediated routing (the spine).** Bridge launches a worker headless, captures its structured JSON result, and injects it into the coordinator's next turn via resume. Workers never talk to each other directly; Bridge is the router. Deterministic, auditable, human-gateable. This is what `claw-orchestrator`'s Autoloop does **[VERIFIED]**: Planner / Coder / Reviewer roles, each with an independently selectable engine and model, iterating in a loop.
2. **MCP message bus (the live channel).** A bus exposed as an MCP server; any MCP-capable worker joins with zero custom integration. References: **MCP Agent Mail** (identities, inboxes, searchable threads, advisory file leases; ships per-tool MCP configs; names Claude/Codex/Gemini/Droid as clients) and `clawo-mcp` (the whole orchestrator as an MCP server). Maps directly onto the existing `saple-mcp` sidecar - which today has **zero messaging tools**; `send_message` / `fetch_inbox` is the missing piece already named by `agent-orchestration-plan.md` Phase 4 (`saple_message_send`).
3. **File mailboxes (what exists now).** Only useful once workers are persistent sessions that can be prompted to check the bus between turns.

The keystone for 1 and 2 is the same: **replace the one-shot pipe with resumable sessions.**

---

## 6. Prior art

- **`claw-orchestrator`** (github.com/Enderfga/claw-orchestrator) **[VERIFIED]** - the closest reference implementation. Wraps claude / codex / cursor-agent / opencode / antigravity as **persistent programmable sessions** (`clawo serve` on :18796, `clawo session-start`, `clawo session-send`); cross-vendor Autoloop; git-worktree "council" with consensus voting; exposes itself as MCP (`clawo-mcp`); **pins tested engine versions** (Claude Code 2.1.207, Codex 0.144.1, OpenCode 1.17.15) - an explicit answer to CLI flag drift. Study this repo closely.
- **Vibe Kanban** (github.com/BloopAI/vibe-kanban) **[CORRECTED]** - Rust backend + TS frontend, 10+ vendor CLIs, per-task git worktree + branch + dedicated terminal, inline diff-review feeding comments back to the executing agent. Correction: the *company* (Bloop) shut down 2026-04-10 ("couldn't find a business model"), but **Vibe Kanban continues as a community-maintained Apache 2.0 project** moving to a fully local architecture. Still valid prior art *and* a live competitor - and a market signal that standalone free orchestrators struggle to monetize, which favors shipping swarm as a feature inside a broader workspace product.
- **Conductor** (Melty Labs) [SINGLE-SOURCE] - macOS-only, parallel Claude + Codex in per-agent worktrees, sweet spot 3-8 parallel features.
- **MCP Agent Mail** (github.com/Dicklesworthstone/mcp_agent_mail) **[VERIFIED]** - MCP mailbox bus; messages are git-committed artifacts (canonical + outbox + per-recipient inbox copies); advisory file-reservation leases with TTL as an alternative to worktree isolation; `fetch_inbox` with `unread_only` to cut polling token cost.
- **gnap** (Git-Native Agent Protocol) [SINGLE-SOURCE] - shared git repo as the coordination task board.
- Common architecture across all of them: **git worktree isolation per agent + PTY-or-headless process management + results routed to a review/coordinator layer.**

---

## 7. Pitfalls (will bite; design for them)

1. **Context degrades before the limit.** Significant quality degradation reported around 50K tokens on 200K-window models [SINGLE-SOURCE]. Coordinator loops need compaction or handoff around 64-80% usage; two-stage threshold (memory sync ~64%, graceful handoff ~80%) is the cited pattern.
2. **Result-size caps + coordinator context accumulation** (issue #10212 + official docs). Workers must write large output to files and return short structured summaries.
3. **Cost scales ~linearly with team size; the real ceiling is human review capacity** - cited optimum 5-7 concurrent agents; tasks under ~15 minutes of sequential work have negative ROI after orchestration overhead [SINGLE-SOURCE].
4. **Rate limits throttle loops.** Gemini free tier ~1,000 requests/day [SINGLE-SOURCE]. Per-provider concurrency caps needed.
5. **CLI flag drift is constant.** `--full-auto` deprecation, cursor-agent `-p` hangs, version-gated behaviors everywhere. Mitigate with a per-provider adapter layer + version detection + pinned tested versions (claw-orchestrator's approach).
6. **Multi-agent only pays on decomposable work** [SINGLE-SOURCE, citing Google Research]: big gains on parallelizable tasks, degradation on sequential ones. The coordinator's first job is honest decomposition; sometimes the right answer is one agent.
7. **Headless runs stall on approval prompts.** Every worker launch must pin an explicit permission posture (`--sandbox workspace-write`, `--auto medium`, `--always-approve`, `--permission-mode acceptEdits`) or the swarm hangs on an invisible prompt.

---

## 8. Implementation plan

Six phases. Each ships independently and leaves the product working. Phases A-C are the value spine; D and E can run in parallel after A; F lands last. This plan is renderer-first where safe and hands the scheduler to the Rust engine exactly where `agent-orchestration-plan.md` (Phases 2-4) already plans to - it does not fork that plan, it feeds it.

### Phase A - Provider adapters + structured results

**Objective:** replace marker-scraping with parsed JSON results; contain flag drift in one module. This is required because today launches bare CLIs without exec/print mode, JSON, or permission posture.

- New Rust module `src-tauri/src/providers.rs`: one adapter per provider describing
  - `headless_cmd(prompt_file, model, permissions) -> String` - exec/print-mode command construction (replaces the ad-hoc `run_cmd` branches in `pty.rs:421-441`),
  - `resume_cmd(session_id, message_file) -> Option<String>`,
  - `result_format` - how the final result is recognized (last-line JSON object for `claude -p --output-format json`; JSONL `result` event for stream modes; `--output-last-message <file>` for codex),
  - `parse_result(raw) -> AgentResult { text, session_id, cost_usd, is_error, structured }`.
- Launch changes per provider (exact verified flags):
  - claude: `claude -p --output-format stream-json --verbose < prompt.md` (later add `--bare` + explicit `--mcp-config` for reproducibility)
  - codex: `codex exec --json --sandbox workspace-write "$(cat prompt.md)"` + `--output-last-message <tmp>`
  - droid: `droid exec -f prompt.md -o json --auto medium`
  - gemini: `gemini -p "$(cat prompt.md)" --output-format json`
  - grok: `grok -p "..." --output-format json --always-approve --no-auto-update`
- The PTY reader keeps streaming raw output to the pane (unchanged UX); a per-attempt result extractor watches the stream, parses the final envelope, and emits a new Tauri event `agent-result { paneId, attemptId, result }`.
- `swarmStore` consumes `agent-result` as the **primary** completion signal; markers and pty-exit remain fallbacks (as `agent-orchestration-plan.md` Phase 4 already mandates: markers permanent fallback).
- Persist `providerSessionId` on `SwarmAgent` (from claude `session_id`, codex thread id, droid session id).
- **Attempt-scoped identity (plan invariant 5):** mint a fresh `attemptId` (and preferably a fresh marker token) per launch/relaunch. Output attributed to attempt N must never complete attempt N+1 - today's seed-time marker reuse is a latent race on relaunch.
- **Optional cheap win (A or early B):** when launching a dependent, Bridge reads known upstream `outcomes/` and handoff files and **injects** a short summary section into the dependent's prompt. Does not replace the coordinator loop; makes the current DAG less hollow until Phase C.
- Tests: adapter unit tests for command construction + envelope parsing per provider; fixture JSON envelopes checked in; attempt-id isolation test (stale attempt output ignored).

**Exit criteria:** a template swarm completes end-to-end with zero marker matches on providers that emit JSON; markers still complete a `custom`-provider agent; relaunch cannot be completed by the previous attempt's output.

### Phase B - Persistent multi-turn worker sessions

**Objective:** an agent is a session, not a process; anything can be delivered into it mid-run.

- Rust command `agent_send_turn(project_path, agent_id, message)` - runs the adapter's `resume_cmd` as a new attempt; output appends into the same pane (new child process, same pane buffer), result parsed as in Phase A. Attempt-scoped ids (plan Phase 3 invariant 5: output attributed to attempt N can never complete attempt N+1).
- `swarmStore.sendTurnToAgent(projectPath, agentId, message)`:
  - **Rework** becomes a turn (feedback delivered into the live session with its full context) instead of a cold relaunch with a pasted prompt. Keep relaunch for dead sessions.
  - **Operator mailbox messages** become actually-delivered turns instead of unread files.
- Session-death handling: resume failure -> fall back to relaunch with the outcome summary + feedback embedded (current behavior, now the fallback).
- Providers without confirmed resume (grok, gemini, opencode) degrade to the Phase A one-shot path automatically via the adapter (`resume_cmd -> None`).

**Exit criteria:** reject-with-feedback on a claude/codex/droid worker visibly continues the same session (prior context retained) rather than restarting from zero.

### Phase C - The coordinator loop

**Objective:** the coordinator stays alive, receives findings, divides work, and iterates - the Task-tool loop across vendors.

**Non-goal (hard):** do **not** build a large TypeScript Autoloop that `agent-orchestration-plan.md` Phase 3 will delete. Implement the **minimal** loop in `swarmStore` (action parse + route + caps), with the action contract shaped like the engine's future `Command` (`Steer`, `Message { to, body }`, ...). Port wholesale as the first engine consumer once Phase 3 lands.

- Coordinator launches as a persistent session (default provider: claude) with a JSON action contract via `--json-schema`:

```json
{
  "actions": [
    { "type": "assign",  "workerId": "fe_builder", "instruction": "..." },
    { "type": "message", "to": "be_builder", "body": "..." },
    { "type": "request_worker", "role": "builder", "provider": "codex", "mission": "..." },
    { "type": "review",  "summary": "..." },
    { "type": "complete","summary": "..." }
  ]
}
```

- Bridge drives the loop: worker's `agent-result` arrives -> Bridge sends a compact result summary (never the full transcript; full output lives in files/artifacts) as a turn to the coordinator -> parses `structured_output.actions` -> executes each action through the existing scheduler. `request_worker` keeps its human-approval gate (existing P6 flow). `assign`/`message` route through Phase B turns.
- Guard rails (all pre-existing patterns extended): max coordinator rounds (like `maxAttempts`), per-swarm budget cap (claude `--max-budget-usd` + cost summed from result envelopes), context watermark - when the coordinator session approaches ~70% context, Bridge asks it for a handoff summary and starts a fresh session seeded with it.
- Lives in `swarmStore` initially as a thin driver only; moves into the Rust engine wholesale at plan Phase 3.

**Exit criteria:** mission "build feature X" runs coordinator(claude) -> parallel workers(codex + droid) -> results return -> coordinator issues a second round of fixes -> completes, with zero human intervention except configured approval gates. The TS loop remains small enough that plan Phase 3 is a port, not a rewrite.

### Phase D - MCP message bus in saple-mcp (parallel track after A)

**Objective:** agents get a live, provider-agnostic channel; the file mailbox becomes an inbox agents actually check.

- New tools in `saple-mcp` (which currently has zero messaging tools): `send_message { from, to, subject, body }`, `fetch_inbox { agentId, unreadOnly, waitSeconds }` (long-poll to cut polling cost - MCP Agent Mail's pattern), `list_thread { threadId }`. Storage: `.saple/swarm/messages/` JSON.
- Multi-writer caveat: until plan Phase 2 (single-writer engine) lands, message writes go through the existing per-path atomic write; the bus is append-mostly so lost-update exposure is low but real - documented, and fixed for free by Phase 2.
- Prompt templates updated: workers check `fetch_inbox` between subtasks; coordinators may `send_message` to workers (delivery becomes push once Phase B turns exist: Bridge can inject "you have mail" turns).

**Exit criteria:** a worker mid-run acts on a message sent after its launch.

### Phase E - Worktree isolation + merge-back (parallel track after A)

**Objective:** parallel builders stop colliding; the swarm operates on an isolated copy and merges back deliberately.

- Rust commands: `create_swarm_worktree(project, swarm_id) -> path` (`git worktree add`), `remove_swarm_worktree`, `list_swarm_worktrees`. Location: sibling dir `../<repo>-swarm-<id>/` (avoids `.saple/` self-nesting and watcher noise).
- Wizard: "Run in isolated worktree" toggle (default on for swarms with >1 editing agent). The swarm's workspace instance points at the worktree path - the P11 instance mechanism already handles the rest.
- Post-create setup hook: run the workspace's configured install command; surface cost honestly in the wizard (node_modules is not shared).
- Completion: Review room shows the worktree diff vs base branch; operator merges / opens PR / discards. Per-agent worktrees (the full collision fix) come after per-swarm proves out; Droid workers can use native `-w`.
- This pulls forward the item `agent-orchestration-plan.md` explicitly deferred ("revisit when parallel editing agents produce real merge conflicts") - the cross-provider design makes that trigger a certainty, so it moves into scope now.

**Exit criteria:** two builders writing the same file in parallel produce two reviewable outcomes instead of one corrupted tree; user's own working tree untouched throughout.

### Phase F - Mission control (last; inside the existing Swarm room)

**Objective:** starting a swarm lands you in one screen that shows everything live.

- On launch: auto-switch to the swarm's workspace instance and the Swarm room's new layout: dependency DAG (existing `SwarmGraph`) + **live terminal grid** (reuse `TerminalPane` - the terminals room's multi-pane grid and the embedded browser panel already prove the composition) + right-rail event feed (agent-result events, bus messages, approvals, coordinator actions) replacing the 4,000-char tail.
- Constraint (per project memory): **no new nav entries** - this is a redesign of the existing Swarm room, not a new room.
- Inline everywhere the loop needs a human: worker requests, rework approvals, merge-back.

**Exit criteria:** a running swarm is fully observable and steerable without leaving the Swarm room.

### Cross-phase engineering rules

- **Version pinning + detection:** the provider store records CLI versions at preflight; adapters declare tested version ranges; untested versions warn, never block. (claw-orchestrator's mitigation, adopted.)
- **Timeouts + leases:** every headless attempt gets a deadline; a silent-but-alive worker past its lease is probed then failed to retry policy (plan Phase 4's lease design, needed earlier in degraded form).
- **Attempt identity:** every launch/relaunch mints a new `attemptId`; completion events (JSON result, marker, pty-exit) are tagged with it; stale attempt output is ignored (plan Phase 3 invariant 5, enforced early in A/B).
- **Windows-first E2E:** every phase exits through a real template swarm on Windows against a scratch repo; macOS smoke on release branches.
- **Sequencing with the engine plan:** A/B/D/E are renderer-safe and engine-agnostic. C is the piece most worth NOT over-building in TS - implement the minimal loop, then port it as the first consumer of the engine's `submit/command/observe` in plan Phase 3.
- **Do not re-litigate v1 usability:** exit fallback, approve/reject, recovery, and in-room tail already exist. New work should preserve them as fallbacks while adapters and the coordinator loop take over as the primary path.

---

## 9. Corrections & verification log

| # | Claim as first reported | Verified reality |
| --- | --- | --- |
| 1 | "Vibe Kanban is being discontinued - don't depend on it" | Bloop (the company) shut down 2026-04-10; **Vibe Kanban continues** as community-maintained Apache 2.0, moving fully local. Still prior art *and* a live competitor. |
| 2 | "In-model subagents share the parent's 200K budget" (issue #10212) | Official docs: each subagent has **its own context window**. The real constraints: results flow back into the parent's finite context, and returned results are size-capped. Conclusion unchanged (separate processes = independent budgets), reasoning corrected. |
| 3 | Codex profile `:danger-no-sandbox` | Correct name: **`:danger-full-access`** (plus `:read-only`, `:workspace`). |
| 4 | Handoffs / `tasks.json` are "read by dependent at launch" | Dependents are only *instructed* to open those paths. Bridge does **not** inject handoff or tasks content into the next prompt. Path-convention dead-drop, not a protocol. |
| 5 | "Implementation not started" for the whole swarm stack | **v2 Phases A-F** are not started. **v1 usability** (exit fallback, review approve/reject, recovery, tails, tests) is already on `main`. |
| 6 | Headless launch is "print mode with structured results" | Today: bare `codex` / `claude` / ... with stdin pipe only - **not** `codex exec` / `claude -p` / JSON envelopes / permission profiles. Phase A closes that gap. |

## 10. Sources

Primary (fetched and read during verification):

- Claude Code headless: code.claude.com/docs/en/headless
- Claude Code subagents: code.claude.com/docs/en/sub-agents, code.claude.com/docs/en/agent-sdk/subagents
- Subagent context issue: github.com/anthropics/claude-code/issues/10212
- Factory Droid CLI: docs.factory.ai/reference/cli-reference
- Codex CLI: developers.openai.com/codex (cli, noninteractive, permissions)
- Gemini CLI headless: geminicli.com/docs/cli/headless
- claw-orchestrator: github.com/Enderfga/claw-orchestrator
- MCP Agent Mail: github.com/Dicklesworthstone/mcp_agent_mail
- Vibe Kanban: github.com/BloopAI/vibe-kanban, vibekanban.com/blog/shutdown
- Grok Build: docs.x.ai/build (cli reference, headless-scripting)
- cursor-agent: cursor.com/docs/cli (headless, output-format), forum.cursor.com hang reports

Secondary / single-source (directional): dev.to and personal-blog CLI comparisons, addyosmani.com/blog/code-agent-orchestra, zylos.ai context-window research, codex.danielvaughan.com deprecation writeups, awesome-agent-orchestrators list, Linux Foundation A2A 1.0 press release.
