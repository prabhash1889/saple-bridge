// Wrapper for the `tauri` CLI invoked via `npm run tauri <subcommand>`.
//
// For `npm run tauri build` it:
//   1. Bumps the patch version in tauri.conf.json + package.json (so every
//      build is a distinct version, e.g. 1.0.0 -> 1.0.1 -> 1.0.2).
//   2. Runs the real `tauri build` (forwarding any extra flags).
//   3. Collects the produced installers into ./build/v<version>/.
//
// Any other subcommand (dev, icon, ...) is passed straight through to tauri.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const args = process.argv.slice(2);

// Run the real tauri CLI, inheriting stdio so output streams live.
function runTauri(tauriArgs) {
  const res = spawnSync('npx', ['tauri', ...tauriArgs], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npx needs a shell on Windows
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

// Pass-through for anything that isn't `build`.
if (args[0] !== 'build') {
  runTauri(args);
  process.exit(0);
}

// --- build: bump version -------------------------------------------------
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const pkgPath = join(root, 'package.json');

const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const [major, minor, patch] = String(conf.version).split('.').map((n) => parseInt(n, 10) || 0);
const newVersion = `${major}.${minor}.${patch + 1}`;

conf.version = newVersion;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`\n→ Building Saple Bridge v${newVersion}\n`);

// --- run the actual build ------------------------------------------------
runTauri(args);

// --- collect installers into ./build/v<version>/ -------------------------
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle');
const outDir = join(root, 'build', `v${newVersion}`);

// Installer extensions Tauri emits across platforms.
const installerExt = /\.(exe|msi|dmg|app|deb|rpm|AppImage)$/i;

function collect(dir) {
  let copied = 0;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      copied += collect(full);
    } else if (installerExt.test(name)) {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(full, join(outDir, basename(full)));
      console.log(`  • ${name}`);
      copied++;
    }
  }
  return copied;
}

console.log(`\n→ Collecting installers into build/v${newVersion}/`);
const count = collect(bundleDir);
if (count === 0) {
  console.log('  (no installers found — check src-tauri/target/release/bundle/)');
} else {
  console.log(`\n✓ ${count} file(s) copied to ${outDir}\n`);
}
