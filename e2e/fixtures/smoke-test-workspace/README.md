# Smoke Test Workspace

This directory is a small Saple Bridge workspace fixture for manual QA. Open this directory from the desktop app to verify that existing workspace state loads correctly.

## Contents

- `.saple/config.json` - workspace config with Codex as the default provider.
- `.saple/tasks.json` - tasks across backlog, progress, review, and done columns.
- `.saple/agents/sessions.json` - sample agent sessions.
- `.saple/agents/prompts/session-001.md` - sample prompt file.
- `.saple/memory/architecture/auth-architecture.md` - architecture memory note with wikilinks.
- `.saple/memory/decision/jwt-auth-decision.md` - decision note with backlinks.
- `.saple/review/task-003.json` - pending review record.
- `.saple/swarm/state.json` - sample swarm state.
- `.saple/swarm/templates.json` - sample swarm templates.

## Checklist

After opening this folder in Saple Bridge, verify:

1. The app detects the existing `.saple/config.json`.
2. Tasks load into the Kanban board.
3. Agent sessions appear with their saved statuses.
4. Memory notes appear in the memory list.
5. Wikilinks render in the memory preview and graph.
6. The Review workspace shows the pending review record.
7. The Swarm workspace shows the saved swarm state.
8. Settings can read workspace configuration without rewriting unrelated files.

## Path Testing

This fixture path intentionally has no spaces or special characters. For path handling checks, copy the directory to a path such as:

```text
C:\My Projects\smoke test\
```

Then repeat the checklist.
