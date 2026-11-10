//! Process-tree termination helpers shared by PTY sessions (`pty.rs`) and shell runners
//! (`review.rs`).
//!
//! Windows: killing a shell with TerminateProcess does NOT terminate the processes it spawned -
//! the AI CLI (node/claude/...) and its own children are orphaned. Each tree therefore lives in
//! a Job Object configured with KILL_ON_JOB_CLOSE: terminating the job (or dropping its last
//! handle) kills the entire subtree. Descendants spawned *after* assignment inherit membership
//! automatically (Win8+).
//!
//! Unix: children are spawned in their own process group (see the spawn sites); killing that
//! group takes down descendants as well.

#[cfg(windows)]
mod imp {
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
        /// Returns `None` if any step fails - callers then fall back to killing the child directly.
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

/// Inert placeholder on non-Windows: Unix cleanup goes through process groups plus
/// `child.kill()`. `attach` never produces a job.
#[cfg(not(windows))]
mod imp {
    pub struct JobObject;

    impl JobObject {
        pub fn attach(_pid: u32) -> Option<JobObject> {
            None
        }

        pub fn terminate(&self) {}
    }
}

pub use imp::JobObject;

/// Kill a whole Unix process group. No-op on Windows (jobs handle trees there) and when no pid
/// is known.
#[cfg(unix)]
pub fn kill_process_group(pid: u32) {
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
pub fn kill_process_group(_pid: u32) {}
