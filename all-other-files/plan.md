# Public Roadmap

This file tracks high-level Saple Bridge work that is useful to contributors and public readers. Internal audit notes, private handoff text, and machine-specific instructions should not be added here.

## Status

Saple Bridge is a working local-first desktop app with:

- Tauri desktop packaging.
- React workspace UI.
- Native PTY-backed terminals.
- Kanban task state.
- Markdown memory and wikilink graph support.
- Swarm coordination state.
- Review, staging, and commit tools.
- OS keychain integration for provider credentials.
- Bundled `saple-mcp` sidecar support.

## Short-Term Priorities

1. Keep release builds reproducible on Windows and macOS.
2. Expand automated coverage for desktop flows that currently rely on manual smoke tests.
3. Improve provider diagnostics and setup instructions.
4. Document swarm templates, memory conventions, and review workflows in more depth.
5. Add an updater and release signing flow once repository hosting and signing decisions are final.

## Verification Standard

For normal code changes, run the checks that match the changed surface area:

```powershell
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cd src-tauri
cargo test
```

For release candidates, also run the manual smoke test in `smoke-test-workspace/` and install the generated bundle on the target platform.

## Documentation Standard

- Keep public docs accurate and reproducible.
- Do not include secrets, personal access tokens, private issue links, or machine-specific absolute paths.
- Prefer commands that exist in `package.json`.
- If a workflow depends on the sibling `../saple-mcp` repository, state that dependency clearly.
- Keep old implementation notes out of the README; move lasting decisions into dedicated docs when needed.
