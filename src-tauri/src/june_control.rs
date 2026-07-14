//! June control endpoint (PLAN.md §2/§6 Phase 1).
//!
//! A localhost-only, token-authed HTTP endpoint that lets June (a separate app) drive this bridge
//! through exactly three operations - `capabilities` / `command` / `observe`. Authority stays in the
//! renderer for now: a `command` is forwarded to the webview as a Tauri event, a thin dispatcher
//! there calls the existing store actions, and the result comes back through the
//! [`june_command_result`] command. State changes the renderer makes are appended to a sequenced
//! event log via [`june_emit_event`], which `observe` replays.
//!
//! This module owns the parts that must be correct independent of the transport: the monotonic event
//! log, `observe(after_sequence)` resume, and request idempotency (retrying a `request_id` replays
//! the original result and creates nothing new). Those are unit-tested at the bottom. The HTTP
//! server ([`serve`]) and the Tauri wiring are thin shells over this core.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// A dispatched command waits at most this long for the renderer to report a result before the
/// endpoint returns a `provider_failure`. Generous: a batch spawn of many agents is slow.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Tauri event the renderer dispatcher listens on. Its payload is `{ correlation_id, workspace_id,
/// action, arguments }`; the dispatcher replies through [`june_command_result`].
const COMMAND_EVENT: &str = "june://command";

pub const CONTRACT_VERSION: u64 = 1;
pub const MAX_CONCURRENT_AGENTS: u64 = 16;
pub const MAX_BATCH_SIZE: u64 = 16;

/// Actions bridge accepts. Kept in lockstep with June's `src/contract/types.ts` `ACTIONS`.
pub const ACTIONS: &[&str] = &[
    "spawn_agents",
    "assign_task",
    "write_terminal",
    "close_terminal",
    "open_browser",
    "close_browser",
    "get_swarm_status",
];

/// The single non-mutating action - it never carries a `request_id` and is never deduplicated.
fn is_mutating(action: &str) -> bool {
    action != "get_swarm_status"
}

/// One ordered state change. Serialized to June exactly as the contract's `Event`.
#[derive(Clone, Serialize)]
pub struct Event {
    pub sequence: u64,
    pub workspace_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

/// A completed command's outcome, kept for idempotent replay. `fingerprint` is a hash of
/// (action, arguments); a retry with the same fingerprint replays `response`, a reuse of the same
/// `request_id` with a *different* fingerprint is a `duplicate_request` error (PLAN.md §2).
struct StoredResult {
    fingerprint: u64,
    response: Value,
}

#[derive(Default)]
pub struct Inner {
    events: Vec<Event>,
    next_seq: u64,
    results: HashMap<String, StoredResult>,
    /// In-flight commands awaiting a renderer result, keyed by `request_id`.
    pending: HashMap<String, Sender<Value>>,
}

/// Managed Tauri state. The HTTP thread and the Tauri commands share this behind a mutex; the token
/// is minted once at startup and never changes for the process lifetime.
pub struct JuneControl {
    inner: Mutex<Inner>,
    pub token: String,
}

/// Outcome of the idempotency pre-check run before a mutating command is dispatched.
pub enum Idempotency {
    /// First time we have seen this `request_id`; go ahead and dispatch.
    Fresh,
    /// Seen before with the same payload - replay this stored response, dispatch nothing.
    Replay(Value),
    /// Seen before with a *different* payload - reject.
    Conflict,
}

fn fingerprint(action: &str, arguments: &Value) -> u64 {
    let mut h = DefaultHasher::new();
    action.hash(&mut h);
    // serde_json's Value serializes object keys in sorted order, so this is stable.
    arguments.to_string().hash(&mut h);
    h.finish()
}

pub fn error_response(request_id: &str, code: &str, message: impl Into<String>) -> Value {
    json!({
        "status": "error",
        "request_id": request_id,
        "error": { "code": code, "message": message.into() },
    })
}

impl JuneControl {
    pub fn new(token: String) -> Self {
        JuneControl {
            inner: Mutex::new(Inner::default()),
            token,
        }
    }

    pub fn capabilities(&self, bridge_version: &str) -> Value {
        json!({
            "contract_version": CONTRACT_VERSION,
            "bridge_version": bridge_version,
            "actions": ACTIONS,
            "limits": {
                "max_concurrent_agents": MAX_CONCURRENT_AGENTS,
                "max_batch_size": MAX_BATCH_SIZE,
            },
        })
    }

