import React, { useEffect, useMemo, useRef, useState } from 'react';

const REVIEW_LINE_HEIGHT = 20;
const REVIEW_MIN_VIEWPORT_HEIGHT = 200;
const REVIEW_OVERSCAN_LINES = 12;

const getDiffLineClass = (line: string) => {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-line-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-line-deleted';
  if (line.startsWith('@@')) return 'diff-line-meta';
  return 'diff-line-normal';
};

export const VirtualizedTextViewer: React.FC<{ text: string; mode: 'diff' | 'code' }> = ({ text, mode }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Measure the scroll container so the virtualized window fills the available
  // panel height instead of a hard-coded value.
  const [viewportHeight, setViewportHeight] = useState(REVIEW_MIN_VIEWPORT_HEIGHT);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(Math.max(el.clientHeight, REVIEW_MIN_VIEWPORT_HEIGHT));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => text.split('\n'), [text]);
  const visibleCount = Math.ceil(viewportHeight / REVIEW_LINE_HEIGHT) + REVIEW_OVERSCAN_LINES * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / REVIEW_LINE_HEIGHT) - REVIEW_OVERSCAN_LINES);
  const endIndex = Math.min(lines.length, startIndex + visibleCount);
  const visibleLines = lines.slice(startIndex, endIndex);
  const totalHeight = Math.max(lines.length * REVIEW_LINE_HEIGHT, viewportHeight);

  return (
    <div
      ref={scrollRef}
      className={mode === 'code' ? 'diff-code-viewer-body' : 'diff-text'}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{
        height: '100%',
        minHeight: `${REVIEW_MIN_VIEWPORT_HEIGHT}px`,
        overflow: 'auto',
        background: mode === 'code' ? 'var(--bg-card)' : undefined,
        border: mode === 'code' ? '1px solid var(--border)' : undefined,
        borderRadius: mode === 'code' ? '4px' : undefined,
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${startIndex * REVIEW_LINE_HEIGHT}px)` }}>
          {visibleLines.map((line, offset) => {
            const lineNumber = startIndex + offset + 1;
            const className = mode === 'diff' ? getDiffLineClass(line) : 'code-line';

            return (
              <div
                key={lineNumber}
                className={className}
                style={{
                  minHeight: REVIEW_LINE_HEIGHT,
                  lineHeight: `${REVIEW_LINE_HEIGHT}px`,
                  display: 'flex',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  color: mode === 'code' ? 'var(--text-primary)' : undefined,
                  whiteSpace: 'pre',
                }}
              >
                {mode === 'code' && (
                  <span className="extracted-style-118"
                  >
                    {lineNumber}
                  </span>
                )}
                <span>{line || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
