# Saple Bridge

Saple Bridge is a local-first desktop workspace for running coding agents against a repository. It combines terminal panes, task tracking, markdown project memory, swarm coordination, and review tools in one Tauri app.

The app is built with Tauri 2, React 19, TypeScript, Vite, Zustand, xterm.js, and Rust. It targets Windows first and also supports macOS 11+.

## Features

- Open a local project and keep Saple Bridge state inside that project.
- Run shell-backed terminal panes for agent CLIs and plain shell sessions.
- Track work on a Kanban board stored as JSON.
- Maintain markdown memory notes with wikilink graph support.
- Coordinate multi-agent swarms with mailboxes, handoffs, and templates.
- Review git changes, stage files, and commit from the review workspace.
- Store provider API keys in the OS keychain instead of project files.
- Install MCP config files that point external clients at the bundled `saple-mcp` sidecar.
- Update itself in place on Windows: Settings -> Diagnostics -> App Updates checks the signed release feed, downloads, and restarts into the new version.

## Requirements

- Node.js 20 or newer
- npm
- Rust stable toolchain
- A sibling checkout of `saple-mcp` at `../saple-mcp` when running `tauri dev` or building release bundles
- Windows 10/11 or macOS 11+

The frontend can run by itself with Vite, but the full desktop app needs Tauri and the Rust toolchain.

## Getting Started

```powershell
npm install
npm run typecheck
npm test
npm run build
```

Run the frontend-only dev server:

```powershell
npm run dev
```

Run the desktop app in development mode:

```powershell
npm run tauri:dev
```

Build a production bundle:

```powershell
npm run tauri:build
```

`npm run tauri:dev` and `npm run tauri:build` stage the `saple-mcp` sidecar automatically through `scripts/prepare-sidecar.mjs`.

## Useful Commands

```powershell
npm run typecheck        # TypeScript check
npm test                 # Vitest suite
npm run build            # TypeScript + Vite production build
npm run tauri:dev        # Tauri desktop dev app
npm run tauri:build      # Tauri production bundle (local QA; auto-bumps patch version)
npm run prepare-sidecar  # Build and stage ../saple-mcp manually
npm run release          # Cut a release: bump, commit, tag, push (CI builds and signs)
```

Rust checks and tests:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri
cargo test
```

## Repository Layout

```text
.
  src/                    React frontend
  src/components/         App views and shared UI
  src/stores/             Zustand stores
  src/styles/             CSS modules and theme tokens
  src-tauri/              Tauri app, Rust commands, packaging config
  scripts/                Build and release helper scripts
  smoke-test-workspace/   Small fixture workspace for manual QA
```

## Workspace Data

Saple Bridge writes project-local state under `.saple/` in the opened workspace:

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

Generated MCP client files such as `.mcp.json` and `mcp_config.json` may also be written into a workspace. They contain local absolute paths and should normally stay uncommitted.

## Security Model

- Project file access goes through Rust commands that validate path containment.
- PTY processes are owned by the Tauri backend.
- Provider API keys are stored through the OS keychain under the Saple Bridge account.
- The renderer should not persist secrets in JSON, localStorage, or markdown.
- `.saple/` is local workspace state and is ignored by this repository.

## Sidecar MCP Server

Saple Bridge expects the standalone `saple-mcp` project to live next to this repository:

```text
SAPLE-ALL/
  saple-bridge/
  saple-mcp/
```

The `prepare-sidecar` script builds that sibling project and copies the binary into `src-tauri/binaries/` with the target triple suffix expected by Tauri external binaries.

For cross-compilation, set `SAPLE_MCP_TARGET=<target-triple>` or pass `--target <target-triple>` consistently to both the sidecar staging script and the Tauri build.

## Manual Smoke Test

Open `smoke-test-workspace/` in the desktop app and confirm that tasks, memory notes, review records, agent sessions, and swarm state load. See [smoke-test-workspace/README.md](smoke-test-workspace/README.md) for the checklist.

## Releases and Auto-Update

Releases are tag-driven and built in CI. Windows users get in-app updates; macOS is manual install only for now.

How it works:

1. `npm run release` (or `npm run release minor|major|x.y.z`) bumps the version in `tauri.conf.json`, `package.json`, and `Cargo.toml`, commits, tags `v<version>`, and pushes.
2. The tag push triggers `.github/workflows/release.yml`, which checks out the sibling `saple-mcp` repo, builds the bundles, signs the updater artifacts, and creates a **draft** GitHub release with the installers and `latest.json`.
3. Review the draft on GitHub and publish it. Publishing is what makes the update visible to installed apps: the updater endpoint points at `releases/latest/download/latest.json`, and drafts are not "latest".
4. Installed apps check the feed from Settings -> Diagnostics -> App Updates, verify the signature against the public key baked into the app, download, install, and restart.

Version rules:

- The release version is whatever `npm run release` commits and tags. CI builds exactly that version.
- Local `npm run tauri:build` auto-bumps the patch version for throwaway QA builds; those builds never reach users and do not sign updater artifacts.

Release infrastructure (one-time setup, already done):

- Updater signing keypair generated with `npx tauri signer generate`. The public key lives in `src-tauri/tauri.release.conf.json`; the private key and its password must stay out of the repo. Losing them means installed apps can never be updated again, so keep backups.
- GitHub Actions secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `SAPLE_MCP_TOKEN` (fine-grained PAT with read access to the private `saple-mcp` repo).
- `src-tauri/tauri.release.conf.json` is a release-only config overlay: it adds `createUpdaterArtifacts` and the updater feed on top of `tauri.conf.json`, so local builds stay signing-free.

Known limitation: installers are not Authenticode-signed, so Windows SmartScreen shows a "Windows protected your PC" warning on first run of a downloaded installer. Users click "More info" -> "Run anyway". Removing the warning requires a Windows code-signing certificate (or Azure Trusted Signing); the Tauri updater signature is a separate mechanism and does not affect SmartScreen. In-place updates applied through the app do not re-trigger the full first-run experience.

## Release Checklist

Before cutting a release:

```powershell
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri
cargo test
cd ..
npm run release
```

Then watch the Release workflow in GitHub Actions, verify the draft release has the installer, its `.sig`, and `latest.json`, and publish it.

Manual checks on the target platform:

| Check | Result |
| --- | --- |
| Open a workspace whose path contains spaces | |
| Open a workspace with a long path | |
| Create and close terminal panes | |
| Missing provider CLI shows a clear diagnostic | |
| API key save/delete uses the OS keychain | |
| Existing `.mcp.json` is preserved when appropriate | |
| Existing `.bridgememory` directory is detected | |
| App restart recovers or stops prior agent sessions correctly | |
| Installer installs, launches, uninstalls, and reinstalls cleanly | |

## Public Repository Notes

No license file is currently included. Until a license is added, the code is public source but not open source under a standard reuse license.
