//! One session's sandbox: its resolved policy and its network proxy.

use std::sync::Arc;

use crate::error::{Error, Result};
use crate::platform::{CommandSandbox, SandboxedLaunch, platform_sandbox};
use crate::policy::{ResolvedPolicy, SandboxPolicy};
use crate::proxy::{Allowlist, Network, NetworkProxy};

/// The sandbox of one session. Dropping it stops the session's proxy.
#[derive(Debug)]
pub struct SessionSandbox {
    policy: ResolvedPolicy,
    proxy: NetworkProxy,
    sandbox: &'static dyn CommandSandbox,
}

impl SessionSandbox {
    /// Resolves `policy` and starts the session's proxy with `allowlist`. Must be called inside
    /// a tokio runtime.
    ///
    /// # Errors
    ///
    /// [`Error::Unsupported`] on a platform without a sandbox, a policy path that cannot be
    /// resolved, or a proxy that cannot listen.
    pub async fn start(
        policy: &SandboxPolicy,
        allowlist: Allowlist,
        network: Arc<dyn Network>,
    ) -> Result<Self> {
        let sandbox = platform_sandbox().ok_or(Error::Unsupported)?;
        let policy = policy.resolve()?;
        let proxy = NetworkProxy::start(allowlist, network)
            .await
            .map_err(Error::Proxy)?;
        Ok(Self {
            policy,
            proxy,
            sandbox,
        })
    }

    /// How to start one command: a profile is generated per command.
    ///
    /// # Errors
    ///
    /// The policy cannot be expressed for this platform's sandbox.
    pub fn launch(&self) -> Result<SandboxedLaunch> {
        self.sandbox.launch(&self.policy, self.proxy.port())
    }

    /// The resolved policy.
    #[must_use]
    pub fn policy(&self) -> &ResolvedPolicy {
        &self.policy
    }

    /// The proxy's port on `127.0.0.1`.
    #[must_use]
    pub fn proxy_port(&self) -> u16 {
        self.proxy.port()
    }
}
