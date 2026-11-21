//! One session's sandbox: its network proxy, and a profile generated for every command from the
//! policy as it stands then (T39: a changed setting applies to the next command).

use std::sync::Arc;

use crate::error::{Error, Result};
use crate::platform::{CommandSandbox, SandboxedLaunch};
use crate::policy::{ResolvedPolicy, SandboxPolicy};
use crate::proxy::{Allowlist, Network, NetworkProxy, ProxyHooks, ProxyLimits};

/// The sandbox of one session. Dropping it stops the session's proxy.
#[derive(Debug)]
pub struct SessionSandbox {
    proxy: NetworkProxy,
    sandbox: Arc<dyn CommandSandbox>,
}

impl SessionSandbox {
    /// Starts the session's proxy with `allowlist`, asking `hooks` about other hosts. Must be
    /// called inside a tokio runtime.
    ///
    /// # Errors
    ///
    /// [`Error::Proxy`] when the proxy cannot listen.
    pub async fn start(
        sandbox: Arc<dyn CommandSandbox>,
        allowlist: Allowlist,
        network: Arc<dyn Network>,
        hooks: Arc<dyn ProxyHooks>,
    ) -> Result<Self> {
        let proxy = NetworkProxy::start_with(allowlist, network, hooks, ProxyLimits::default())
            .await
            .map_err(Error::Proxy)?;
        Ok(Self { proxy, sandbox })
    }

    /// How to start one command under `policy`: the policy is resolved and the profile built
    /// for this command only.
    ///
    /// # Errors
    ///
    /// A path of the policy cannot be resolved, or the policy cannot be expressed for this
    /// platform's sandbox.
    pub fn launch(&self, policy: &SandboxPolicy) -> Result<(SandboxedLaunch, ResolvedPolicy)> {
        let resolved = policy.resolve()?;
        let launch = self.sandbox.launch(&resolved, self.proxy.port())?;
        Ok((launch, resolved))
    }

    /// Replaces the proxy's allowlist: the next connection uses it.
    pub fn set_allowlist(&self, allowlist: Allowlist) {
        self.proxy.set_allowlist(allowlist);
    }

    /// The proxy's port on `127.0.0.1`.
    #[must_use]
    pub fn proxy_port(&self) -> u16 {
        self.proxy.port()
    }
}
