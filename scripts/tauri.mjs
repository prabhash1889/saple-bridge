// Wrapper for the `tauri` CLI invoked via `npm run tauri <subcommand>`.
//
// For `npm run tauri build` it:
//   1. Bumps the patch version in tauri.conf.json + package.json ONLY when explicitly asked
//      (SAPLE_RELEASE_BUILD=1). Plain local builds never touch version files.
//   2. Runs the real `tauri build` (forwarding any extra flags).
//   3. Collects the produced installers into ./build/v<version>/ and records the staged
//      sidecar binary's SHA-256 next to them.
//
// Any other subcommand (dev, icon, ...) is passed straight through to tauri.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// --- build: version handling ----------------------------------------------
// Version files are only ever mutated on an EXPLICIT release build (SAPLE_RELEASE_BUILD=1).
// Plain `npm run tauri:build` builds the committed version untouched, so local QA runs no
// longer dirty tauri.conf.json / package.json / Cargo.toml. Release versions are minted by
// `npm run release` (scripts/release.mjs); CI builds always use the committed/tagged version.
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const pkgPath = join(root, 'package.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

const conf = JSON.parse(readFileSync(confPath, 'utf8'));
let newVersion = String(conf.version);

if (process.env.SAPLE_RELEASE_BUILD === '1') {
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

  console.log(`\n→ Building Saple Bridge v${newVersion} (release build)\n`);
} else {
  console.log(`\n→ Building Saple Bridge v${newVersion} (no auto-bump; set SAPLE_RELEASE_BUILD=1 to bump)\n`);
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

// --- record sidecar supply-chain hashes ----------------------------------
// The staged sidecar under src-tauri/binaries/ is what actually ships inside the bundle.
// Record its SHA-256 next to the installers so each build's inputs are auditable/reproducible.
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const binariesDir = join(root, 'src-tauri', 'binaries');
let sidecarLines = [];
try {
  sidecarLines = readdirSync(binariesDir)
    .filter((name) => /^saple-mcp-/.test(name) && !name.includes('.stale'))
    .sort()
    .map((name) => `${sha256File(join(binariesDir, name))}  ${name}`);
} catch {
  // No staged sidecar (e.g. a bare cargo-only build) — nothing to record.
}
if (sidecarLines.length > 0) {
  mkdirSync(outDir, { recursive: true });
  const sumsPath = join(outDir, 'sidecar.SHA256SUMS');
  writeFileSync(sumsPath, sidecarLines.join('\n') + '\n');
  console.log(`→ Sidecar SHA-256 recorded in build/v${newVersion}/sidecar.SHA256SUMS`);
  for (const line of sidecarLines) console.log(`  • ${line}`);
}