    /// Append a renderer-reported state change and hand back the sequenced event (for broadcast).
    pub fn record_event(
        &self,
        workspace_id: String,
        kind: String,
        request_id: Option<String>,
        payload: Value,
    ) -> Event {
        let mut inner = self.inner.lock().unwrap();
        inner.next_seq += 1;
        let ev = Event {
            sequence: inner.next_seq,
            workspace_id,
            kind,
            request_id,
            payload,
        };
        inner.events.push(ev.clone());
        ev
    }

    /// `observe(after_sequence)`: events strictly after `after` for this workspace, plus the highest
    /// sequence held for it so June knows whether it is caught up.
    pub fn observe(&self, workspace_id: &str, after: u64) -> Value {
        let inner = self.inner.lock().unwrap();
        let mut latest = 0u64;
        let mut events = Vec::new();
        for ev in &inner.events {
            if ev.workspace_id != workspace_id {
                continue;
            }
            latest = latest.max(ev.sequence);
            if ev.sequence > after {
                events.push(ev.clone());
            }
        }
        json!({ "workspace_id": workspace_id, "events": events, "latest_sequence": latest })
    }

    /// Pre-dispatch idempotency check for a mutating command. Non-mutating actions never reach here.
    pub fn check_idempotency(&self, request_id: &str, action: &str, arguments: &Value) -> Idempotency {
        let inner = self.inner.lock().unwrap();
        match inner.results.get(request_id) {
            None => Idempotency::Fresh,
            Some(stored) if stored.fingerprint == fingerprint(action, arguments) => {
                Idempotency::Replay(stored.response.clone())
            }
            Some(_) => Idempotency::Conflict,
        }
    }

    /// Store a completed mutating command's response for future idempotent replay.
    pub fn remember_result(&self, request_id: &str, action: &str, arguments: &Value, response: &Value) {
        if !is_mutating(action) {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.results.insert(
            request_id.to_string(),
            StoredResult {
                fingerprint: fingerprint(action, arguments),
                response: response.clone(),
            },
        );
    }

    /// Register a channel to receive the renderer's result for a dispatched command. Returns the
    /// receiver the HTTP handler blocks on.
    pub fn register_pending(&self, request_id: &str) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        self.inner.lock().unwrap().pending.insert(request_id.to_string(), tx);
        rx
    }

    /// Called by [`june_command_result`] when the renderer reports a command outcome. Returns false
    /// if no handler was waiting (already timed out or unknown id).
    pub fn resolve_pending(&self, request_id: &str, result: Value) -> bool {
        let sender = self.inner.lock().unwrap().pending.remove(request_id);
        match sender {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    pub fn discard_pending(&self, request_id: &str) {
        self.inner.lock().unwrap().pending.remove(request_id);
    }
}

// ---------------------------------------------------------------------------
// Enable toggle + discovery record. Mirrors the `agent_browser` opt-in pattern: a flag file under
// the app config dir gates the endpoint, and enabling/disabling takes effect on next launch (the
// server binds once at startup). June finds a running bridge by reading the discovery record.
// ---------------------------------------------------------------------------

/// `%APPDATA%\ai.saple.bridge` on Windows - Tauri's app_config_dir, computed from the env because
/// startup has no AppHandle. Keep the identifier in sync with tauri.conf.json.
fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("ai.saple.bridge"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|d| PathBuf::from(d).join(".config").join("ai.saple.bridge"))
    }
}

fn enable_flag_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("june-control.enabled"))
}

/// The discovery record June reads to find and authenticate to a running bridge (PLAN.md §5).
/// Written on start, removed on clean shutdown; a stale record is detected by its dead `pid`.
fn discovery_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("june-control.json"))
}

