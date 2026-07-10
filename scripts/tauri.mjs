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

// Pass-through for anything that isn't `build`. `dev` gets the dev config overlay (re-adds the
// Vite dev-server origins to the CSP, which the production config no longer ships).
if (args[0] !== 'build') {
  if (args[0] === 'dev' && !args.includes('--config') && !args.some((a) => a.startsWith('--config='))) {
    args.push('--config', 'src-tauri/tauri.dev.conf.json');
  }
  runTauri(args);
  process.exit(0);
}

// Parse a cross-compile target (either `--target <triple>` or `--target=<triple>`), used to
// locate the bundle output dir, which lives under target/<triple>/release for cross builds.
function parseTargetTriple(list) {
  const eq = list.find((a) => a.startsWith('--target='));
  if (eq) return eq.slice('--target='.length);
  const idx = list.indexOf('--target');
  if (idx !== -1 && list[idx + 1]) return list[idx + 1];
  return null;
}

// --- build: bump version (local QA builds only) ---------------------------
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const pkgPath = join(root, 'package.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

const conf = JSON.parse(readFileSync(confPath, 'utf8'));
let newVersion = String(conf.version);

// In CI (the tag-driven release workflow, where tauri-action invokes this script through the
// package.json `tauri` script) the version is whatever `npm run release` committed and tagged —
// bumping here would make the built version drift +1 from the tag and from latest.json.
// The auto-bump is a convenience for local throwaway QA builds only.
if (process.env.CI) {
  console.log(`\n→ CI build: using committed version v${newVersion} (no auto-bump)\n`);
} else {
  const [major, minor, patch] = newVersion.split('.').map((n) => parseInt(n, 10) || 0);
  newVersion = `${major}.${minor}.${patch + 1}`;

  conf.version = newVersion;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Keep Cargo.toml in the bump loop too — the first `version = "..."` line is the [package]
  // version at the top of the manifest (dependency versions use inline-table syntax).
  const cargoToml = readFileSync(cargoPath, 'utf8');
  writeFileSync(cargoPath, cargoToml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${newVersion}"`));

  console.log(`\n→ Building Saple Bridge v${newVersion}\n`);
}

// --- run the actual build ------------------------------------------------
runTauri(args);

// --- collect installers into ./build/v<version>/<bundle>/ ----------------
// Cross-compiled builds emit under target/<triple>/release/bundle instead of target/release.
const buildTriple = parseTargetTriple(args);
const bundleDir = buildTriple
  ? join(root, 'src-tauri', 'target', buildTriple, 'release', 'bundle')
  : join(root, 'src-tauri', 'target', 'release', 'bundle');
const outDir = join(root, 'build', `v${newVersion}`);

// Installer extensions Tauri emits across platforms.
const installerExt = /\.(exe|msi|dmg|app|deb|rpm|AppImage)$/i;

// Tauri lays out the bundle dir as <bundleDir>/<bundleType>/<installer>
// (e.g. bundle/msi/Saple Bridge_1.0.2_x64_en-US.msi, bundle/nsis/...setup.exe).
// We mirror that one-level <bundleType> folder under build/v<version>/ so each
// installer kind lands in its own subfolder (msi/, nsis/, ...).
//
// The bundle dir accumulates installers from previous builds, so we only copy
// files whose name contains the version we just built — otherwise older
// versions' installers would leak into this version's folder.
function collect(dir, bundleType) {
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
      // The first level under bundleDir names the installer kind (msi, nsis, ...).
      copied += collect(full, bundleType ?? name);
    } else if (installerExt.test(name) && name.includes(newVersion)) {
      const destDir = bundleType ? join(outDir, bundleType) : outDir;
      mkdirSync(destDir, { recursive: true });
      copyFileSync(full, join(destDir, basename(full)));
      console.log(`  • ${bundleType ?? '.'}/${name}`);
      copied++;
    }
  }
  return copied;
}

console.log(`\n→ Collecting installers into build/v${newVersion}/`);
const count = collect(bundleDir, null);
if (count === 0) {
  console.log('  (no installers found — check src-tauri/target/release/bundle/)');
} else {
  console.log(`\n✓ ${count} file(s) copied to ${outDir}\n`);
}
