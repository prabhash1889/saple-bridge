# Lazarus Build Plan

Lazarus is a local-first desktop workspace for durable AI coding sessions. It combines structured Chat agents, provider-native Terminal agents, project artifacts, worktrees, and change inspection without requiring an account or cloud service for the first release.

This folder is the implementation source of truth. It plans Lazarus as an independent product inspired by the architectural lessons in Traycer, not as a visual or behavioral copy.

## Settled v1 boundaries

| Decision | Lazarus v1 |
|---|---|
| Product shape | Cross-platform desktop application |
| Data model | Local-first, durable, single-user |
| Agent surfaces | Structured Chat agents and provider-native Terminal agents |
| Initial providers | Codex and Claude Code |
| Native architecture | Browser-safe renderer plus local daemon |
| Work isolation | Local folder or Git worktree |
| Accounts/cloud | Not required; deferred |
| Collaboration | Deferred |
| Remote machines | Deferred |
| Application name | Lazarus |

## Document map

1. [PRODUCT.md](PRODUCT.md) — vision, users, scope, requirements, and success criteria.
2. [UX-UI.md](UX-UI.md) — information architecture, interaction model, screens, and visual direction.
3. [ARCHITECTURE.md](ARCHITECTURE.md) — processes, boundaries, modules, request traces, and provider adapters.
4. [DATA-AND-PROTOCOL.md](DATA-AND-PROTOCOL.md) — domain model, persistence, RPC, streams, and migrations.
5. [SECURITY-RELIABILITY.md](SECURITY-RELIABILITY.md) — trust boundaries, permissions, recovery, and operational safety.
6. [ROADMAP.md](ROADMAP.md) — milestones, dependencies, acceptance gates, and release strategy.
7. [STEP-BY-STEP.md](STEP-BY-STEP.md) — the concrete build order from empty repository to v1.
8. [index.html](index.html) — self-contained visual dashboard for the entire plan.

## Guiding principles

1. The daemon owns machine authority; the renderer never gets arbitrary filesystem or process access.
2. One provider path must work end to end before a generalized integration layer grows.
3. A session is durable only when it can be resumed after both UI and daemon restart.
4. Chat and Terminal are two views over related agent concepts, not one compromised abstraction.
5. A request that might have been applied is never retried automatically.
6. Worktrees are explicit user choices, not hidden side effects.
7. Local failure must not destroy accepted work.
8. No cloud-shaped abstractions until a cloud milestone is approved.

## Definition of v1

A user can open a Git repository, create either a Codex or Claude agent in Chat or Terminal mode, choose the repository or an isolated worktree, run and resume the agent, approve sensitive actions, inspect changed files and diffs, preserve notes/specs beside the session, close Lazarus, reopen it, and continue without an account.

## Explicit non-goals for v1

- Multi-user collaboration
- Cross-device synchronization
- Browser client
- Remote daemon access
- Built-in paid inference
- Mobile client
- Plugin marketplace
- Autonomous multi-agent loops
- Pull-request hosting integration
- Full IDE replacement

These features remain possible because the process and protocol boundaries are clean; they are not pre-built as speculative scaffolding.