pub fn is_enabled() -> bool {
    enable_flag_path().map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn june_control_get_enabled() -> bool {
    is_enabled()
}

/// Toggle the endpoint on/off for the next launch. Returns nothing to start now - like the agent
/// browser, the change applies on restart because the server binds once at startup.
#[tauri::command]
pub fn june_control_set_enabled(enabled: bool) -> Result<(), String> {
    let path = enable_flag_path().ok_or("cannot resolve app config directory")?;
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, "1").map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_discovery_record(endpoint: &str, token: &str, version: &str) {
    let Some(path) = discovery_path() else { return };
    let record = json!({
        "protocol_version": CONTRACT_VERSION,
        "pid": std::process::id(),
        "endpoint": endpoint,
        "token": token,
        "version": version,
    });
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Temp-file + rename so June never reads a half-written record.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, record.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Remove the discovery record on clean shutdown so June rejects a dead endpoint immediately instead
/// of falling back to the (slower) stale-PID check.
pub fn remove_discovery_record() {
    if let Some(path) = discovery_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// Start the endpoint if the user has opted in. Binds an ephemeral loopback port, writes the
/// discovery record, and serves requests on a background thread. No-op (and no open port) when the
/// toggle is off.
pub fn start(app: AppHandle) {
    if !is_enabled() {
        return;
    }
    let server = match tiny_http::Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[june-control] failed to bind: {e}");
            return;
        }
    };
    let endpoint = match server.server_addr().to_ip() {
        Some(addr) => format!("http://{addr}"),
        None => return,
    };
    let token = app.state::<JuneControl>().token.clone();
    let version = app.package_info().version.to_string();
    write_discovery_record(&endpoint, &token, &version);
    eprintln!("[june-control] listening on {endpoint}");

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            // Thread-per-request: `command` blocks up to COMMAND_TIMEOUT on the renderer, so it must
            // not stall `observe` polls. ponytail: fine for a single local client (June).
            std::thread::spawn(move || handle_request(app, request));
        }
    });
}

fn respond_json(request: tiny_http::Request, status: u16, body: &Value) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let response = tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn authorized(request: &tiny_http::Request, token: &str) -> bool {
    request.headers().iter().any(|h| {
        h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}")
    })
}

fn handle_request(app: AppHandle, mut request: tiny_http::Request) {
    let control = app.state::<JuneControl>();
    if !authorized(&request, &control.token) {
        return respond_json(request, 401, &json!({ "error": "unauthorized" }));
    }

    let method = request.method().to_string();
    let url = request.url().to_string();

    // GET /capabilities - no body.
    if method == "GET" && url == "/capabilities" {
        let caps = control.capabilities(&app.package_info().version.to_string());
        return respond_json(request, 200, &caps);
    }

    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        return respond_json(request, 400, &json!({ "error": "unreadable body" }));
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return respond_json(request, 400, &json!({ "error": format!("bad json: {e}") })),
    };

    match (method.as_str(), url.as_str()) {
        ("POST", "/observe") => {
            let ws = parsed["workspace_id"].as_str().unwrap_or("");
            let after = parsed["after_sequence"].as_u64().unwrap_or(0);
            respond_json(request, 200, &control.observe(ws, after));
        }
        ("POST", "/command") => {
            // Contract errors ride in the body with HTTP 200; only transport faults use 4xx/5xx.
            let response = run_command(&app, &control, &parsed);
            respond_json(request, 200, &response);
        }
        _ => respond_json(request, 404, &json!({ "error": "not found" })),
    }
}

/// The command pipeline: validate -> idempotency -> dispatch to renderer -> await result. Returns a
/// contract `CommandResponse` value in every branch (errors included).
fn run_command(app: &AppHandle, control: &JuneControl, req: &Value) -> Value {
    let request_id = req["request_id"].as_str().unwrap_or("").to_string();
    let workspace_id = req["workspace_id"].as_str().unwrap_or("").to_string();
    let action = req["action"].as_str().unwrap_or("").to_string();
    let arguments = req.get("arguments").cloned().unwrap_or(json!({}));

    if !ACTIONS.contains(&action.as_str()) {
        return error_response(&request_id, "invalid_request", format!("unknown action '{action}'"));
    }
    let mutating = is_mutating(&action);
    if mutating && request_id.is_empty() {
        return error_response(&request_id, "invalid_request", "mutating command needs a request_id");
    }

    // Idempotency: replay a prior result, reject a conflicting reuse of the id.
    if mutating {
        match control.check_idempotency(&request_id, &action, &arguments) {
            Idempotency::Replay(v) => return v,
            Idempotency::Conflict => {
                return error_response(&request_id, "duplicate_request", "request_id reused with a different payload")
            }
            Idempotency::Fresh => {}
        }
    }

    // Correlation id ties the renderer's reply back to this waiter (mutating uses request_id;
    // get_swarm_status has none, so mint one).
    let correlation_id = if request_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        request_id.clone()
    };
    let rx = control.register_pending(&correlation_id);

    if app
        .emit(
            COMMAND_EVENT,
            json!({
                "correlation_id": correlation_id,
                "request_id": request_id,
                "workspace_id": workspace_id,
                "action": action,
                "arguments": arguments,
            }),
        )
        .is_err()
    {
        control.discard_pending(&correlation_id);
        return error_response(&request_id, "bridge_unavailable", "no window to dispatch to");
    }

    match rx.recv_timeout(COMMAND_TIMEOUT) {
        Ok(response) => {
            if mutating {
                control.remember_result(&request_id, &action, &arguments, &response);
            }
            response
        }
        Err(_) => {
            control.discard_pending(&correlation_id);
            error_response(&request_id, "provider_failure", "renderer did not respond in time")
        }
    }
}

