# Release approval environment

The release workflow (`.github/workflows/release.yml`) runs its jobs in the GitHub environment
`release`, with a concurrency group of the same name (`cancel-in-progress: false`) so only one
release builds at a time.

Environments cannot be created from source control. Configure it once, repo-side:

1. Repository **Settings > Environments > New environment** - name it exactly `release`.
2. Under **Required reviewers**, add the maintainer(s) who approve a release.
3. Optionally restrict deployment branches/tags to `v*` tag refs.

With that in place, every tag-driven release pauses for manual approval before any installer is
built or uploaded. Until the environment exists, the workflow's `environment: release` reference
is inert: releases run without an approval gate.

## Sidecar pin

The release workflow checks out `prabhash1889/saple-mcp` at the commit named by the
`SAPLE_MCP_SHA` repository variable (Settings > Secrets and variables > Actions > Variables).
`scripts/prepare-sidecar.mjs` verifies the same SHA locally before staging the sidecar; CI fails
closed while no pin is recorded. To rotate the pin, review the new saple-mcp commit, then update:

- the `SAPLE_MCP_SHA` repository variable,
- `SAPLE_MCP_PINNED_SHA` in `scripts/prepare-sidecar.mjs`.
