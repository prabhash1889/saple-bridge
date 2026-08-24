# Lazarus Step-by-Step Build Process

This is the execution order. Each step ends with a runnable check or reviewable artifact. Do not start a later step because the earlier code “mostly exists”; satisfy its exit check.

## Stage A — Frame the repository

### Step 1: Create the workspace

- Initialize Bun workspaces.
- Add `apps/desktop`, `apps/renderer`, `apps/daemon`, `packages/protocol`, `packages/client`, `packages/domain`, and `packages/provider-core`.
- Add root scripts: install, compile, lint, format, test, build.
- Pin runtime versions.

Exit check: clean checkout installs and every empty package type-checks in CI.

### Step 2: Add repository rules

- Record process boundaries and type-safety rules in `AGENTS.md`.
- Add formatter/linter configs.
- Add pre-commit checks for affected files.
- Add DCO/commit convention only if the project will require it.

Exit check: deliberately malformed formatting, lint, and type examples fail locally and in CI.

### Step 3: Record architectural decisions

Write short ADRs for:

- separate daemon;
- direct renderer↔daemon transport;
- SQLite plus Markdown;
- whole-connection protocol v1;
- Codex/Claude provider contract;
- no cloud/accounts in v1.

Exit check: implementation agents can answer ownership and storage questions without inventing decisions.

### Step 4: Prototype the five core screens

- Home.
- Objective overview.
- Chat run.
- Terminal run.
- Changes inspector.

Use static data and validate keyboard flow, information density, and split inspector behavior.

Exit check: a reviewer can complete the first-run and run-inspection journeys without implementation.

## Stage B — Establish the trust boundary

### Step 5: Bootstrap Electron securely

- Create main, preload, and renderer entries.
- Enable context isolation and disable Node integration.
- Add CSP and deny navigation/window-open by default.
- Expose one harmless named preload method, such as platform info.

Exit check: renderer cannot import `fs`, spawn processes, or call arbitrary IPC channels.

### Step 6: Create the daemon executable

- Add a minimal process with health endpoint and structured logger.
- Acquire a per-user single-instance lock.
- Handle graceful shutdown and parent-independent lifetime.
- Write no domain logic yet.

Exit check: launching twice produces one daemon; health identifies its version/instance.

### Step 7: Implement daemon install and readiness

- Stage the packaged daemon in the user-data directory.
- Verify embedded SHA-256.
- Atomically activate it.
- Start and validate process identity.
- Atomically publish `runtime.json` only after health readiness.

Exit check: fresh start, adopt-existing, stale metadata, wrong PID, crash, and failed readiness tests pass.

### Step 8: Authenticate renderer connections

- Generate boot secret outside command-line arguments.
- Mint short-lived instance-bound renderer tokens.
- Validate loopback, Origin, token, expiry, and instance ID.
- Rotate token after renderer reload/window creation.

Exit check: local malicious-page test cannot connect; packaged renderer can.

### Step 9: Implement the minimal protocol

- Define Zod schemas for open/openAck, request/response, subscribe/stream/close.
- Add request IDs and typed error envelope.
- Build client and daemon dispatch tables.
- Enforce frame size and concurrency limits.

Exit check: protocol conformance tests run against an in-memory socket pair and a real daemon process.

### Step 10: Connect the renderer runtime

- Add typed daemon client and reconnect state.
- Add TanStack Query provider and daemon status query.
- Add readiness/error/retry UI.
- Ensure renderer reload preserves daemon.

Exit check: UI shows truthful connected, reconnecting, incompatible, and unavailable states.

## Stage C — Persist projects safely

### Step 11: Create SQLite foundation

- Open DB in daemon only.
- Enable WAL and foreign keys.
- Add migration table and transactional migration runner.
- Add backup-before-migrate hook.

Exit check: concurrent clients serialize through daemon; injected migration failure restores backup.

### Step 12: Implement native folder selection

- Add named preload/main picker method.
- Send selected paths to daemon for canonicalization.
- Create project/workspace records.
- Reject invalid/missing roots with structured errors.

Exit check: selected project appears after restart; renderer never decides path trust.

### Step 13: Implement safe file reads

- Add canonical containment helper in daemon.
- Re-check symlinks for reads.
- Add file tree pagination/lazy expansion.
- Add text/image preview size limits.

Exit check: traversal, symlink escape, huge file, binary file, and disappearing file cases pass.

### Step 14: Add Git read service

- Resolve Git executable/version.
- Read repository root, branch, HEAD, status, worktrees, and diff using argv arrays.
- Normalize results into protocol DTOs.
- Add coalesced watcher refresh.

Exit check: clean, dirty, untracked, renamed, detached HEAD, subdirectory, and non-Git folders render correctly.

### Step 15: Finish project UI

