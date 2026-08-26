// Build the standalone `saple-mcp` MCP server (from the sibling ../saple-mcp repo) and stage it as
// a Tauri sidecar binary under src-tauri/binaries/saple-mcp-<target-triple>[.exe].
//
// Tauri's `externalBin` looks for a file suffixed with the build target triple; at bundle time it
// strips the triple and ships `saple-mcp[.exe]` next to the app binary. Run this before
// `tauri dev` / `tauri build` (both run it automatically via before*Command).
//
// The triple defaults to the rustc host. For a CROSS build, point Bridge and this script at the
// same target by setting SAPLE_MCP_TARGET=<triple> (or passing --target=<triple>) AND building
// Bridge with `tauri build --target <triple>` — that keeps the staged file name, Bridge's baked
// TARGET (build.rs), and the bundle layout all in agreement.
//
// Supply-chain pinning:
//   SAPLE_MCP_PINNED_SHA below must hold the reviewed commit SHA of ../saple-mcp that sidecar
//   builds are allowed to use. Before every build this script compares the sibling checkout's
//   HEAD against the pin and refuses to stage anything from an unreviewed commit.
//   - Update the pin by reviewing the new saple-mcp commit, then pasting its full SHA here AND
//     into the `SAPLE_MCP_SHA` repository variable used by .github/workflows/release.yml.
//   - Until a pin is recorded, local builds print a loud warning; CI fails closed so a release
//     can never ship an unpinned sidecar.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(__dirname, '..');
const mcpRoot = resolve(bridgeRoot, '..', 'saple-mcp'); // sibling repo under SAPLE-ALL
const isWindows = process.platform === 'win32';

// Reviewed commit of ../saple-mcp the sidecar may be built from. Empty means "not yet recorded":
// local runs warn, CI fails. Set this to the full 40-char SHA after reviewing a saple-mcp commit.
const SAPLE_MCP_PINNED_SHA = '95b1d787375f48005816498108ce018c7db7a8e5';

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

// Verify the sibling checkout's HEAD matches the reviewed pin (see header comment).
function verifySidecarPin() {
  if (!existsSync(join(mcpRoot, '.git'))) {
    fail(
      `the saple-mcp sibling repo was not found at ${mcpRoot}.\n` +
        `Clone it next to this repo (so the layout is <workspace>/saple-bridge + <workspace>/saple-mcp),\n` +
        `then check out commit ${SAPLE_MCP_PINNED_SHA || '(the SHA pinned in scripts/prepare-sidecar.mjs)'}.\n` +
        `See the "Sidecar MCP Server" section of README.md for full setup instructions.`
    );
  }
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mcpRoot, encoding: 'utf8', shell: isWindows });
  if (rev.status !== 0) {
    fail(`could not read the HEAD of the saple-mcp checkout at ${mcpRoot}: ${rev.stderr || rev.stdout}`);
  }
  const head = rev.stdout.trim();
  const pin = process.env.SAPLE_MCP_SHA || SAPLE_MCP_PINNED_SHA;
  if (!pin) {
    const msg =
      `SAPLE_MCP_PINNED_SHA is empty in scripts/prepare-sidecar.mjs — the sidecar source is UNPINNED.\n` +
      `To record the pin: review saple-mcp at ${head}, then paste its full SHA into\n` +
      `scripts/prepare-sidecar.mjs and the SAPLE_MCP_SHA repository variable (release workflow).`;
    if (process.env.CI) fail(`${msg}\nCI refuses to build from an unpinned sidecar source.`);
    console.warn(`\nWARNING: ${msg}\n`);
    return;
  }
  if (head !== pin) {
    fail(
      `saple-mcp checkout is at ${head} but the reviewed pin is ${pin}.\n` +
        `Check out the pinned commit (git -C "${mcpRoot}" checkout ${pin}), or, if the new commit has\n` +
        `been reviewed, update the pin in scripts/prepare-sidecar.mjs and the SAPLE_MCP_SHA\n` +
        `repository variable to ${head}.`
    );
  }
  console.log(`✓ saple-mcp HEAD matches reviewed pin ${pin}`);
}

verifySidecarPin();

// Resolve the target triple: explicit override (env or --target) else the rustc host.
// Accept both `--target=<triple>` and the space form `--target <triple>` (two argv entries).
function parseArgTarget(argv) {
  const eq = argv.find((a) => a.startsWith('--target='));
  if (eq) return eq.slice('--target='.length);
  const idx = argv.indexOf('--target');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return undefined;
}
const argTarget = parseArgTarget(process.argv.slice(2));
let triple = process.env.SAPLE_MCP_TARGET || argTarget;
if (!triple) {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8', shell: isWindows });
  if (rustc.status !== 0) {
    console.error('ERROR: failed to run `rustc -vV` — is the Rust toolchain installed?');
    process.exit(1);
  }
  triple = rustc.stdout.match(/^host:\s*(.+)$/m)?.[1]?.trim();
  if (!triple) {
    console.error('ERROR: could not parse host triple from `rustc -vV` output.');
    process.exit(1);
  }
}
// A Windows *target* triple produces a .exe regardless of the build host (e.g. cross from macOS).
const targetIsWindows = triple.includes('windows');
const srcName = targetIsWindows ? 'saple-mcp.exe' : 'saple-mcp';
const destName = `saple-mcp-${triple}${targetIsWindows ? '.exe' : ''}`;

// Only pass --target to cargo when cross-compiling; a redundant --target needs the std component
// installed for that triple, so avoid it for the native default. `--locked` keeps the build on the
// reviewed Cargo.lock (release reproducibility; a stale lockfile is a deliberate build failure).
const isHostBuild = !process.env.SAPLE_MCP_TARGET && !argTarget;
const cargoArgs = isHostBuild ? ['build', '--release', '--locked'] : ['build', '--release', '--locked', '--target', triple];

console.log(`\n→ Building saple-mcp (${triple}) from ${mcpRoot}\n`);
const build = spawnSync('cargo', cargoArgs, { cwd: mcpRoot, stdio: 'inherit', shell: isWindows });
if (build.status !== 0) {
  console.error('\nERROR: `cargo build` for saple-mcp failed.');
  process.exit(build.status ?? 1);
}

const releaseDir = isHostBuild
  ? join(mcpRoot, 'target', 'release')
  : join(mcpRoot, 'target', triple, 'release');

const binDir = join(bridgeRoot, 'src-tauri', 'binaries');
mkdirSync(binDir, { recursive: true });

const src = join(releaseDir, srcName);
const dest = join(binDir, destName);

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Skip the copy when the staged sidecar is already byte-identical — the common case on
// incremental dev runs, and it sidesteps EBUSY when something (the app, an MCP client) is
// running the staged binary.
if (existsSync(dest) && sha256(src) === sha256(dest)) {
  console.log(`\n✓ Sidecar already up to date → src-tauri/binaries/${destName}\n`);
} else {
  try {
    copyFileSync(src, dest);
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
    // The staged binary is locked by a running process. Windows can't overwrite a running
    // exe, but it CAN be renamed away — move it aside and stage the fresh build in its place.
    const aside = `${dest}.stale-${Date.now()}`;
    renameSync(dest, aside);
    copyFileSync(src, dest);
    console.log(`(previous sidecar was in use; moved aside to ${aside})`);
  }
  console.log(`\n✓ Staged sidecar → src-tauri/binaries/${destName}\n`);
}
