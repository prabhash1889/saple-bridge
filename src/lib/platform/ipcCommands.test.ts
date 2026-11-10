import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { IPC_COMMANDS } from './ipcCommands';

// Contract check: the registry in `ipcCommands.ts`, the Rust handler
// registration in `src-tauri/src/lib.rs`, and every actual `invoke(...)` call
// site under `src/` must describe the same command set. Sources are loaded as
// raw text via import.meta.glob, so no Node APIs are needed.

const FRONTEND_SOURCES = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const RUST_LIB = import.meta.glob<string>('/src-tauri/src/lib.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const CALLABLE_SOURCES = new Map(
  Object.entries(FRONTEND_SOURCES).filter(([file]) => !/\.test\.(ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file)),
);

function parseRustHandlerNames(): string[] {
  const source = RUST_LIB['/src-tauri/src/lib.rs'];
  expect(source, 'src-tauri/src/lib.rs was not loaded').toBeTruthy();
  const marker = 'generate_handler![';
  const start = source.indexOf(marker);
  expect(start, 'generate_handler![ block not found in src-tauri/src/lib.rs').toBeGreaterThanOrEqual(0);
  let depth = 1;
  let i = start + marker.length;
  let block = '';
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    block += ch;
    i += 1;
  }
  return block
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    // Entries may be module-qualified (`pty::spawn_pty`); the wire name is the fn identifier.
    .map((entry) => entry.split('::').pop()!.trim());
}

function extractInvokeCallSites(file: string, text: string): { names: string[]; dynamic: string[] } {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const dynamic: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invoke') {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        names.push(first.text);
      } else if (
        first &&
        ts.isConditionalExpression(first) &&
        ts.isStringLiteral(first.whenTrue) &&
        ts.isStringLiteral(first.whenFalse)
      ) {
        names.push(first.whenTrue.text, first.whenFalse.text);
      } else {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        dynamic.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { names, dynamic };
}

describe('IPC command registry contract', () => {
  it('matches the Rust generate_handler set exactly', () => {
    const rustHandlers = parseRustHandlerNames().sort();
    expect(rustHandlers.length, 'lib.rs registers no commands?').toBeGreaterThan(0);
    expect([...IPC_COMMANDS].sort()).toEqual(rustHandlers);
  });

  it('every invoke call site under src/ uses a registered command name', () => {
    expect(CALLABLE_SOURCES.size).toBeGreaterThan(0);

    const invoked = new Set<string>();
    const unknown: string[] = [];
    for (const [file, text] of CALLABLE_SOURCES) {
      const { names } = extractInvokeCallSites(file, text);
      for (const name of names) {
        invoked.add(name);
        if (!IPC_COMMANDS.some((cmd) => cmd === name)) {
          unknown.push(`${file}: invoke('${name}') is not in ipcCommands.ts`);
        }
      }
    }
    // Sanity: the scanner must actually see real traffic, otherwise this test
    // could pass vacuously after a glob or import rename.
    expect(invoked.size, 'suspiciously few distinct invoke names found').toBeGreaterThan(30);
    expect(unknown, 'invoke calls naming unregistered commands').toEqual([]);
  });

  it('has no dynamic (non-literal) invoke command names that bypass the contract', () => {
    const unresolved: string[] = [];
    for (const [file, text] of CALLABLE_SOURCES) {
      const { dynamic } = extractInvokeCallSites(file, text);
      unresolved.push(...dynamic);
    }
    // Ternaries between two literals are fine; anything else must be added to
    // this allowlist with a comment justifying why the name cannot be literal.
    const allowed = new Set<string>([]);
    expect(
      unresolved.filter((site) => !allowed.has(site)),
      'dynamic invoke sites need review or an explicit allowlist entry',
    ).toEqual([]);
  });
});
