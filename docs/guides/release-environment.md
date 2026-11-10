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

## Artifact verification

Every release leg re-downloads its own installers from the draft release and then publishes
three kinds of verification assets alongside them:

| Asset | What it proves |
| --- | --- |
| `SHA256SUMS-windows.txt` / `-macos.txt` / `-linux.txt` | SHA-256 of every installer, computed from the uploaded bytes (not the build directory) |
| `build-provenance-<os>.intoto.jsonl` | SLSA v1 provenance attestation, keyless-signed via Sigstore; verify with `gh attestation verify <artifact> -R prabhash1889/saple-bridge` |

Users can check a download with `sha256sum -c SHA256SUMS-<os>.txt`; anyone can verify the
provenance with `gh attestation verify`. The updater signature (`latest.json` + `.sig`
files) remains the primary integrity channel for auto-updates; these assets cover manual
downloads.
