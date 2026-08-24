# Saple Bridge - Explainer & Interview Prep

A single reference for answering "What is it? How does it work? How is it built?" - written so every claim is defensible against the real code. Interviewers can and will open the app and ask you to trace a feature end to end. This doc is ordered from the 30-second pitch down to line-level detail so you can go as deep as they push.

---

## 1. The 30-second pitch

**Saple Bridge is a local-first desktop workspace for AI-assisted software development.** It puts the tools you use to drive coding agents - terminals, a task board, a markdown knowledge base, multi-agent "swarm" coordination, and a code-review queue - into one native app that reads and writes plain files inside your project. No server, no cloud account, no vendor lock-in: your data is just files on your disk.

It ships as a native desktop app for **Windows (primary) and macOS 11+**, and it is **published on the Microsoft Store**.

It is one app in a larger ecosystem I built - **Saple Bridge, ClearShot, Eve, and June** - where June is an orchestrator that can drive Bridge through a small local control protocol.

---

## 2. What problem it solves

Working with AI coding agents (Claude Code, etc.) means juggling: several terminal sessions, notes/memory the agent should remember, a task list, and a review step before you trust the diff. Normally that is scattered across a terminal, a notes app, a Kanban SaaS, and your editor.

Saple Bridge unifies those into **"rooms"** in one window, and - critically - it keeps everything as **local files inside your project** (`.saple/` folder). That means:

- **Local-first / private:** nothing leaves your machine. Secrets go in the OS keychain, not a config file.
- **Agent-friendly:** because state is plain JSON and markdown, an MCP server or an agent can read and write the same files the UI does, and the UI live-reloads.
- **Portable:** delete the app, your work (`.saple/`) is still there in the repo.

---

## 3. The tech stack (and why)

| Layer | Tech | Why this choice |
| --- | --- | --- |
| Shell / native | **Tauri 2** (Rust) | Native, small binary, uses the OS webview instead of bundling Chromium (unlike Electron). Rust gives a safe, fast backend for filesystem/PTY/process work. |
| UI | **React 19 + TypeScript** | Component model for the rooms; TS for safety across a large surface. |
| Build | **Vite** | Fast dev server + production bundling. |
| State | **Zustand** | Small, unopinionated store; one store per domain (project, terminal, kanban, swarm...). No Redux boilerplate. |
| Terminal | **xterm.js** (+ webgl/fit/search/web-links addons) | Industry-standard browser terminal emulator. |
| Editor | **CodeMirror 6** + **Shiki** | Code editing + accurate syntax highlighting. |
| Backend | **Rust** | Owns everything that touches the OS. |
| Secrets | **OS keychain** | Windows Credential Manager / macOS Keychain via `keychain.rs`. |

**The one-liner on why Tauri over Electron:** smaller installs, lower memory, a real systems language (Rust) for the trust-sensitive parts (filesystem, process lifecycle, secrets), and it packages cleanly to MSIX for the Microsoft Store.

---

## 4. The architecture in one picture

```
+-------------------------------------------------------------+
|  React 19 + TypeScript (the webview / "front of house")     |
|                                                             |
|  Rooms:  Dashboard | Terminals | Kanban | Memory |          |
|          Swarm | Review | Editor | Settings                 |
|                                                             |
|  Zustand stores: projectStore, terminalStore, kanbanStore,  |
|                  memoryStore, swarmStore, reviewStore, ...   |
+----------------------------┬--------------------------------+
                             |
              Tauri IPC  (invoke commands  +  events)
                             |
+----------------------------┴--------------------------------+
|  Rust backend (the "back of house" - owns the OS)           |
|                                                             |
|  pty.rs        native PTY sessions, streamed to xterm       |
|  project.rs    read/write .saple, config, MCP install       |
|  memory.rs     parse markdown+frontmatter, snapshots, graph |
|  keychain.rs   secrets in the OS keychain                   |
|  git.rs        status / diff / stage / commit               |
|  swarm.rs      swarm state, mailbox, handoff, dep graph     |
|  june_control  localhost control endpoint (opt-in)          |
|  watcher.rs    watch .saple, notify UI of external edits    |
+----------------------------┬--------------------------------+
                             |
          .saple/*.json + .saple/memory/*.md on disk
                             |
                  saple-mcp sidecar / other agents
```

