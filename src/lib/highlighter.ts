/**
 * Shiki-backed syntax highlighting for the Files viewer.
 *
 * Everything here is loaded through dynamic `import()` so Shiki (its WASM engine,
 * themes, and grammars) stays out of the initial bundle — the runtime core loads on
 * first highlight, and each language grammar loads only when a file of that type is
 * opened. We use the VS Code default themes (`dark-plus` / `light-plus`) for parity.
 */
import type { CSSProperties } from 'react';
import type { HighlighterCore, ThemedToken } from 'shiki';
import type { ResolvedTheme } from '../stores/themeStore';

export type { ThemedToken };

export type ShikiThemeName = 'dark-plus' | 'light-plus';

/** Resolved themes that read as light backgrounds — these get the light VS Code theme. */
const LIGHT_FAMILY_THEMES: ReadonlySet<ResolvedTheme> = new Set([
  'light',
  'solarized',
  'latte',
]);

/** Map the app's resolved theme to the matching VS Code theme. Ember/Mocha/Nord/Dracula/
 *  Tokyo Night are dark variants; Solarized Light and Catppuccin Latte are light. */
export function shikiThemeFor(theme: ResolvedTheme): ShikiThemeName {
  return LIGHT_FAMILY_THEMES.has(theme) ? 'light-plus' : 'dark-plus';
}

/**
 * Curated language grammars. Keys are Shiki language ids; each value lazily imports
 * just that grammar. Static specifiers keep Vite's code-splitting happy.
 */
type LangLoader = () => Promise<unknown>;
const LANG_LOADERS: Record<string, LangLoader> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  json5: () => import('@shikijs/langs/json5'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  sass: () => import('@shikijs/langs/sass'),
  less: () => import('@shikijs/langs/less'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  csharp: () => import('@shikijs/langs/csharp'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  bat: () => import('@shikijs/langs/bat'),
  fish: () => import('@shikijs/langs/fish'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  docker: () => import('@shikijs/langs/docker'),
  lua: () => import('@shikijs/langs/lua'),
  dart: () => import('@shikijs/langs/dart'),
  r: () => import('@shikijs/langs/r'),
  scala: () => import('@shikijs/langs/scala'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  diff: () => import('@shikijs/langs/diff'),
  make: () => import('@shikijs/langs/make'),
  proto: () => import('@shikijs/langs/proto'),
  csv: () => import('@shikijs/langs/csv'),
};

/** File extension → Shiki language id. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  py: 'python', pyw: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  lua: 'lua',
  dart: 'dart',
  r: 'r',
  scala: 'scala', sc: 'scala',
  vue: 'vue',
  svelte: 'svelte',
  diff: 'diff', patch: 'diff',
  proto: 'proto',
  csv: 'csv', tsv: 'csv',
};

/** Special filenames that have no useful extension. */
const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
};

const LANG_LABELS: Record<string, string> = {
  typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', jsx: 'JSX',
  json: 'JSON', jsonc: 'JSON with Comments', json5: 'JSON5',
  markdown: 'Markdown', mdx: 'MDX', html: 'HTML', css: 'CSS', scss: 'SCSS',
  sass: 'Sass', less: 'Less', xml: 'XML', yaml: 'YAML', toml: 'TOML', ini: 'INI',
  python: 'Python', rust: 'Rust', go: 'Go', ruby: 'Ruby', php: 'PHP', java: 'Java',
  kotlin: 'Kotlin', swift: 'Swift', csharp: 'C#', c: 'C', cpp: 'C++',
  shellscript: 'Shell', powershell: 'PowerShell', bat: 'Batch', fish: 'Fish',
  sql: 'SQL', graphql: 'GraphQL', docker: 'Dockerfile', lua: 'Lua', dart: 'Dart',
  r: 'R', scala: 'Scala', vue: 'Vue', svelte: 'Svelte', diff: 'Diff',
  make: 'Makefile', proto: 'Protocol Buffers', csv: 'CSV',
};

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Detect a Shiki language id from a file path, or undefined when unsupported. */
export function detectLang(path: string): string | undefined {
  const name = basename(path).toLowerCase();
  if (name in FILENAME_TO_LANG) return FILENAME_TO_LANG[name];
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_TO_LANG[name.slice(dot + 1)];
}

/** Human-readable label for the header badge. */
export function langLabel(langId: string | undefined): string {
  if (!langId) return 'Plain Text';
  return LANG_LABELS[langId] ?? langId;
}

/** True for Markdown-family files (which get the Code/Preview toggle). */
export function isMarkdown(path: string): boolean {
  const lang = detectLang(path);
  return lang === 'markdown' || lang === 'mdx';
}

// Skip highlighting on very large files so tokenizing never janks the UI.
const MAX_HIGHLIGHT_BYTES = 600_000; // ~600 KB
const MAX_HIGHLIGHT_LINES = 5000;

/** Whether a file is small enough to highlight without noticeable lag. */
export function canHighlight(content: string): boolean {
  if (content.length > MAX_HIGHLIGHT_BYTES) return false;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

let corePromise: Promise<HighlighterCore> | null = null;
// Resolved core, exposed for synchronous tokenizing once warmed up (see tokenizeSync).
let coreInstance: HighlighterCore | null = null;

/** Lazily create (once) the Shiki core with both VS Code themes preloaded. */
function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
      ]);
      const core = await createHighlighterCore({
        themes: [
          import('@shikijs/themes/dark-plus'),
          import('@shikijs/themes/light-plus'),
        ],
        langs: [],
        engine: createOnigurumaEngine(import('shiki/wasm')),
      });
      coreInstance = core;
      return core;
    })();
  }
  return corePromise;
}

