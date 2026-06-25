# Docked Browser in Terminal Room

## Summary

Add a browser dock inside the existing terminal room using a Tauri child WebView, not an iframe. The terminal grid stays on the left and resizes normally; the browser lives on the right as a separate native webview positioned over a React dock slot. This avoids iframe failures on common websites that block embedding.

## Key Changes

- Add a compact terminal workbench toolbar with a browser toggle button near the terminal section controls.
- Add frontend browser dock state:
  - open/closed
  - dock width
  - active tab id
  - tabs with title, URL, loading/error state
  - address/search input
- Change the terminal room layout from one full-width grid to a split layout:
  - left: existing terminal grid
  - right: browser dock shell when enabled
- Keep terminal panes as normal xterm panes; rely on their existing `ResizeObserver` fit logic to resize PTYs after the grid shrinks.
- On small widths, preserve a minimum terminal width and either collapse the browser dock or make it overlay within the terminal room.

## Tauri Browser Backend

- Add a Rust browser module, for example `browser.rs`, registered from `src-tauri/src/lib.rs`.
- Enable the required Tauri webview API support in `Cargo.toml`; current docs show `WebviewBuilder` behind Tauri's `unstable` feature, so first implementation step is a compile spike for child webview creation.
- Maintain a `BrowserRegistry` with tab id to child webview handle.
- Expose frontend commands:
  - `browser_create_tab(initial_url?)`
  - `browser_close_tab(tab_id)`
  - `browser_activate_tab(tab_id)`
  - `browser_navigate(tab_id, url_or_query)`
  - `browser_reload(tab_id)`
  - `browser_go_back(tab_id)`
  - `browser_go_forward(tab_id)`
  - `browser_set_bounds(x, y, width, height)`
  - `browser_set_visible(visible)`
- Normalize address input:
  - valid `http://` or `https://` URL: load directly
  - domain-like text such as `google.com`: prepend `https://`
  - other text: open configured search URL, defaulting to Google search
- Use Tauri child webview APIs for create, show/hide, set bounds, navigate, reload, title changes, and page load events. Use JS evaluation or native history support for back/forward depending on what compiles cleanly in Tauri 2.11.3.
- Do not expose Saple/Tauri privileged commands to external browser pages.

## Frontend Browser Dock

- Create a `BrowserDock` component with:
  - tab strip
  - new tab button
  - close tab button
  - back, forward, reload controls
  - combined address/search input
  - loading indicator
  - empty/error state for failed navigation
- Render only the browser chrome in React; the actual webpage is the native child webview aligned to the dock content rectangle.
- Add a placeholder element for the webpage area and measure it with `ResizeObserver`.
- Send measured bounds to Rust whenever:
  - browser opens/closes
  - terminal view becomes active/inactive
  - window resizes
  - dock width changes
  - tab chrome height changes
- Because heavy views stay mounted while hidden, explicitly call `browser_set_visible(false)` whenever the active app view is not `terminals`.

## UX Details

- The browser button should be a single icon button with tooltip, placed in the terminal workbench toolbar rather than inside individual panes.
- Dock width default: 42% of terminal room, clamped to a sensible minimum and maximum, for example `360px` minimum and `60%` maximum.
- Add a draggable vertical divider between terminals and browser.
- Closing the dock hides the native webview but preserves tabs for the current app session.
- Maximized terminal pane behavior: keep the browser dock visible and maximize within the left terminal area so "browser beside terminal" remains predictable.
- Visual style should match the existing command workbench: compact controls, restrained borders, no decorative cards, browser chrome quiet enough that terminals remain primary.

## Tests And Verification

- Typecheck/build:
  - `npm run build`
  - `cargo check --manifest-path apps/saple-bridge/src-tauri/Cargo.toml`
- Manual browser cases:
  - open browser dock from terminal room
  - terminals resize and remain usable
  - enter `https://example.com`
  - enter `google.com`
  - enter a plain search query
  - create, switch, and close tabs
  - reload, back, and forward work
  - switch away from terminals and confirm browser webview is hidden
  - switch back and confirm it reappears in the correct dock position
  - resize app window and drag dock divider
- Regression checks:
  - terminal pane add/remove/maximize still works
  - xterm focus and typing still work after browser toggles
  - browser does not appear over kanban/memory/review views
  - external pages cannot invoke privileged app APIs

## Assumptions

- Target is desktop Tauri, especially Windows/WebView2, not mobile.
- A native child WebView is acceptable even though it is positioned by Tauri rather than truly nested in the DOM.
- Browser history, cookies, and session state may be handled by the underlying WebView engine for v1.
- Downloads, permission prompts, bookmarks, extensions, and full Chrome feature parity are out of v1 unless explicitly added later.
