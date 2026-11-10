# Left to Implement

Improvements identified in the deep-dive review that were **not** done in
`improve/deep-dive-fixes`, because each needs infrastructure, secrets, or a
larger dedicated effort rather than a self-contained code change. Ordered by
user-facing impact.

---

## 1. Auto-updater (highest user-facing impact)

**Problem.** `npm run tauri:build` bumps the patch version on every build (currently
1.0.16), but there is no updater: `tauri-plugin-updater` is absent from
`src-tauri/Cargo.toml`, and there is no release pipeline. Every fix reaches users
only if they manually download and reinstall.

**Why it wasn't done here.** It requires a signing keypair whose **private key must
be generated and kept secret by the maintainer** (I should not fabricate one), plus
a hosted update feed. Adding a half-configured `plugins.updater` block would break
the frequently-run `npm run tauri:build`.

**What's needed (maintainer steps).**
1. Generate a signing keypair: `npx tauri signer generate -w ~/.tauri/saple.key`
   (store the private key + password as CI secrets: `TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Keep the private key out of the repo.
2. Add `tauri-plugin-updater = "2"` (Cargo.toml) and
   `@tauri-apps/plugin-updater` (package.json); register the plugin in `lib.rs`.
3. Add to `tauri.conf.json`:
   ```json
   "plugins": {
     "updater": {
       "pubkey": "<public key from step 1>",
       "endpoints": ["https://<host>/saple-bridge/{{target}}/{{arch}}/{{current_version}}"]
     }
   }
   ```
   The endpoint can be GitHub Releases (`latest.json`) or any static host.
4. A release workflow that builds the signed bundle + `latest.json` and uploads it
   (e.g. `tauri-apps/tauri-action` on tag push).
5. Frontend: call `check()` from the updater plugin on startup (or a "Check for
   updates" button) and surface a download/restart prompt.

**Scope.** ~1 Cargo dep + 1 npm dep, ~40 lines of wiring, plus the release workflow
and the one-time key/secret setup. Once the key and endpoint exist, the code side
is small.

---

## 8. End-to-end test harness

**Problem.** `CLAUDE.md` mandates E2E-first bug reproduction, but there is nothing to
do it with: no `tauri-driver`/WebdriverIO setup, no smoke test. Unit tests
structurally cannot catch packaging, CSP, or sidecar-wiring regressions.

**Why it wasn't done here.** A working harness is a dedicated setup, not a bundled
fix. On Windows it needs `tauri-driver` + the matching **Edge WebDriver**
(`msedgedriver`) pinned to the installed Edge/WebView2 version, which is fiddly and
flaky in CI.

**What's needed.**
1. Dev deps: `@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`, plus
   `tauri-driver` (`cargo install tauri-driver`).
2. A `wdio.conf.ts` that launches the built app through `tauri-driver`, and on
   Windows resolves the correct `msedgedriver` version.
3. One smoke spec exercising the critical path: launch app → open a project →
   spawn a terminal → assert a shell prompt renders. That alone catches the
   CSP/sidecar/packaging regression class.
4. A CI job (Windows first, macOS later) that builds the app and runs the spec.
   Expect to gate it as `continue-on-error` at first until it's stable, given
   WebDriver/WebView2 flakiness.

**Scope.** Meaningful setup effort; start with a single smoke test and grow it.

---

## 10. Decompose the god components

**Problem.** Several view components are single very large functions:
`ReviewWorkspace` (~754 lines), `MemoryGraph` (~602), `TerminalGrid` (~559),
`SwarmWorkspace` (~528), `Sidebar` (~499), `ProjectDashboard` (~498). They work, but
each is a merge-conflict magnet and slow for both humans and agents to modify
safely. The knowledge graph flags `ReviewWorkspace` as the densest untested
coupling.

**Why it wasn't done here.** A big-bang refactor of working UI is high-risk and low
immediate value. The right approach is incremental.

**What's needed.** Extract sub-panels **opportunistically, when the file is next
touched** for a feature or fix, rather than in one sweep. Suggested first target:
`ReviewWorkspace` — split the file list, the diff viewer, and the actions panel into
child components, and add tests around the extracted pure logic as you go. Repeat for
the others only when you're already in them.

**Scope.** Ongoing / opportunistic. No single PR.
