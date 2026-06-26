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

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(__dirname, '..');
const mcpRoot = resolve(bridgeRoot, '..', 'saple-mcp'); // sibling repo under SAPLE-ALL
const isWindows = process.platform === 'win32';

// Resolve the target triple: explicit override (env or --target=) else the rustc host.
const argTarget = process.argv.slice(2).map(a => a.match(/^--target[=\s]+(.+)$/)?.[1]).find(Boolean);
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
// installed for that triple, so avoid it for the native default.
const isHostBuild = !process.env.SAPLE_MCP_TARGET && !argTarget;
const cargoArgs = isHostBuild ? ['build', '--release'] : ['build', '--release', '--target', triple];

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
copyFileSync(src, dest);
console.log(`\n✓ Staged sidecar → src-tauri/binaries/${destName}\n`);
