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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

const exePath = join(root, 'src-tauri', 'target', 'release', 'saple-bridge.exe');
// Written after a successful Store build. `--skip-build` refuses to pack unless this marker is
// newer than the staged exe and frontend: a plain release build (updater compiled in, updater UI
// visible) leaves the same artifacts behind and must never end up inside an MSIX.
const storeMarker = join(root, 'dist', '.ms-store');

if (!skipBuild) {
  console.log(`\n→ Building Saple Bridge v${version} (Store build, no installer bundle)\n`);
  // `--features ms-store` compiles the self-updater out of the binary; VITE_MS_STORE=1 is the
  // frontend half of the same gate (Settings copy + hidden update controls).
  run('npx', ['tauri', 'build', '--no-bundle', '--', '--features', 'ms-store'], {
    VITE_MS_STORE: '1',
  });
  writeFileSync(storeMarker, `${msixVersion}\n`);
} else {
  const indexHtml = join(root, 'dist', 'index.html');
  const storeBuildIsCurrent =
    existsSync(storeMarker) &&
    existsSync(exePath) &&
    existsSync(indexHtml) &&
    statSync(storeMarker).mtimeMs >= statSync(exePath).mtimeMs &&
    statSync(storeMarker).mtimeMs >= statSync(indexHtml).mtimeMs;
  if (!storeBuildIsCurrent) {
    console.error('✖ --skip-build: the last build is not a Store build (dist/.ms-store missing or');
    console.error('  older than the built exe/frontend). Re-run without --skip-build so the');
    console.error('  ms-store / VITE_MS_STORE gates are applied.');
    process.exit(1);
  }
}

// --- stage the package layout ----------------------------------------------
const stage = join(root, 'dist-msix');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'Assets'), { recursive: true });

copyFileSync(exePath, join(stage, 'saple-bridge.exe'));
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

if (existsSync(out)) {
  console.warn(`⚠ ${out} already exists.`);
  console.warn(`  Partner Center rejects re-uploads of the same Identity.Version (${msixVersion}) -`);
  console.warn('  bump "version" in src-tauri/tauri.conf.json (+ package.json/Cargo.toml) before a new submission.');
}

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
