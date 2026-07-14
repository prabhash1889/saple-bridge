// Row-based "brick" tiling model for the terminal grid, with a special case for exactly 3
// panes (one tall pane on the left, two stacked on the right). Each row fills the full width
// and splits evenly among its own panes by default, so odd counts stagger (5 = 3 on top, 2
// stretched on the bottom). Users drag the gutters between panes to resize, and those
// fractions persist per workspace. All values here are fractions of the grid (0..1); the
// component turns them into `%` positions. Kept framework-free so the geometry is unit-testable.

export interface RowsLayout {
  kind: 'rows';
  rowH: number[]; // height fraction per row (sums to 1)
  colW: number[][]; // width fraction per column, per row (each row sums to 1)
}

export interface TripleLayout {
  kind: 'triple';
  leftW: number; // width fraction of the tall left pane
  rightTopH: number; // height fraction of the top-right pane within the right column
}

export type GridLayout = RowsLayout | TripleLayout;

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Gutter =
  | { kind: 'row'; rowIndex: number; rect: PaneRect } // horizontal divider, drag adjusts row heights
  | { kind: 'col'; rowIndex: number; colIndex: number; rect: PaneRect } // vertical divider within a row
  | { kind: 'triple-v'; rect: PaneRect }
  | { kind: 'triple-h'; rect: PaneRect };

// Smallest fraction a pane may shrink to along either axis, so a drag can never collapse a
// pane to nothing (which would give xterm a degenerate 0-col/row size).
const MIN = 0.08;

// How many rows for a given pane count. Always two rows past 2 panes (1 row for 1-2 panes,
// 3 is special-cased in evenLayout) - never a third row, no matter how many panes are open.
export const rowCountFor = (n: number): number => (n <= 2 ? 1 : 2);

// Panes per row, extra panes weighted to the top rows (5 -> [3,2], 7 -> [4,3], 9 -> [5,4]).
export const rowDistribution = (n: number): number[] => {
  const rows = rowCountFor(n);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
};

export const evenLayout = (n: number): GridLayout => {
  if (n === 3) return { kind: 'triple', leftW: 0.5, rightTopH: 0.5 };
  const dist = rowDistribution(n);
  return {
    kind: 'rows',
    rowH: dist.map(() => 1 / dist.length),
    colW: dist.map((cols) => Array.from({ length: cols }, () => 1 / cols)),
  };
};

// Does a persisted layout still match the current pane count / row shape? Adding or removing a
// pane re-balances to an even split, so a stored layout only applies when the shape is identical.
export const layoutFitsCount = (layout: GridLayout, n: number): boolean => {
  if (n === 3) return layout.kind === 'triple';
  if (layout.kind !== 'rows') return false;
  const dist = rowDistribution(n);
  if (layout.rowH.length !== dist.length) return false;
  return dist.every((cols, r) => layout.colW[r]?.length === cols);
};

export const paneRects = (layout: GridLayout, n: number): PaneRect[] => {
  if (layout.kind === 'triple') {
    const { leftW, rightTopH } = layout;
    return [
      { left: 0, top: 0, width: leftW, height: 1 },
      { left: leftW, top: 0, width: 1 - leftW, height: rightTopH },
      { left: leftW, top: rightTopH, width: 1 - leftW, height: 1 - rightTopH },
    ];
  }
  const dist = rowDistribution(n);
  const rects: PaneRect[] = [];
  let y = 0;
  for (let r = 0; r < dist.length; r++) {
    const h = layout.rowH[r];
    let x = 0;
    for (let c = 0; c < dist[r]; c++) {
      const w = layout.colW[r][c];
      rects.push({ left: x, top: y, width: w, height: h });
      x += w;
    }
    y += h;
  }
  return rects;
};

export const gutters = (layout: GridLayout, n: number): Gutter[] => {
  if (layout.kind === 'triple') {
    const { leftW, rightTopH } = layout;
    return [
      { kind: 'triple-v', rect: { left: leftW, top: 0, width: 0, height: 1 } },
      { kind: 'triple-h', rect: { left: leftW, top: rightTopH, width: 1 - leftW, height: 0 } },
    ];
  }
  const dist = rowDistribution(n);
  const out: Gutter[] = [];
  let y = 0;
  for (let r = 0; r < dist.length; r++) {
    const h = layout.rowH[r];
    let x = 0;
    for (let c = 0; c < dist[r]; c++) {
      const w = layout.colW[r][c];
      if (c < dist[r] - 1) {
        out.push({ kind: 'col', rowIndex: r, colIndex: c, rect: { left: x + w, top: y, width: 0, height: h } });
      }
      x += w;
    }
    if (r < dist.length - 1) {
      out.push({ kind: 'row', rowIndex: r, rect: { left: 0, top: y + h, width: 1, height: 0 } });
    }
    y += h;
  }
  return out;
};

// Split a delta between two adjacent fractions that must keep their combined size, clamping so
// neither drops below MIN.
const shiftPair = (a: number, b: number, delta: number): [number, number] => {
  const sum = a + b;
  const na = Math.min(Math.max(a + delta, MIN), sum - MIN);
  return [na, sum - na];
};

// Apply a drag (deltaFrac = pixels moved / container size along the axis) to the layout the
// drag started from, returning a new layout. Always call with the drag-start snapshot so the
// delta is absolute, not compounding.
export const applyDrag = (layout: GridLayout, g: Gutter, deltaFrac: number): GridLayout => {
  if (layout.kind === 'triple') {
    if (g.kind === 'triple-v') {
      return { ...layout, leftW: Math.min(Math.max(layout.leftW + deltaFrac, MIN), 1 - MIN) };
    }
    if (g.kind === 'triple-h') {
      return { ...layout, rightTopH: Math.min(Math.max(layout.rightTopH + deltaFrac, MIN), 1 - MIN) };
    }
    return layout;
  }
  if (g.kind === 'row') {
    const rowH = [...layout.rowH];
    const [a, b] = shiftPair(rowH[g.rowIndex], rowH[g.rowIndex + 1], deltaFrac);
    rowH[g.rowIndex] = a;
    rowH[g.rowIndex + 1] = b;
    return { ...layout, rowH };
  }
  if (g.kind === 'col') {
    const colW = layout.colW.map((row) => [...row]);
    const row = colW[g.rowIndex];
    const [a, b] = shiftPair(row[g.colIndex], row[g.colIndex + 1], deltaFrac);
    row[g.colIndex] = a;
    row[g.colIndex + 1] = b;
    return { ...layout, colW };
  }
  return layout;
};