/** Whether the viewer knows how to highlight this language at all. */
export function isSupportedLang(langId: string | undefined): boolean {
  return !!langId && langId in LANG_LOADERS;
}

/**
 * Make sure the core + a language grammar are loaded so that subsequent
 * `tokenizeSync` calls succeed. No-op for unsupported languages.
 */
export async function ensureLanguage(langId: string): Promise<void> {
  const loader = LANG_LOADERS[langId];
  if (!loader) return;
  const core = await getCore();
  if (!core.getLoadedLanguages().includes(langId)) {
    await core.loadLanguage(loader() as Parameters<typeof core.loadLanguage>[0]);
  }
}

/**
 * Synchronously tokenize when the core + language are already loaded; otherwise
 * null. Used by the editor overlay, where the visible layer must update in lock
 * step with each keystroke (no async lag behind the caret).
 */
export function tokenizeSync(
  code: string,
  langId: string,
  theme: ShikiThemeName,
): ThemedToken[][] | null {
  if (!coreInstance || !coreInstance.getLoadedLanguages().includes(langId)) return null;
  try {
    return coreInstance.codeToTokens(code, { lang: langId, theme }).tokens;
  } catch {
    return null;
  }
}

/**
 * Tokenize `code` for `langId` under `theme`. Returns a 2-D array (lines → tokens)
 * or null when the language is unsupported (caller renders plain text).
 */
export async function tokenizeCode(
  code: string,
  langId: string,
  theme: ShikiThemeName,
): Promise<ThemedToken[][] | null> {
  if (!isSupportedLang(langId)) return null;
  await ensureLanguage(langId);
  return tokenizeSync(code, langId, theme);
}

/** Translate a Shiki token's color/font-style into an inline React style. */
export function tokenStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  const fs = token.fontStyle ?? 0;
  if (fs > 0) {
    if (fs & 1) style.fontStyle = 'italic';
    if (fs & 2) style.fontWeight = 'bold';
    const deco: string[] = [];
    if (fs & 4) deco.push('underline');
    if (fs & 8) deco.push('line-through');
    if (deco.length) style.textDecoration = deco.join(' ');
  }
  return style;
}
