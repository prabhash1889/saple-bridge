# Lazarus Product Plan

## Product thesis

Coding agents are useful but their work is scattered across terminal windows, provider transcripts, temporary prompts, and unreviewed diffs. Lazarus makes each coding session a durable project object with an explicit workspace, provider, permissions, history, artifacts, and resulting changes.

The product is deliberately local-first. It should feel like a focused workbench rather than a cloud project manager.

## Target users

### Primary

- Individual developers already using Codex or Claude Code subscriptions.
- Developers who move between structured prompting and direct terminal interaction.
- Developers who want agent work isolated in worktrees and easy to inspect.

### Secondary

- Technical leads who want durable specs and review records around agent work.
- Open-source maintainers who need several parallel work streams without losing provenance.

### Not targeted in v1

- Non-technical workflow teams.
- Organizations requiring centralized identity, billing, audit export, or hosted collaboration.
- Users looking for a general chat assistant unrelated to a code workspace.

## Jobs to be done

1. When I start agent work, bind it to an exact repository and execution location.
2. When the agent uses tools, show what it is doing without forcing me to parse raw logs.
3. When I need full native control, let me work with the provider CLI in a real terminal.
4. When the agent changes code, let me inspect the diff in the same workspace.
5. When I stop and return later, resume the same durable session.
6. When a task needs context, keep specs, decisions, and review notes outside the transcript.
7. When work may be risky, ask for approval at the boundary where the action occurs.

## Product differentiation

Lazarus should not reproduce Traycer's canvas-first experience. Its core UI is a calm project workbench.

| Concern | Lazarus decision |
|---|---|
| Primary navigation | Project rail and activity timeline |
| Main surface | One focused work surface with optional split inspector |
| Session organization | Runs grouped by project and objective, not a free-form canvas |
| Artifacts | Plain Markdown notebook beside runs |
| Progress | Timeline of turns, tools, approvals, checkpoints, and changes |
| Multi-agent work | Manual parallel runs in v1; orchestration later |
| Local operation | No sign-in screen or cloud dependency |
| Provider setup | Detect installed CLIs and use existing accounts |
| Visual tone | Quiet, precise, high-density only where evidence is inspected |

## Core entities

- **Project** — one or more local workspace folders, normally one Git repository.
- **Objective** — a named body of work inside a project.
- **Run** — one durable agent session attached to an objective.
- **Surface** — Chat or Terminal presentation for a run.
- **Execution location** — original workspace or a specific worktree.
- **Artifact** — a Markdown note, spec, checklist, decision, or review.
- **Checkpoint** — a durable point recording run state and repository state metadata.
- **Change set** — files and diffs produced in one execution location.

## Functional requirements

### Project onboarding

- Open one or more local folders through a native picker.
- Detect Git repository root, branch, dirty state, and existing worktrees.
- Remember recently opened projects.
- Validate that selected folders remain reachable.
- Detect Codex and Claude Code installations and login state without reading secrets into the renderer.

### Objectives and runs

- Create, rename, archive, restore, and delete an objective.
- Create Chat or Terminal runs under an objective.
- Select provider, model when discoverable, reasoning effort, permissions, and execution location.
- Show run status: idle, starting, running, awaiting input, stopping, failed, unavailable.
- Stop a live turn without deleting the run.
- Resume a run after application restart.
- Fork a run into a new run when the provider supports native session forking; otherwise create a new run with an explicit context handoff.

### Structured Chat

- Compose text plus file references and image attachments.
- Stream assistant text and reasoning summaries.
- Render tool calls, commands, file changes, plans, usage, warnings, and errors as typed blocks.
- Support approval requests and structured questions.
- Queue a follow-up while a turn is active when the provider supports steering; otherwise hold it locally until the current turn ends.
- Preserve the provider-native session identifier for resume.

### Terminal agents

- Launch Codex or Claude Code in a real PTY.
- Resize, search, copy, paste, and reconnect to the PTY.
- Persist provider session identity separately from terminal scrollback.
- Restore the run and relaunch/resume its provider session after daemon restart.
- Make the fixed workspace/worktree and provider identity visible.

### Artifacts

- Create Markdown notes with type: note, spec, checklist, decision, or review.
- Store files under `.lazarus/artifacts/` in the project by default.
- Link an artifact to objectives and runs through stable IDs in frontmatter.
- Preview and edit Markdown.
- Keep normal files usable without Lazarus.
- Do not introduce CRDT or custom binary formats in v1.

### Files and Git

- Browse files under approved workspace roots.
- Preview text, images, and common structured files.
- Show working-tree status and diffs per execution location.
- Stage/unstage only after a dedicated post-v1 decision; v1 is inspection-first.
- Open a file in the user's configured external editor.
- Create and delete worktrees with explicit confirmation and safety checks.

### Settings and diagnostics

- Configure provider CLI paths, default arguments, shell, theme, density, and permission defaults.
- Show daemon version, process state, logs, and health.
- Export a scrubbed diagnostics bundle.
- Never include prompts, file contents, tokens, or terminal output in diagnostics unless the user explicitly opts in.

## Non-functional requirements

| Requirement | Target |
|---|---|
| Cold start to usable shell | ≤ 2 seconds on a typical development machine |
| Local daemon readiness | ≤ 3 seconds when already installed |
| Chat event latency | UI render within 100 ms of daemon receipt |
| Terminal input latency | No intentional buffering beyond PTY transport |
| Crash recovery | No loss of acknowledged messages or artifact saves |
| Offline use | All v1 core features work without Lazarus cloud |
| Supported OS | macOS, Windows 11, current Ubuntu LTS |
| Accessibility | Keyboard-complete core flows; WCAG AA contrast |
| Upgrade safety | Rollback-compatible local database migration strategy |

## Success metrics

The private alpha is successful when:

- 90% of created runs can be resumed after full application restart.
- A user can complete the first agent turn in under five minutes from install.
- No renderer process has direct filesystem or child-process access.
- No ambiguous post-send mutation is automatically retried.
- At least ten real coding tasks are completed using both Chat and Terminal surfaces.
- Crash testing shows no corruption of acknowledged run events or Markdown artifacts.

## Release tiers

1. **Developer preview** — one OS, Codex Chat, local workspace, raw diagnostics.
2. **Private alpha** — Codex and Claude, Chat and Terminal, worktrees, diffs, restart recovery.
3. **Public beta** — all three desktop OSes, signed installers, updater, polished onboarding and diagnostics.
4. **v1** — stable local data compatibility, documented recovery, accessibility pass, provider support matrix.

