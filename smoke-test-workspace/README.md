# Smoke Test Workspace

A minimal workspace fixture for manual and automated QA of Saple Bridge.

## Contents

- `.saple/config.json` — Workspace config with Codex as default provider.
- `.saple/tasks.json` — 5 tasks across backlog, progress, review, and done columns.
- `.saple/agents/sessions.json` — 3 agent sessions (stopped, running, done).
- `.saple/agents/prompts/session-001.md` — Example prompt file.
- `.saple/memory/architecture/auth-architecture.md` — Architecture memory note with wikilinks.
- `.saple/memory/decision/jwt-auth-decision.md` — Decision record with backlinks.
- `.saple/review/task-003.json` — Pending review record.
- `.saple/swarm/state.json` — Active swarm with coordinator, builder, reviewer.
- `.saple/swarm/templates.json` — 5 swarm templates.

## Usage

Open this directory as a workspace in Saple Bridge. The app should:

1. Detect the existing `.saple/config.json`.
2. Load all tasks, sessions, memory notes, and swarm state.
3. Show 5 tasks in the Kanban board across all columns.
4. Show 2 memory notes with wikilink graph edges.
5. Show 1 pending review in the Review Room.
6. Show 1 active swarm in the Swarm Room.
7. Display 3 agent sessions (one running, one stopped, one done).

## Path Notes

The workspace path contains no special characters or spaces, making it suitable
for baseline QA. For space-in-path testing, copy this directory to a path like
`C:\My Projects\smoke test\` and repeat the QA steps.