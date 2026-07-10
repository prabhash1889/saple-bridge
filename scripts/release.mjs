// Cut a release: bump the version in the three source-of-truth files, commit, tag `v<version>`,
// and push the tag so the GitHub release workflow (.github/workflows/release.yml) builds a signed,
// updater-ready NSIS bundle and publishes `latest.json`.
//
//   npm run release            # patch bump (1.0.17 -> 1.0.18)
//   npm run release minor      # 1.0.17 -> 1.1.0
//   npm run release major      # 1.0.17 -> 2.0.0
//   npm run release 1.5.0      # explicit version
//   node scripts/release.mjs --self-check   # run the version-math self-test and exit
//
// This is the ONLY path that should mint a release version. Local `npm run tauri:build` also bumps
// the patch, but those are throwaway QA builds — the release version is whatever this script commits
// and tags, which is what `tauri-action` reads and what installed apps compare against.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Compute the next version from the current one and a bump spec ("patch"|"minor"|"major"|"x.y.z").
// Pure and total: throws on a malformed current version or an unrecognized/invalid explicit spec.
export function nextVersion(current, spec = 'patch') {
  const parts = String(current).split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`current version is not x.y.z: "${current}"`);
  }
  const [major, minor, patch] = parts;
  switch (spec) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default:
      if (!/^\d+\.\d+\.\d+$/.test(spec)) throw new Error(`bump must be patch|minor|major|x.y.z, got "${spec}"`);
      return spec;
  }
}

function demo() {
  const assert = (a, b) => { if (a !== b) throw new Error(`self-check failed: expected ${b}, got ${a}`); };
  assert(nextVersion('1.0.17'), '1.0.18');
  assert(nextVersion('1.0.17', 'minor'), '1.1.0');
  assert(nextVersion('1.9.9', 'major'), '2.0.0');
  assert(nextVersion('1.0.17', '3.2.1'), '3.2.1');
  let threw = false;
  try { nextVersion('1.0'); } catch { threw = true; }
  assert(threw, true);
  try { threw = false; nextVersion('1.0.0', 'huge'); } catch { threw = true; }
  assert(threw, true);
  console.log('release.mjs self-check passed');
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout || ''}`);
  }
  // With stdio: 'inherit' git writes straight to the terminal and stdout is null here.
  return (res.stdout ?? '').trim();
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-check')) { demo(); return; }

  const spec = argv[0] ?? 'patch';

  // A clean tree guarantees the release commit contains only the version bump — no stray edits and
  // no half-finished work riding into a tagged release.
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error('ERROR: working tree is not clean. Commit or stash changes before releasing.\n' + dirty);
    process.exit(1);
  }

  const confPath = join(root, 'src-tauri', 'tauri.conf.json');
  const pkgPath = join(root, 'package.json');
  const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  const version = nextVersion(conf.version, spec);

  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Only the [package] version at the top of the manifest — dependency pins use inline-table syntax.
  const cargoToml = readFileSync(cargoPath, 'utf8');
  writeFileSync(cargoPath, cargoToml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));

  const tag = `v${version}`;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  git(['add', confPath, pkgPath, cargoPath]);
  git(['commit', '-m', `chore(release): ${tag}`]);
  // Annotated tag (carries tagger/date/message) — and it's what the release feed is keyed on.
  git(['tag', '-a', tag, '-m', tag]);

  console.log(`\n✓ Committed and tagged ${tag}.`);
  console.log('  Pushing branch + tag — the release workflow will build, sign, and publish the draft release.\n');
  // Push the branch and the tag by explicit refspec, so this never depends on --follow-tags
  // pushing (or not pushing) the tag. The tag push is what triggers the release workflow.
  git(['push', 'origin', branch, tag], { stdio: 'inherit' });
  console.log(`\n✓ Pushed. Watch the "Release" workflow, then publish the draft release for ${tag}.\n`);
}

main();
