//! The OS sandbox behind a trait: Seatbelt on macOS, none elsewhere (architecture section
//! 6.10; Windows has no OS sandbox in the first release, requirement D7).

use std::ffi::OsString;
use std::path::PathBuf;

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
}

/// This platform's sandbox, if it has one.
#[must_use]
pub fn platform_sandbox() -> Option<&'static dyn CommandSandbox> {
    #[cfg(target_os = "macos")]
    {
        Some(&Seatbelt)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// `sandbox-exec` with a profile generated per command.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, Default)]
pub struct Seatbelt;

#[cfg(target_os = "macos")]
impl CommandSandbox for Seatbelt {
    fn launch(&self, policy: &ResolvedPolicy, proxy_port: u16) -> Result<SandboxedLaunch> {
        let profile = crate::seatbelt::SeatbeltProfile::build(policy, proxy_port)?;
        Ok(SandboxedLaunch {
            program: PathBuf::from(crate::seatbelt::SANDBOX_EXEC),
            args: profile.args(),
            env: crate::sandbox_env(&policy.session_tmp, proxy_port),
        })
    }
}

/// The wrapper that starts the Agent Host under its permissive Seatbelt profile
/// ([`crate::seatbelt::SeatbeltProfile::agent_host`]): `sandbox-exec -p <profile> -D… --`
/// before the bundled `node`. `writable` are the directories the Agent Host and its children
/// may write (the workspace and PiArc's data directory); they must exist and are resolved to
/// their real paths, which Seatbelt matches. `env` is empty: Core sets the Agent Host's
/// environment itself.
///
/// # Errors
///
/// A directory does not exist, is not absolute or is not UTF-8.
#[cfg(target_os = "macos")]
pub fn agent_host_launch(writable: &[PathBuf]) -> Result<SandboxedLaunch> {
    let resolved: Vec<PathBuf> = writable
        .iter()
        .map(|dir| crate::policy::resolve_existing(dir))
        .collect::<Result<_>>()?;
    let profile = crate::seatbelt::SeatbeltProfile::agent_host(&resolved)?;
    Ok(SandboxedLaunch {
        program: PathBuf::from(crate::seatbelt::SANDBOX_EXEC),
        args: profile.args(),
        env: Vec::new(),
    })
}
