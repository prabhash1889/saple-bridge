# E2E smoke test

A single WebdriverIO + [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) smoke
spec that drives the **built** app. It catches the CSP / sidecar / packaging regression class that
unit tests structurally cannot: the webview failing to boot, the production CSP blocking the
bundle, or the PTY wiring breaking after packaging.

The spec (`specs/smoke.e2e.ts`): launch the app → open `../smoke-test-workspace` → spawn a
terminal → assert a shell prompt renders.

This is deliberately one spec with no page-object layer. Grow it by adding more `*.e2e.ts` files
under `specs/`.

## Prerequisites

- **`tauri-driver`**: `cargo install tauri-driver`
- **A built app binary** at `src-tauri/target/release/saple-bridge(.exe)`. Produce it with
  `npm run tauri:build` from the repo root, or a plain
  `cargo build --release --manifest-path src-tauri/Cargo.toml` **after** `npm run build` has
  produced `dist/` (Tauri embeds the frontend at compile time).
- **Windows only**: `msedgedriver` matching the installed Edge/WebView2 runtime. The config finds
  it via, in order: `MSEDGEDRIVER_PATH`, the `EdgeWebDriver` env var (set on GitHub-hosted windows
  runners), then `PATH`. Locally, install the matching
  [Edge WebDriver](https://developer.microsoft.com/microsoft-edge/tools/webdriver/) and put it on
  `PATH` or point `MSEDGEDRIVER_PATH` at it. macOS is not supported by `tauri-driver`.

## Run

```bash
npm install        # in this e2e/ directory
npm test
```