- Home recents.
- Project rail.
- Files and Changes navigator tabs.
- Unavailable/relink path.
- Project status footer.

Exit check: onboarding and reopen journeys meet the UX prototype.

## Stage D — Build Codex Chat end to end

### Step 16: Add objective/run persistence

- Implement objectives, execution locations, runs, turns, events, and checkpoints.
- Add run state transition functions in `packages/domain`.
- Reject invalid transitions at daemon boundary.

Exit check: state-machine unit tests and restart reconstruction pass.

### Step 17: Define provider-core contracts

- Add installation probe, capabilities, session union, models, Chat lifecycle, Terminal lifecycle, transcript, and event sink.
- Define normalized runtime events needed by Chat UI.
- Avoid methods with no Codex or Claude use case.

Exit check: fake provider drives one complete turn through daemon and persisted event replay.

### Step 18: Probe Codex

- Resolve configured path, then PATH.
- Read version and login health through supported CLI mechanisms.
- Discover models/capabilities when supported.
- Return repair guidance instead of raw spawn errors.

Exit check: missing, wrong path, outdated, logged-out, and healthy installations produce distinct states.

### Step 19: Implement Codex session lifecycle

- Create and resume provider-native sessions.
- Persist session identity only after it is observed/confirmed.
- Stop a turn safely.
- Convert native errors into stable Lazarus error codes.

Exit check: create, complete, restart/resume, stop, provider crash, and missing-history cases pass.

### Step 20: Normalize Codex events

- Map text, reasoning, tools, commands, file changes, approvals, plan, usage, and turn lifecycle.
- Assign daemon run sequence before commit/emit.
- Preserve enough provider metadata for diagnostics without leaking raw secrets.

Exit check: fixture transcripts/events replay deterministically into the same UI projection.

### Step 21: Implement durable turn acceptance

- Client creates request ID.
- Daemon transaction commits message and accepted turn.
- Response returns accepted turn ID.
- Provider launch happens after commit.
- Repeated request ID returns existing outcome.

Exit check: crash at every boundary produces no lost acknowledged message and no duplicate turn.

### Step 22: Build Chat UI

- Objective/run navigation.
- Transcript virtualization.
- Typed content blocks.
- Composer, stop, queued follow-up.
- Pending approval/question presentation.
- Replay/reconnect from last sequence.

Exit check: ten representative tasks remain responsive and readable after reload.

### Step 23: Enforce approvals

- Define supervised/trusted-workspace policies.
- Persist approval request/answer.
- Enforce in daemon, not UI.
- Fail pending provider handles as interrupted on daemon restart.

Exit check: bypass attempts through protocol and stale UI answers fail closed.

### Step 24: Link changes to activity

- Refresh Git status after tool/file-change boundaries.
- Store path/run/turn attribution when trustworthy.
- Open the exact diff from Chat card.

Exit check: change card resolves against the run's execution location, never the currently selected project path by accident.

## Stage E — Prove multi-provider design

### Step 25: Probe and configure Claude Code

Repeat the installation-state matrix without changing the shared provider contract to fit incidental CLI output.

Exit check: provider list and setup UI are capability-driven.

### Step 26: Implement Claude Chat lifecycle

- Create/resume/steer/stop.
- Persist Claude-native session metadata.
- Normalize approvals and runtime events.
- Map unsupported differences explicitly.

Exit check: the shared behavioral contract suite passes for Codex and Claude.

### Step 27: Remove provider leakage

- Search shared daemon/UI code for provider-ID branching.
- Keep branching in adapters, capability presentation, or intentional provider copy.
- Delete abstractions that neither provider uses.

Exit check: adding a fixture third provider requires a new adapter and registration, not Chat UI edits.

## Stage F — Add Terminal agents

### Step 28: Implement PTY manager

- Spawn under daemon with process groups/jobs.
- Track process identity and exit.
- Resize, input, signals, and bounded output buffer.
- Use binary stream frames.

Exit check: echo shell survives resize/load tests and cleans descendants.

### Step 29: Implement terminal action protocol

- Client input sequence.
- Daemon ordered application and acknowledgement.
- Reconnect with last acknowledgement.
- Output sequence and snapshot/gap recovery.

Exit check: forced disconnect test proves no duplicated acknowledged input.

### Step 30: Build xterm surface

- Fit, search, clipboard, web links, theme, focus, IME.
- Keep provider/worktree/reconnect metadata visible.
- Detach UI without deleting run.

Exit check: keyboard, paste, large output, Unicode, and zoom tests pass on all OSes.

### Step 31: Add Codex Terminal launch/resume

- Generate exact argv from run settings.
- Observe provider session identity.
- Persist and resume.
- Keep transcript durability separate from scrollback.

