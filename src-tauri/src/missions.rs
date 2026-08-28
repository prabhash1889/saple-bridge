//! Mission artifact model and storage (missions plan Phase M1).
//!
//! A mission is a durable, markdown-first work order:
//!
//! ```text
//! .saple/missions/<mission_id>/
//!   mission.md     frontmatter (title/objective/acceptance/limits) + free prose
//!   state.json     engine truth: revision, status, task DAG, events, idempotency
//!   artifacts/     sub-documents agents write; the engine never rewrites prose here
//! ```
//!
//! Ownership rules (plan section 3.1): `mission.md` is agent/human-writable and
//! engine-read-only - the engine parses its frontmatter and never rewrites prose.
//! `state.json` is engine-only and every mutation flows through this module under
//! [`crate::fs_lock::with_path_lock`] on the state file, so Bridge and the saple-mcp
//! sidecar can never interleave a read-modify-write cycle.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::project_roots::{get_project_file_path, ProjectRootRegistry};

pub mod ask_reply;
pub mod gates;
pub mod liveness;
pub mod mailbox;
pub mod preamble;
pub mod scheduler;
pub mod settlement;
pub mod supervisor;

/// Root folder for all missions inside a project's `.saple` directory.
pub const MISSIONS_DIR: &str = ".saple/missions";

/// Events kept in `state.json`. Older events are archived to `events.log` next to it,
/// so long missions cannot grow the engine-truth document without bound.
const EVENT_CAP: usize = 500;
/// Recorded `request_id` outcomes kept for idempotent replay of [`MissionCommand`]s.
const IDEMPOTENCY_CAP: usize = 200;

// --- Serde model -------------------------------------------------------------------------------
//
// All wire types are camelCase so the TS mirrors in `src/types/mission.ts` round-trip
// against serde without renaming layers. Keep both sides in sync by hand.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorSpec {
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub permission: String,
}

/// Parsed `mission.md` frontmatter, mirrored verbatim into `state.json.spec`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionSpec {
    pub title: String,
    pub objective: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default = "default_max_parallel")]
    pub max_parallel: u32,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: u32,
    #[serde(default = "default_budget_cap")]
    pub budget_usd_cap: f64,
    /// `per-task | per-mission | shared`
    #[serde(default = "default_worktree_mode")]
    pub worktree_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<CoordinatorSpec>,
}

fn default_max_parallel() -> u32 {
    4
}

fn default_max_rounds() -> u32 {
    12
}

fn default_budget_cap() -> f64 {
    15.0
}

fn default_worktree_mode() -> String {
    "shared".to_string()
}

fn default_fanout() -> u32 {
    1
}

impl MissionSpec {
    fn new(title: String, objective: String) -> Self {
        MissionSpec {
            title,
            objective,
            acceptance: Vec::new(),
            max_parallel: default_max_parallel(),
            max_rounds: default_max_rounds(),
            budget_usd_cap: default_budget_cap(),
            worktree_mode: default_worktree_mode(),
            coordinator: None,
        }
    }
}

/// One node of the mission task DAG. Statuses follow the plan's task machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTask {
    pub id: String,
    pub title: String,
    /// `implement | review | verify`
    pub kind: String,
    /// Full instructions handed to the worker when this task dispatches.
    pub spec: String,
    /// IDs of tasks that must complete before this one becomes ready.
    pub deps: Vec<String>,
    /// Best-of-N speculative fanout (M6). Validated 1..=3 here.
    pub fanout: u32,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub key: String,
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub session_id: String,
    /// `idle | retained | released`
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_task_id: Option<String>,
    #[serde(default)]
    pub reused_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionGate {
    pub id: String,
    pub task_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    /// `pending | resolved | timeout`
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionMessage {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub to: String,
    /// `message | ask | reply | notice`
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub expects_reply: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub acked: bool,
    pub created_at: String,
}

/// One concrete worker dispatch attempt assignment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionDispatch {
    pub id: String,
    pub task_id: String,
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub capability_hash: String,
    /// `pending | starting | starting_unknown | running | succeeded | failed | stop_unknown | abandoned`
    pub status: String,
    #[serde(default)]
    pub failure_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_heartbeat_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDispatchOutput {
    pub state: Box<MissionState>,
    pub dispatch_id: String,
    pub attempt_id: String,
    pub pane_id: String,
    pub prompt_file: String,
    pub capability_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementOutcome {
    pub state: Box<MissionState>,
    pub result: settlement::SettlementResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutcome {
    pub state: Box<MissionState>,
    pub output: ask_reply::AskOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionEvent {
    pub seq: u64,
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub at: String,
}

/// Outcome recorded per `request_id` so a replayed command returns the original result
/// instead of applying twice (plan section 3.2: "Idempotent via request_id").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub applied: bool,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Successful replays return the same state that the original request returned.
    /// Receipts are cleared from the snapshot to avoid recursive idempotency data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Box<MissionState>>,
}

/// Engine-owned mission truth. Everything except `spec` is written exclusively here;
/// `spec` mirrors `mission.md`'s frontmatter (markdown stays the planning source).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionState {
    pub id: String,
    /// Optimistic-concurrency token. Every mutating command carries `expected_revision`.
    pub revision: u64,
    /// `draft | running | paused | gated | completed | failed | cancelled`
    pub status: String,
    pub spec: MissionSpec,
    #[serde(default)]
    pub tasks: Vec<MissionTask>,
    #[serde(default)]
    pub dispatches: Vec<MissionDispatch>,
    #[serde(default)]
    pub gates: Vec<MissionGate>,
    #[serde(default)]
    pub messages: Vec<MissionMessage>,
    #[serde(default)]
    pub pool: Vec<PoolEntry>,
    #[serde(default)]
    pub events: Vec<MissionEvent>,
    /// `request_id` -> recorded outcome, pruned to [`IDEMPOTENCY_CAP`] entries.
    #[serde(default)]
    pub idempotency: BTreeMap<String, CommandOutcome>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub task_total: usize,
    pub task_completed: usize,
    pub updated_at: String,
}

/// What the renderer asked to decompose the mission into (`mission_set_tasks`). Tasks are
/// addressed by client-side `key`s so deps can reference siblings before server ids exist.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpecInput {
    #[serde(default)]
    pub key: Option<String>,
    pub title: String,
    #[serde(default = "default_task_kind")]
    pub kind: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default = "default_fanout")]
    pub fanout: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPublishInput {
    pub dispatch_id: String,
    #[serde(default = "default_artifact_kind")]
    pub kind: String,
    pub content: String,
    pub label: String,
}

fn default_task_kind() -> String {
    "implement".to_string()
}

fn default_artifact_kind() -> String {
    "report".to_string()
}

const ULID_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn new_ulid() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let random = uuid::Uuid::new_v4();
    let mut random_value = 0u128;
    for byte in &random.as_bytes()[..10] {
        random_value = (random_value << 8) | u128::from(*byte);
    }
    let mut value = ((millis as u128) << 80) | random_value;
    let mut output = [b'0'; 26];
    for slot in output.iter_mut().rev() {
        *slot = ULID_ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(output.to_vec()).expect("ULID alphabet is ASCII")
}

fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, new_ulid())
}

/// Optional overrides at creation time. Anything omitted falls back to the defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MissionOptions {
    pub acceptance: Option<Vec<String>>,
    pub max_parallel: Option<u32>,
    pub max_rounds: Option<u32>,
    pub budget_usd_cap: Option<f64>,
    pub worktree_mode: Option<String>,
    pub coordinator: Option<CoordinatorSpec>,
    /// Free-form markdown body seeded below the frontmatter.
    pub body: Option<String>,
}

/// The structured action contract for mission lifecycle commands (plan section 3.2).
/// Retry/Abandon/ResolveGate are accepted from day one for wire stability but can never
/// succeed before M3/M4 mint any dispatches or gates.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MissionCommand {
    Start,
    Pause,
    Resume,
    Cancel,
    Retry { dispatch_id: String },
    Abandon { dispatch_id: String },
    ResolveGate { gate_id: String, resolution: String },
}

/// Result of [`mission_read`]. Mirrors the `state_load.rs` outcome taxonomy so the UI can
/// branch on `loaded | missing | corrupt | locked` exactly like every other `.saple` store.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MissionReadResult {
    Loaded {
        state: Box<MissionState>,
        doc: String,
        /// Non-fatal notes from reconcile-on-read (e.g. an external frontmatter edit was
        /// rejected and the last-good spec kept). Empty for plain loads.
        #[serde(default)]
        warnings: Vec<String>,
    },
    Missing,
    Corrupt {
        error: String,
        backup_path: String,
    },
    Locked,
}

// --- Validation --------------------------------------------------------------------------------

const WORKTREE_MODES: [&str; 3] = ["per-task", "per-mission", "shared"];
const TASK_KINDS: [&str; 3] = ["implement", "review", "verify"];
/// Plan section 3.2: best-of-N speculative fanout is capped at 3 (M6 doctrine).
const MAX_FANOUT: u32 = 3;
/// Round caps beyond this are treated as typos rather than intent.
const MAX_ROUNDS_LIMIT: u32 = 1000;
/// A mission DAG stays hand-inspectable; this is a sanity ceiling, not a product limit.
const MAX_TASKS: usize = 200;

/// Validate a spec against the plan's constraints: `max_parallel` 1..=8, positive round
/// cap, budget cap > 0, known worktree mode, non-empty title/objective.
pub(crate) fn validate_spec(spec: &MissionSpec) -> Result<(), String> {
    if spec.title.trim().is_empty() {
        return Err("Mission title must not be empty".to_string());
    }
    if spec.objective.trim().is_empty() {
        return Err("Mission objective must not be empty".to_string());
    }
    if !(1..=8).contains(&spec.max_parallel) {
        return Err(format!(
            "max_parallel must be between 1 and 8 (got {})",
            spec.max_parallel
        ));
    }
    if spec.max_rounds == 0 || spec.max_rounds > MAX_ROUNDS_LIMIT {
        return Err(format!(
            "max_rounds must be between 1 and {} (got {})",
            MAX_ROUNDS_LIMIT, spec.max_rounds
        ));
    }
    if !(spec.budget_usd_cap.is_finite() && spec.budget_usd_cap > 0.0) {
        return Err("budget_usd_cap must be greater than 0".to_string());
    }
    if !WORKTREE_MODES.contains(&spec.worktree_mode.as_str()) {
        return Err(format!(
            "worktree_mode must be one of {} (got '{}')",
            WORKTREE_MODES.join(", "),
            spec.worktree_mode
        ));
    }
    Ok(())
}

// --- Frontmatter parsing -----------------------------------------------------------------------
//
// A deliberately small parser for the documented mission frontmatter grammar:
// scalars (`key: value`, optionally double-quoted), one list field (`acceptance:` with
// `- item` lines), and one inline-map field (`coordinator: { provider: x, ... }` or its
// indented multi-line form). Unknown keys are rejected so agent-typoed fields fail loudly
// instead of being silently dropped (plan risk table: markdown/state divergence).

/// Unescape the two sequences [`render_mission_doc`] produces inside double-quoted values.
fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

/// Escape a value for double-quoted placement in rendered frontmatter.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Parse `{ provider: opencode, model: "gpt-5.2", permission: full_access }`-style maps.
/// Splits on commas that sit outside double quotes (backslash escapes honored).
fn parse_inline_map(text: &str) -> Result<BTreeMap<String, String>, String> {
    let text = text.trim();
    if !text.starts_with('{') || !text.ends_with('}') {
        return Err(format!("expected an inline {{...}} map, got '{}'", text));
    }
    let inner = &text[1..text.len() - 1];
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                current.push(ch);
                if let Some(&next) = chars.peek() {
                    current.push(next);
                    chars.next();
                }
            }
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            ',' if !in_quotes => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    if in_quotes {
        return Err("unterminated double quote in inline map".to_string());
    }
    parts.push(current);

    let mut map = BTreeMap::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (key, value) = part
            .split_once(':')
            .ok_or_else(|| format!("inline map entry '{}' has no ':' separator", part))?;
        map.insert(key.trim().to_string(), unquote(value));
    }
    Ok(map)
}

