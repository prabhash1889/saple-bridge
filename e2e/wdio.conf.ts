import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './paths';

// The binary tauri-driver launches. `npm run tauri:build` (or a plain `cargo build --release`)
// produces it; the exe name follows the Cargo package name (`saple-bridge`), not the productName.
const appBinary = path.join(
  repoRoot,
  'src-tauri',
  'target',
  'release',
  process.platform === 'win32' ? 'saple-bridge.exe' : 'saple-bridge',
);

const tauriDriverBin = path.join(
  os.homedir(),
  '.cargo',
  'bin',
  process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver',
);

// tauri-driver proxies WebDriver calls to a native driver. On Windows that's msedgedriver, which
// must match the installed Edge/WebView2 runtime — a version mismatch is the main flakiness source.
// Resolution order:
//   1. MSEDGEDRIVER_PATH  - explicit override.
//   2. EdgeWebDriver      - set by GitHub-hosted windows runners to a folder holding a matched driver.
//   3. undefined          - let tauri-driver find msedgedriver on PATH (local dev default).
function resolveNativeDriver(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (process.env.MSEDGEDRIVER_PATH) return process.env.MSEDGEDRIVER_PATH;
  const runnerDir = process.env.EdgeWebDriver;
  if (runnerDir) {
    const candidate = path.join(runnerDir, 'msedgedriver.exe');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./specs/**/*.e2e.ts'],
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver reads `tauri:options.application` to launch the app; browserName is unused.
      // @ts-expect-error tauri:options is a tauri-driver capability, absent from WebdriverIO types.
      'tauri:options': { application: appBinary },
    },
  ],
  // tauri-driver listens here by default; WebdriverIO talks to it, not to msedgedriver directly.
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  // Fail fast with an actionable message instead of a cryptic connection error.
  onPrepare() {
    if (!existsSync(appBinary)) {
      throw new Error(
        `App binary not found at ${appBinary}. Build it first: npm run tauri:build (or ` +
          `cargo build --release --manifest-path src-tauri/Cargo.toml with dist/ already built).`,
      );
    }
    if (!existsSync(tauriDriverBin)) {
      throw new Error(
        `tauri-driver not found at ${tauriDriverBin}. Install it: cargo install tauri-driver.`,
      );
    }
  },

  // WDIO drives tauri-driver, which drives the native WebDriver — so we own its lifecycle.
  beforeSession() {
    const nativeDriver = resolveNativeDriver();
    const args = nativeDriver ? ['--native-driver', nativeDriver] : [];
    tauriDriver = spawn(tauriDriverBin, args, { stdio: [null, process.stdout, process.stderr] });
  },

  afterSession() {
    tauriDriver?.kill();
  },
};