Exit check: close/reopen tab, desktop restart, and daemon restart scenarios report truthful outcomes.

### Step 32: Add Claude Terminal launch/resume

Implement provider-specific argv/session rules behind the same Terminal lifecycle contract.

Exit check: Codex and Claude Terminal contract suite passes.

## Stage G — Preserve intent and isolate work

### Step 33: Add Markdown artifacts

- Create `.lazarus` project metadata only after user creates the first artifact.
- Parse/preserve frontmatter.
- Atomic writes and file watcher.
- Source/preview editor with external-conflict handling.

Exit check: normal editors can round-trip files; unknown metadata survives Lazarus edits.

### Step 34: Build objective timeline

- Merge run events, checkpoints, approvals, artifact links, and change summaries by time.
- Add filters and stable deep links.
- Reconstruct from DB rather than separate timeline persistence.

Exit check: restart produces identical timeline ordering.

### Step 35: Implement worktree listing and binding

- Discover existing worktrees.
- Let user bind new runs to Local or Existing worktree.
- Make binding visible everywhere.

Exit check: diff/file reads always use the bound execution location.

### Step 36: Implement managed worktree creation

- Choose source branch and new branch.
- Validate names and existing checkouts.
- Create under configured Lazarus worktree root.
- Persist operation and binding.
- Run optional setup script with output stream.

Exit check: clean creation, setup failure, cancellation, and retry converge correctly.

### Step 37: Add carry-uncommitted-changes

- Detect dirty source.
- Explain exact carried content/limitations.
- Use a tested Git mechanism with pre/post fingerprints.
- Keep this flow explicit, never default.

Exit check: modified, staged, untracked, renamed, conflict, and ignored-file cases are characterized.

### Step 38: Implement safe managed-worktree deletion

- Verify Lazarus management record and Git worktree identity.
- Resolve absolute target within configured worktree root.
- Reject dirty/unmanaged/broad targets.
- Run teardown only after confirmation.
- Remove Git registration then filesystem path with recoverable reporting.

Exit check: adversarial deletion test corpus passes on every OS.

## Stage H — Harden and ship

### Step 39: Fault-injection pass

Inject process exit, socket loss, disk full, permission error, DB busy, corrupt runtime metadata, provider crash, and Git failure at lifecycle boundaries.

Exit check: state is truthful, accepted data survives, and recovery action is clear.

### Step 40: Performance pass

- Profile startup, event ingestion, transcript render, file tree, diff, terminal output.
- Virtualize only measured large lists.
- Bound buffers and caches.
- Add main-thread/event-loop stall diagnostics in development.

Exit check: targets in `PRODUCT.md` pass on baseline hardware.

### Step 41: Accessibility pass

- Keyboard map.
- Focus management.
- Screen-reader labels/announcements.
- Contrast, zoom, reduced motion.
- Terminal/diff font scaling.

Exit check: keyboard-only core journeys and automated accessibility checks pass.

### Step 42: Diagnostics and privacy pass

- Implement scrubber corpus.
- Build previewable export.
- Write operational runbooks.
- Keep telemetry disabled unless explicitly introduced and consented.

Exit check: seeded secrets/prompts/file content do not appear in bundle.

### Step 43: Packaging matrix

- Produce macOS, Windows, and Linux packages.
- Validate resources, daemon execution permissions, icons, protocol handlers if used, and uninstall behavior.
- Add signing/notarization in protected release CI.

Exit check: clean-machine install/launch/update/uninstall matrix passes.

### Step 44: Update and rollback

- Signed feed.
- Staged download.
- Apply on restart.
- Keep previous desktop/daemon.
- Backup DB before migration.
- Roll back executable on readiness failure.

Exit check: interrupted download, bad signature, failed migration, failed daemon readiness, and successful update tests pass.

### Step 45: Private alpha

- Recruit Codex and Claude users across target OSes.
- Observe onboarding and ten real tasks per surface/provider combination.
- Track recovery failures and confusing states before feature requests.

Exit check: alpha success metrics in `PRODUCT.md` are met or the release is held.

### Step 46: Public beta and v1 freeze

- Freeze protocol/database/artifact v1 compatibility rules.
- Publish provider support matrix and recovery docs.
- Complete security review and dependency remediation.
- Remove preview-only raw event/log surfaces.

Exit check: every v1 scenario in `README.md`, `UX-UI.md`, and `SECURITY-RELIABILITY.md` passes on each supported OS.

## What to defer when schedule slips

Cut in this order:

1. Native session fork.
2. Image attachments.
3. Carry-uncommitted-changes.
4. Artifact types beyond Note/Spec.
5. Multi-root projects.
6. Linux package variants beyond one format.

Do not cut renderer isolation, durable acknowledgement, approval enforcement, path containment, restart recovery, or destructive-operation guards.
