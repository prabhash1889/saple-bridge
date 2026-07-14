// Embedded browser tabs: each tab is a native child webview added to the main window and
// positioned over the React-rendered placeholder (`.browser-viewport`). Rust holds no tab
// state - tabs are found by their webview label `browser-<tabId>`; the frontend
// (browserStore) owns which tabs exist, which is active, and where the panel sits.

use serde::Serialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl,
    Window,
};

const LABEL_PREFIX: &str = "browser-";

#[derive(Clone, Serialize)]
struct TabNav {
    id: String,
    url: String,
    loading: bool,
}

fn tab_label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

fn get_tab<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Webview<R>, String> {
    app.webviews()
        .get(&tab_label(id))
        .cloned()
        .ok_or_else(|| format!("browser tab '{id}' not found"))
}

fn parse_url(url: &str) -> Result<Url, String> {
    url.parse().map_err(|e| format!("invalid url '{url}': {e}"))
}

// All commands here are `async` deliberately: Tauri runs sync commands on the main thread,
// where `add_child` (and this file's blocking waits) deadlock the event loop. Async commands
// run on a worker task, letting webview operations dispatch to the main thread and return.
#[tauri::command]
pub async fn browser_open_tab<R: Runtime>(
    window: Window<R>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = tab_label(&id);
    let parsed = parse_url(&url)?;
    let tab_id = id.clone();
    // Creation runs on the main thread; the channel carries the result back. Serializing on
    // the main thread also makes the exists-check race-free: concurrent duplicate requests
    // (React StrictMode re-runs effects) become idempotent no-ops instead of errors.
    let (tx, rx) = std::sync::mpsc::channel();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            if win.webviews().iter().any(|w| w.label() == label) {
                let _ = tx.send(Ok(()));
                return;
            }
            let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
                // Push every navigation (link clicks, redirects, history) to the main webview
                // so the URL bar and tab label stay current without polling.
                .on_page_load(move |webview, payload| {
                    let _ = webview.emit_to(
                        "main",
                        "browser-tab-nav",
                        TabNav {
                            id: tab_id.clone(),
                            url: payload.url().to_string(),
                            loading: matches!(payload.event(), PageLoadEvent::Started),
                        },
                    );
                });
            let result = win
                .add_child(
                    builder,
                    LogicalPosition::new(x, y),
                    LogicalSize::new(width, height),
                )
                .map(|_| ())
                .map_err(|e| e.to_string());
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browser_close_tab<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    get_tab(&app, &id)?.close().map_err(|e| e.to_string())
}

/// Keep every tab webview aligned with the placeholder rect (logical/CSS px, relative to
/// the window client area). Applied to all tabs so switching never shows a stale rect.
#[tauri::command]
pub async fn browser_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    for (label, webview) in app.webviews() {
        if label.starts_with(LABEL_PREFIX) {
            webview
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            webview
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Show only the active tab (or nothing). Also the overlay escape hatch: native webviews
/// render above all DOM, so the command palette / dialogs suppress the browser entirely
/// by passing `active_id: None`.
#[tauri::command]
pub async fn browser_set_visible<R: Runtime>(
    app: AppHandle<R>,
    active_id: Option<String>,
) -> Result<(), String> {
    let active_label = active_id.map(|id| tab_label(&id));
    for (label, webview) in app.webviews() {
        if !label.starts_with(LABEL_PREFIX) {
            continue;
        }
        let result = if Some(&label) == active_label.as_ref() {
            webview.show()
        } else {
            webview.hide()
        };
        result.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    url: String,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    get_tab(&app, &id)?
        .navigate(parsed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    get_tab(&app, &id)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    get_tab(&app, &id)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    get_tab(&app, &id)?
        .eval("location.reload()")
        .map_err(|e| e.to_string())
}
