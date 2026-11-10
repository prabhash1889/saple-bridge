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
//! [`crate::workspace::fs_lock::with_path_lock`] on the state file, so Bridge and the saple-mcp
//! sidecar can never interleave a read-modify-write cycle.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::workspace::project_roots::{get_project_file_path, ProjectRootRegistry};

pub mod ask_reply;
pub mod gates;
pub mod liveness;
pub mod mailbox;
pub mod preamble;
pub mod scheduler;
pub mod settlement;
pub mod supervisor;
pub mod worktrees;

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
    #[serde(default)]
    pub allow_stale_base: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
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
    #[serde(default)]
    pub allow_stale_base: bool,
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
    let base = crate::workspace::project_roots::canonical_base(project_path).map_err(|e| e.to_string())?;
    crate::workspace::project_roots::contained_target(&base, MISSIONS_DIR).map_err(|e| e.to_string())
}

fn ensure_missions_enabled(project_path: &str) -> Result<(), String> {
    let config_path =
        get_project_file_path(project_path, ".saple/config.json").map_err(|e| e.to_string())?;
    let content = match crate::workspace::state_load::read_json_text(&config_path) {
        crate::workspace::state_load::JsonText::Ok(content) => content,
        crate::workspace::state_load::JsonText::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("Missions are disabled for this workspace".to_string())
        }
        crate::workspace::state_load::JsonText::Io(e) => return Err(e.to_string()),
        crate::workspace::state_load::JsonText::Encoding(message) => return Err(message),
    };
    let config: crate::workspace::project::WorkspaceConfig = serde_json::from_str(&content)
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
    let text = match crate::workspace::state_load::read_json_text(&path) {
        crate::workspace::state_load::JsonText::Ok(t) => t,
        crate::workspace::state_load::JsonText::Io(e) => return Err(e.to_string()),
        crate::workspace::state_load::JsonText::Encoding(m) => return Err(m),
    };
    match serde_json::from_str::<MissionState>(&text) {
        Ok(state) if state.id == id => {
            // The user may have repaired the file externally while it was flagged; a clean
            // parse lifts the write block automatically (mirrors load_state_inner).
            crate::workspace::fs_lock::clear_corrupt_flag(&path);
            Ok(LoadedState::Ok(Box::new(state)))
        }
        Ok(state) => {
            let err = format!(
                "Mission state id '{}' does not match its directory '{}'",
                state.id, id
            );
            let backup = crate::workspace::state_load::preserve_and_flag_corrupt(&path, &err)?;
            Ok(LoadedState::Corrupt {
                error: err,
                backup_path: backup.to_string_lossy().to_string(),
            })
        }
        Err(e) => {
            let err = format!("Failed to parse mission state.json: {}", e);
            let backup = crate::workspace::state_load::preserve_and_flag_corrupt(&path, &err)?;
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
        at: crate::workspace::project::now_iso(),
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
/// ([`crate::workspace::fs_lock::write_unlocked`] would deadlock through `atomic_write`).
fn persist_state(project_path: &str, id: &str, state: &MissionState) -> Result<(), String> {
    let path = state_file_path(project_path, id)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    crate::workspace::fs_lock::write_unlocked(&path, &bytes)
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

    let now = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || -> Result<(), String> {
        crate::workspace::fs_lock::write_unlocked(&doc_path, doc.as_bytes())?;
        crate::workspace::fs_lock::write_unlocked(&state_path, &state_bytes)?;
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        // Read the doc under the lock so reconcile-on-read never adopts a snapshot older
        // than what an external editor just wrote.
        let doc = match fs::read_to_string(&doc_path) {
            Ok(doc) => doc,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(MissionReadResult::Missing)
            }
            Err(e) => return Err(format!("Failed to read mission.md: {}", e)),
        };

        if crate::workspace::fs_lock::sentinel_held_by_live_process(&state_path) {
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
        state.updated_at = crate::workspace::project::now_iso();
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
    let now = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(id, state.revision, expected_revision));
        }
        // Markdown first, then engine truth - same crash ordering as create; the next read
        // reconciles either survivor back into a consistent pair.
        crate::workspace::fs_lock::write_unlocked(&doc_path, body.as_bytes())?;
        state.spec = parsed.spec;
        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
                allow_stale_base: input.allow_stale_base,
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
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
                state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
        state.updated_at = crate::workspace::project::now_iso();
        persist_state(project_path, mission_id, &state)?;

        Ok(TaskDispatchOutput {
            state: Box::new(state),
            dispatch_id: prepared.dispatch_id,
            attempt_id: prepared.attempt_id,
            pane_id: prepared.pane_id,
            prompt_file: prepared.prompt_file,
            capability_token: prepared.capability_token,
            worktree_path: prepared.worktree_path,
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
        let now = crate::workspace::project::now_iso();

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
        state.updated_at = crate::workspace::project::now_iso();
        persist_state(project_path, mission_id, &state)?;
        Ok(state)
    })?
}

pub(crate) fn mission_tick_inner(
    project_path: &str,
    mission_id: &str,
) -> Result<MissionState, String> {
    let state_path = state_file_path(project_path, mission_id)?;
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        let caps = std::collections::HashMap::new();
        let outcome = scheduler::scheduler_tick(&mut state, project_path, mission_id, &caps)?;

        if outcome.terminal_status.is_some()
            || !outcome.promoted_task_ids.is_empty()
            || !outcome.blocked_task_ids.is_empty()
        {
            state.revision += 1;
            state.updated_at = crate::workspace::project::now_iso();
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
        let res: Result<(), String> = crate::workspace::fs_lock::with_path_lock(&state_path, || {
            let mut state = match load_state(project_path, &id)? {
                LoadedState::Ok(s) => *s,
                _ => return Ok(()),
            };
            let changed = supervisor::reconcile_orphan_dispatches(&mut state, project_path, &id, live_pane_ids)?;
            if changed {
                state.revision += 1;
                state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let result = settlement::settle_step_report(&mut state, project_path, mission_id, &report)?;

        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
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
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        let output = ask_reply::ask_question(&mut state, project_path, mission_id, input)?;

        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        ask_reply::reply_question(&mut state, project_path, mission_id, thread_id, body, "operator")?;

        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        mailbox::send_message(&mut state, project_path, mission_id, input)?;

        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    crate::workspace::fs_lock::with_path_lock(&state_path, || {
        let mut state = require_state(project_path, mission_id)?;
        if state.revision != expected_revision {
            return Err(revision_conflict(mission_id, state.revision, expected_revision));
        }

        mailbox::inbox_ack(&mut state, project_path, mission_id, &message_ids)?;

        state.revision += 1;
        state.updated_at = crate::workspace::project::now_iso();
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
    pty_registry: tauri::State<'_, crate::terminal::pty::PtyRegistry>,
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

#[tauri::command]
pub async fn mission_worktree_create(
    project_path: String,
    mission_id: String,
    task_id: Option<String>,
    base_ref: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<worktrees::WorktreeInfo, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    let reg = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        worktrees::mission_worktree_create_inner(
            &reg,
            &project_path,
            &mission_id,
            task_id.as_deref(),
            base_ref.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_worktree_diff(
    project_path: String,
    worktree_path: String,
    base_ref: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<worktrees::GitDiffSummary, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktrees::mission_worktree_diff_inner(&project_path, &worktree_path, base_ref.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_worktree_merge(
    project_path: String,
    worktree_path: String,
    strategy: String,
    target_branch: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<worktrees::WorktreeMergeResult, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktrees::mission_worktree_merge_inner(
            &project_path,
            &worktree_path,
            &strategy,
            target_branch.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_worktree_remove(
    project_path: String,
    worktree_path: String,
    force: bool,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<(), String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    let reg = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        worktrees::mission_worktree_remove_inner(&reg, &project_path, &worktree_path, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mission_worktree_list(
    project_path: String,
    mission_id: Option<String>,
    registry: tauri::State<'_, Arc<ProjectRootRegistry>>,
) -> Result<Vec<worktrees::WorktreeInfo>, String> {
    registry
        .ensure_inside_approved_root(&project_path)
        .map_err(|e| e.to_string())?;
    ensure_missions_enabled(&project_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktrees::mission_worktree_list_inner(&project_path, mission_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