/// Parsed frontmatter. The body below the closing fence is prose the engine never
/// interprets; callers keep working with the raw document.
#[derive(Debug)]
pub(crate) struct ParsedDoc {
    pub spec: MissionSpec,
}

/// Parse `mission.md` content into a validated spec + body. Returns a human-readable
/// error naming the offending line or key so hand-editors get actionable feedback.
pub(crate) fn parse_mission_doc(content: &str) -> Result<ParsedDoc, String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let all_lines: Vec<&str> = content.lines().collect();
    let Some(first) = all_lines.first() else {
        return Err("mission.md is empty".to_string());
    };
    if first.trim_end_matches('\r').trim() != "---" {
        return Err("mission.md must start with a '---' frontmatter fence".to_string());
    }

    let mut scalars: BTreeMap<String, String> = BTreeMap::new();
    let mut acceptance: Vec<String> = Vec::new();
    let mut coordinator_inline: Option<String> = None;
    let mut coordinator_block: Vec<String> = Vec::new();

    let mut current_list: Option<String> = None;
    // Index loop (not for-over-iterator): the indented `coordinator:` block form consumes
    // its continuation lines inline and must hand control back to the main scan after.
    let mut i = 1usize; // line 0 is the opening fence
    let mut closed = false;
    while i < all_lines.len() {
        let raw = all_lines[i];
        let line_no = i + 1; // 1-based; the opening fence counts as line 1
        i += 1;
        let trimmed = raw.trim_end_matches('\r').trim();

        if trimmed == "---" {
            closed = true;
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // List continuation: "- item" under the most recent list field.
        if let Some(item) = trimmed.strip_prefix("- ") {
            match &current_list {
                Some(field) if field == "acceptance" => {
                    acceptance.push(unquote(item));
                    continue;
                }
                Some(field) => {
                    return Err(format!("line {}: unknown list field '{}'", line_no, field))
                }
                None => {
                    return Err(format!(
                        "line {}: list item outside of a list field",
                        line_no
                    ))
                }
            }
        }

        let (key, value) = trimmed
            .split_once(':')
            .ok_or_else(|| format!("line {}: expected 'key: value'", line_no))?;
        let key = key.trim();
        let value = value.trim();

        match key {
            "title" | "objective" | "max_parallel" | "max_rounds" | "budget_usd_cap"
            | "worktree_mode" => {
                current_list = None;
                scalars.insert(key.to_string(), unquote(value));
            }
            "acceptance" => {
                current_list = Some(key.to_string());
                // Inline array form is intentionally unsupported: the list form keeps the
                // grammar unambiguous for a line-based parser.
                if !value.is_empty() {
                    return Err(format!(
                        "line {}: 'acceptance' must use '- item' list lines, not an inline value",
                        line_no
                    ));
                }
            }
            "coordinator" => {
                current_list = None;
                if value.is_empty() {
                    // Indented block form (`coordinator:\n  provider: x`): consume every
                    // following indented non-list line as its own key: value entry.
                    while i < all_lines.len() {
                        let cont = all_lines[i];
                        let cont_trimmed = cont.trim_end_matches('\r').trim();
                        let indented = cont.starts_with(' ') || cont.starts_with('\t');
                        if !indented || cont_trimmed.is_empty() || cont_trimmed.starts_with('-') {
                            break;
                        }
                        coordinator_block.push(cont_trimmed.to_string());
                        i += 1;
                    }
                    if coordinator_block.is_empty() {
                        return Err("frontmatter 'coordinator' block has no entries".to_string());
                    }
                } else {
                    coordinator_inline = Some(value.to_string());
                }
            }
            other => {
                return Err(format!(
                    "line {}: unknown frontmatter key '{}'",
                    line_no, other
                ));
            }
        }
    }

    if !closed {
        return Err("mission.md frontmatter is missing its closing '---' fence".to_string());
    }

    let mut spec = MissionSpec::new(String::new(), String::new());
    for (key, value) in &scalars {
        match key.as_str() {
            "title" => spec.title = value.clone(),
            "objective" => spec.objective = value.clone(),
            "max_parallel" => {
                spec.max_parallel = value.parse::<u32>().map_err(|_| {
                    format!(
                        "frontmatter key 'max_parallel' must be a whole number (got '{}')",
                        value
                    )
                })?;
            }
            "max_rounds" => {
                spec.max_rounds = value.parse::<u32>().map_err(|_| {
                    format!(
                        "frontmatter key 'max_rounds' must be a whole number (got '{}')",
                        value
                    )
                })?;
            }
            "budget_usd_cap" => {
                spec.budget_usd_cap = value.parse::<f64>().map_err(|_| {
                    format!(
                        "frontmatter key 'budget_usd_cap' must be a number (got '{}')",
                        value
                    )
                })?;
            }
            "worktree_mode" => spec.worktree_mode = value.clone(),
            _ => unreachable!("scalar loop only inserts known keys"),
        }
    }
    spec.acceptance = acceptance;

    if coordinator_inline.is_some() || !coordinator_block.is_empty() {
        let map = match &coordinator_inline {
            // Inline form: one `{ k: v, ... }` fragment.
            Some(inline) => {
                parse_inline_map(inline).map_err(|e| format!("frontmatter 'coordinator': {}", e))?
            }
            // Block form: each indented line is its own `k: v` entry.
            None => {
                let mut map = BTreeMap::new();
                for line in &coordinator_block {
                    let (key, value) = line.split_once(':').ok_or_else(|| {
                        format!(
                            "frontmatter 'coordinator' entry '{}' has no ':' separator",
                            line
                        )
                    })?;
                    map.insert(key.trim().to_string(), unquote(value));
                }
                map
            }
        };
        if !map.contains_key("provider") {
            return Err("frontmatter 'coordinator': missing required entry 'provider'".to_string());
        }
        let allowed = ["provider", "model", "permission"];
        if let Some(unknown) = map.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(format!(
                "frontmatter 'coordinator': unknown entry '{}' (allowed: {})",
                unknown,
                allowed.join(", ")
            ));
        }
        spec.coordinator = Some(CoordinatorSpec {
            provider: map.get("provider").cloned().unwrap_or_default(),
            model: map.get("model").cloned().unwrap_or_default(),
            permission: map.get("permission").cloned().unwrap_or_default(),
        });
    }

    validate_spec(&spec)?;

    // Everything after the closing fence is prose the engine never interprets; drop it.
    Ok(ParsedDoc { spec })
}

/// Render `mission.md` content from a spec plus free-form body prose.
pub(crate) fn render_mission_doc(spec: &MissionSpec, body: &str) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", quote(&spec.title)));
    out.push_str(&format!("objective: {}\n", quote(&spec.objective)));
    if !spec.acceptance.is_empty() {
        out.push_str("acceptance:\n");
        for item in &spec.acceptance {
            out.push_str(&format!("  - {}\n", quote(item)));
        }
    }
    out.push_str(&format!("max_parallel: {}\n", spec.max_parallel));
    out.push_str(&format!("max_rounds: {}\n", spec.max_rounds));
    out.push_str(&format!("budget_usd_cap: {}\n", spec.budget_usd_cap));
    out.push_str(&format!("worktree_mode: {}\n", spec.worktree_mode));
    if let Some(coordinator) = &spec.coordinator {
        out.push_str(&format!(
            "coordinator: {{ provider: {}, model: {}, permission: {} }}\n",
            quote(&coordinator.provider),
            quote(&coordinator.model),
            quote(&coordinator.permission)
        ));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_start());
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// --- Paths -------------------------------------------------------------------------------------

/// Mission ids are minted here (`msn_<ulid>`), but they arrive from the renderer on every
/// read/write, so enforce the exact minted shape before they touch the filesystem: no
/// separators, no dots, nothing that could escape the missions directory.
pub(crate) fn validate_mission_id(id: &str) -> Result<(), String> {
    let valid = id.starts_with("msn_")
        && id.len() > "msn_".len()
        && id["msn_".len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(format!("invalid mission id '{}'", id))
    }
}

fn missions_root(project_path: &str) -> Result<PathBuf, String> {
    let base = crate::project_roots::canonical_base(project_path).map_err(|e| e.to_string())?;
    crate::project_roots::contained_target(&base, MISSIONS_DIR).map_err(|e| e.to_string())
}

fn ensure_missions_enabled(project_path: &str) -> Result<(), String> {
    let config_path =
        get_project_file_path(project_path, ".saple/config.json").map_err(|e| e.to_string())?;
    let content = match crate::state_load::read_json_text(&config_path) {
        crate::state_load::JsonText::Ok(content) => content,
        crate::state_load::JsonText::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("Missions are disabled for this workspace".to_string())
        }
        crate::state_load::JsonText::Io(e) => return Err(e.to_string()),
        crate::state_load::JsonText::Encoding(message) => return Err(message),
    };
    let config: crate::project::WorkspaceConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse workspace config: {}", e))?;
    if config.missions_enabled {
        Ok(())
    } else {
        Err("Missions are disabled for this workspace".to_string())
    }
}

fn mission_dir(project_path: &str, id: &str) -> Result<PathBuf, String> {
    validate_mission_id(id)?;
    Ok(missions_root(project_path)?.join(id))
}

fn state_file_path(project_path: &str, id: &str) -> Result<PathBuf, String> {
    Ok(mission_dir(project_path, id)?.join("state.json"))
}

fn doc_file_path(project_path: &str, id: &str) -> Result<PathBuf, String> {
    Ok(mission_dir(project_path, id)?.join("mission.md"))
}

fn summary_of(state: &MissionState) -> MissionSummary {
    MissionSummary {
        id: state.id.clone(),
        title: state.spec.title.clone(),
        status: state.status.clone(),
        task_total: state.tasks.len(),
        task_completed: state
            .tasks
            .iter()
            .filter(|t| t.status == "completed")
            .count(),
        updated_at: state.updated_at.clone(),
    }
}

fn corrupt_summary(id: String) -> MissionSummary {
    MissionSummary {
        id,
        title: "(unreadable mission)".to_string(),
        status: "corrupt".to_string(),
        task_total: 0,
        task_completed: 0,
        updated_at: String::new(),
    }
}

// --- State load / persist ----------------------------------------------------------------------

enum LoadedState {
    Ok(Box<MissionState>),
    /// `state.json` does not exist yet (crash between the create writes).
    Missing,
    /// `state.json` exists but does not parse. Bytes preserved, writes blocked until
    /// recovery - identical semantics to every other `.saple` store.
    Corrupt {
        error: String,
        backup_path: String,
    },
}

fn load_state(project_path: &str, id: &str) -> Result<LoadedState, String> {
    let path = state_file_path(project_path, id)?;
    if !path.exists() {
        return Ok(LoadedState::Missing);
    }
    let text = match crate::state_load::read_json_text(&path) {
        crate::state_load::JsonText::Ok(t) => t,
        crate::state_load::JsonText::Io(e) => return Err(e.to_string()),
        crate::state_load::JsonText::Encoding(m) => return Err(m),
    };
    match serde_json::from_str::<MissionState>(&text) {
        Ok(state) if state.id == id => {
            // The user may have repaired the file externally while it was flagged; a clean
            // parse lifts the write block automatically (mirrors load_state_inner).
            crate::fs_lock::clear_corrupt_flag(&path);
            Ok(LoadedState::Ok(Box::new(state)))
        }
        Ok(state) => {
            let err = format!(
                "Mission state id '{}' does not match its directory '{}'",
                state.id, id
            );
            let backup = crate::state_load::preserve_and_flag_corrupt(&path, &err)?;
            Ok(LoadedState::Corrupt {
                error: err,
                backup_path: backup.to_string_lossy().to_string(),
            })
        }
        Err(e) => {
            let err = format!("Failed to parse mission state.json: {}", e);
            let backup = crate::state_load::preserve_and_flag_corrupt(&path, &err)?;
            Ok(LoadedState::Corrupt {
                error: err,
                backup_path: backup.to_string_lossy().to_string(),
            })
        }
    }
}

