// Package Saple Bridge as an MSIX for Microsoft Store submission.
//
// Flow:
//   1. `tauri build --no-bundle` with VITE_MS_STORE=1 (the app hides its self-updater —
//      the Store owns updates for MSIX installs). Bypasses scripts/tauri.mjs on purpose:
//      no version auto-bump, the committed version is what ships.
//   2. Stage the package layout into dist-msix/: main exe, saple-mcp sidecar
//      (Tauri resolves it as `saple-mcp.exe` next to the exe), logo assets, and the
//      manifest with Version patched from tauri.conf.json (MSIX wants 4 parts).
//   3. `winapp package` -> build/msix/. Unsigned by default: the Store re-signs
//      MSIX uploads, so no certificate is needed for submission.
//
// Local install testing (self-signed cert, then double-click the .msix):
//   node scripts/pack-msix.mjs -- --cert devcert.pfx --generate-cert --install-cert
// Anything after `--` is forwarded to `winapp package`. `--skip-build` reuses the
// last release build.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// ponytail: x64-only, matching the release workflow; stage per-triple dirs if arm64 ever ships
const TRIPLE = 'x86_64-pc-windows-msvc';

function run(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const version = JSON.parse(
  readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
).version;
const msixVersion = `${version}.0`;

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const fwdIdx = argv.indexOf('--');
const winappExtra = fwdIdx === -1 ? [] : argv.slice(fwdIdx + 1);

if (!skipBuild) {
  console.log(`\n→ Building Saple Bridge v${version} (Store build, no installer bundle)\n`);
  run('npx', ['tauri', 'build', '--no-bundle'], { VITE_MS_STORE: '1' });
}

// --- stage the package layout ----------------------------------------------
const stage = join(root, 'dist-msix');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'Assets'), { recursive: true });

copyFileSync(
  join(root, 'src-tauri', 'target', 'release', 'saple-bridge.exe'),
  join(stage, 'saple-bridge.exe'),
);
copyFileSync(
  join(root, 'src-tauri', 'binaries', `saple-mcp-${TRIPLE}.exe`),
  join(stage, 'saple-mcp.exe'),
);
for (const logo of ['StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png']) {
  copyFileSync(join(root, 'src-tauri', 'icons', logo), join(stage, 'Assets', logo));
}

const manifest = readFileSync(join(root, 'Package.appxmanifest'), 'utf8').replace(
  /(<Identity[^>]*\bVersion=")[^"]*(")/,
  `$1${msixVersion}$2`,
);
if (manifest.includes('REPLACE-WITH')) {
  console.warn('⚠ Package.appxmanifest still has REPLACE-WITH placeholders.');
  console.warn('  Fine for a local test pack; fill in the Partner Center identity before a Store upload.');
}
writeFileSync(join(stage, 'Package.appxmanifest'), manifest);

// --- pack --------------------------------------------------------------------
const outDir = join(root, 'build', 'msix');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `SapleBridge_${msixVersion}_x64.msix`);

console.log(
  `\n→ Packing ${out}\n  ${winappExtra.length ? `winapp extras: ${winappExtra.join(' ')}` : 'unsigned — the Store signs Store uploads'}\n`,
);
run('winapp', [
  'package',
  stage,
  '--manifest',
  join(stage, 'Package.appxmanifest'),
  '--output',
  out,
  ...winappExtra,
]);

console.log(`\n✓ MSIX ready: ${out}\n`);
