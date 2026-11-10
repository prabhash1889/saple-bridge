// Context-window math for the Claude pane badge. Transcript model ids (e.g.
// "claude-opus-4-8") do not reveal whether the session runs with the 1M-context beta -
// only an explicit "[1m]" model suffix marks it - but some model families (Fable/Mythos)
// have a 1M window natively. Everything else assumes the standard 200k window. After an
// auto-compact the reported usage shrinks and the badge self-corrects on the next poll.
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;

// Model families whose bare API id already means a 1M window, no [1m] beta marker.
const NATIVE_1M_FAMILIES = ['fable', 'mythos'];

export interface ClaudeContextUsage {
  usedTokens: number;
  model: string;
}

export function contextWindowFor(model: string): number {
  const is1m = model.includes('[1m]') || NATIVE_1M_FAMILIES.some((f) => model.includes(f));
  return is1m ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/** Whole percent of the context window still free, clamped to 0..100. */
export function contextLeftPercent(usedTokens: number, model: string): number {
  // Usage beyond 200k proves a 1M window even when no marker says so (opus/sonnet
  // sessions switched to 1M via /model or launched with an explicit --model).
  // ponytail: below 200k such sessions still read as 200k - the transcript records
  // no window size, so there is nothing better to infer from.
  const window =
    usedTokens > DEFAULT_CONTEXT_WINDOW ? LARGE_CONTEXT_WINDOW : contextWindowFor(model);
  const left = 100 * (1 - usedTokens / window);
  return Math.min(100, Math.max(0, Math.round(left)));
}
