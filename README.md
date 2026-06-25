# Saple Bridge

Saple Bridge is a local-first agentic development environment for opening a repo, running shell-backed coding agents, tracking task work, maintaining markdown project memory, and reviewing agent output without leaving the workspace.

The app is Windows-first but cross-platform: it builds and runs on Windows and macOS (11+). It is built with Tauri 2, React, TypeScript, Vite, Zustand, xterm.js, and Rust commands for filesystem, PTY, keychain, and memory operations.

## Development Commands

```powershell
npm install
npm run dev
npm run typecheck
npm run build
npm run tauri:dev
npm run tauri:build
```

Rust checks and tests run from the Tauri crate:

```powershell
cd src-tauri
cargo test
```

## Workspace Data

Saple Bridge stores project-local state under `.saple/`:

```text
.saple/
  config.json
  tasks.json
  providers.json
  agents/
    sessions.json
    presets.json
    prompts/
    logs/
    transcripts/
  swarm/
    state.json
    templates.json
    mailbox/
    handoffs/
  memory/
  review/
  snapshots/
    memory/
```

Current implemented storage includes task state in `.saple/tasks.json`, markdown memory files in `.saple/memory`, memory snapshots in `.saple/snapshots`, and swarm state in `.saple/swarm/state.json`.

## Providers

Shared frontend types model these providers:

- Codex CLI
- Claude Code
- Gemini CLI
- OpenCode
- Custom

The current PTY launcher can directly start shell sessions plus Codex, Claude, and OpenCode. Provider readiness diagnostics and profile-aware launches are planned in later phases.

## Platform Assumptions

- Terminal panes are backed by `portable-pty`.
- The default shell is PowerShell (`powershell.exe`) on Windows and the user's login shell (`$SHELL`, e.g. `zsh`) on macOS/Unix; plain terminals start as login shells so `PATH` matches the OS terminal. `TERM`/`COLORTERM` are set so curses programs render.
- API keys are stored through the OS keychain via the Rust `keyring` integration — Windows Credential Manager on Windows, the login Keychain on macOS.
- Packaging and QA target Windows first (including paths with spaces). macOS builds produce a `.dmg` and are ad-hoc signed in CI (`APPLE_SIGNING_IDENTITY` = `-`).

## Release Checklist

Before shipping a release build:

### Verification

```powershell
# TypeScript checks
npm run typecheck

# Production build
npm run build

# Rust tests
cd src-tauri && cargo test && cd ..

# Tauri production bundle
npm run tauri:build
```

### Smoke Tests (Manual)

Test these scenarios on the target Windows machine:

| Test | Pass/Fail |
|------|-----------|
| Open workspace with spaces in path | |
| Open workspace with long path (>200 chars) | |
| Create terminal pane | |
| Provider CLI missing shows clear error | |
| API key saved to Credential Manager | |
| Existing `.mcp.json` preserved on workspace open | |
| Existing `.bridgememory` directory detected | |
| App restart recovers agent sessions (marks dead as stopped) | |
| Install/uninstall/reinstall cleanly | |

### Windows Installer QA

1. Run `npm run tauri:build`.
2. Locate the installer in `src-tauri/target/release/bundle/`.
3. Run the installer. Verify:
   - App name and publisher appear correctly.
   - Icon is correct in Add/Remove Programs.
4. Launch the installed app.
   - Window title reads "Saple Bridge".
   - Default size is 1280x820.
   - Minimum size is 980x680.
5. Open a workspace folder.
   - `.saple/` directory is created.
   - `.saple/config.json` is written.
6. Verify Credential Manager access works for API keys.

### Branding Checks

- [ ] Window title is "Saple Bridge".
- [ ] Product name is "Saple Bridge".
- [ ] Identifier is `ai.saple.bridge`.
- [ ] App icon is the Saple Bridge mark (not default Tauri icon).
- [ ] `public/` has no `tauri.svg` or `vite.svg` default artwork.
- [ ] index.html has Saple Bridge title and favicon.
- [ ] Sidebar shows Saple Bridge logo.