/// Append an event, capping the in-file list and archiving overflow to `events.log`.
fn record_event(
    project_path: &str,
    id: &str,
    state: &mut MissionState,
    kind: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let seq = state.events.last().map(|e| e.seq + 1).unwrap_or(1);
    state.events.push(MissionEvent {
        seq,
        kind: kind.to_string(),
        payload,
        at: crate::project::now_iso(),
    });
    if state.events.len() > EVENT_CAP {
        let overflow: Vec<MissionEvent> = state
            .events
            .drain(..state.events.len() - EVENT_CAP)
            .collect();
        let mut lines = String::new();
        for event in overflow {
            lines.push_str(&format!(
                "{}\n",
                serde_json::json!({
                    "seq": event.seq,
                    "kind": event.kind,
                    "payload": event.payload,
                    "at": event.at,
                })
            ));
        }
        let log_path = mission_dir(project_path, id)?.join("events.log");
        append_log(&log_path, &lines)?;
    }
    Ok(())
}

/// Append pre-rendered lines to a log file. Archival failures surface as errors but never
/// lose the in-file mutation they were archiving.
fn append_log(path: &Path, lines: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    file.write_all(lines.as_bytes())
        .map_err(|e| format!("Failed to append to {}: {}", path.display(), e))
}

/// Remember a command outcome for idempotent replay, pruning old entries.
fn remember_outcome(state: &mut MissionState, request_id: &str, outcome: CommandOutcome) {
    while state.idempotency.len() >= IDEMPOTENCY_CAP {
        // Remove an arbitrary first entry (BTreeMap order); replay correctness needs the
        // recent window, not LRU precision.
        let Some(first) = state.idempotency.keys().next().cloned() else {
            break;
        };
        state.idempotency.remove(&first);
    }
    state.idempotency.insert(request_id.to_string(), outcome);
}

/// Persist engine truth. MUST run while already holding the per-path lock
/// ([`crate::fs_lock::write_unlocked`] would deadlock through `atomic_write`).
fn persist_state(project_path: &str, id: &str, state: &MissionState) -> Result<(), String> {
    let path = state_file_path(project_path, id)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    crate::fs_lock::write_unlocked(&path, &bytes)
}

/// Load-or-fail helper shared by the mutating commands: corrupt state aborts the mutation
/// with the preserved-backup message instead of overwriting evidence.
fn require_state(project_path: &str, id: &str) -> Result<MissionState, String> {
    match load_state(project_path, id)? {
        LoadedState::Ok(state) => Ok(*state),
        LoadedState::Missing => Err(format!("mission '{}' does not exist", id)),
        LoadedState::Corrupt { error, .. } => Err(error),
    }
}

fn revision_conflict(id: &str, actual: u64, expected: u64) -> String {
    format!(
        "Revision conflict: mission {} is at revision {} but the edit expected {}. \
         Reload the mission and retry.",
        id, actual, expected
    )
}

// --- Core operations (blocking; run under spawn_blocking from the commands) --------------------

pub(crate) fn mission_create_inner(
    project_path: &str,
    title: &str,
    objective: &str,
    options: MissionOptions,
) -> Result<MissionSummary, String> {
    let mut spec = MissionSpec::new(title.trim().to_string(), objective.trim().to_string());
    if let Some(acceptance) = options.acceptance {
        spec.acceptance = acceptance
            .into_iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
    }
    if let Some(max_parallel) = options.max_parallel {
        spec.max_parallel = max_parallel;
    }
    if let Some(max_rounds) = options.max_rounds {
        spec.max_rounds = max_rounds;
    }
    if let Some(budget) = options.budget_usd_cap {
        spec.budget_usd_cap = budget;
    }
    if let Some(mode) = options.worktree_mode {
        spec.worktree_mode = mode;
    }
    if let Some(coordinator) = options.coordinator {
        spec.coordinator = Some(coordinator);
    }
    validate_spec(&spec)?;

    let now = crate::project::now_iso();
    let id = new_id("msn");
    let state = MissionState {
        id: id.clone(),
        revision: 1,
        status: "draft".to_string(),
        spec: spec.clone(),
        tasks: Vec::new(),
        dispatches: Vec::new(),
        gates: Vec::new(),
        messages: Vec::new(),
        pool: Vec::new(),
        events: Vec::new(),
        idempotency: BTreeMap::new(),
        created_at: now.clone(),
        updated_at: now,
    };

    let dir = mission_dir(project_path, &id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create mission directory: {}", e))?;
    // Conventions say artifacts live in `artifacts/`; create it up front so agents can
    // discover their workspace without special-casing the empty mission.
    fs::create_dir_all(dir.join("artifacts"))
        .map_err(|e| format!("Failed to create mission artifacts directory: {}", e))?;

    let body = options.body.unwrap_or_else(|| {
        format!(
            "# {}\n\n{}\n\n## Acceptance\n\n{}\n",
            spec.title,
            spec.objective,
            if spec.acceptance.is_empty() {
                "_Define measurable acceptance criteria here._".to_string()
            } else {
                spec.acceptance
                    .iter()
                    .map(|a| format!("- [ ] {}", a))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        )
    });
    let doc = render_mission_doc(&spec, &body);
    let state_bytes = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;

    // One atomic sequence under the cross-process lock on the state file: mission.md lands
    // first, then state.json. If the process dies between the two writes, the next
    // `mission_read` repairs by regenerating state.json from the parsed frontmatter.
    let state_path = state_file_path(project_path, &id)?;
    let doc_path = doc_file_path(project_path, &id)?;
    crate::fs_lock::with_path_lock(&state_path, || -> Result<(), String> {
        crate::fs_lock::write_unlocked(&doc_path, doc.as_bytes())?;
        crate::fs_lock::write_unlocked(&state_path, &state_bytes)?;
        Ok(())
    })??;

    Ok(summary_of(&state))
}

pub(crate) fn mission_list_inner(project_path: &str) -> Result<Vec<MissionSummary>, String> {
    let root = missions_root(project_path)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut summaries: Vec<MissionSummary> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("Failed to list missions: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if validate_mission_id(&id).is_err() {
            continue;
        }
        // Reuse the read path so a valid hand-edited frontmatter change is reconciled before
        // its summary is returned. This also repairs a state.json lost during creation.
        match mission_read_inner(project_path, &id)? {
            MissionReadResult::Loaded { state, .. } => summaries.push(summary_of(&state)),
            MissionReadResult::Corrupt { .. } => {
                // Stay honest: a corrupt mission still shows up (status `corrupt`) instead
                // of silently disappearing from the room.
                summaries.push(corrupt_summary(id));
            }
            MissionReadResult::Missing | MissionReadResult::Locked => {}
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(summaries)
}

pub(crate) fn mission_read_inner(
    project_path: &str,
    id: &str,
) -> Result<MissionReadResult, String> {
    let doc_path = doc_file_path(project_path, id)?;
    // Fast path: an unknown id has no directory yet, so there is nothing to lock or read.
    if !doc_path.exists() {
        return Ok(MissionReadResult::Missing);
    }
    let state_path = state_file_path(project_path, id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        // Read the doc under the lock so reconcile-on-read never adopts a snapshot older
        // than what an external editor just wrote.
        let doc = match fs::read_to_string(&doc_path) {
            Ok(doc) => doc,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(MissionReadResult::Missing)
            }
            Err(e) => return Err(format!("Failed to read mission.md: {}", e)),
        };

        if crate::fs_lock::sentinel_held_by_live_process(&state_path) {
            return Ok(MissionReadResult::Locked);
        }
        match load_state(project_path, id)? {
            LoadedState::Ok(mut state) => reconcile_on_read(project_path, id, &doc, &mut state),
            LoadedState::Missing => {
                // Crash between the two create writes: mission.md survived, engine truth
                // did not. Rebuild from the parsed frontmatter (plan M1 atomicity test).
                let mut state = rebuild_missing_state(project_path, id, &doc)?;
                let mut result = reconcile_on_read(project_path, id, &doc, &mut state)?;
                if let MissionReadResult::Loaded { warnings, .. } = &mut result {
                    warnings
                        .push("state.json was missing and was rebuilt from mission.md".to_string());
                }
                Ok(result)
            }
            LoadedState::Corrupt { error, backup_path } => {
                Ok(MissionReadResult::Corrupt { error, backup_path })
            }
        }
    })?
}

/// Reconcile-on-read (plan sections 3.1 and M1): agents edit `mission.md` with normal file
/// tools; the engine adopts valid frontmatter changes and falls back to the last-good spec
/// with a surfaced warning when an external edit fails validation. Prose is never parsed.
///
/// Crash-repair lives here too: when `mission.md` survived but `state.json` did not (kill
/// between the two create writes), engine truth is rebuilt from the parsed frontmatter -
/// the markdown is the durable source of the spec.
fn reconcile_on_read(
    project_path: &str,
    id: &str,
    doc: &str,
    state: &mut MissionState,
) -> Result<MissionReadResult, String> {
    let parsed = match parse_mission_doc(doc) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(MissionReadResult::Loaded {
                state: Box::new(state.clone()),
                doc: doc.to_string(),
                warnings: vec![format!(
                    "External mission.md edit rejected, keeping the last-good spec: {}",
                    error
                )],
            })
        }
    };

    if parsed.spec != state.spec {
        state.spec = parsed.spec;
        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        record_event(
            project_path,
            id,
            state,
            "doc_reconciled",
            serde_json::json!({ "source": "external_edit" }),
        )?;
        persist_state(project_path, id, state)?;
    }
    Ok(MissionReadResult::Loaded {
        state: Box::new(state.clone()),
        doc: doc.to_string(),
        warnings: Vec::new(),
    })
}

/// Rebuild `state.json` from `mission.md` after a crash between the two create writes.
fn rebuild_missing_state(project_path: &str, id: &str, doc: &str) -> Result<MissionState, String> {
    let parsed = parse_mission_doc(doc).map_err(|e| {
        format!(
            "mission state.json is missing and mission.md could not be parsed to rebuild it: {}",
            e
        )
    })?;
    let now = crate::project::now_iso();
    let state = MissionState {
        id: id.to_string(),
        revision: 1,
        status: "draft".to_string(),
        spec: parsed.spec,
        tasks: Vec::new(),
        dispatches: Vec::new(),
        gates: Vec::new(),
        messages: Vec::new(),
        pool: Vec::new(),
        events: Vec::new(),
        idempotency: BTreeMap::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    persist_state(project_path, id, &state)?;
    Ok(state)
}

pub(crate) fn mission_update_doc_inner(
    project_path: &str,
    id: &str,
    body: &str,
    expected_revision: u64,
) -> Result<MissionState, String> {
    // Validate BEFORE taking the lock: a bad edit should never touch disk.
    let parsed = parse_mission_doc(body)?;

    let doc_path = doc_file_path(project_path, id)?;
    let state_path = state_file_path(project_path, id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(id, state.revision, expected_revision));
        }
        // Markdown first, then engine truth - same crash ordering as create; the next read
        // reconciles either survivor back into a consistent pair.
        crate::fs_lock::write_unlocked(&doc_path, body.as_bytes())?;
        state.spec = parsed.spec;
        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        record_event(
            project_path,
            id,
            &mut state,
            "doc_updated",
            serde_json::json!({}),
        )?;
        persist_state(project_path, id, &state)?;
        Ok(state)
    })?
}

/// DAG readiness by fixpoint: Kahn's algorithm over the dep keys. Rejects unknown refs,
/// self-deps, and cycles, naming the offending tasks so authors get actionable errors.
/// This mirrors (and tightens) the swarm validator pattern: unknown deps are errors here,
/// not silently-ignored edges.
pub(crate) fn validate_task_dag(keys: &[String], deps: &[Vec<String>]) -> Result<(), String> {
    let count = keys.len();
    let mut index_of: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, key) in keys.iter().enumerate() {
        if index_of.insert(key.as_str(), i).is_some() {
            return Err(format!("duplicate task key '{}'", key));
        }
    }

    let mut indegree = vec![0usize; count];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (i, task_deps) in deps.iter().enumerate() {
        for dep in task_deps {
            if dep == &keys[i] {
                return Err(format!("task '{}' depends on itself", keys[i]));
            }
            let j = *index_of
                .get(dep.as_str())
                .ok_or_else(|| format!("task '{}' depends on unknown task '{}'", keys[i], dep))?;
            indegree[i] += 1;
            dependents[j].push(i);
        }
    }

    // Kahn peel: anything left with indegree > 0 after the queue drains sits on a cycle.
    let mut queue: Vec<usize> = (0..count).filter(|&i| indegree[i] == 0).collect();
    let mut processed = 0usize;
    let mut cursor = 0usize;
    while cursor < queue.len() {
        let node = queue[cursor];
        cursor += 1;
        processed += 1;
        for &next in &dependents[node] {
            indegree[next] -= 1;
            if indegree[next] == 0 {
                queue.push(next);
            }
        }
    }
    if processed < count {
        let stuck: Vec<String> = (0..count)
            .filter(|&i| indegree[i] > 0)
            .map(|i| keys[i].clone())
            .collect();
        return Err(format!(
            "dependency cycle detected involving: {}",
            stuck.join(", ")
        ));
    }
    Ok(())
}

