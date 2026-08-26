# Security and Privacy

What Saple Bridge protects, what it deliberately does not do, and which surfaces carry risk when you enable them. This page states the model as implemented; for day-to-day setup see [first-run.md](first-run.md) and [troubleshooting.md](troubleshooting.md).

## Privacy posture

Saple Bridge is local-first. There is no server, no account, and no telemetry. All workspace state lives under `.saple/` in the project you open.

What leaves your machine:

| Traffic | When | Destination |
| --- | --- | --- |
| Provider API calls | Only when a provider CLI (codex, claude, gemini, ...) runs in a pane or headless agent session and talks to its vendor | The LLM vendor whose CLI you launched. Bridge itself does not proxy or observe this traffic beyond the terminal stream it displays |
| Release update feed check | Windows only, when you use Settings -> Diagnostics -> App Updates | GitHub releases (`releases/latest/download/latest.json`). Downloads are signature-verified against the public key baked into the app |

Bridge makes no other outbound network connections. The June control endpoint and browser automation described below are loopback-only surfaces: they listen locally and never dial out.

## Credentials

- API keys live **only** in the OS keychain, account `saple_bridge_user`, with per-provider service names `saple_provider_<provider>_api_key`. They are never written to JSON, localStorage, markdown, or component state.
- The renderer has no command that reads a key back. `has_api_key` returns a boolean; "test connection" confirms presence inside Rust without returning the secret.
- Keychain service names that cross from the renderer to Rust are validated against the documented namespace; anything outside `saple_provider_<id>_api_key` is rejected.
- When a pane spawns, Rust reads the key from the keychain and constructs the provider environment variables itself (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GITHUB_TOKEN`, etc.). Renderer-supplied values for any provider credential variable are refused, compared case-insensitively, so a pane can never run with attacker-chosen credentials.
- Diagnostics probes the keychain backend with a throwaway entry; your real keys are never touched by diagnostics.
- A legacy pre-namespaced OpenAI slot (`openai_api_key`) is still honored for codex only, injected after the namespaced value so existing setups keep working.

## Approved-root trust boundary

The renderer runs untrusted web content in principle, so its strings are never trusted as authority:

- Privileged commands operate only on roots registered in a Rust-side registry (`project_roots.rs`). Roots enter it via a native directory dialog or validated restoration of an accessible recent project - nothing else. Every privileged command fails closed with `root_not_approved` otherwise.
- Relative paths from the renderer are resolved through containment checks: absolute paths, `..` traversal, and drive/prefix components are rejected; symlinked targets are canonicalized before containment is confirmed; not-yet-existing targets are proven contained via their nearest existing ancestor before any directory creation.
- Writes into `.git/**` are blocked at the editor layer (case-insensitively on Windows); git internals are owned by intentional git commands only.
- Destructive operations refuse to target the workspace root itself (a delete of `.` would trash the whole project).
- One deliberate exception: a terminal pane may run a shell in the home directory with no project open. Only the gates that need that mode use the home-inclusive check; everything else uses the strict approved-root gate.

## Agent commands require human approval

Agents can propose shell commands, but execution is gated:

- Acceptance commands produced during a swarm run are hashed (SHA-256 over the exact command text) and held in an `awaiting_approval` state until a human confirms in a dialog that shows exactly what will run, where, and on whose behalf. An unapproved command is never sent to the backend at all - it parks until decided, and denial leaves the run parked.
- Approvals are scoped to the swarm run that earned them: they die when the run ends, and a state file whose approvals point at another swarm id loads with none.
- Reviewer rejection feedback is routed back into the relaunched agent's prompt context as prose; it is never executed as a shell command, so rejection text cannot reach `write_pty` as input to run. Rework loops past the attempt budget escalate back to explicit human approval.

## June control plane

When explicitly enabled, Bridge exposes a localhost-only, token-authed HTTP endpoint (`june_control.rs`) that lets a separate app ("June") drive the bridge through three operations: `capabilities`, `command`, and `observe`.

How it is locked down:

- Off by default. Enabled by a flag file (`june-control.enabled` under `%APPDATA%\ai.saple.bridge`); changes apply on next launch because the server binds once at startup.
- Binds an ephemeral port on `127.0.0.1` only. Discovery happens through a record file next to the flag containing the endpoint and a per-process bearer token (a fresh UUID each launch). On Windows the record's DACL is replaced with owner-full-control so other local users cannot read the token; the attempt is best-effort and token auth still guards the endpoint.
- Token comparison is constant-time. Requests above a small concurrency cap are shed with 503 rather than spawning unbounded threads.
- Actions are allowlisted (`spawn_agents`, `assign_task`, `write_terminal`, `close_terminal`, `open_browser`, `close_browser`, `get_swarm_status`) with idempotency by `request_id`; reusing an id with a different payload is rejected.
- Terminal actions are scope-enforced in Rust: June may only write to or close panes it spawned through this endpoint, never the operator's own panes.

Risks and operator guidance:

| Risk | Guidance |
| --- | --- |
| Any local process that reads the discovery record gets full bridge control | Only enable June control while you actively use it; the record is removed on clean shutdown and stale records are detected by dead PID |
| A local process could race the ephemeral port | Loopback binding plus bearer token keeps this low-risk; do not weaken either |
| Commands execute through the same store actions as the UI | Treat "enable June control" as granting a local app the ability to spawn agents and write terminals; disable when idle |

## Browser automation (CDP exposure)

Separately opt-in and Windows-only (`browser.rs`): enabling agent browser control launches WebView2 with `--remote-debugging-port`, exposing a loopback Chrome DevTools Protocol endpoint that CDP clients (Playwright, Puppeteer, CDP MCP servers) can attach to.

| Risk | Mitigation in code | Residual risk / guidance |
| --- | --- | --- |
| CDP grants full control of every webview in the process, including the app shell that holds the Tauri API | Off by default; explicit flag file required; takes effect after restart | Enable only when actively automating; disable afterward |
| Drive-by CDP clients finding a well-known port | Port is a random free loopback port chosen per launch, never 9222, and never persisted | Any local process that scans loopback ports could still find it; keep the machine single-user while enabled |
| Embedded tabs loading local or privileged content | Tab URLs are restricted to `http`/`https`; `file://`, `javascript:`, and custom schemes are refused | Pages you load in embedded tabs are still remote web content; treat them accordingly |

macOS uses WKWebView, which has no equivalent mechanism, so the feature is compiled out there.

## Audit log and log redaction

Two durable evidence files live next to each other under the OS app log directory (`%LOCALAPPDATA%\ai.saple.bridge\logs` on Windows):

- **Audit log** (`audit.log`): one JSON line per privileged action - shell executions, PTY writes/spawns, destructive file operations - with timestamp, source, command, cwd, exit code or stop reason, and duration. Append-only, rotated at 10 MB instead of truncated.
- **App log** (`saple-bridge.log`): size-capped error/info logging, including renderer-reported errors via a dedicated IPC command.

Redaction contract: every line written to either file passes secret redaction first - known token shapes (`sk-proj-`, `ghp_`, AWS `AKIA`, Google `AIza`, ...), `Bearer ...` header values, and key/value pairs whose key names a secret (`api_key=`, `"token":`, ...) collapse to `[REDACTED]` markers while keeping the prefix so logs still say *what kind* of token appeared. Absolute user paths are intentionally kept because they are needed to diagnose anything. Audit error strings are additionally bounded to 512 characters. The Copy diagnostics report action re-redacts every line again at copy time, defense in depth against a future writer regression.
