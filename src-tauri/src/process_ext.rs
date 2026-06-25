use std::process::Command;

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
