// P5 Local Preview accepts only loopback origins in its first release — the preview iframe and the
// CSP frame-src are both scoped to localhost / 127.0.0.1 / [::1]. This is the single validator both
// the input guard and any callers share, so "what counts as local" is defined in one place.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Parse `raw` into a loopback http(s) URL, or return null if it isn't one. A bare `localhost:3000`
// (no scheme) is treated as http:// for convenience. Anything non-loopback, non-http(s), or
// unparseable returns null so the caller can show a clear rejection.
export function parseLoopbackUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url;
}

export function isLoopbackUrl(raw: string): boolean {
  return parseLoopbackUrl(raw) !== null;
}
