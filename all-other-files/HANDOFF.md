# Improvement History

This document records completed and remaining improvement work for Saple Bridge. It is intentionally public-facing: avoid private session notes, machine-specific paths, secrets, or unpublished credentials.

## Completed Work

The following work has been completed and verified in prior development passes:

- Security and stability hardening for renderer-to-Rust command boundaries.
- Provider key storage cleanup so API keys use the shared OS keychain convention.
- Memory note correctness fixes for new-note creation, wikilink aliases, and code-block parsing.
- Swarm persistence fixes and handoff/mailbox UI wiring.
- Additional terminal provider support and terminal pane UX fixes.
- Atomic write and path-containment improvements for project state files.
- Test coverage for write queues, IDs, notifications, memory store behavior, git rename parsing, wikilink parsing, traversal checks, and injection checks.
- Review workspace staging and commit support.
- Terminal search.
- Command palette search across tasks and memory notes.
- Memory full-text search.
- Settings, terminal, and review component decomposition.
- CSS modularization into view-specific stylesheets.
- Desktop notifications for relevant agent and task events.
- Accessibility pass for dialogs, icon buttons, focus rings, and keyboard alternatives.
- First-run and empty-state polish.
- Resizable workspace panes.

## Current Verification Baseline

Use these commands before publishing meaningful changes:

```powershell
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri
cargo test
```

Manual verification still matters for desktop behavior that is hard to cover headlessly:

- Open a workspace with spaces in the path.
- Launch and close terminal panes.
- Save and delete a provider API key.
- Open existing `.saple/` state.
- Verify memory graph links and memory search.
- Exercise review staging, unstaging, and commit flow.
- Run a small swarm and confirm mailbox, handoff, completion, and failure states.
- Install and launch a production bundle on the target platform.

## Remaining Public Roadmap

These items are suitable follow-up work:

- Auto-updater integration for GitHub Releases.
- Signed release pipeline and update metadata generation.
- Broader end-to-end UI tests around critical desktop flows.
- More provider-specific diagnostics and setup guidance.
- Additional documentation for authoring swarm templates.

## Release Notes Guidance

When this repository starts publishing tagged releases, move this historical file toward concise release notes or replace it with a `CHANGELOG.md`.
