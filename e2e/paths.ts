import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in <repo>/e2e, so the repo root is one level up. Shared by the WDIO config
// (to find the built app binary) and the spec (to know which folder to open).
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const smokeWorkspace = path.join(repoRoot, 'smoke-test-workspace');
