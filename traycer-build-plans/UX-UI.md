# Lazarus UX and UI Plan

## Experience principles

1. **Project before agent.** Users enter a project and see its objectives, runs, artifacts, and changes together.
2. **Evidence before decoration.** Tool calls, approvals, and diffs use dense layouts; navigation and composition remain quiet.
3. **One dominant surface.** Avoid a canvas full of competing tiles. The user can split the main area once for an inspector.
4. **State is visible.** Every run shows provider, surface, execution location, and live state.
5. **Native escape hatches.** Files open externally; Terminal runs are real PTYs; Markdown stays plain.

## Information architecture

```text
Lazarus
├─ Home
│  ├─ Recent projects
│  ├─ Running agents
│  └─ Recovery/diagnostics notices
└─ Project
   ├─ Objectives
   │  └─ Runs (Chat or Terminal)
   ├─ Artifacts
   ├─ Changes
   ├─ Files
   └─ Project settings
```

## Desktop frame

```text
┌──────────┬──────────────────────┬─────────────────────────────────┐
│ Project  │ Objective / run list │ Focused work surface            │
│ rail     │                      │                                 │
│          │ • Auth refactor      │ Chat / Terminal / Artifact      │
│ Home     │   ├ Codex · running  │                                 │
│ Repo A   │   └ Claude · idle    │ Optional right-side inspector   │
│ Repo B   │ • Search redesign    │ for diff, file, run details     │
│          │                      │                                 │
├──────────┴──────────────────────┴─────────────────────────────────┤
│ Status: daemon · branch/worktree · provider · resource activity  │
└──────────────────────────────────────────────────────────────────┘
```

### Project rail

- Narrow icon/name rail for Home and recently opened projects.
- Running indicator and unread/failure dot per project.
- Native project picker at the bottom.
- No global host picker in v1 because there is one local daemon.

### Navigator

- Switcher tabs: Objectives, Artifacts, Changes, Files.
- Objectives expand into runs.
- Run rows show surface icon, provider, state, and execution-location badge.
- Keyboard navigation and command palette expose every action.

### Main work surface

- Tabs exist only inside the current project.
- Opening a run, artifact, diff, or file creates a tab.
- Tabs persist across restart but never silently change execution location.
- One optional inspector split can show diff/file/run details alongside the main tab.

## Key screens

### Home

Sections:

- Continue: recently active projects and last focused objective.
- Running now: live runs across projects.
- Open project button.
- Setup health: provider or daemon issues only when action is needed.

Empty state teaches one action: open a project. It does not ask users to create an account.

### Project onboarding

1. Pick folder(s).
2. Show detected Git repository and dirty state.
3. Detect Codex and Claude Code availability.
4. Offer to create the first objective.
5. Let the user choose Local or New worktree for the first run.

Provider repair is inline. If a CLI is missing, show the detected path search and an external installation link; never embed provider credentials in Lazarus.

### Objective overview

The objective home is a timeline, not a canvas. It combines:

- objective summary and linked artifacts;
- run creation button;
- chronological activity from all runs;
- checkpoints and approvals;
- changed-file summary per execution location.

Timeline filters: All, Messages, Tools, Changes, Checkpoints, Errors.

### Chat run

Header:

- provider/model/profile label;
- execution location and branch;
- permission mode;
- status and stop action;
- run menu: rename, fork, archive, diagnostics.

Transcript:

- Human messages are visually compact.
- Assistant prose is readable and selectable.
- Reasoning is summarized/collapsible rather than visually dominant.
- Tool calls use typed cards with command, target, status, duration, and expandable detail.
- File-change cards link directly to the inspector diff.
- Approval cards remain pinned near the composer until answered.

Composer:

- Text area with `/` commands and `@` references.
- Attachment button, provider/model controls, and permission indicator.
- Send becomes Stop only through a separate control; the typed draft remains editable while a turn runs.
- Queued follow-ups are visibly separate from sent messages.

### Terminal run

- Terminal occupies the main surface with minimal chrome.
- A slim header makes provider, fixed worktree, and reconnect state visible.
- Search and copy controls appear on demand.
- Inspector can show provider session metadata, recent checkpoints, or git diff.
- Closing the tab releases the UI attachment, not the durable run record.

### Artifacts

- Artifact list is a flat notebook with folders/tags, not a mandatory hierarchy.
- Types use subtle labels: Note, Spec, Checklist, Decision, Review.
- Editor supports Markdown source and preview.
- Linked objectives/runs appear in a metadata side panel.
- Files remain editable by external tools without conversion.

### Changes

- Group by execution location, then repository.
- File tree with status and change counts.
- Unified/split diff modes.
- Link a change back to the run/tool event that produced it when known.
- v1 does not stage, commit, push, or discard changes from Lazarus.

### Settings

- General: startup, updates, recent-project retention.
- Appearance: theme, density, font, terminal theme.
- Providers: discovered CLIs, version, login health, model catalog, default args.
- Shell: executable and environment overrides.
- Worktrees: root directory, setup/teardown scripts, managed worktrees.
- Permissions: default approval mode and command/file boundaries.
- Diagnostics: daemon status, versions, logs, export.

## Visual system

### Direction

- Dark-first neutral palette with warm amber for attention and mint for healthy activity.
- Off-black surfaces, restrained borders, little elevation.
- Figtree/Inter-style UI type; monospaced evidence surfaces.
- Rounded corners are small and functional, not card-heavy.
- Motion only communicates state transitions, stream arrival, or panel movement.

### Semantic colors

| Meaning | Color role |
|---|---|
| Active/healthy | Mint |
| Awaiting user | Amber |
| Destructive/error | Coral |
| Informational | Blue |
| Inactive/unavailable | Slate |

### Accessibility

- Every operation reachable by keyboard.
- Visible focus rings are never suppressed.
- Do not encode run status by color alone.
- Terminal and diff text allow font scaling.
- Reduced-motion mode removes nonessential transitions.
- Screen-reader announcements for new approval requests and completed turns.

## Command palette

Minimum commands:

- Open project
- Switch project/objective/run
- New objective
- New Chat run
- New Terminal run
- Open artifact
- Open changes
- Open file
- Stop active run
- Toggle inspector
- Open settings/diagnostics

Commands and buttons invoke the same action functions; do not duplicate behavior inside palette definitions.

## UI acceptance scenarios

1. A keyboard-only user opens a project and starts a Chat run.
2. A running Terminal agent reconnects after the renderer reloads.
3. A Chat tool produces a file change and its card opens the exact diff.
4. An approval remains actionable while the transcript continues streaming.
5. Switching projects never changes a run's worktree or provider.
6. A missing provider CLI produces a repair path rather than a blank state.
7. At 200% zoom the core run and approval workflow remains usable.
