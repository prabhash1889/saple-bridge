import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseUnifiedDiffToSplitRows, SplitCellKind } from '../../lib/diffSplit';

const LINE_HEIGHT = 20;
const MIN_VIEWPORT_HEIGHT = 200;
const OVERSCAN_LINES = 12;

const cellClass = (kind: SplitCellKind) => {
  if (kind === 'add') return 'split-diff-cell diff-line-added';
  if (kind === 'del') return 'split-diff-cell diff-line-deleted';
  if (kind === 'meta') return 'split-diff-cell diff-line-meta';
  if (kind === 'empty') return 'split-diff-cell split-diff-empty';
  return 'split-diff-cell diff-line-normal';
};

// Virtualized side-by-side diff. Same windowing approach as VirtualizedTextViewer,
// so very large diffs stay cheap to render.
export const SplitDiffViewer: React.FC<{ diff: string }> = ({ diff }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(MIN_VIEWPORT_HEIGHT);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(Math.max(el.clientHeight, MIN_VIEWPORT_HEIGHT));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => parseUnifiedDiffToSplitRows(diff), [diff]);
  const visibleCount = Math.ceil(viewportHeight / LINE_HEIGHT) + OVERSCAN_LINES * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN_LINES);
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);
  const totalHeight = Math.max(rows.length * LINE_HEIGHT, viewportHeight);

  if (rows.length === 0) {
    return <div className="compact-empty">No diff content to display.</div>;
  }

  return (
    <div
      ref={scrollRef}
      className="split-diff-viewer"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative', minWidth: 'fit-content' }}>
        <div style={{ transform: `translateY(${startIndex * LINE_HEIGHT}px)` }}>
          {visibleRows.map((row, offset) => {
            const rowIndex = startIndex + offset;
            return (
              <div key={rowIndex} className="split-diff-row" style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}>
                <span className={cellClass(row.left.kind)}>
                  <span className="diff-line-number">{row.left.num ?? ''}</span>
                  <span className="split-diff-text">{row.left.text || ' '}</span>
                </span>
                <span className={cellClass(row.right.kind)}>
                  <span className="diff-line-number">{row.right.num ?? ''}</span>
                  <span className="split-diff-text">{row.right.text || ' '}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
