# [Amber] AI agent chat room

Amber is a chat room where the user talks to an LLM (Anthropic API key, or **Claude Code** on a Max/Pro
subscription; OpenAI-compatible deferred) that can call tools — the 18 in-house memory/task/swarm tools
plus file/command builtins. The agent loop lives in **Rust** (`src-tauri/src/amber/`); this folder is
the view only.

## Files

| File | Role |
|------|------|
| `AmberWorkspace.tsx` | Shell: header (model chip + actions), history rail, settings panel or message-list + composer. Calls `amberStore.init()` once on mount. Mounted as a **heavy view** (kept alive so a stream survives room switches). |
| `AmberMessageList.tsx` | Renders the committed log + the in-flight turn. Indexes `tool_results` by id and attaches each to its `tool_use` block. |
| `AmberMessage.tsx` | One text turn. Assistant text → `MarkdownPreview` (GFM); user text verbatim. `React.memo`. |
| `AmberToolCall.tsx` | Collapsible tool card (name · status · args · result). `useState` toggle — there is no shared disclosure primitive. |
| `AmberComposer.tsx` | Textarea; Enter sends, Shift+Enter newline; send/stop. |
| `AmberSettings.tsx` | Provider / model / base-URL + key entry (`set_api_key`); presence via `has_api_key`. For the **`claude-code`** provider it hides the key/base-URL and shows a CLI detect/login status (`amber_claude_code_status`) instead. |

## Invariants

- **State lives in `stores/amberStore.ts`**, not here. Components only read selectors + call actions.
- **Secrets never enter the renderer.** The key entry writes via `set_api_key`; presence is checked
  via `has_api_key` (returns a bool). Never call `get_api_key` from Amber.
- **Streaming is event-driven.** The store subscribes to `amber://event` / `amber://run` and
  batches `text_delta` via rAF — do not add per-token `set()` paths. On run completion the store
  reloads the canonical log from Rust (the streamed events don't carry tool-call inputs).
- **Not project-gated.** Amber works with no folder open; the four file/command builtins do require
  a project and return an error result otherwise.
- **`claude-code` provider has no key.** It delegates the whole turn to the user's logged-in `claude`
  CLI (subscription) — Rust spawns it (`amber/claude_code.rs`), so the renderer just selects the
  provider and shows CLI status. The CLI runs *its own* tools (Read/Bash/Write + the project's
  `.mcp.json`, e.g. `saple-memory`), not Amber's 22-tool catalog.
- **Theme-safe styling.** Use `var(--*)` tokens and the `accent-amber` token (no hardcoded hex);
  styles live under the `/* Amber chat room */` block in `styles/index.css`.

## Deferred

- Per-message Shiki syntax highlighting (currently the `.md-preview` code styling).
- OpenAI-compatible provider (the seam exists; `Provider::OpenAiCompatible` errors for now).
