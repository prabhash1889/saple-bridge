# Security Audit Report

**Agent:** Security Auditor (`auditor`)
**Scope:** Working-tree git diff (P3 structured-outcome feature)
**Date:** 2026-07-14

## Files reviewed

- `src/lib/controlPlane.ts` (+58)
- `src/stores/swarmStore.ts` (+32)
- `src/components/swarm/SwarmWorkspace.tsx` (+36)
- `src/components/swarm/SwarmAgentCard.tsx` (+76)

## Verdict

**No blocking security issues.** The change is defensively written. Agents may write
`.saple/swarm/outcomes/<id>.json`; Bridge reads, sanitizes, stores, and displays it. All three
trust boundaries hold.

### Verified safe

- **Path traversal — SAFE.** `agentId`/`runId` are interpolated into file paths, but every read
  routes through Rust `get_project_file_path` (`src-tauri/src/project.rs:8`), which rejects
  absolute paths, `..`, root/prefix components, and canonicalizes to prove containment (including
  symlinked ancestors). Even a hostile id cannot escape the workspace.
- **Untrusted-input parsing — SAFE.** `parseAgentOutcome` (`controlPlane.ts`) is an allowlist:
  it type-checks each known field, filters arrays element-by-element to strings, and drops
  everything else. Malformed/partial/garbage input degrades to `null` (marker-only fallback).
- **Rendering — SAFE.** The agent-written `summary` renders as `{outcome.summary}` in
  `SwarmAgentCard.tsx`, using React's default text escaping. No `dangerouslySetInnerHTML`, no
  markdown pipeline for the outcome fields. No XSS.
- **No hardcoded credentials / secrets** in the diff.
- **Best-effort isolation.** Outcome reads/writes are wrapped in try/catch and swallow errors,
  so a bad outcome file cannot break agent completion or the poll loop.

## Findings (non-blocking)

### LOW-1 — Unbounded agent-controlled strings (resource / UI)
`parseAgentOutcome` sanitizes *types* but not *size*. A runaway or hostile agent can write a
multi-MB `summary` or a huge `changedFiles`/`decisions` array; it is then stored in
`artifacts.json` and rendered on the card each poll tick. Impact is limited to memory/UI jank
(no injection), so severity is low.
**Suggested fix:** cap `summary` length (e.g. slice to ~2 KB) and array lengths (e.g. first 200)
inside `parseAgentOutcome`.

### LOW-2 — Full `artifacts.json` re-parsed per agent per poll (efficiency, not security)
`readRunOutcome` reads and `JSON.parse`s the entire `artifacts.json` once **per agent, per poll
tick** in `SwarmWorkspace`'s `Promise.all`. With N agents this is N full-file parses each interval.
Not a vulnerability; flagging for robustness/scalability. Consider reading+parsing once per tick
and resolving all agents against the in-memory array.

## Project-standards check

- Frontend project writes go through the queued/Rust-owned helpers; secrets stay out of JSON and
  component state. Consistent with `CLAUDE.md` boundaries. ✔
- No new dependencies introduced. ✔

---
*Findings are advisory. LOW-1 is the only item worth a small follow-up commit; nothing here blocks merge.*
