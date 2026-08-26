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

/// Run a command to completion with stdout/stderr piped, killing it when it exceeds
/// `timeout`. Returns None when the command cannot be spawned or hits the deadline.
/// Polls with adaptive backoff so fast commands return immediately.
pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let started = Instant::now();
    let mut backoff = Duration::from_millis(1);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {}
            Err(_) => return None,
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }

        std::thread::sleep(backoff);
        if backoff < Duration::from_millis(25) {
            backoff *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_ext::CommandNoWindow;

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
