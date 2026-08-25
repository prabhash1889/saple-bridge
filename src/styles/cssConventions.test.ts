import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// CSS convention scans for src/styles/*.css. These are lint-style guards:
// hard-coded dark overlays/surfaces break non-dark themes, so they must go
// through theme tokens instead.

const STYLES_DIR = fileURLToPath(new URL('.', import.meta.url));

const CSS_FILES = readdirSync(STYLES_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, text: readFileSync(STYLES_DIR + name, 'utf8') }));

describe('styles css conventions', () => {
  it('uses theme tokens instead of rgba(0,0,0,...) backgrounds', () => {
    const offenders: string[] = [];
    for (const { name, text } of CSS_FILES) {
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/^\s*(background|background-color)\s*:\s*rgba\(0\s*,\s*0\s*,\s*0/.test(line)) {
          offenders.push(`${name}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `hard-coded black backgrounds found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps literal hex backgrounds limited to the reviewed allowlist', () => {
    // #fff logo plates and the web preview iframe surface stay literal on
    // purpose: they sit behind external imagery/content in every theme.
    const allowed = new Set(['layout.css', 'preview.css']);
    const offenders: string[] = [];
    for (const { name, text } of CSS_FILES) {
      if (allowed.has(name)) continue;
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/^\s*(background|background-color)\s*:\s*#[0-9A-Fa-f]{3,8}\s*;?\s*$/.test(line)) {
          offenders.push(`${name}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `literal hex backgrounds found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
