// Unified-diff -> side-by-side rows for the Review room's split view.

export type SplitCellKind = 'ctx' | 'del' | 'add' | 'empty' | 'meta';

export interface SplitCell {
  num: number | null;
  text: string;
  kind: SplitCellKind;
}

export interface SplitRow {
  left: SplitCell;
  right: SplitCell;
}

const EMPTY_CELL: SplitCell = { num: null, text: '', kind: 'empty' };

const isHeaderLine = (line: string) =>
  line.startsWith('+++') ||
  line.startsWith('---') ||
  line.startsWith('diff ') ||
  line.startsWith('index ') ||
  line.startsWith('new file') ||
  line.startsWith('deleted file') ||
  line.startsWith('similarity') ||
  line.startsWith('rename') ||
  line.startsWith('Binary') ||
  line.startsWith('\\');

/// Parse a unified diff into side-by-side rows: deletions pair with the additions
/// that replaced them, context lines span both sides.
export function parseUnifiedDiffToSplitRows(diff: string): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = diff.replace(/\n$/, '').split('\n');
  let oldNum = 0;
  let newNum = 0;
  let inHunk = false;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flushPairs = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i += 1) {
      rows.push({ left: dels[i] ?? EMPTY_CELL, right: adds[i] ?? EMPTY_CELL });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushPairs();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNum = parseInt(m[1], 10);
        newNum = parseInt(m[2], 10);
      }
      inHunk = true;
      rows.push({ left: { num: null, text: line, kind: 'meta' }, right: { num: null, text: '', kind: 'meta' } });
    } else if (isHeaderLine(line) || !inHunk) {
      // File headers and anything before the first hunk are not content lines.
    } else if (line.startsWith('-')) {
      dels.push({ num: oldNum, text: line.slice(1), kind: 'del' });
      oldNum += 1;
    } else if (line.startsWith('+')) {
      adds.push({ num: newNum, text: line.slice(1), kind: 'add' });
      newNum += 1;
    } else {
      flushPairs();
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({
        left: { num: oldNum, text, kind: 'ctx' },
        right: { num: newNum, text, kind: 'ctx' },
      });
      oldNum += 1;
      newNum += 1;
    }
  }
  flushPairs();
  return rows;
}
