// Apply persisted/system theme before paint to avoid a flash of the wrong theme.
// Kept as an external file (not inline) so the CSP can drop script-src 'unsafe-inline'.
(function () {
  try {
    var mode = 'system';
    var raw = localStorage.getItem('saple-bridge-theme-store');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.state && parsed.state.mode) mode = parsed.state.mode;
    }
    var explicit = mode !== 'system';
    var resolved = explicit
      ? mode
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
