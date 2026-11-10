use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window Windows would otherwise pop for a child process
/// spawned from a GUI app. No-op on non-Windows.
pub trait CommandNoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl CommandNoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

/// Why [`run_with_deadline`] produced no output.
#[derive(Debug)]
pub enum RunFailure {
    /// The program could not be started (not installed, bad cwd, ...).
    Spawn(std::io::Error),
    /// It was still running at the deadline and has been killed.
    TimedOut,
    /// Waiting on the child failed.
    Wait(std::io::Error),
}

/// Run a command to completion with stdout/stderr piped, killing it when it exceeds
/// `timeout`. Polls with adaptive backoff so fast commands return immediately.
///
/// Both pipes are drained on their own threads from spawn to exit. Reading them only after
/// exit deadlocks any child that writes more than the OS pipe buffer (~64 KB): it blocks on
/// the write, never exits, and the deadline kills a healthy command (a large `git diff`).
pub fn run_with_deadline(mut command: Command, timeout: Duration) -> Result<Output, RunFailure> {
    use std::io::Read;

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunFailure::Spawn)?;

    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let started = Instant::now();
    let mut backoff = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunFailure::Wait(e));
            }
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunFailure::TimedOut);
        }

        std::thread::sleep(backoff);
        if backoff < Duration::from_millis(25) {
            backoff *= 2;
        }
    };

    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// [`run_with_deadline`] for callers that only care whether output was produced.
pub fn run_with_timeout(command: Command, timeout: Duration) -> Option<Output> {
    run_with_deadline(command, timeout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::process_ext::CommandNoWindow;

    #[test]
    fn fast_command_completes_within_deadline() {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo ok"]);
            c
        } else {
            let mut c = Command::new("echo");
            c.arg("ok");
            c
        };
        cmd.no_window();
        let out = run_with_timeout(cmd, Duration::from_secs(10));
        assert!(out.is_some());
        assert!(out.unwrap().status.success());
    }

    #[test]
    fn output_larger_than_the_pipe_buffer_does_not_look_like_a_hang() {
        // 2 MB on stdout, far past the ~64 KB pipe buffer. Undrained pipes block the child on
        // write, so it never exits and the deadline kills a perfectly healthy command.
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('x' * 2000000)"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "head -c 2000000 /dev/zero"]);
            c
        };
        cmd.no_window();
        let out = run_with_timeout(cmd, Duration::from_secs(20)).expect("must complete, not time out");
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), 2_000_000);
    }

    #[test]
    fn hung_command_is_killed_at_the_deadline() {
        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.no_window();
        let started = Instant::now();
        let out = run_with_timeout(cmd, Duration::from_millis(500));
        assert!(out.is_none(), "command past its deadline must be killed");
        assert!(started.elapsed() < Duration::from_secs(5), "kill must not wait out the full runtime");
    }
}