**The single most important idea:** the UI never touches the filesystem or the OS directly. Everything crosses the Tauri boundary into Rust. That boundary is the security and correctness line.

---

## 5. Frontend / backend boundary (know this cold)

This is the question that separates "I used a framework" from "I understand what I built."

**Rust owns:** filesystem access, PTY sessions, keychain access, process lifecycle, markdown parsing, snapshots, git, and resolving where the bundled MCP sidecar lives.

**React owns:** user interaction, room routing, provider/project selection, rendering, and UI state.

**They talk two ways:**

1. **`invoke` (request/response):** the frontend calls a named Rust command and awaits a result. There are ~90 of these registered in `src-tauri/src/lib.rs` (`invoke_handler![...]`). Examples: `spawn_pty`, `write_project_file`, `git_commit`, `set_api_key`, `read_swarm_state`.
2. **Events (push):** Rust pushes data to the UI. The terminal streams PTY output as events; a file watcher emits `saple-file-changed` when disk changes underneath the app; June commands arrive as `june://command` events.

**Rule enforced in code:** project writes must stay inside the selected project directory, and secrets never land in JSON/localStorage/markdown - they go through the keychain commands.

---

## 6. How each room works (feature walkthrough)

### Terminals
Native pseudo-terminals (PTYs) are spawned and **owned by Rust** (`pty.rs`, `PtyRegistry`). Output is streamed to **xterm.js** in React through Tauri events; keystrokes go back via `write_pty`. When the window closes, Rust kills every PTY child and joins its reader threads so no agent CLI is left running as an orphan process. Copy/paste deliberately uses the Tauri clipboard plugin (not `navigator.clipboard`) because the WebView2 clipboard permission isn't granted to config-defined windows.

### Kanban
A task board backed by a single file: `.saple/tasks.json`. `kanbanStore` reads and writes it. Because an agent (via MCP) might edit that same file, the store can be force-reloaded from disk when the watcher fires.

### Memory
A markdown knowledge base under `.saple/memory/**/*.md`, each file being a note with **YAML frontmatter**. Rust (`memory.rs`) parses frontmatter, builds a **link graph** between notes (so you get a visual graph of connected memories), finds unlinked mentions, and supports **snapshots** (save/restore the whole memory state). This mirrors how the agent's own memory works, so the human and the agent share one brain.

### Swarm
Multi-agent coordination. State lives in `.saple/swarm/state.json`. Agents communicate through **mailbox** and **handoff** files, and there's **dependency-graph validation** (`validate_dependency_graph`) so you can't create a swarm plan with cyclic or broken dependencies. There's a wizard (name → mission → roster → directory → context → launch) to set one up.

### Review
A code-review queue. `git.rs` provides status/diff/stage/commit; `review.rs` stores a review record, tracks which files you've viewed, lets you run a verification command, and submit a decision. Split-diff and virtualized viewers keep it fast on large diffs.

### Editor / Files
A CodeMirror-based editor with Shiki highlighting, plus a file tree and project-wide search - all going through Rust file commands.

### Settings
Provider API keys (stored in the keychain via `KeychainTab`), MCP install/status, workspace config, diagnostics (checks whether provider CLIs are installed and signed in), and SSH presets.

---

## Complete capability list - everything you can do today

The full, defensible inventory of what a user can actually do in the shipped app, grouped by area. Every item maps to real UI or a real Rust command.