pub(crate) fn mission_set_tasks_inner(
    project_path: &str,
    id: &str,
    expected_revision: u64,
    specs: Vec<TaskSpecInput>,
) -> Result<MissionState, String> {
    // Per-input validation up front (before touching disk).
    if specs.len() > MAX_TASKS {
        return Err(format!("A mission is limited to {} tasks", MAX_TASKS));
    }
    for (n, input) in specs.iter().enumerate() {
        if input.title.trim().is_empty() {
            return Err(format!("task #{} has an empty title", n + 1));
        }
        if !TASK_KINDS.contains(&input.kind.as_str()) {
            return Err(format!(
                "task '{}' has invalid kind '{}' (allowed: {})",
                input.title,
                input.kind,
                TASK_KINDS.join(", ")
            ));
        }
        if input.fanout == 0 || input.fanout > MAX_FANOUT {
            return Err(format!(
                "task '{}' fanout must be between 1 and {} (got {})",
                input.title, MAX_FANOUT, input.fanout
            ));
        }
    }

    let keys: Vec<String> = specs
        .iter()
        .enumerate()
        .map(|(n, s)| {
            s.key
                .clone()
                .filter(|k| !k.trim().is_empty())
                .unwrap_or_else(|| format!("#{}/{}", n, s.title.trim()))
        })
        .collect();
    let deps: Vec<Vec<String>> = specs.iter().map(|s| s.deps.clone()).collect();
    validate_task_dag(&keys, &deps)?;

    let state_path = state_file_path(project_path, id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(id, state.revision, expected_revision));
        }

        // Server-side id minting: client keys resolve to fresh task ids.
        let key_to_id: BTreeMap<String, String> = keys
            .iter()
            .map(|key| (key.clone(), new_id("task")))
            .collect();

        let tasks: Vec<MissionTask> = specs
            .into_iter()
            .zip(keys.iter())
            .map(|(input, key)| MissionTask {
                id: key_to_id[key].clone(),
                title: input.title.trim().to_string(),
                kind: input.kind,
                spec: input.spec,
                deps: input
                    .deps
                    .iter()
                    .map(|dep| key_to_id[dep].clone())
                    .collect(),
                fanout: input.fanout,
                status: if input.deps.is_empty() {
                    "ready"
                } else {
                    "pending"
                }
                .to_string(),
                result: None,
                gate_id: None,
            })
            .collect();

        let count = tasks.len();
        state.tasks = tasks;
        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        record_event(
            project_path,
            id,
            &mut state,
            "tasks_set",
            serde_json::json!({ "count": count }),
        )?;
        persist_state(project_path, id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_command_inner(
    project_path: &str,
    id: &str,
    expected_revision: u64,
    request_id: &str,
    cmd: MissionCommand,
) -> Result<MissionState, String> {
    if request_id.trim().is_empty() {
        return Err("request_id must not be empty".to_string());
    }

    let cmd_label = match &cmd {
        MissionCommand::Start => "started",
        MissionCommand::Pause => "paused",
        MissionCommand::Resume => "resumed",
        MissionCommand::Cancel => "cancelled",
        MissionCommand::Retry { .. } => "dispatch_retried",
        MissionCommand::Abandon { .. } => "dispatch_abandoned",
        MissionCommand::ResolveGate { .. } => "gate_resolved",
    }
    .to_string();

    // Everything (replay check, CAS, apply, event, outcome receipt) happens under one
    // cross-process lock so a retried request can never race its original.
    let state_path = state_file_path(project_path, id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, id)?;

        // Idempotent replay: a repeated request returns the originally recorded outcome and
        // touches nothing. Successful replays return the recorded revision's successor
        // state from disk; rejected replays re-raise the recorded error.
        if let Some(recorded) = state.idempotency.get(request_id) {
            return match (&recorded.applied, &recorded.error, &recorded.state) {
                (true, _, Some(snapshot)) => Ok((**snapshot).clone()),
                (true, _, None) => Ok(state),
                (_, Some(error), _) => Err(error.clone()),
                (false, None, _) => unreachable!("rejected outcomes always carry an error"),
            };
        }

        // CAS BEFORE mutation: a stale write must never half-apply the command it carries.
        if state.revision != expected_revision {
            let conflict = revision_conflict(id, state.revision, expected_revision);
            let receipt = CommandOutcome {
                applied: false,
                revision: state.revision,
                error: Some(conflict.clone()),
                state: None,
            };
            remember_outcome(&mut state, request_id, receipt);
            persist_state(project_path, id, &state)?;
            return Err(conflict);
        }

        let apply_result = match cmd.clone() {
            MissionCommand::Start => match state.status.as_str() {
                "draft" | "paused" => {
                    state.status = "running".to_string();
                    Ok(())
                }
                other => Err(format!("cannot start a mission from status '{}'", other)),
            },
            MissionCommand::Pause => match state.status.as_str() {
                "running" | "gated" => {
                    state.status = "paused".to_string();
                    Ok(())
                }
                other => Err(format!("cannot pause a mission from status '{}'", other)),
            },
            MissionCommand::Resume => match state.status.as_str() {
                "paused" => {
                    state.status = "running".to_string();
                    Ok(())
                }
                other => Err(format!("cannot resume a mission from status '{}'", other)),
            },
            MissionCommand::Cancel => match state.status.as_str() {
                "completed" | "failed" | "cancelled" => Err(format!(
                    "cannot cancel a mission already in terminal status '{}'",
                    state.status
                )),
                _ => {
                    state.status = "cancelled".to_string();
                    for entry in &mut state.pool {
                        entry.state = "released".to_string();
                    }
                    Ok(())
                }
            },
            MissionCommand::Retry { dispatch_id } => {
                let dsp = state
                    .dispatches
                    .iter()
                    .find(|d| d.id == dispatch_id)
                    .ok_or_else(|| format!("unknown dispatch '{}'", dispatch_id))?;
                let task_id = dsp.task_id.clone();
                let task_idx = state
                    .tasks
                    .iter()
                    .position(|t| t.id == task_id)
                    .ok_or_else(|| format!("task '{}' for dispatch '{}' not found", task_id, dispatch_id))?;

                state.tasks[task_idx].status = "ready".to_string();
                Ok(())
            }
            MissionCommand::Abandon { dispatch_id } => {
                let dsp_idx = state
                    .dispatches
                    .iter()
                    .position(|d| d.id == dispatch_id)
                    .ok_or_else(|| format!("unknown dispatch '{}'", dispatch_id))?;
                state.dispatches[dsp_idx].status = "abandoned".to_string();
                let task_id = state.dispatches[dsp_idx].task_id.clone();
                if let Some(task_idx) = state.tasks.iter().position(|t| t.id == task_id) {
                    state.tasks[task_idx].status = "failed".to_string();
                }
                Ok(())
            }
            MissionCommand::ResolveGate {
                gate_id,
                resolution,
            } => gates::resolve_gate(&mut state, project_path, id, &gate_id, &resolution, "human"),
        };

        let outcome = match apply_result {
            Ok(()) => {
                state.revision += 1;
                state.updated_at = crate::project::now_iso();
                record_event(
                    project_path,
                    id,
                    &mut state,
                    &cmd_label,
                    serde_json::json!({ "requestId": request_id }),
                )?;
                let mut snapshot = state.clone();
                snapshot.idempotency.clear();
                CommandOutcome {
                    applied: true,
                    revision: state.revision,
                    error: None,
                    state: Some(Box::new(snapshot)),
                }
            }
            Err(error) => CommandOutcome {
                applied: false,
                revision: state.revision,
                error: Some(error),
                state: None,
            },
        };

        remember_outcome(&mut state, request_id, outcome.clone());
        // Recording the replay receipt is bookkeeping, not a mutation: revision unchanged.
        persist_state(project_path, id, &state)?;
        let response_state = outcome.state.as_deref().cloned();
        match outcome.error {
            Some(error) => Err(error),
            None => Ok(response_state.unwrap_or(state)),
        }
    })?
}

pub(crate) fn mission_dispatch_task_inner(
    project_path: &str,
    mission_id: &str,
    task_id: &str,
    provider: &str,
    model: Option<String>,
    expected_revision: u64,
) -> Result<TaskDispatchOutput, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let prepared = supervisor::prepare_dispatch_launch(
            &mut state,
            project_path,
            mission_id,
            task_id,
            provider,
            model,
        )?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;

        Ok(TaskDispatchOutput {
            state: Box::new(state),
            dispatch_id: prepared.dispatch_id,
            attempt_id: prepared.attempt_id,
            pane_id: prepared.pane_id,
            prompt_file: prepared.prompt_file,
            capability_token: prepared.capability_token,
        })
    })?
}

pub(crate) fn mission_record_dispatch_result_inner(
    project_path: &str,
    mission_id: &str,
    dispatch_id: &str,
    raw_output: &str,
    last_message_content: Option<String>,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let dispatch_idx = state
            .dispatches
            .iter()
            .position(|d| d.id == dispatch_id)
            .ok_or_else(|| format!("Dispatch '{}' not found in mission '{}'", dispatch_id, mission_id))?;

        let task_id = state.dispatches[dispatch_idx].task_id.clone();
        let provider = state.dispatches[dispatch_idx].provider.clone();
        let model = state.dispatches[dispatch_idx].model.clone();

        let parsed = crate::providers::parse_provider_result(
            &provider,
            raw_output,
            last_message_content.as_deref(),
        )?;

        let result_val = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
        let now = crate::project::now_iso();

        if !parsed.is_error {
            state.dispatches[dispatch_idx].status = "succeeded".to_string();
            state.dispatches[dispatch_idx].finished_at = Some(now.clone());
            state.dispatches[dispatch_idx].result = Some(result_val.clone());

            if let Some(task_idx) = state.tasks.iter().position(|t| t.id == task_id) {
                state.tasks[task_idx].status = "completed".to_string();
                state.tasks[task_idx].result = Some(result_val);
            }

            if let Some(session_id) = &parsed.session_id {
                let ad = crate::providers::adapter(&provider);
                if ad.map(|a| a.resume.is_some()).unwrap_or(false) {
                    supervisor::pool_idle_session(
                        &mut state,
                        &provider,
                        &model,
                        None,
                        session_id,
                        &task_id,
                    );
                }
            }

            scheduler::promote_ready_tasks(&mut state, project_path, mission_id)?;
            scheduler::evaluate_mission_terminal_status(&mut state, project_path, mission_id)?;

            record_event(
                project_path,
                mission_id,
                &mut state,
                "dispatch_settled",
                serde_json::json!({
                    "dispatchId": dispatch_id,
                    "taskId": task_id,
                    "status": "succeeded",
                }),
            )?;
        } else {
            supervisor::handle_dispatch_failure(
                &mut state,
                project_path,
                mission_id,
                dispatch_id,
                Some("execution_error".to_string()),
                Some(result_val),
            )?;
            scheduler::propagate_deadlocks(&mut state, project_path, mission_id)?;
            scheduler::evaluate_mission_terminal_status(&mut state, project_path, mission_id)?;
        }

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_tick_inner(
    project_path: &str,
    mission_id: &str,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        let caps = std::collections::HashMap::new();
        let outcome = scheduler::scheduler_tick(&mut state, project_path, mission_id, &caps)?;

        if outcome.terminal_status.is_some()
            || !outcome.promoted_task_ids.is_empty()
            || !outcome.blocked_task_ids.is_empty()
        {
            state.revision += 1;
            state.updated_at = crate::project::now_iso();
            persist_state(project_path, mission_id, &state)?;
        }

        Ok(state)
    })?
}

