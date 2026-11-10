# Troubleshooting

Practical fixes for the failure modes you are most likely to hit while building, launching, and running Saple Bridge: sidecar staging problems, corrupt workspace state, terminal and provider issues, and Windows-specific quirks. For the normal first-run flow see [first-run.md](first-run.md); for what is written to disk and why see [security-and-privacy.md](security-and-privacy.md).

## Missing or mismatched saple-mcp sidecar

`npm run tauri:dev` and `npm run tauri:build` stage the sidecar through `scripts/prepare-sidecar.mjs`, which builds `../saple-mcp` with `cargo build --release --locked` and copies the binary into `src-tauri/binaries/saple-mcp-<target-triple>[.exe]`. Failures look like this:

| Error | Cause | Fix |
| --- | --- | --- |
| "the saple-mcp sibling repo was not found" | No `../saple-mcp` checkout next to this repo | Clone `saple-mcp` as a sibling (`SAPLE-ALL/saple-bridge` + `SAPLE-ALL/saple-mcp`) and check out the pinned commit |
| "saple-mcp checkout is at <sha> but the reviewed pin is <pin>" | The sibling checkout's `HEAD` does not match `SAPLE_MCP_PINNED_SHA` in `scripts/prepare-sidecar.mjs` | Either check out the pinned commit (`git -C ../saple-mcp checkout <pin>`), or, after reviewing the new commit, update the pin in the script and the `SAPLE_MCP_SHA` repository variable used by the release workflow |
| "SAPLE_MCP_PINNED_SHA is empty ... UNPINNED" | The pin constant was cleared | Local builds print a loud warning and continue; CI fails closed. Record a reviewed SHA before releasing |
| "`cargo build` for saple-mcp failed" or a stale-lockfile error | Sidecar build failure; builds use `--locked` so an out-of-date `Cargo.lock` fails deliberately | Fix the sidecar checkout (clean, update dependencies deliberately) |
| "could not parse host triple from rustc -vV" | Rust toolchain missing or broken | Install/stable Rust |

Notes:

- `SAPLE_MCP_SHA` (environment) overrides the in-script pin; CI sets it from a repository variable so release builds verify against the reviewed SHA even if the script constant lags.
- Cross-compilation: set `SAPLE_MCP_TARGET=<triple>` (or pass `--target`) consistently to both this script and `tauri build --target`.
- Each production build records the staged binary's SHA-256 into `build/v<version>/sidecar.SHA256SUMS`; compare it if you suspect a stale binary.

## Corrupt state files (.saple/*.json)

State loads are structured, never guessed. `load_state_file` returns one of:

| Outcome | Meaning | What you see |
| --- | --- | --- |
| `missing` | File does not exist; fresh project | Store initializes empty state freely |
| `loaded` | File read and (for JSON) parsed cleanly | Normal view |
| `corrupt` | JSON unparseable; original bytes were preserved at `<name>.corrupt-<timestamp>.bak` next to the file, and all writes to that path are blocked | A recovery banner (Kanban, Swarm, Agent sessions, Review) offering actions below |
| `locked` | Another live process holds the cross-process write sentinel for the file | Load is deferred; retry after the other instance closes |
| `ioError` | Unreadable file - permissions, or a UTF-16/32 byte-order mark ("re-save as UTF-8") | Error message with the reason |

Corruption is fail-closed: Bridge never treats unreadable bytes as empty state, because the next save would erase them. The recovery banner offers:

- **Retry** - you fixed the file externally; Bridge re-validates on-disk bytes and lifts the block if they parse.
- **Restore backup** - copies the most recent preserved `.bak` back over the file and re-validates.
- **Start empty** - explicit operator decision; clears the block, fresh state initializes on next save, and the preserved corrupt copy stays on disk.

A clean external repair also self-heals: any later load that parses cleanly clears the flag automatically.

## Terminal / PTY issues

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Provider CLI "command not found" inside a pane but works in your own terminal | The GUI-launched app inherits a shorter `PATH` than your shell | Add the CLI to a system-wide PATH location, or launch Bridge from a shell that has it. On macOS plain panes start login shells for this reason |
| Pane output stops responding | A hung child process | Close the pane; closing kills the whole process tree (Windows Job Object / Unix process group), not just the shell |
| Duplicate pane id error (`already_exists`) | Two spawn requests raced with the same id | Retry; the losing duplicate child was killed automatically |
| Garbled colors or prompt rendering | Terminal type mismatch | Panes advertise `TERM=xterm-256color`; avoid overriding `TERM` via custom env unless you know the value is right |

## Provider CLI not detected

1. Check Settings -> Diagnostics -> Provider CLIs. `available: false` means the binary did not resolve on `PATH` at probe time.
2. Remember the exceptions: OpenRouter and Grok have no version-probeable CLI, so their readiness rows report unavailable even when panes can launch them. Codex and Claude additionally show sign-in status from their own CLIs/configs.
3. After installing a CLI, restart Bridge so new `PATH` entries are visible to the app process.
4. Keychain rows in Diagnostics show whether the OS keychain backend itself works (probed with a throwaway entry); a failure there means key storage, not the CLI, is broken.

## Windows-specific notes

- **Paths with spaces.** Fully supported and part of the manual QA checklist, but if you script around the app, quote paths. Long paths are also exercised by QA; prefer keeping workspaces shallow if you hit tool-level limits.
- **Locked binaries during staging.** Windows cannot overwrite a running executable. If the app or an MCP client is running the staged sidecar during `prepare-sidecar.mjs`, identical binaries are skipped outright, and a changed binary is renamed aside (`*.stale-<timestamp>`) before the fresh copy lands. If you still see EBUSY/EPERM errors, close running Bridge instances and MCP clients using the old sidecar, then re-run `npm run prepare-sidecar`.
- **SmartScreen warning for unsigned installers.** Installers are not Authenticode-signed, so a downloaded installer triggers "Windows protected your PC". Click "More info" -> "Run anyway". The Tauri updater signature (used for in-app updates) is separate and does not remove this warning.
- **In-place updates** applied through the app do not re-trigger the full first-run experience.

## Logs and the diagnostics report

Durable evidence lives under Tauri's app log directory:

```text
%LOCALAPPDATA%\ai.saple.bridge\logs\   (Windows)
~/Library/Logs/ai.saple.bridge/        (macOS)
  saple-bridge.log       current app log
  saple-bridge.log.old   previous generation after rotation
  audit.log              privileged-action audit trail (+ .old)
```

The app log and audit log are size-capped (5 MB and 10 MB respectively) with a single rotated generation, append-only, and every line passes secret redaction before hitting disk.

Use **Settings -> Copy diagnostics report** to assemble a support bundle without touching these files by hand. It includes app identity/version, OS and architecture, the selected project path, live PTY session and watcher counts, the last 200 lines of the app log, and the last 50 audit entries plus a total count. Every line is re-redacted at copy time, so pasting the report externally will not leak API keys.