### Projects & workspaces
- Open any folder on disk as a workspace (`Ctrl+O` or the dashboard).
- Open the **same** folder multiple times as independent workspace instances (separate terminal/pane sets per instance).
- See recent workspaces and a project summary on the Dashboard.
- Per-workspace config: default AI provider, default model per provider, and workspace settings, persisted under `.saple/`.
- The app remembers window size/position/maximized state across restarts, and refuses to open a second copy of itself (focuses the running one instead).

### Terminals (Command Room)
- Open multiple native shell terminal panes in a split grid.
- Run any command-line tool in a real PTY (full interactive shells, TUIs, agent CLIs).
- Launch an **AI agent** into a pane for a specific provider + model, seeded with a generated prompt file.
- Rename terminal/agent sessions; right-click context menu; per-pane title bar.
- Search within terminal output; copy (`Ctrl+C` / `Ctrl+Shift+C`) and paste (`Ctrl+V`) via the native clipboard.
- Cycle focus between panes (`Ctrl+Shift+Tab` / `Ctrl+Alt+→`); new pane (`Ctrl+Shift+T`).
- Pane-count limits are enforced so launches can't spawn unbounded terminals.
- On app close, every child process is killed - no orphaned agent CLIs left running.

### Tasks (Kanban)
- Create, edit, and delete tasks on a board with columns (backlog → done).
- Give a task a description and an agent config (which provider + model should run it).
- **Launch an AI agent directly from a task** - Bridge writes a prompt file and starts the agent in a terminal, named after the task.
- Open a task detail drawer; attach a local preview URL to a task.
- The board is one JSON file that live-reloads when an agent/MCP edits it.

### Memory (knowledge graph)
- Create markdown notes with title, category, tags, links, and body.
- Auto-built **link graph** between notes, with a visual graph view.
- Full-text search across memory content.
- See "unlinked mentions" (notes that reference each other without an explicit link) and add links.
- **Snapshots:** save the entire memory state, list snapshots, and restore one.
- Delete notes; edit in a markdown editor with live preview.
- Save a quick note straight from the command palette composer.

### Swarm (multi-agent coordination)
- Set up a multi-agent swarm through a wizard: name → mission → roster → directory → context → launch.
- Track active agents with live status (starting / running / etc.) and roles, plus elapsed time.
- **Message any running agent's mailbox**, or broadcast to all running agents at once.
- Agents coordinate through mailbox and handoff files.
- **Dependency-graph validation** prevents cyclic or broken swarm plans before launch.
- Visual swarm graph and per-agent cards; editable swarm templates.

### Review (code review queue)
- View git status and per-file diffs in a split-diff viewer (virtualized for large files).
- Stage / unstage files; commit from inside the app.
- Track which files you've viewed; run a verification command against the change.
- Approve or reject completed agent changes (submit a review decision).

### Files & Editor
- Browse the project in a file tree; open multiple files in editor tabs.
- Edit code in CodeMirror 6 with Shiki syntax highlighting (JS/TS, Rust, Python, JSON, YAML, HTML, CSS, Markdown...).
- Create, rename, and delete files and folders.
- Project-wide full-text **search in files** (`Search in Files` command).
- Open a file in your external editor, or reveal it in the OS file explorer.
- The Files-room layout (expanded folders + open tabs) persists per workspace across restarts.