/// The renderer dispatcher reports a completed command's `CommandResponse` here.
#[tauri::command]
pub fn june_command_result(app: AppHandle, correlation_id: String, response: Value) {
    app.state::<JuneControl>().resolve_pending(&correlation_id, response);
}

/// The renderer appends a state change to the sequenced event log here (drives `observe`).
#[tauri::command]
pub fn june_emit_event(
    app: AppHandle,
    workspace_id: String,
    kind: String,
    request_id: Option<String>,
    payload: Value,
) {
    app.state::<JuneControl>()
        .record_event(workspace_id, kind, request_id, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control() -> JuneControl {
        JuneControl::new("test-token".into())
    }

    #[test]
    fn events_are_sequenced_monotonically_and_observe_resumes() {
        let c = control();
        c.record_event("w".into(), "agent.spawned".into(), Some("r1".into()), json!({"id": 1}));
        c.record_event("w".into(), "agent.spawned".into(), Some("r1".into()), json!({"id": 2}));
        c.record_event("other".into(), "agent.spawned".into(), None, json!({"id": 3}));
        c.record_event("w".into(), "terminal.closed".into(), None, json!({"pane": 7}));

        // Full backlog for "w" (workspace-scoped: the "other" event is excluded).
        let all = c.observe("w", 0);
        let seqs: Vec<u64> = all["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["sequence"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, vec![1, 2, 4]);
        assert_eq!(all["latest_sequence"], 4);

        // Resume after seq 2 returns only what June has not seen.
        let resumed = c.observe("w", 2);
        let seqs: Vec<u64> = resumed["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["sequence"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, vec![4]);
        assert_eq!(resumed["latest_sequence"], 4);
    }

    #[test]
    fn retrying_a_request_id_replays_and_conflicts_are_caught() {
        let c = control();
        let args = json!({ "count": 5 });
        let resp = json!({ "status": "result", "request_id": "r1", "result": { "counts": { "requested": 5 } } });

        assert!(matches!(c.check_idempotency("r1", "spawn_agents", &args), Idempotency::Fresh));
        c.remember_result("r1", "spawn_agents", &args, &resp);

        // Same id + same payload -> replay the original, spawn nothing new.
        match c.check_idempotency("r1", "spawn_agents", &args) {
            Idempotency::Replay(v) => assert_eq!(v, resp),
            _ => panic!("expected replay"),
        }

        // Same id + different payload -> conflict.
        let other = json!({ "count": 9 });
        assert!(matches!(c.check_idempotency("r1", "spawn_agents", &other), Idempotency::Conflict));
    }

    #[test]
    fn non_mutating_results_are_not_remembered() {
        let c = control();
        let args = json!({});
        c.remember_result("r1", "get_swarm_status", &args, &json!({"status": "result"}));
        assert!(matches!(c.check_idempotency("r1", "get_swarm_status", &args), Idempotency::Fresh));
    }

    #[test]
    fn pending_results_route_to_the_waiting_handler() {
        let c = control();
        let rx = c.register_pending("r1");
        assert!(c.resolve_pending("r1", json!({ "ok": true })));
        assert_eq!(rx.recv().unwrap(), json!({ "ok": true }));
        // Second resolve finds no waiter.
        assert!(!c.resolve_pending("r1", json!({})));
    }

    #[test]
    fn capabilities_lists_every_action() {
        let c = control();
        let caps = c.capabilities("1.0.29");
        assert_eq!(caps["contract_version"], CONTRACT_VERSION);
        assert_eq!(caps["actions"].as_array().unwrap().len(), ACTIONS.len());
        assert_eq!(caps["limits"]["max_concurrent_agents"], MAX_CONCURRENT_AGENTS);
    }
}
