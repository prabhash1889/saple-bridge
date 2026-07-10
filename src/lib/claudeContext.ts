// Context-window math for the Claude pane badge. Transcript model ids (e.g.
// "claude-opus-4-8") do not reveal whether the session runs with the 1M-context beta -
// only an explicit "[1m]" model suffix marks it - so everything else assumes the
// standard 200k window. After an auto-compact the reported usage shrinks and the badge
// self-corrects on the next poll.
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

export interface ClaudeContextUsage {
  usedTokens: number;
  model: string;
}

export function contextWindowFor(model: string): number {
  return model.includes('[1m]') ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** Whole percent of the context window still free, clamped to 0..100. */
export function contextLeftPercent(usedTokens: number, model: string): number {
  const left = 100 * (1 - usedTokens / contextWindowFor(model));
  return Math.min(100, Math.max(0, Math.round(left)));
}