pub(crate) fn mission_recover_inner(
    project_path: &str,
    live_pane_ids: &std::collections::HashSet<String>,
) -> Result<Vec<MissionSummary>, String> {
    let root = missions_root(project_path)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("Failed to list missions: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if validate_mission_id(&id).is_err() {
            continue;
        }
        let state_path = state_file_path(project_path, &id)?;
        if !state_path.exists() {
            continue;
        }
        let res: Result<(), String> = crate::fs_lock::with_path_lock(&state_path, || {
            let mut state = match load_state(project_path, &id)? {
                LoadedState::Ok(s) => *s,
                _ => return Ok(()),
            };
            let changed = supervisor::reconcile_orphan_dispatches(&mut state, project_path, &id, live_pane_ids)?;
            if changed {
                state.revision += 1;
                state.updated_at = crate::project::now_iso();
                persist_state(project_path, &id, &state)?;
            }
            Ok(())
        })?;
        if res.is_ok() {
            if let Ok(MissionReadResult::Loaded { state, .. }) = mission_read_inner(project_path, &id) {
                summaries.push(summary_of(&state));
            }
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(summaries)
}

pub(crate) fn mission_settle_report_inner(
    project_path: &str,
    mission_id: &str,
    report: settlement::StepReport,
    expected_revision: u64,
) -> Result<SettlementOutcome, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let result = settlement::settle_step_report(&mut state, project_path, mission_id, &report)?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;

        Ok(SettlementOutcome {
            state: Box::new(state),
            result,
        })
    })?
}

pub(crate) fn mission_request_gate_inner(
    project_path: &str,
    mission_id: &str,
    input: gates::GateRequestInput,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        gates::request_gate(
            &mut state,
            project_path,
            mission_id,
            &input.dispatch_id,
            input.question,
            input.options,
        )?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_resolve_gate_inner(
    project_path: &str,
    mission_id: &str,
    gate_id: &str,
    resolution: &str,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        gates::resolve_gate(
            &mut state,
            project_path,
            mission_id,
            gate_id,
            resolution,
            "human",
        )?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_publish_artifact_inner(
    project_path: &str,
    mission_id: &str,
    input: ArtifactPublishInput,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let dispatch = state
            .dispatches
            .iter()
            .find(|d| d.id == input.dispatch_id)
            .ok_or_else(|| format!("Dispatch '{}' not found", input.dispatch_id))?;

        let task_id = dispatch.task_id.clone();
        let slug: String = input
            .label
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let slug = slug.trim_matches('-');
        let slug = if slug.is_empty() { "artifact" } else { slug };

        let m_dir = mission_dir(project_path, mission_id)?;
        let artifact_dir = m_dir.join("artifacts").join(slug);
        fs::create_dir_all(&artifact_dir)
            .map_err(|e| format!("Failed to create artifact directory: {}", e))?;
        let file_path = artifact_dir.join("index.md");
        fs::write(&file_path, &input.content)
            .map_err(|e| format!("Failed to write artifact: {}", e))?;

        let rel_path = format!("artifacts/{}/index.md", slug);
        record_event(
            project_path,
            mission_id,
            &mut state,
            "artifact_published",
            serde_json::json!({
                "dispatchId": input.dispatch_id,
                "taskId": task_id,
                "kind": input.kind,
                "label": input.label,
                "path": rel_path,
            }),
        )?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_ask_inner(
    project_path: &str,
    mission_id: &str,
    input: ask_reply::AskInput,
    expected_revision: u64,
) -> Result<AskOutcome, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let output = ask_reply::ask_question(&mut state, project_path, mission_id, input)?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(AskOutcome {
            state: Box::new(state),
            output,
        })
    })?
}

