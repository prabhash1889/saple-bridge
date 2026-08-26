import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Theme alias contract: --bg-card, --bg-surface-hover, and --color-primary are
// consumed across view CSS but were historically undefined (silently falling
// back to the initial value). tokens.css must define them for :root and keep a
// light-family mapping wherever the dark-family default would be wrong.

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
expect(TOKENS_CSS.length, 'src/styles/tokens.css was empty').toBeGreaterThan(0);

const ALIASES = ['--bg-card', '--bg-surface-hover', '--color-primary'];

/** Light-family themes re-map --bg-card because their *-light surface step is
    darker than the card surface; every theme inherits the other aliases. */
const LIGHT_THEMES = ['light', 'solarized', 'latte'];

function themeBlock(theme: string): string {
  const marker = `html[data-theme="${theme}"]`;
  const start = TOKENS_CSS.indexOf(marker);
  expect(start, `tokens.css is missing the ${marker} block`).toBeGreaterThanOrEqual(0);
  const open = TOKENS_CSS.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < TOKENS_CSS.length) {
    if (TOKENS_CSS[i] === '{') depth += 1;
    if (TOKENS_CSS[i] === '}') depth -= 1;
    i += 1;
  }
  return TOKENS_CSS.slice(open, i);
}

describe('tokens.css theme aliases', () => {
  it('defines all aliases on :root (dark-family default)', () => {
    const rootStart = TOKENS_CSS.indexOf(':root');
    const rootEnd = TOKENS_CSS.indexOf('}', rootStart);
    const rootBlock = TOKENS_CSS.slice(rootStart, rootEnd);
    for (const alias of ALIASES) {
      expect(rootBlock).toContain(`${alias}: var(--`);
    }
  });

  it('re-maps --bg-card in every light-family theme block', () => {
    for (const theme of LIGHT_THEMES) {
      expect(themeBlock(theme)).toContain('--bg-card:');
    }
  });

  it('keeps alias definitions consistent when new themes are added', () => {
    const themeNames = [...TOKENS_CSS.matchAll(/html\[data-theme="([^"]+)"\]/g)].map((m) => m[1]);
    expect(themeNames.length, 'tokens.css declares no themes').toBeGreaterThan(0);
    for (const theme of themeNames) {
      const block = themeBlock(theme);
      if (LIGHT_THEMES.includes(theme)) {
        expect(block).toContain('--bg-card:');
      } else {
        // Dark-family themes inherit the :root var() aliases.
        expect(block).not.toContain('--color-primary:');
      }
    }
  });
});