### Embedded browser & local preview
- Open native browser tabs inside Bridge (navigate, back, forward, reload).
- **Local Preview** drawer (`Ctrl+Shift+B`): load a loopback dev URL (e.g. an agent's `localhost:3000`) and **attach that URL to a task, swarm agent, or memory note** - without leaving the app.
- Optional agent-browser mode with a remote-debugging (CDP) port for automated inspection.

### Providers, keys & models
- Store API keys per provider (Claude, Codex, and others) in the **OS keychain** - never in files.
- Browse the available models per provider from a model catalog.
- Test a provider connection; pick default provider and default model per provider.

### MCP integration
- One-click **install the Saple MCP config** so IDEs/agents can reach the memory-graph server globally.
- Check MCP status and test that the MCP tools respond.
- The `saple-mcp` server is bundled and staged automatically.

### Diagnostics & system
- **Run system diagnostics**: OS + shell detection, workspace writability, git availability, keychain status per provider, which provider CLIs are installed (with versions), and MCP config presence.
- Check whether a provider CLI is installed and whether you're signed in to it.
- View Claude context-window usage.
- Toast notifications for success/failure of actions.

### Command palette & composer
- `Ctrl+P` command palette: run any command, switch rooms, jump to matching tasks and memory notes by typing.
- **Composer** (`Ctrl+Shift+K`): type one message and route it to - a running agent, all running agents, a new one-off terminal agent, a Kanban task (as an operator note), a new swarm mission, or a new memory note.
- Full keyboard-shortcut reference dialog; `Alt+1..9` to jump between rooms.

### Appearance & platform
- Light / dark / follow-system theme.
- Windows (primary) and macOS 11+ native builds.
- Installed from the **Microsoft Store** (MSIX); auto-updates handled by the Store on that channel, and by an in-app updater on direct-download builds.

### Automation surface (for June / other orchestrators)
When the opt-in control endpoint is enabled, an external app can drive Bridge to: spawn agents, assign a task, write to / close a terminal, open / close the browser, and read swarm status - all idempotently, with a resumable event log.

---

## 7. The engineering details worth bragging about

These are the answers to "tell me about a hard problem you solved." Each is real and in the code.

### 7.1 Two-layer write safety (`src/lib/writeQueue.ts` + Rust atomic writes)
The problem: rapid edits, the swarm scheduler ticking, and an MCP-triggered save can all try to write the same file at once and clobber each other.

- **Rust layer** writes atomically: write to a temp file, then rename, under a **per-path mutex**. This guarantees a reader never sees a half-written (torn) file.
- **That alone doesn't guarantee ordering** - two back-to-back saves could land in either order, and a stale snapshot could win.
- **TS layer** (`enqueueWrite`) chains writes per logical file key, so for a given file each write starts only after the previous one settles (resolved *or* rejected - a failed write must not wedge the chain). Net result: **last save issued is the last save written, and no reader ever sees a torn file.**

That two-layer split (atomicity in Rust, ordering in TS) is a clean, defensible design decision - exactly the kind of thing to walk an interviewer through.

### 7.2 Live external-edit reconciliation (`watcher.rs` → `saple-file-changed`)
Because agents and the MCP sidecar edit `.saple/` files behind the app's back, Rust watches the active project and emits `saple-file-changed`. The frontend force-reloads the affected store (tasks/swarm/sessions) so the in-memory copy matches disk **before the next save clobbers it**. It re-reads the current project path from the store at event time so a stale closure can't reload into the wrong project after a switch.

### 7.3 Instant room switching (`App.tsx`)
Heavy, stateful rooms (terminals, kanban, memory, swarm, review) are **kept mounted once first visited** and toggled with CSS visibility - so switching back is instant, with no xterm dispose/replay or remount. Light rooms (dashboard, editor, settings) render on demand. All rooms are **code-split with `React.lazy` + Suspense**, so startup only loads what you open.

### 7.4 Secrets in the OS keychain (`keychain.rs`)
API keys never touch JSON, localStorage, or component state. They're stored under the OS keychain account `saple_bridge_user`. This is a real security boundary, not a nice-to-have.

### 7.5 The MCP sidecar
`saple-mcp` is a sibling project bundled as a **Tauri sidecar**. On release builds it's staged to a stable per-user path so `.mcp.json` never points at the versioned, ACL-restricted install directory (which matters specifically for the MSIX/Store install).

### 7.6 June control endpoint (`june_control.rs`) - how the ecosystem connects
This is the bridge between apps. June (a separate app) can drive Saple Bridge through a **localhost-only, token-authenticated HTTP endpoint** with exactly three operations: `capabilities`, `command`, `observe`.

- It is **opt-in and default-off** - no open port unless the user enables it - which is the right security default.
- A `command` is forwarded into the webview as a Tauri event; a thin dispatcher calls the existing store actions; the result comes back to Rust.
- The core that must be correct independent of transport is unit-tested: a **monotonic event log**, `observe(after_sequence)` resume (so June can catch up on what it missed), and **request idempotency** (retrying a `request_id` replays the original result and creates nothing new).

If asked "how do your apps connect?" - this is the answer: a small, versioned, idempotent, opt-in control protocol, not a shared database or a cloud.

### 7.7 Store-aware build (`--features ms-store`)
Store builds compile the in-app updater out entirely, because the Microsoft Store owns updates for MSIX installs and a dormant updater would be a policy liability. Non-store builds keep the Tauri updater. Same codebase, two distribution channels.

---

## 8. How it's built, versioned, and shipped

- `npm run tauri:dev` - dev app (stages the MCP sidecar first, applies a dev CSP overlay that re-adds Vite origins).
- `npm run tauri:build` - production bundle; **auto-bumps the patch version** in `tauri.conf.json`, `package.json`, and `Cargo.toml`, then collects installers into `build/v<version>/`. (So version-file diffs after a build are expected, not hand-edited.)
- `npm run pack:msix` - packages the MSIX for the **Microsoft Store**.
- Quality gates: `npm run typecheck`, `npm test` (Vitest), `npm run lint`, plus `cargo check` / `cargo test` on the Rust side.

Current version at time of writing: **1.0.32** (patch-bumped per build).

---

## 9. Likely interview questions - and crisp answers

**Q: Why Tauri and not Electron?**
Smaller binary and memory footprint (uses the OS webview, not a bundled Chromium), and Rust for the OS-facing work. It also packages cleanly to MSIX for the Store.

**Q: Where does data live? Is there a database?**
No server or DB. Everything is plain files inside the project's `.saple/` folder - JSON for tasks/swarm/sessions, markdown+frontmatter for memory. Secrets are the exception: they're in the OS keychain.

**Q: How do you prevent two writers from corrupting a file?**
Two layers: Rust writes atomically (temp file + rename under a per-path mutex) so reads are never torn; a TS write-queue serializes writes per file so ordering is preserved and the last save wins.

**Q: How does the UI stay in sync when an agent edits files directly?**
A Rust file watcher emits a `saple-file-changed` event; the frontend force-reloads the affected store before its next save, using the live project path so it can't reload into the wrong project.

**Q: How do your different apps talk to each other?**
Through a localhost-only, token-authed control endpoint (three ops: capabilities/command/observe) with a monotonic event log, resumable observation, and idempotent commands. It's opt-in and default-off.

**Q: How do you keep secrets safe?**
OS keychain only. Never in JSON, localStorage, markdown, or component state. Enforced as an architectural rule.

**Q: What was the hardest part?**
Getting the write-safety and external-edit reconciliation right - the app and autonomous agents write the same files concurrently, so I had to separate atomicity (Rust) from ordering (TS) and reconcile external edits without clobbering in-flight saves.

**Q: How is it distributed?**
Published on the Microsoft Store as an MSIX; store builds compile the in-app updater out because the Store owns updates. Non-store builds keep the Tauri updater.

**Q: What would you improve / what are the limits?**
Local-first means no built-in multi-device sync (by design - the tradeoff is privacy and simplicity). Cross-machine sync would be the next big feature, and it'd have to preserve the "your data is just files" guarantee.

---

## 10. The ecosystem framing (for the "tell me about your experience" moment)

- **Saple Bridge** - the workspace. Published on the Microsoft Store. (This doc.)
- **ClearShot** - [your one-liner].
- **Eve** - in Microsoft Store review.
- **June** - in active development; the orchestrator that drives Bridge through the control endpoint (§7.6).

Frame it as: *"I built and shipped a suite of developer tools - one published on the Microsoft Store, a second in store review, a third in active development - designed to work together as a local-first AI development ecosystem."* Shipped product > side project. Own the initiative.
