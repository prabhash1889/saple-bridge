// Browsers / WebView2 cap simultaneous WebGL contexts (~16 per process). Each xterm
// WebGL renderer holds one context, so with many panes the cap is exceeded and the
// browser forcibly loses the oldest contexts, thrashing the GPU compositor. Cap the
// number of WebGL-accelerated panes; panes beyond the cap use the DOM renderer.
export const MAX_WEBGL_CONTEXTS = 8;

let activeWebglContexts = 0;

export const getActiveWebglContexts = () => activeWebglContexts;
export const incrementActiveWebglContexts = () => {
  activeWebglContexts += 1;
};
export const decrementActiveWebglContexts = () => {
  activeWebglContexts = Math.max(0, activeWebglContexts - 1);
};

// --- TEMP WebGL artifact diagnostics -------------------------------------------------
// Instrumentation to correlate the intermittent terminal render artifacts with WebGL
// context churn (acquire / release / evict / context-loss / DOM fallback). When you see
// an artifact, note the time and check the console: a `context-loss` or `evict` event
// immediately before it confirms the GPU-context juggling is the cause. Remove this block
// (and the webglDiag() calls in useXtermSession) once diagnosed.
const WEBGL_DIAG = true;
// Decisive A/B test: force every pane onto xterm's DOM renderer (skip WebGL entirely).
// Toggle live from the DevTools console WITHOUT a rebuild, then reload the window:
//   localStorage.setItem('saple-disable-webgl', '1')  // DOM renderer everywhere
//   localStorage.removeItem('saple-disable-webgl')     // back to WebGL
// If the artifacts disappear with WebGL disabled, the GPU-context juggling is the cause.
export const isWebglDisabled = () => {
  try {
    return localStorage.getItem('saple-disable-webgl') === '1';
  } catch {
    return false;
  }
};
export const webglDiag = (event: string, sessionId: string, extra?: Record<string, unknown>) => {
  if (!WEBGL_DIAG) return;
  // performance.now() is monotonic and avoids the Date.now() restrictions elsewhere.
  const t = Math.round(performance.now());
  // eslint-disable-next-line no-console
  console.log(
    `[webgl-diag +${t}ms] ${event} pane=${sessionId} active=${activeWebglContexts}/${MAX_WEBGL_CONTEXTS} holders=${webglHolders.size}`,
    extra ?? '',
  );
};
// -------------------------------------------------------------------------------------

// Panes that currently hold a WebGL context, mapped to their `unloadWebgl` release fn. When the
// context budget is spent, a newly-focused pane reclaims a context from a non-focused holder via
// this registry, so the pane the user is actually looking at always gets the GPU renderer even in
// rooms with more than MAX_WEBGL_CONTEXTS panes. Eviction frees a slot before a new context is
// acquired, so the hard cap is never exceeded.
export const webglHolders = new Map<string, () => void>();