pub(crate) fn mission_reply_inner(
    project_path: &str,
    mission_id: &str,
    thread_id: &str,
    body: &str,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        ask_reply::reply_question(&mut state, project_path, mission_id, thread_id, body, "operator")?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_send_message_inner(
    project_path: &str,
    mission_id: &str,
    input: mailbox::SendMessageInput,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        mailbox::send_message(&mut state, project_path, mission_id, input)?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_inbox_fetch_inner(
    project_path: &str,
    mission_id: &str,
    recipient: &str,
) -> Result<Vec<MissionMessage>, String> {
    let state = require_state(project_path, mission_id)?;
    Ok(mailbox::inbox_fetch(&state, recipient))
}

pub(crate) fn mission_inbox_ack_inner(
    project_path: &str,
    mission_id: &str,
    message_ids: Vec<String>,
    expected_revision: u64,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        mailbox::inbox_ack(&mut state, project_path, mission_id, &message_ids)?;

        state.revision += 1;
        state.updated_at = crate::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

// --- Tauri commands -----------------------------------------------------------------------------

#[tauri::command]
pub async fn mission_create(
    project_path: String,
    title: String,
    objective: String,
    acceptance: Option<Vec<String>>,
    options: Option<MissionOptions>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionSummary, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = options.unwrap_or_default();
        if acceptance.is_some() {
            options.acceptance = acceptance;
        }
        mission_create_inner(&project_path, &title, &objective, options)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_list(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<MissionSummary>, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || mission_list_inner(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_read(
    project_path: String,
    id: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionReadResult, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || mission_read_inner(&project_path, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_update_doc(
    project_path: String,
    id: String,
    body: String,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_update_doc_inner(&project_path, &id, &body, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_set_tasks(
    project_path: String,
    id: String,
    expected_revision: u64,
    tasks: Vec<TaskSpecInput>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_set_tasks_inner(&project_path, &id, expected_revision, tasks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_command(
    project_path: String,
    id: String,
    expected_revision: u64,
    request_id: String,
    cmd: MissionCommand,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_command_inner(&project_path, &id, expected_revision, &request_id, cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_dispatch_task(
    project_path: String,
    mission_id: String,
    task_id: String,
    provider: String,
    model: Option<String>,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<TaskDispatchOutput, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_dispatch_task_inner(
            &project_path,
            &mission_id,
            &task_id,
            &provider,
            model,
            expected_revision,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_record_dispatch_result(
    project_path: String,
    mission_id: String,
    dispatch_id: String,
    raw_output: String,
    last_message_content: Option<String>,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_record_dispatch_result_inner(
            &project_path,
            &mission_id,
            &dispatch_id,
            &raw_output,
            last_message_content,
            expected_revision,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_tick(
    project_path: String,
    mission_id: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_tick_inner(&project_path, &mission_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_recover(
    project_path: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
    pty_registry: tauri::State<'_, crate::pty::PtyRegistry>,
) -> Result<Vec<MissionSummary>, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    let live_pane_ids: std::collections::HashSet<String> = {
        let sessions = pty_registry.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    };
    tauri::async_runtime::spawn_blocking(move || {
        mission_recover_inner(&project_path, &live_pane_ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_settle_report(
    project_path: String,
    mission_id: String,
    report: settlement::StepReport,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<SettlementOutcome, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_settle_report_inner(&project_path, &mission_id, report, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_request_gate(
    project_path: String,
    mission_id: String,
    input: gates::GateRequestInput,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_request_gate_inner(&project_path, &mission_id, input, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_resolve_gate(
    project_path: String,
    mission_id: String,
    gate_id: String,
    resolution: String,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_resolve_gate_inner(&project_path, &mission_id, &gate_id, &resolution, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_publish_artifact(
    project_path: String,
    mission_id: String,
    input: ArtifactPublishInput,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_publish_artifact_inner(
            &project_path,
            &mission_id,
            input,
            expected_revision,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_ask(
    project_path: String,
    mission_id: String,
    input: ask_reply::AskInput,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<AskOutcome, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_ask_inner(&project_path, &mission_id, input, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_reply(
    project_path: String,
    mission_id: String,
    thread_id: String,
    body: String,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_reply_inner(&project_path, &mission_id, &thread_id, &body, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_send_message(
    project_path: String,
    mission_id: String,
    input: mailbox::SendMessageInput,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_send_message_inner(&project_path, &mission_id, input, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_inbox_fetch(
    project_path: String,
    mission_id: String,
    recipient: String,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<MissionMessage>, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_inbox_fetch_inner(&project_path, &mission_id, &recipient)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_inbox_ack(
    project_path: String,
    mission_id: String,
    message_ids: Vec<String>,
    expected_revision: u64,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<MissionState, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        mission_inbox_ack_inner(&project_path, &mission_id, message_ids, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_roots::ProjectRootRegistry;

    /// Contained scratch project with an approved root, mirroring the TempProject
    /// pattern from state_load.rs tests.
    struct TempProject {
        path: PathBuf,
        _registry: Arc<ProjectRootRegistry>,
    }

    impl TempProject {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("saple_missions_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join(".saple")).unwrap();
            let registry = Arc::new(ProjectRootRegistry::new());
            registry.register_root(&path).unwrap();
            TempProject {
                path,
                _registry: registry,
            }
        }
        fn project(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
        /// Path helpers used by crash-simulation assertions.
        fn mission_dir(&self, id: &str) -> PathBuf {
            self.path.join(".saple").join("missions").join(id)
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            // Clear any corrupt flag this test planted so later temp projects sharing
            // nothing still behave (flags are keyed by canonical path, but be tidy).
            let root = self.path.join(".saple").join("missions");
            if let Ok(entries) = fs::read_dir(&root) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let _ = crate::fs_lock::clear_corrupt_flag(&entry.path().join("state.json"));
                }
            }
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn create_mission(p: &TempProject, title: &str) -> MissionSummary {
        mission_create_inner(
            &p.project(),
            title,
            "Do the thing",
            MissionOptions::default(),
        )
        .unwrap()
    }

    // --- Frontmatter parsing -------------------------------------------------------------------

    #[test]
    fn render_then_parse_round_trips_the_spec() {
        let spec = MissionSpec {
            title: "Add OAuth login".into(),
            objective: "Ship one paragraph the coordinator decomposes.".into(),
            acceptance: vec!["npm test passes".into(), "manual flow works".into()],
            max_parallel: 3,
            max_rounds: 8,
            budget_usd_cap: 12.5,
            worktree_mode: "per-task".into(),
            coordinator: Some(CoordinatorSpec {
                provider: "opencode".into(),
                model: "gpt-5.2".into(),
                permission: "full_access".into(),
            }),
        };
        let doc = render_mission_doc(&spec, "# Body\n\nprose stays untouched\n");
        let parsed = parse_mission_doc(&doc).unwrap();
        assert_eq!(parsed.spec, spec);
        // The body below the fence is preserved verbatim in the rendered document.
        assert!(doc.contains("# Body"));
        assert!(doc.contains("prose stays untouched"));
    }

    #[test]
    fn parse_accepts_quoted_scalars_and_multiline_coordinator_block() {
        let doc = "---\ntitle: \"Quoted \\\"Title\\\"\"\nobjective: plain\nacceptance:\n  - first\n  - \"second item\"\nmax_parallel: 2\nmax_rounds: 4\nbudget_usd_cap: 5\nworktree_mode: shared\ncoordinator:\n  provider: claude\n  model: sonnet\n---\n\nbody";
        let parsed = parse_mission_doc(doc).unwrap();
        assert_eq!(parsed.spec.title, "Quoted \"Title\"");
        assert_eq!(parsed.spec.acceptance, vec!["first", "second item"]);
        assert_eq!(parsed.spec.budget_usd_cap, 5.0);
        let coordinator = parsed.spec.coordinator.unwrap();
        assert_eq!(coordinator.provider, "claude");
        assert_eq!(coordinator.model, "sonnet");
    }

    #[test]
    fn parse_rejects_unknown_keys_with_their_line_number() {
        let err =
            parse_mission_doc("---\ntitle: t\nobjective: o\nbogus_key: 1\n---\n").unwrap_err();
        assert!(
            err.contains("unknown frontmatter key 'bogus_key'"),
            "{}",
            err
        );
        assert!(err.contains("line 4"), "{}", err);
    }

    #[test]
    fn parse_rejects_out_of_range_limits_and_bad_modes() {
        let cases = [
            ("max_parallel: 0", "max_parallel"),
            ("max_parallel: 9", "max_parallel"),
            ("max_rounds: 0", "max_rounds"),
            ("budget_usd_cap: 0", "budget_usd_cap"),
            ("worktree_mode: solo", "worktree_mode"),
            ("max_parallel: many", "whole number"),
        ];
        for (override_line, needle) in cases {
            let doc = format!("---\ntitle: t\nobjective: o\n{}\n---\n", override_line);
            let err = parse_mission_doc(&doc).unwrap_err();
            assert!(
                err.contains(needle),
                "'{}' should mention {}: got {}",
                override_line,
                needle,
                err
            );
        }
    }

    #[test]
    fn parse_rejects_missing_fences_and_empty_required_fields() {
        assert!(parse_mission_doc("no frontmatter here").is_err());
        assert!(
            parse_mission_doc("---\ntitle: t\nobjective: o\n").is_err(),
            "missing close fence"
        );
        assert!(
            parse_mission_doc("---\nobjective: o\n---\n").is_err(),
            "missing title"
        );
        assert!(
            parse_mission_doc("---\ntitle: t\n---\n").is_err(),
            "missing objective"
        );
    }

    #[test]
    fn parse_rejects_unknown_coordinator_entries() {
        let err = parse_mission_doc(
            "---\ntitle: t\nobjective: o\ncoordinator: { provider: x, sneaky: 1 }\n---\n",
        )
        .unwrap_err();
        assert!(err.contains("sneaky"), "{}", err);
    }

    #[test]
    fn mission_id_validation_blocks_path_tricks() {
        assert!(validate_mission_id("msn_01JqZ9").is_ok());
        for bad in [
            "", "task_1", "msn_", "../etc", "msn_a/b", "msn_a b", "MSN_x",
        ] {
            assert!(
                validate_mission_id(bad).is_err(),
                "'{}' must be rejected",
                bad
            );
        }
    }

    // --- Create / read / list ------------------------------------------------------------------

    #[test]
    fn create_then_read_round_trips() {
        let p = TempProject::new();
        let summary = mission_create_inner(
            &p.project(),
            "Add OAuth login",
            "One paragraph objective",
            MissionOptions {
                acceptance: Some(vec!["npm test passes".to_string()]),
                max_parallel: Some(2),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(summary.title, "Add OAuth login");
        assert_eq!(summary.status, "draft");
        assert!(summary.id.starts_with("msn_"));

        match mission_read_inner(&p.project(), &summary.id).unwrap() {
            MissionReadResult::Loaded {
                state,
                doc,
                warnings,
            } => {
                assert_eq!(state.id, summary.id);
                assert_eq!(state.revision, 1);
                assert_eq!(state.spec.max_parallel, 2);
                assert_eq!(state.spec.acceptance, vec!["npm test passes"]);
                assert!(warnings.is_empty(), "plain load carries no warnings");
                // The rendered doc is hand-editable markdown with frontmatter.
                assert!(doc.starts_with("---\n"));
                assert!(doc.contains("title: \"Add OAuth login\""));
                assert!(p.mission_dir(&summary.id).join("artifacts").exists());
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn generated_ids_use_the_documented_prefix_and_ulid_shape() {
        let p = TempProject::new();
        let mission = create_mission(&p, "IDs");
        assert!(mission.id.starts_with("msn_"));
        assert_eq!(mission.id.len(), 30);

        let state = mission_read_inner(&p.project(), &mission.id).unwrap();
        let MissionReadResult::Loaded { state, .. } = state else {
            panic!("expected loaded mission")
        };
        let tasks = mission_set_tasks_inner(
            &p.project(),
            &mission.id,
            state.revision,
            vec![TaskSpecInput {
                key: Some("one".to_string()),
                title: "One".to_string(),
                kind: "implement".to_string(),
                spec: String::new(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();
        assert!(tasks.tasks[0].id.starts_with("task_"));
        assert_eq!(tasks.tasks[0].id.len(), 31);
    }

    #[test]
    fn read_reports_missing_for_unknown_ids() {
        let p = TempProject::new();
        assert!(matches!(
            mission_read_inner(&p.project(), "msn_doesnotexist").unwrap(),
            MissionReadResult::Missing
        ));
        assert!(!p.path.join(".saple").join("missions").exists());
    }

    #[test]
    fn state_id_mismatch_is_corrupt_and_preserves_evidence() {
        let p = TempProject::new();
        let mission = create_mission(&p, "Identity");
        let state_path = p.mission_dir(&mission.id).join("state.json");
        let mut state: MissionState =
            serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        state.id = "msn_other".to_string();
        fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();

        match mission_read_inner(&p.project(), &mission.id).unwrap() {
            MissionReadResult::Corrupt { error, backup_path } => {
                assert!(error.contains("does not match"), "{}", error);
                assert!(Path::new(&backup_path).exists());
            }
            other => panic!("expected corrupt identity, got {:?}", other),
        }
    }

    #[test]
    fn list_returns_summaries_newest_first() {
        let p = TempProject::new();
        let first = create_mission(&p, "First");
        // now_iso has second resolution; age the first mission explicitly so ordering
        // is deterministic instead of same-second tie-break luck.
        let state_path = p.mission_dir(&first.id).join("state.json");
        let mut older: MissionState =
            serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        older.updated_at = "2020-01-01T00:00:00Z".to_string();
        fs::write(&state_path, serde_json::to_vec_pretty(&older).unwrap()).unwrap();

        let second = create_mission(&p, "Second");

        let summaries = mission_list_inner(&p.project()).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, second.id, "second was created later");
        assert_eq!(summaries[1].id, first.id);

        // A stray directory that does not look like a mission id is ignored.
        fs::create_dir_all(p.path.join(".saple").join("missions").join("not-a-mission")).unwrap();
        assert_eq!(mission_list_inner(&p.project()).unwrap().len(), 2);
    }

    #[test]
    fn list_surfaces_a_doc_when_state_is_missing() {
        let p = TempProject::new();
        let mission = create_mission(&p, "Recover me");
        fs::remove_file(p.mission_dir(&mission.id).join("state.json")).unwrap();

        let summaries = mission_list_inner(&p.project()).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, mission.id);
        assert_eq!(summaries[0].title, "Recover me");
        assert_eq!(summaries[0].status, "draft");
    }

    #[test]
    fn mission_commands_require_the_workspace_flag() {
        let p = TempProject::new();
        assert!(ensure_missions_enabled(&p.project()).is_err());

        fs::write(
            p.path.join(".saple").join("config.json"),
            serde_json::json!({
                "workspaceId": "test",
                "workspaceName": "test",
                "memoryMode": "saple",
                "defaultProvider": "codex",
                "defaultModelByProvider": {},
                "maxParallelAgents": 12,
                "enableEditMode": true,
                "verificationPresets": [],
                "missionsEnabled": true,
                "createdAt": "now",
                "updatedAt": "now"
            })
            .to_string(),
        )
        .unwrap();
        assert!(ensure_missions_enabled(&p.project()).is_ok());
    }

    // --- Doc editing -----------------------------------------------------------------------------

    #[test]
    fn update_doc_validates_rewrites_spec_and_bumps_revision() {
        let p = TempProject::new();
        let m = create_mission(&p, "Before");

        let new_doc = "---\ntitle: After\nobjective: updated objective\nmax_parallel: 6\nmax_rounds: 3\nbudget_usd_cap: 9\nworktree_mode: per-mission\n---\n\nNew body prose.\n";
        let state = mission_update_doc_inner(&p.project(), &m.id, new_doc, 1).unwrap();

        assert_eq!(state.revision, 2);
        assert_eq!(state.spec.title, "After");
        assert_eq!(state.spec.max_parallel, 6);
        // Prose landed verbatim on disk.
        let on_disk = fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap();
        assert!(on_disk.contains("New body prose."));
        // The event log records the edit.
        assert!(state.events.iter().any(|e| e.kind == "doc_updated"));

        // Stale revision refused.
        let err = mission_update_doc_inner(&p.project(), &m.id, new_doc, 1).unwrap_err();
        assert!(err.contains("Revision conflict"), "{}", err);

        // Invalid frontmatter refused without touching disk.
        let before = fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap();
        let err =
            mission_update_doc_inner(&p.project(), &m.id, "---\nbogus: 1\n---\n", state.revision)
                .unwrap_err();
        assert!(err.contains("bogus"));
        assert_eq!(
            fs::read_to_string(p.mission_dir(&m.id).join("mission.md")).unwrap(),
            before
        );
    }

    #[test]
    fn hand_edited_frontmatter_is_adopted_on_read() {
        let p = TempProject::new();
        let m = create_mission(&p, "Original");

        let doc_path = p.mission_dir(&m.id).join("mission.md");
        let edited = "---\ntitle: Hand Edited\nobjective: changed externally\nmax_parallel: 8\nmax_rounds: 12\nbudget_usd_cap: 15\nworktree_mode: shared\n---\n\nExternal prose.\n";
        fs::write(&doc_path, edited).unwrap();

        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded {
                state, warnings, ..
            } => {
                assert_eq!(state.spec.title, "Hand Edited");
                assert_eq!(state.spec.max_parallel, 8);
                assert_eq!(state.revision, 2, "adoption is an audited revision bump");
                assert!(warnings.is_empty());
                assert!(state.events.iter().any(|e| e.kind == "doc_reconciled"));
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn list_reconciles_hand_edited_frontmatter() {
        let p = TempProject::new();
        let m = create_mission(&p, "Original");
        fs::write(
            p.mission_dir(&m.id).join("mission.md"),
            "---\ntitle: Renamed\nobjective: changed\n---\n\nbody\n",
        )
        .unwrap();

        let summaries = mission_list_inner(&p.project()).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Renamed");
        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => assert_eq!(state.revision, 2),
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn invalid_external_edit_falls_back_to_last_good_spec_with_warning() {
        let p = TempProject::new();
        let m = create_mission(&p, "Good Spec");

        // An agent typoed the frontmatter: unknown key AND out-of-range parallelism.
        fs::write(
            p.mission_dir(&m.id).join("mission.md"),
            "---\ntitle: Broken Edit\nobjective: o\nmax_parallel: 99\nwho_knows: 1\n---\n",
        )
        .unwrap();

        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded {
                state, warnings, ..
            } => {
                assert_eq!(state.spec.title, "Good Spec", "last-good spec kept");
                assert_eq!(state.revision, 1, "no adoption happened");
                assert_eq!(warnings.len(), 1);
                assert!(warnings[0].contains("rejected"), "{}", warnings[0]);
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn crash_between_writes_repairs_state_from_markdown_on_read() {
        let p = TempProject::new();
        let m = create_mission(&p, "Crash Survivor");
        // Simulate the kill between mission.md and state.json writes.
        fs::remove_file(p.mission_dir(&m.id).join("state.json")).unwrap();

        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded {
                state, warnings, ..
            } => {
                assert_eq!(state.spec.title, "Crash Survivor");
                assert!(
                    warnings.iter().any(|w| w.contains("rebuilt")),
                    "{:?}",
                    warnings
                );
                // The repaired file persists and lists cleanly afterwards.
                assert!(p.mission_dir(&m.id).join("state.json").exists());
                assert!(mission_list_inner(&p.project())
                    .unwrap()
                    .iter()
                    .any(|s| s.id == m.id && s.title == "Crash Survivor"));
            }
            other => panic!("expected repaired load, got {:?}", other),
        }
    }

    #[test]
    fn corrupt_state_preserves_bytes_and_surfaces_recovery() {
        let p = TempProject::new();
        let m = create_mission(&p, "Corruptible");
        let state_path = p.mission_dir(&m.id).join("state.json");
        fs::write(&state_path, "{ not json").unwrap();

        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Corrupt { error, backup_path } => {
                assert!(error.contains("parse"), "{}", error);
                assert_eq!(fs::read_to_string(&backup_path).unwrap(), "{ not json");
            }
            other => panic!("expected corrupt, got {:?}", other),
        }
        // Mutations refuse to touch the evidence while flagged...
        let err = mission_set_tasks_inner(&p.project(), &m.id, 1, vec![]).unwrap_err();
        assert!(err.contains("parse"), "{}", err);
        assert_eq!(fs::read_to_string(&state_path).unwrap(), "{ not json");

        // ...until the file is repaired externally (a clean parse lifts the flag).
        let repaired = format!(
            r#"{{"id":"{id}","revision":1,"status":"draft","spec":{{"title":"Corruptible","objective":"Do the thing","acceptance":[],"maxParallel":4,"maxRounds":12,"budgetUsdCap":15,"worktreeMode":"shared"}},"tasks":[],"events":[],"idempotency":{{}},"createdAt":"t","updatedAt":"t"}}"#,
            id = m.id
        );
        fs::write(&state_path, repaired).unwrap();
        let state = mission_set_tasks_inner(&p.project(), &m.id, 1, vec![]).unwrap();
        assert_eq!(state.revision, 2);
    }

    // --- Task DAG --------------------------------------------------------------------------------

    fn task_input(key: &str, deps: &[&str]) -> TaskSpecInput {
        TaskSpecInput {
            key: Some(key.to_string()),
            title: format!("Task {}", key),
            kind: "implement".to_string(),
            spec: format!("Instructions for {}", key),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            fanout: 1,
        }
    }

    #[test]
    fn dag_validator_catches_cycles_unknown_deps_and_self_deps() {
        let keys = |k: &[&str]| k.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let deps = |d: &[&[&str]]| -> Vec<Vec<String>> {
            d.iter()
                .map(|row| row.iter().map(|s| s.to_string()).collect::<Vec<_>>())
                .collect()
        };

        validate_task_dag(&keys(&["a", "b"]), &deps(&[&[], &["a"]])).unwrap();
        validate_task_dag(&keys(&["a"]), &deps(&[&[]])).unwrap();
        validate_task_dag(&keys(&[]), &deps(&[])).unwrap();

        // Direct + transitive cycles.
        let err = validate_task_dag(&keys(&["a", "b"]), &deps(&[&["b"], &["a"]])).unwrap_err();
        assert!(err.contains("cycle"), "{}", err);
        let err = validate_task_dag(
            &keys(&["root", "a", "b", "c"]),
            &deps(&[&[], &["root", "c"], &["a"], &["b"]]),
        )
        .unwrap_err();
        assert!(err.contains("cycle"), "{}", err);

        // Self-dep and unknown dep get their own messages.
        let err = validate_task_dag(&keys(&["a"]), &deps(&[&["a"]])).unwrap_err();
        assert!(err.contains("itself"), "{}", err);
        let err = validate_task_dag(&keys(&["a"]), &deps(&[&["ghost"]])).unwrap_err();
        assert!(err.contains("unknown task 'ghost'"), "{}", err);

        // Duplicate keys are rejected before any graph walk.
        let err = validate_task_dag(&keys(&["a", "a"]), &deps(&[&[], &[]])).unwrap_err();
        assert!(err.contains("duplicate task key"), "{}", err);
    }

    #[test]
    fn set_tasks_computes_initial_statuses_and_mints_server_ids() {
        let p = TempProject::new();
        let m = create_mission(&p, "Dag Mission");

        let specs = vec![
            task_input("setup", &[]),
            task_input("fe", &["setup"]),
            task_input("be", &["setup"]),
            task_input("verify", &["fe", "be"]),
        ];
        let state = mission_set_tasks_inner(&p.project(), &m.id, 1, specs).unwrap();

        assert_eq!(state.tasks.len(), 4);
        assert_eq!(state.revision, 2);
        let by_title = |t: &str| {
            state
                .tasks
                .iter()
                .find(|x| x.title == format!("Task {}", t))
                .unwrap()
        };
        assert_eq!(by_title("setup").status, "ready");
        assert_eq!(by_title("fe").status, "pending");
        assert_eq!(by_title("be").status, "pending");
        assert_eq!(by_title("verify").status, "pending");
        // Deps were remapped from client keys to server-minted ids.
        let fe = by_title("fe");
        assert_eq!(fe.deps, vec![by_title("setup").id.clone()]);
        assert!(fe.id.starts_with("task_"));
        // All four ids are unique.
        let mut ids: Vec<_> = state.tasks.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4);
        assert!(state.events.iter().any(|e| e.kind == "tasks_set"));
    }

    #[test]
    fn set_tasks_rejects_bad_graphs_without_writing() {
        let p = TempProject::new();
        let m = create_mission(&p, "Rejects");

        let cases: Vec<(Vec<TaskSpecInput>, &str)> = vec![
            (vec![task_input("a", &["ghost"])], "unknown task 'ghost'"),
            (vec![task_input("a", &["a"])], "depends on itself"),
            (
                vec![task_input("a", &["b"]), task_input("b", &["a"])],
                "cycle",
            ),
        ];
        for (specs, needle) in cases {
            let err = mission_set_tasks_inner(&p.project(), &m.id, 1, specs).unwrap_err();
            assert!(err.contains(needle), "expected '{}': got {}", needle, err);
        }

        // Kind + fanout validation.
        let mut bad_kind = task_input("a", &[]);
        bad_kind.kind = "deploy".to_string();
        assert!(
            mission_set_tasks_inner(&p.project(), &m.id, 1, vec![bad_kind])
                .unwrap_err()
                .contains("invalid kind")
        );
        let mut bad_fanout = task_input("a", &[]);
        bad_fanout.fanout = 4;
        assert!(
            mission_set_tasks_inner(&p.project(), &m.id, 1, vec![bad_fanout])
                .unwrap_err()
                .contains("fanout")
        );

        // Nothing above may have mutated the mission: still revision 1, no tasks.
        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => {
                assert_eq!(state.revision, 1);
                assert!(state.tasks.is_empty());
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    // --- Commands: CAS, lifecycle, idempotency ----------------------------------------------------

    #[test]
    fn cas_conflict_refuses_stale_writes() {
        let p = TempProject::new();
        let m = create_mission(&p, "Cas");
        let err = mission_command_inner(&p.project(), &m.id, 999, "req_1", MissionCommand::Start)
            .unwrap_err();
        assert!(err.contains("Revision conflict"), "{}", err);
        // Nothing changed.
        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => {
                assert_eq!(state.status, "draft");
                assert_eq!(state.revision, 1);
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn lifecycle_transitions_follow_the_status_machine() {
        let p = TempProject::new();
        let m = create_mission(&p, "Lifecycle");

        let run = |rev, req: &str, cmd| {
            mission_command_inner(&p.project(), &m.id, rev, req, cmd).map(|s| s.status)
        };
        assert_eq!(run(1, "r1", MissionCommand::Start).unwrap(), "running");
        assert_eq!(run(2, "r2", MissionCommand::Pause).unwrap(), "paused");
        assert_eq!(run(3, "r3", MissionCommand::Resume).unwrap(), "running");
        assert_eq!(run(4, "r4", MissionCommand::Cancel).unwrap(), "cancelled");

        // Terminal states reject everything.
        let err = run(5, "r5", MissionCommand::Start).unwrap_err();
        assert!(err.contains("'cancelled'"), "{}", err);

        // Invalid transition from draft recorded as rejection, state unchanged.
        let m2 = create_mission(&p, "No Pause Yet");
        let err = mission_command_inner(&p.project(), &m2.id, 1, "bad", MissionCommand::Resume)
            .unwrap_err();
        assert!(err.contains("cannot resume"), "{}", err);
        match mission_read_inner(&p.project(), &m2.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => {
                assert_eq!(state.status, "draft");
                assert_eq!(
                    state.events.iter().filter(|e| e.kind == "resumed").count(),
                    0
                );
            }
            other => panic!("expected loaded, got {:?}", other),
        }
    }

    #[test]
    fn command_replay_is_idempotent_for_applied_and_rejected_requests() {
        let p = TempProject::new();
        let m = create_mission(&p, "Replay");

        // First application flips to running at revision 2.
        let applied =
            mission_command_inner(&p.project(), &m.id, 1, "req_start", MissionCommand::Start)
                .unwrap();
        assert_eq!(applied.status, "running");
        assert_eq!(applied.revision, 2);

        // A later transition changes the live state, but does not change the original result.
        let paused =
            mission_command_inner(&p.project(), &m.id, 2, "req_pause", MissionCommand::Pause)
                .unwrap();
        assert_eq!(paused.status, "paused");
        let replayed =
            mission_command_inner(&p.project(), &m.id, 1, "req_start", MissionCommand::Start)
                .unwrap();
        assert_eq!(replayed.status, "running");
        assert_eq!(replayed.revision, 2, "replay returns the original result");
        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => {
                assert_eq!(state.revision, 3);
                assert_eq!(
                    state.events.iter().filter(|e| e.kind == "started").count(),
                    1
                );
            }
            other => panic!("expected loaded, got {:?}", other),
        }

        // A rejected request replays its recorded error on repeat attempts.
        let first_err = mission_command_inner(
            &p.project(),
            &m.id,
            3,
            "req_bad",
            MissionCommand::Retry {
                dispatch_id: "dsp_missing".to_string(),
            },
        )
        .unwrap_err();
        assert!(first_err.contains("unknown dispatch"), "{}", first_err);
        let replay_err = mission_command_inner(
            &p.project(),
            &m.id,
            3,
            "req_bad",
            MissionCommand::Retry {
                dispatch_id: "dsp_missing".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(first_err, replay_err);

        // A genuinely new request_id applies normally.
        let next =
            mission_command_inner(&p.project(), &m.id, 3, "req_cancel", MissionCommand::Cancel)
                .unwrap();
        assert_eq!(next.status, "cancelled");
    }

    #[test]
    fn empty_request_id_is_rejected_before_any_locking() {
        let p = TempProject::new();
        let m = create_mission(&p, "ReqId");
        let err =
            mission_command_inner(&p.project(), &m.id, 1, "  ", MissionCommand::Start).unwrap_err();
        assert!(err.contains("request_id"), "{}", err);
    }

    // --- Event log --------------------------------------------------------------------------------

    #[test]
    fn event_overflow_archives_to_events_log() {
        let p = TempProject::new();
        let m = create_mission(&p, "Archive");
        let mut state = match load_state(&p.project(), &m.id).unwrap() {
            LoadedState::Ok(state) => state,
            _ => panic!("state must load"),
        };
        for n in 0..(EVENT_CAP + 20) {
            record_event(
                &p.project(),
                &m.id,
                &mut state,
                "tick",
                serde_json::json!({ "n": n }),
            )
            .unwrap();
        }
        assert_eq!(state.events.len(), EVENT_CAP);
        assert_eq!(state.events.first().unwrap().seq, 21, "oldest 20 archived");
        persist_state(&p.project(), &m.id, &state).unwrap();

        let log = fs::read_to_string(p.mission_dir(&m.id).join("events.log")).unwrap();
        assert_eq!(log.lines().count(), 20);
        assert!(log.lines().next().unwrap().contains("\"seq\":1"));
    }

    // --- Phase M2: Dispatching & Result Recording --------------------------------------------------

    #[test]
    fn manual_dispatch_creates_attempt_preamble_and_running_dispatch() {
        let p = TempProject::new();
        let m = create_mission(&p, "DispatchTest");
        let initial_state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![
                TaskSpecInput {
                    key: Some("t1".to_string()),
                    title: "Task 1".to_string(),
                    kind: "implement".to_string(),
                    spec: "Write authentication service".to_string(),
                    deps: Vec::new(),
                    fanout: 1,
                },
                TaskSpecInput {
                    key: Some("t2".to_string()),
                    title: "Task 2".to_string(),
                    kind: "verify".to_string(),
                    spec: "Run auth tests".to_string(),
                    deps: vec!["t1".to_string()],
                    fanout: 1,
                },
            ],
        )
        .unwrap();

        let task1_id = initial_state.tasks[0].id.clone();
        let task2_id = initial_state.tasks[1].id.clone();
        assert_eq!(initial_state.tasks[0].status, "ready");
        assert_eq!(initial_state.tasks[1].status, "pending");

        let dispatch_output = mission_dispatch_task_inner(
            &p.project(),
            &m.id,
            &task1_id,
            "codex",
            Some("gpt-5.2".to_string()),
            2,
        )
        .unwrap();

        assert!(dispatch_output.dispatch_id.starts_with("dsp_"));
        assert!(dispatch_output.attempt_id.starts_with("att_"));
        assert!(dispatch_output.pane_id.starts_with("pane_"));
        assert!(!dispatch_output.capability_token.is_empty());

        let state = dispatch_output.state;
        assert_eq!(state.revision, 3);
        assert_eq!(state.tasks[0].status, "dispatched");
        assert_eq!(state.dispatches.len(), 1);

        let d = &state.dispatches[0];
        assert_eq!(d.id, dispatch_output.dispatch_id);
        assert_eq!(d.task_id, task1_id);
        assert_eq!(d.provider, "codex");
        assert_eq!(d.model, "gpt-5.2");
        assert_eq!(d.status, "starting");
        assert!(d.capability_hash.starts_with("sha256:"));

        // Check that prompt file was written to disk
        let prompt_path = p.path.join(&dispatch_output.prompt_file);
        assert!(prompt_path.exists());
        let prompt_body = fs::read_to_string(prompt_path).unwrap();
        assert!(prompt_body.contains("Write authentication service"));
        assert!(prompt_body.contains(&dispatch_output.dispatch_id));

        // Now settle dispatch 1 with codex result
        let fixture = include_str!("../fixtures/codex_jsonl.jsonl");
        let settled_state = mission_record_dispatch_result_inner(
            &p.project(),
            &m.id,
            &dispatch_output.dispatch_id,
            fixture,
            Some("Auth service is done and tested.".to_string()),
            3,
        )
        .unwrap();

        assert_eq!(settled_state.revision, 4);
        assert_eq!(settled_state.dispatches[0].status, "succeeded");
        assert_eq!(settled_state.tasks[0].status, "completed");
        // Task 2 was promoted from pending to ready!
        assert_eq!(settled_state.tasks[1].status, "ready");
        assert_eq!(settled_state.tasks[1].id, task2_id);
    }

    #[test]
    fn dispatch_rejects_ineligible_provider() {
        let p = TempProject::new();
        let m = create_mission(&p, "Ineligible");
        let initial_state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let task1_id = initial_state.tasks[0].id.clone();
        let err = mission_dispatch_task_inner(
            &p.project(),
            &m.id,
            &task1_id,
            "cursor",
            None,
            2,
        )
        .unwrap_err();

        assert!(err.contains("not eligible"), "{}", err);
    }

    #[test]
    fn dispatch_revision_conflict_fails_cleanly() {
        let p = TempProject::new();
        let m = create_mission(&p, "Conflict");
        let initial_state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let task1_id = initial_state.tasks[0].id.clone();
        let err = mission_dispatch_task_inner(
            &p.project(),
            &m.id,
            &task1_id,
            "claude",
            None,
            999, // wrong revision
        )
        .unwrap_err();

        assert!(err.contains("Revision conflict"), "{}", err);
    }

    // --- Phase M3: Scheduler, Supervisor, Pooling, and Recovery Tests -------------------------------

    #[test]
    fn scheduler_tick_promotes_waves_and_completes_mission() {
        let p = TempProject::new();
        let m = create_mission(&p, "WaveTest");

        // Start mission
        let started = mission_command_inner(&p.project(), &m.id, 1, "start_1", MissionCommand::Start).unwrap();
        assert_eq!(started.status, "running");

        // Set DAG: T1 -> T2
        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            2,
            vec![
                TaskSpecInput {
                    key: Some("t1".to_string()),
                    title: "Task 1".to_string(),
                    kind: "implement".to_string(),
                    spec: "Step 1".to_string(),
                    deps: Vec::new(),
                    fanout: 1,
                },
                TaskSpecInput {
                    key: Some("t2".to_string()),
                    title: "Task 2".to_string(),
                    kind: "verify".to_string(),
                    spec: "Step 2".to_string(),
                    deps: vec!["t1".to_string()],
                    fanout: 1,
                },
            ],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let t2_id = state.tasks[1].id.clone();

        // Dispatch T1
        let dsp1 = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 3).unwrap();
        assert_eq!(dsp1.state.tasks[0].status, "dispatched");

        // Settle T1
        let fixture = include_str!("../fixtures/codex_jsonl.jsonl");
        let settled1 = mission_record_dispatch_result_inner(
            &p.project(),
            &m.id,
            &dsp1.dispatch_id,
            fixture,
            Some("Step 1 done".to_string()),
            4,
        )
        .unwrap();

        assert_eq!(settled1.tasks[0].status, "completed");
        assert_eq!(settled1.tasks[1].status, "ready");
        // Session was pooled
        assert_eq!(settled1.pool.len(), 1);
        assert_eq!(settled1.pool[0].state, "idle");

        // Dispatch T2 with session reuse!
        let dsp2 = mission_dispatch_task_inner(&p.project(), &m.id, &t2_id, "codex", None, 5).unwrap();
        assert_eq!(dsp2.state.pool[0].state, "retained");
        assert_eq!(dsp2.state.pool[0].reused_count, 1);

        // Settle T2 -> mission automatically completes!
        let settled2 = mission_record_dispatch_result_inner(
            &p.project(),
            &m.id,
            &dsp2.dispatch_id,
            fixture,
            Some("Step 2 verified".to_string()),
            6,
        )
        .unwrap();

        assert_eq!(settled2.status, "completed");
        assert_eq!(settled2.tasks[1].status, "completed");
        assert_eq!(settled2.pool[0].state, "released");
    }

    #[test]
    fn retry_and_abandon_commands_behave_correctly() {
        let p = TempProject::new();
        let m = create_mission(&p, "RetryAbandonTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

        // Abandon command
        let abandoned = mission_command_inner(
            &p.project(),
            &m.id,
            3,
            "req_abandon",
            MissionCommand::Abandon {
                dispatch_id: dsp.dispatch_id.clone(),
            },
        )
        .unwrap();

        assert_eq!(abandoned.dispatches[0].status, "abandoned");
        assert_eq!(abandoned.tasks[0].status, "failed");

        // Retry command resets task to ready
        let retried = mission_command_inner(
            &p.project(),
            &m.id,
            4,
            "req_retry",
            MissionCommand::Retry {
                dispatch_id: dsp.dispatch_id,
            },
        )
        .unwrap();

        assert_eq!(retried.tasks[0].status, "ready");
    }

    #[test]
    fn recovery_scans_and_updates_orphan_dispatches() {
        let p = TempProject::new();
        let m = create_mission(&p, "RecoveryTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();
        assert_eq!(dsp.state.dispatches[0].status, "starting");

        // Recover without live panes -> starting dispatch becomes starting_unknown
        let live_panes = std::collections::HashSet::new();
        let summaries = mission_recover_inner(&p.project(), &live_panes).unwrap();
        assert_eq!(summaries.len(), 1);

        // Read mission state to verify honest unknown state
        match mission_read_inner(&p.project(), &m.id).unwrap() {
            MissionReadResult::Loaded { state, .. } => {
                assert_eq!(state.dispatches[0].status, "starting_unknown");
                assert_eq!(state.tasks[0].status, "failed");
            }
            other => panic!("expected loaded mission, got {:?}", other),
        }
    }

    #[test]
    fn step_report_settles_and_promotes_dependents_transactionally() {
        let p = TempProject::new();
        let m = create_mission(&p, "SettlementTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![
                TaskSpecInput {
                    key: Some("t1".to_string()),
                    title: "Task 1".to_string(),
                    kind: "implement".to_string(),
                    spec: "Do something".to_string(),
                    deps: Vec::new(),
                    fanout: 1,
                },
                TaskSpecInput {
                    key: Some("t2".to_string()),
                    title: "Task 2".to_string(),
                    kind: "implement".to_string(),
                    spec: "Do second thing".to_string(),
                    deps: vec!["t1".to_string()],
                    fanout: 1,
                },
            ],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

        // 1. Submit step report done with correct token
        let report = settlement::StepReport {
            dispatch_id: dsp.dispatch_id.clone(),
            attempt_id: dsp.attempt_id.clone(),
            token: dsp.capability_token.clone(),
            pane_id: Some(dsp.pane_id.clone()),
            status: "done".to_string(),
            summary: "Task 1 implemented successfully".to_string(),
            changed_files: Some(vec!["src/main.rs".to_string()]),
            tests: Some(vec!["cargo test".to_string()]),
        };

        let outcome = mission_settle_report_inner(&p.project(), &m.id, report, 3).unwrap();
        assert_eq!(
            outcome.result,
            settlement::SettlementResult::Settled {
                task_id: t1_id,
                status: "succeeded".to_string(),
            }
        );
        assert_eq!(outcome.state.tasks[0].status, "completed");
        // Dependent task 2 is promoted!
        assert_eq!(outcome.state.tasks[1].status, "ready");
    }

    #[test]
    fn worker_gate_request_and_resolution_flow() {
        let p = TempProject::new();
        let m = create_mission(&p, "GateTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Database Migration".to_string(),
                kind: "implement".to_string(),
                spec: "Run schema migration".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

        // 1. Worker requests decision gate
        let gated_state = mission_request_gate_inner(
            &p.project(),
            &m.id,
            gates::GateRequestInput {
                dispatch_id: dsp.dispatch_id.clone(),
                question: "Approve dropping legacy column?".to_string(),
                options: vec!["approve".to_string(), "reject".to_string()],
            },
            3,
        )
        .unwrap();

        assert_eq!(gated_state.tasks[0].status, "blocked");
        assert_eq!(gated_state.gates.len(), 1);
        let gate_id = gated_state.gates[0].id.clone();

        // 2. Human resolves gate
        let resolved_state = mission_resolve_gate_inner(
            &p.project(),
            &m.id,
            &gate_id,
            "approve",
            4,
        )
        .unwrap();

        assert_eq!(resolved_state.gates[0].status, "resolved");
        assert_eq!(resolved_state.gates[0].resolution, Some("approve".to_string()));
        assert_eq!(resolved_state.tasks[0].status, "ready");
    }

    #[test]
    fn mailbox_and_ask_reply_end_to_end() {
        let p = TempProject::new();
        let m = create_mission(&p, "MailboxTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

        // 1. Worker asks question
        let ask_res = mission_ask_inner(
            &p.project(),
            &m.id,
            ask_reply::AskInput {
                dispatch_id: dsp.dispatch_id.clone(),
                attempt_id: dsp.attempt_id.clone(),
                token: dsp.capability_token.clone(),
                pane_id: Some(dsp.pane_id.clone()),
                question: "Which database port?".to_string(),
                options: None,
                timeout_ms: None,
            },
            3,
        )
        .unwrap();

        assert_eq!(ask_res.state.messages.len(), 1);
        assert!(ask_res.state.messages[0].expects_reply);

        // 2. Operator replies
        let replied_state = mission_reply_inner(
            &p.project(),
            &m.id,
            &ask_res.output.thread_id,
            "Use port 5432",
            4,
        )
        .unwrap();

        assert_eq!(replied_state.messages.len(), 2);
        assert_eq!(replied_state.messages[0].answered_by, Some(replied_state.messages[1].id.clone()));

        // 3. Worker fetches inbox
        let inbox = mission_inbox_fetch_inner(&p.project(), &m.id, &format!("task_{}", t1_id)).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].body, "Use port 5432");

        // 4. Worker acks inbox
        let acked_state = mission_inbox_ack_inner(&p.project(), &m.id, vec![inbox[0].id.clone()], 5).unwrap();
        assert!(acked_state.messages[1].acked);
    }

    #[test]
    fn artifact_publishing_writes_to_disk_and_logs_event() {
        let p = TempProject::new();
        let m = create_mission(&p, "ArtifactTest");

        let state = mission_set_tasks_inner(
            &p.project(),
            &m.id,
            1,
            vec![TaskSpecInput {
                key: Some("t1".to_string()),
                title: "Task 1".to_string(),
                kind: "implement".to_string(),
                spec: "Do something".to_string(),
                deps: Vec::new(),
                fanout: 1,
            }],
        )
        .unwrap();

        let t1_id = state.tasks[0].id.clone();
        let dsp = mission_dispatch_task_inner(&p.project(), &m.id, &t1_id, "codex", None, 2).unwrap();

        let published = mission_publish_artifact_inner(
            &p.project(),
            &m.id,
            ArtifactPublishInput {
                dispatch_id: dsp.dispatch_id,
                kind: "report".to_string(),
                content: "# Final Architecture\n\nDetailed breakdown of components.".to_string(),
                label: "Architecture Summary".to_string(),
            },
            3,
        )
        .unwrap();

        assert!(published.events.iter().any(|e| e.kind == "artifact_published"));
        let artifact_file = p.path.join(".saple/missions").join(&m.id).join("artifacts/architecture-summary/index.md");
        assert!(artifact_file.exists());
        assert!(fs::read_to_string(&artifact_file).unwrap().contains("Detailed breakdown"));
    }
}
