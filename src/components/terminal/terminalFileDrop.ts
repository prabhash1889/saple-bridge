// Formats OS-dropped file paths for insertion at a shell prompt: quotes any path containing
// whitespace, joins multiple with spaces, and leaves a trailing space so the user can keep
// typing (or hit enter). Double quotes work for ordinary paths in both PowerShell (Windows)
// and POSIX shells, so one rule covers both platforms.
// ponytail: only quotes on whitespace; a path with a literal `"` or `$` isn't escaped - rare
// enough to not warrant per-shell escaping. Upgrade to shell-aware quoting if it bites.
export function formatDroppedPaths(paths: string[]): string {
  const quoted = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p));
  return quoted.join(' ') + ' ';
}
