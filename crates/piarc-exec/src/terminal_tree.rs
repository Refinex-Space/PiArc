//! [`TerminalTree`]: ending everything a terminal's shell started, when the terminal closes or
//! PiArc quits (T33). The shell is started by the PTY library (`piarc-term`), not by
//! [`crate::ProcessTreeSpawner`], so the tree is collected after the fact:
//!
//! - **macOS**: the shell leads a new session whose controlling terminal is the PTY. An
//!   interactive shell puts each job in a process group of its own, so the process group of
//!   the shell is not enough: [`TerminalTree::end`] lists every process whose controlling
//!   terminal is the PTY (before hanging up, which detaches them), hangs up, sends `SIGHUP`
//!   (and `SIGCONT`, for stopped jobs) to all their process groups, waits up to the grace
//!   period, then sends `SIGKILL` to whatever is left. A process that started its own session
//!   (`setsid`, a daemon) has left the terminal on purpose and is not reached.
//! - **other Unix**: the shell's process group only (PiArc ships for macOS and Windows).
//! - **Windows**: the shell joins a Job Object with `KILL_ON_JOB_CLOSE` right after it starts;
//!   everything it starts afterwards is in the job too. Ending terminates the job. A process
//!   the shell started before it joined (in the first instant, before reading any input) is
//!   not in the job.

use std::io;
use std::path::Path;
use std::time::Duration;

/// How long [`TerminalTree::end`] waits after the hangup before killing (Unix).
pub const HANGUP_GRACE: Duration = Duration::from_secs(2);

/// The processes of one terminal.
#[derive(Debug)]
pub struct TerminalTree {
    #[cfg(unix)]
    leader: nix::unistd::Pid,
    #[cfg(target_os = "macos")]
    device: Option<u64>,
    #[cfg(windows)]
    job: crate::job::Job,
}

impl TerminalTree {
    /// Collects the tree of the terminal whose shell is `pid` and whose terminal device is
    /// `tty` (Unix; ignored on Windows).
    ///
    /// # Errors
    ///
    /// Windows: the Job Object cannot be created or the shell cannot join it.
    pub fn attach(pid: u32, tty: Option<&Path>) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let leader = i32::try_from(pid).map_err(io::Error::other)?;
            #[cfg(target_os = "macos")]
            let device = tty.and_then(|tty| {
                use std::os::unix::fs::MetadataExt;
                std::fs::metadata(tty).ok().map(|meta| meta.rdev())
            });
            #[cfg(not(target_os = "macos"))]
            let _ = tty;
            Ok(Self {
                leader: nix::unistd::Pid::from_raw(leader),
                #[cfg(target_os = "macos")]
                device,
            })
        }
        #[cfg(windows)]
        {
            let _ = tty;
            let job = crate::job::Job::new()?;
            job.assign_pid(pid)?;
            Ok(Self { job })
        }
    }

    /// The processes in the terminal now: the shell and everything attached to its terminal.
    #[cfg(unix)]
    #[must_use]
    pub fn members(&self) -> Vec<u32> {
        let mut pids = vec![self.leader.as_raw()];
        #[cfg(target_os = "macos")]
        if let Some(device) = self.device
            && let Ok(listed) = crate::tty_processes::processes_of_tty(device)
        {
            pids.extend(listed);
        }
        pids.sort_unstable();
        pids.dedup();
        pids.into_iter()
            .filter_map(|pid| u32::try_from(pid).ok())
            .collect()
    }

    /// Ends the tree: `hangup` closes the terminal (its PTY master), then every process of the
    /// terminal gets `SIGHUP`, and after `grace` whatever is left `SIGKILL` (Unix); the Job
    /// Object is terminated (Windows).
    pub async fn end(&self, hangup: impl FnOnce(), grace: Duration) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{Signal, kill, killpg};
            use nix::unistd::{Pid, getpgid};

            let pids: Vec<Pid> = self
                .members()
                .into_iter()
                .filter_map(|pid| i32::try_from(pid).ok())
                .map(Pid::from_raw)
                .collect();
            let mut groups: Vec<Pid> = pids
                .iter()
                .filter_map(|pid| getpgid(Some(*pid)).ok())
                .collect();
            groups.push(self.leader);
            groups.sort_unstable_by_key(|g| g.as_raw());
            groups.dedup();
            hangup();
            for group in &groups {
                // ESRCH: the group is gone already.
                let _ = killpg(*group, Signal::SIGHUP);
                let _ = killpg(*group, Signal::SIGCONT);
            }
            let alive = |pid: &Pid| kill(*pid, None).is_ok();
            let deadline = tokio::time::Instant::now() + grace;
            while pids.iter().any(alive) && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            for group in &groups {
                let _ = killpg(*group, Signal::SIGKILL);
            }
            for pid in pids.iter().filter(|pid| alive(pid)) {
                let _ = kill(*pid, Signal::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = grace;
            hangup();
            // Fails only for a job that is already gone; dropping it ends the rest anyway.
            let _ = self.job.terminate();
        }
    }
}

#[cfg(test)]
mod tests;
