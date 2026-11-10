# Lazarus Security, Reliability, and Operations Plan

## Security posture

Lazarus runs powerful coding agents against real source code. The local-machine boundary is a security boundary even without cloud accounts.

## Authority table

| Operation | Renderer | Electron main | Daemon |
|---|---:|---:|---:|
| Render UI | Owns | No | No |
| Native folder picker | Requests | Owns | Receives validated selection |
| Read/write workspace files | No | No | Owns |
| Spawn provider/shell processes | No | No | Owns |
| PTY control | No | No | Owns |
| Git/worktree mutation | No | No | Owns |
| Desktop updater | No | Owns | No |
| Store operational DB | No | No | Owns |
| Open external URL | Requests | Validates/owns | No |
| Show native notification | Requests | Owns | No |

## Renderer isolation

- `contextIsolation: true`.
- `nodeIntegration: false`.
- Sandbox enabled where Electron compatibility permits.
- Preload imports only IPC contracts and Electron bridge APIs.
- No generic `invoke(channel, args)` bridge; expose named functions.
- Validate IPC input in main even when TypeScript types agree.
- Content Security Policy blocks inline script and unapproved network origins.
- Navigation and window-open handlers deny by default.
- External links allow only `https:` and explicit documentation destinations.

## Workspace path security

- Daemon canonicalizes workspace roots once and stores them.
- Every requested path is resolved and checked to remain under an approved root.
- Symlink traversal is checked at operation time for writes and destructive actions.
- Do not trust paths supplied by provider events; re-resolve them.
- Git commands use argument arrays, never shell-concatenated strings.
- Shell execution is reserved for explicit terminal or project setup scripts.

## Process execution

- Provider binaries are resolved to absolute paths.
- UI displays the exact executable and arguments before first launch.
- Environment variables are assembled from a reviewed allow/override model.
- Lazarus never logs environment values classified as secrets.
- Child processes run in process groups/jobs so stop and daemon shutdown can clean descendants.
- Setup/teardown scripts require explicit project trust.

## Permission modes

### Supervised (default)

- Reads inside workspace are allowed.
- Writes inside workspace require provider/runtime approval semantics when available.
- Commands that mutate Git history, delete files, access outside workspace, use network credentials, or request elevation require explicit Lazarus approval.

### Trusted workspace

- Allows routine writes and commands inside approved workspace roots.
- Still requires approval for privilege elevation, OS credential access, destructive actions outside managed worktrees, and changes to Lazarus security settings.

No unrestricted mode is exposed in v1 UI. Advanced users can use a plain terminal when they intentionally want direct control.

## Approval model

Approval request fields:

- stable ID and run/turn link;
- action kind;
- exact command/path/host where applicable;
- human explanation;
- risk level;
- proposed scope: once, this turn, or this run;
- expiry.

The daemon enforces the decision. The renderer only presents it. Expired, disconnected, or daemon-restarted requests resolve as denied/interrupted.

## Local transport security

- Bind daemon listeners to loopback only.
- Authenticate every connection with short-lived instance-bound token.
- Reject browser Origin values not belonging to the packaged renderer/dev origin.
- Cap frame size and subscription count.
- Apply per-connection request concurrency limits.
- Parse and validate before dispatch.
- Never put boot secrets in process arguments, logs, or `runtime.json`.

## Data protection

- Operational DB directory uses current-user permissions.
- Artifacts inherit project permissions because they are user-owned project files.
- Lazarus stores no provider password/API token in v1; it uses provider CLI login state.
- Diagnostic exports are scrubbed and previewable.
- Clipboard contents are never logged.
- Terminal output and prompts are excluded from telemetry by default.

## Destructive action rules

Before deletion or irreversible Git operations:

1. Resolve the exact canonical target.
2. Prove it is inside the intended managed scope.
3. Check dirty/untracked state.
4. Show the user what will be removed.
5. Prefer recoverable behavior where practical.
6. Record the outcome without sensitive content.

Lazarus v1 does not expose reset-hard, clean, force-push, branch deletion, or arbitrary workspace deletion through product UI.

## Reliability model

### Acknowledged work

A Chat message is acknowledged only after it is durably committed. An artifact save is successful only after atomic rename. A worktree creation is successful only after Git reports the worktree and its metadata is persisted.

### Single writer

The daemon is the only SQLite writer and serializes domain mutations. Renderer windows may be multiple readers/clients, never independent persistence owners.

### Crash recovery

Daemon startup:

1. acquire a single-instance lock;
2. validate database integrity and migration state;
3. reconcile runs left in starting/running/stopping;
4. probe recorded child-process identities;
5. mark lost processes interrupted;
6. validate worktree bindings;
7. start listener and atomically publish readiness.

### Backpressure

- Chat events are small and persisted in order.
- Terminal output uses bounded buffers; slow clients receive a gap marker and fresh screen snapshot rather than unbounded memory growth.
- File/Git watchers debounce and coalesce by execution location.
- A provider flood cannot starve terminal input or approval traffic.

## Observability

Every process writes structured logs with:

- timestamp, level, process, version;
- daemon instance/connection/request/run/turn IDs when relevant;
- stable event code;
- scrubbed error category and stack in development.

Never log prompt bodies, assistant text, file contents, terminal bytes, tokens, or full environment values by default.

Metrics remain local in v1:

- startup/readiness duration;
- request latency/error counts;
- stream reconnects/gaps;
- provider launch/turn outcomes;
- database migration duration;
- dropped terminal output bytes;
- event-loop stall samples.

## Diagnostics bundle

User-reviewed ZIP contains:

- version/platform manifest;
- daemon health and process identity;
- scrubbed recent logs;
- database schema version and integrity result, not table contents;
- provider executable paths/versions, not credentials;
- workspace availability and Git version, not source paths unless opted in;
- crash metadata.

## Update strategy

### Preview/alpha

- Manual downloadable builds.
- Desktop and daemon versions are coupled.
- Database backup before every migration.

### Beta/v1

- Signed/notarized installers.
- Signed update feed.
- Staged update download, apply on restart.
- Keep previous desktop/daemon version until new version passes readiness.
- Roll back executable automatically on failed readiness; database rollback follows migration backup rules.

## Security test gates

- Renderer cannot import Node built-ins.
- Preload exposes only reviewed named methods.
- Local daemon rejects missing, expired, wrong-instance, and wrong-origin connections.
- Path traversal and symlink-escape test corpus passes on all OSes.
- Command arguments with quotes/metacharacters are passed literally.
- Destructive worktree deletion rejects unmanaged, dirty, root, home, and workspace-root targets.
- Log scrubber corpus contains provider tokens, common API keys, paths, emails, and prompt-like text.
- Dependency and secret scans run in CI.

## Operational runbooks required before beta

1. Daemon will not start.
2. Provider CLI missing or logged out.
3. Database migration failed.
4. Terminal agent cannot resume.
5. Worktree setup failed or is stuck.
6. Renderer cannot authenticate to daemon.
7. Update downloaded but readiness failed.
8. Diagnostics export and privacy review.
