import { describe, expect, it } from 'vitest';
import {
  applyDrag,
  evenLayout,
  gutters,
  layoutFitsCount,
  paneRects,
  rowDistribution,
  type RowsLayout,
} from './terminalLayout';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('rowDistribution', () => {
  it('matches the sketched brick layouts', () => {
    expect(rowDistribution(2)).toEqual([2]);
    expect(rowDistribution(4)).toEqual([2, 2]);
    expect(rowDistribution(5)).toEqual([3, 2]); // 3 on top, 2 stretched below
    expect(rowDistribution(6)).toEqual([3, 3]);
    expect(rowDistribution(7)).toEqual([4, 3]);
    expect(rowDistribution(8)).toEqual([4, 4]);
    expect(rowDistribution(12)).toEqual([4, 4, 4]);
    expect(rowDistribution(16)).toEqual([4, 4, 4, 4]);
  });

  it('always accounts for every pane', () => {
    for (let n = 1; n <= 16; n++) expect(sum(rowDistribution(n))).toBe(n);
  });
});

describe('paneRects', () => {
  it('produces one full-coverage, non-overlapping rect per pane', () => {
    for (let n = 1; n <= 16; n++) {
      const rects = paneRects(evenLayout(n), n);
      expect(rects).toHaveLength(n);
      // Every rect sits inside the unit square and the areas tile it exactly.
      const area = rects.reduce((acc, r) => {
        expect(r.left).toBeGreaterThanOrEqual(-1e-9);
        expect(r.top).toBeGreaterThanOrEqual(-1e-9);
        expect(r.left + r.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.top + r.height).toBeLessThanOrEqual(1 + 1e-9);
        return acc + r.width * r.height;
      }, 0);
      expect(area).toBeCloseTo(1, 6);
    }
  });

  it('lays out the 3-pane special case as tall-left + two-stacked-right', () => {
    const [left, top, bottom] = paneRects(evenLayout(3), 3);
    expect(left).toMatchObject({ left: 0, top: 0, height: 1 });
    expect(top.left).toBeCloseTo(left.width);
    expect(bottom.left).toBeCloseTo(left.width);
    expect(top.height + bottom.height).toBeCloseTo(1);
  });
});

describe('applyDrag', () => {
  it('keeps the pair sum constant and respects the min size', () => {
    const layout = evenLayout(6) as RowsLayout; // [3,3]
    const colGutter = gutters(layout, 6).find((g) => g.kind === 'col')!;
    // Yank far past the edge; the neighbour must not collapse below the 0.08 floor.
    const dragged = applyDrag(layout, colGutter, -5) as RowsLayout;
    expect(sum(dragged.colW[0])).toBeCloseTo(1);
    expect(Math.min(...dragged.colW[0])).toBeGreaterThanOrEqual(0.08 - 1e-9);
    // Pane count is untouched by a resize.
    expect(paneRects(dragged, 6)).toHaveLength(6);
  });
});

describe('layoutFitsCount', () => {
  it('accepts a matching shape and rejects a stale one', () => {
    expect(layoutFitsCount(evenLayout(6), 6)).toBe(true);
    expect(layoutFitsCount(evenLayout(6), 7)).toBe(false);
    expect(layoutFitsCount(evenLayout(3), 3)).toBe(true);
    expect(layoutFitsCount(evenLayout(4), 3)).toBe(false);
  });
});
