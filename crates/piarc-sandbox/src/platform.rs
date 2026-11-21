//! The OS sandbox behind a trait: Seatbelt on macOS, none elsewhere (architecture section
//! 6.10; Windows has no OS sandbox in the first release, requirement D7).

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::Result;
use crate::policy::ResolvedPolicy;

/// How to start a sandboxed command: run `program args… <shell> -c <command>` with `env` on
/// top of the command's environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxedLaunch {
    /// The wrapper's executable.
    pub program: PathBuf,
    /// The wrapper's arguments before the shell.
    pub args: Vec<OsString>,
    /// Variables that replace the command's own of the same name ([`crate::sandbox_env`]).
    pub env: Vec<(OsString, OsString)>,
}

/// Wraps commands in an OS sandbox.
pub trait CommandSandbox: Send + Sync + std::fmt::Debug {
    /// The wrapper for a command under `policy`, whose only network access is the proxy on
    /// `proxy_port`.
    ///
    /// # Errors
    ///
    /// The policy cannot be expressed (for example a path that is not UTF-8).
    fn launch(&self, policy: &ResolvedPolicy, proxy_port: u16) -> Result<SandboxedLaunch>;

    /// Whether the wrapper is there to run (risk R10: `sandbox-exec` may disappear from a
    /// later macOS). A wrapper that is there but fails to start a command is reported by the
    /// command's own failure ([`launch_failed`]).
    fn available(&self) -> bool;
}

/// This platform's sandbox, if it has one.
#[must_use]
pub fn platform_sandbox() -> Option<Arc<dyn CommandSandbox>> {
    #[cfg(target_os = "macos")]
    {
        Some(Arc::new(Seatbelt::default()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Whether a sandboxed command's output says the wrapper itself failed, so the command never
/// ran: `sandbox-exec` prefixes its own errors with its name (an unusable profile, or a
/// kernel that refuses `sandbox_init`).
#[must_use]
pub fn launch_failed(exit_code: Option<i32>, stderr_head: &str) -> bool {
    exit_code.is_some_and(|code| code != 0)
        && stderr_head
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("sandbox-exec:"))
}

/// `sandbox-exec` with a profile generated per command.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
pub struct Seatbelt {
    program: PathBuf,
}

#[cfg(target_os = "macos")]
impl Default for Seatbelt {
    fn default() -> Self {
        Self {
            program: PathBuf::from(crate::seatbelt::SANDBOX_EXEC),
        }
    }
}

#[cfg(target_os = "macos")]
impl Seatbelt {
    /// Seatbelt through another `sandbox-exec` (tests: a missing one stands for risk R10).
    #[must_use]
    pub fn at(program: PathBuf) -> Self {
        Self { program }
    }
}

#[cfg(target_os = "macos")]
impl CommandSandbox for Seatbelt {
    fn launch(&self, policy: &ResolvedPolicy, proxy_port: u16) -> Result<SandboxedLaunch> {
        let profile = crate::seatbelt::SeatbeltProfile::build(policy, proxy_port)?;
        Ok(SandboxedLaunch {
            program: self.program.clone(),
            args: profile.args(),
            env: crate::sandbox_env(&policy.session_tmp, proxy_port),
        })
    }

    fn available(&self) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(&self.program)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
}

/// The wrapper that starts the Agent Host under its Seatbelt profile
/// ([`crate::seatbelt::SeatbeltProfile::agent_host`]): `sandbox-exec -p <profile> -D… --` before
/// the bundled `node`. `workspace` and `data_dir` must exist; they are resolved to their real
/// paths, which Seatbelt matches. `env` is empty: Core sets the Agent Host's environment itself.
///
/// # Errors
///
/// A directory does not exist, is not absolute or is not UTF-8.
#[cfg(target_os = "macos")]
pub fn agent_host_launch(
    workspace: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<SandboxedLaunch> {
    let workspace = crate::policy::resolve_existing(workspace)?;
    let data_dir = crate::policy::resolve_existing(data_dir)?;
    let protected: Vec<String> = crate::PROTECTED_PATHS
        .iter()
        .map(|&p| p.to_owned())
        .collect();
    let profile = crate::seatbelt::SeatbeltProfile::agent_host(&workspace, &data_dir, &protected)?;
    Ok(SandboxedLaunch {
        program: PathBuf::from(crate::seatbelt::SANDBOX_EXEC),
        args: profile.args(),
        env: Vec::new(),
    })
}
