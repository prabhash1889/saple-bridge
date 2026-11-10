# First Launch

This document walks through what happens the first time you open Saple Bridge and open a workspace: which folders and files are created under `.saple/`, how the app detects installed provider CLIs, where API keys go, and what the Settings -> Diagnostics report tells you. For problems during setup see [troubleshooting.md](troubleshooting.md); for the trust model behind these steps see [security-and-privacy.md](security-and-privacy.md).

## What happens on very first launch

1. The app starts with no workspace selected. It shows an empty state that asks you to open a folder.
2. Clicking **Open folder** opens a native directory dialog. Only a folder picked through this dialog (or restored from your recents, validated against the filesystem) becomes a trusted project root on the Rust side. A path merely typed or passed around in the UI is never trusted.
3. Once you pick a folder, Bridge registers it as an approved root, creates the `.saple/` workspace layout inside it (see below), and loads tasks, memory, agents, and swarm views from whatever already exists - on a truly fresh repo, all of them start empty.
4. Provider panes and Settings work immediately; provider readiness checks run against the CLIs found on your `PATH`. No account, sign-in, or network step exists.

Nothing is written outside the folder you opened except OS-standard app data: logs under `%LOCALAPPDATA%\ai.saple.bridge\logs` (Windows), theme preferences in localStorage, and API keys in the OS keychain.

## Opening a workspace and approved roots

The Rust backend keeps a registry of approved project roots (`project_roots.rs`). A root enters that registry only two ways:

| Entry path | How it works |
| --- | --- |
| Native directory selection | `select_directory` (lib.rs) shows the OS dialog and registers the chosen, canonicalized directory |
| Validated restoration | A recent project from persisted state is re-registered only if the directory still exists and is readable |

Every privileged command (file reads/writes, PTY spawns, diagnostics, state loading) fails closed with a `root_not_approved` error unless its project path resolves inside an approved root. Closing a workspace releases its reference; the root stops being trusted when its last open instance closes.

## What gets created under .saple/

On first project open, `ensure_workspace_dirs` (`src-tauri/src/project.rs`) creates:

```text
.saple/
  config.json              (workspace settings, via ensure_project_config)
  agents/
    logs/
    prompts/
    transcripts/
  swarm/
    mailbox/
    handoffs/
    context/
  review/
  memory/                  (layout depends on the configured memory mode)
```

Other files appear lazily as you use features:

- `.saple/tasks.json` - first time you add a Kanban task
- `.saple/providers.json` - first time provider preferences are saved
- `.saple/agents/sessions.json`, `presets.json` - first agent session activity
- `.saple/swarm/state.json`, `templates.json` - first swarm run or template save
- `.mcp.json` / `mcp_config.json` - generated MCP client configs pointing external tools at the bundled sidecar (release builds also repair stale sidecar paths on every project open)

All of this stays inside the project directory. See README.md ("Workspace Data") for the full layout.

## Provider readiness

Bridge detects installed provider CLIs without launching them interactively. The single source of truth is the provider table in `src-tauri/src/providers.rs`; detection and pane launch share it so they can never disagree.

- `check_provider_cli` resolves each CLI on `PATH` (handling Windows `PATHEXT`) and runs `<cli> --version` with a 5 second timeout. `available` reflects PATH resolution; `version` is best-effort.
- Providers probed for a version: codex, claude, gemini, opencode, cursor (`cursor-agent`), droid, copilot (`gh copilot`), pi.
- OpenRouter and Grok have no dedicated CLI to probe; their readiness rows always report not available from the version probe even though panes can launch them.
- `check_provider_signin` additionally detects subscription/OAuth sign-in for codex (`codex login status`) and Claude Code (its `.credentials.json`), which drives the "Signed in" vs "No key" distinction in the UI.

A missing CLI is not an error; the provider row simply shows unavailable until you install the CLI.

## API key entry

API keys are entered in Settings and stored only in the OS keychain:

- Storage account: `saple_bridge_user`. Service name per provider: `saple_provider_<provider>_api_key`.
- There is intentionally no IPC command that returns a stored key. The renderer can ask `has_api_key` (a boolean) or use "test connection", which confirms presence internally in Rust; the raw key never crosses back to the webview.
- When a provider pane spawns, Rust reads the key from the keychain and injects it as the vendor's environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` plus `GOOGLE_API_KEY`, and so on). Renderer-supplied values for those variables are refused.
- Deleting a key removes the keychain entry.

## Settings -> Diagnostics

The Diagnostics tab runs `run_diagnostics` and reports:

| Field | Meaning |
| --- | --- |
| OS | Desktop platform detected at build time |
| Shell | Whether PowerShell/CMD (Windows) or bash/sh (macOS) respond to a probe |
| Workspace write | Whether a test file could be written and removed in the open project |
| Git available | Whether `git status --porcelain` succeeds in the project |
| Keychains | Per-provider keychain backend status, probed with a throwaway entry (never your real keys) |
| Provider CLIs | Per-provider install status and version, same probe the readiness UI uses |
| MCP config | Whether `.mcp.json` / `mcp_config.json` exist and configure the `saple-memory` server |

Every probe is time-bounded so one hung CLI cannot stall the report. The same screen hosts App Updates (Windows) and the Copy diagnostics report action described in [troubleshooting.md](troubleshooting.md).
