//! Proxies of the browser partitions (ADR-0088 rule 5).
//!
//! The main process asks for a partition's proxy port when it creates the partition and again
//! whenever the user's local development names or PiArc's listening ports change; the same
//! partition keeps its proxy and gets the new policy. Refusals are logged with host, port and
//! reason only (never a path or query).

use std::collections::HashMap;
use std::sync::Arc;

use piarc_ports::BoxFuture;
use piarc_sandbox::proxy::{
    Allowlist, BrowserPolicy, Network, NetworkProxy, ProxyHooks, ProxyLimits, Refused,
};
use serde::Deserialize;

use crate::error::{Error, Result};

/// The most partitions with a running proxy (one per workspace and storage mode).
pub const MAX_PARTITIONS: usize = 64;
/// The most local development names.
pub const MAX_LOCAL_NAMES: usize = 64;
/// The most denied ports.
pub const MAX_DENIED_PORTS: usize = 64;

/// A partition's proxy as the main process asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProxyRequest {
    /// The partition's name without the `persist:` prefix (`piarc-browser-<hash>`).
    pub partition: String,
    /// Names that may resolve to loopback (`*.test`, `*.local`).
    pub local_names: Vec<String>,
    /// PiArc's own listening ports on loopback.
    pub denied_ports: Vec<u16>,
}

/// The running proxies, keyed by partition.
pub struct BrowserProxies {
    network: Arc<dyn Network>,
    proxies: tokio::sync::Mutex<HashMap<String, NetworkProxy>>,
}

impl std::fmt::Debug for BrowserProxies {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserProxies").finish_non_exhaustive()
    }
}

impl BrowserProxies {
    /// Proxies that resolve and connect through `network`.
    #[must_use]
    pub fn new(network: Arc<dyn Network>) -> Self {
        Self {
            network,
            proxies: tokio::sync::Mutex::default(),
        }
    }

    /// The port of the partition's proxy on `127.0.0.1`, starting it on first use; an
    /// existing proxy takes the request's policy for its next connections.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a malformed request or too many partitions; the
    /// listening socket cannot be opened.
    pub async fn port(&self, request: BrowserProxyRequest) -> Result<u16> {
        let policy = policy(&request)?;
        let mut proxies = self.proxies.lock().await;
        if let Some(proxy) = proxies.get(&request.partition) {
            proxy.set_browser_policy(policy);
            return Ok(proxy.port());
        }
        if proxies.len() >= MAX_PARTITIONS {
            return Err(Error::InvalidArgument {
                field: "partition",
                reason: format!("at most {MAX_PARTITIONS} browser partitions have a proxy"),
            });
        }
        let proxy = NetworkProxy::start_browser(
            policy,
            Arc::clone(&self.network),
            Arc::new(LogRefusals),
            ProxyLimits::default(),
        )
        .await
        .map_err(|error| Error::Internal {
            reason: format!("cannot start the browser proxy: {error}"),
        })?;
        let port = proxy.port();
        proxies.insert(request.partition, proxy);
        Ok(port)
    }

    /// Stops the partition's proxy, if it has one (its data was cleared or it is no longer
    /// used); open connections through it end.
    pub async fn stop(&self, partition: &str) -> bool {
        self.proxies.lock().await.remove(partition).is_some()
    }
}

fn policy(request: &BrowserProxyRequest) -> Result<BrowserPolicy> {
    let partition = &request.partition;
    let valid = (1..=128).contains(&partition.len())
        && partition
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err(Error::InvalidArgument {
            field: "partition",
            reason: "1 to 128 letters, digits, '-' or '_'".into(),
        });
    }
    if request.local_names.len() > MAX_LOCAL_NAMES {
        return Err(Error::InvalidArgument {
            field: "localNames",
            reason: format!("at most {MAX_LOCAL_NAMES} names"),
        });
    }
    if request.denied_ports.len() > MAX_DENIED_PORTS || request.denied_ports.contains(&0) {
        return Err(Error::InvalidArgument {
            field: "deniedPorts",
            reason: format!("at most {MAX_DENIED_PORTS} ports from 1 to 65535"),
        });
    }
    let local_names =
        Allowlist::new(&request.local_names).map_err(|invalid| Error::InvalidArgument {
            field: "localNames",
            reason: invalid.to_string(),
        })?;
    Ok(BrowserPolicy {
        local_names,
        denied_ports: request.denied_ports.clone(),
    })
}

/// Hooks of a browser proxy: it never asks (every host is listed), refusals go to the log.
struct LogRefusals;

impl ProxyHooks for LogRefusals {
    fn unlisted<'a>(&'a self, _host: &'a str, _port: u16) -> BoxFuture<'a, bool> {
        Box::pin(async { true })
    }

    fn refused(&self, refused: &Refused) {
        tracing::info!(
            target: "piarc_core::browser",
            host = %refused.host,
            port = refused.port,
            reason = refused.reason.as_str(),
            "browser proxy refused a connection"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use piarc_sandbox::proxy::SystemNetwork;

    fn request(partition: &str) -> BrowserProxyRequest {
        BrowserProxyRequest {
            partition: partition.into(),
            local_names: vec!["*.test".into()],
            denied_ports: vec![4100],
        }
    }

    #[tokio::test]
    async fn a_partition_keeps_its_proxy_and_takes_the_new_policy() {
        let proxies = BrowserProxies::new(Arc::new(SystemNetwork));
        let first = proxies
            .port(request("piarc-browser-a"))
            .await
            .expect("starts");
        let again = proxies
            .port(request("piarc-browser-a"))
            .await
            .expect("reuses");
        let other = proxies
            .port(request("piarc-browser-b"))
            .await
            .expect("starts");
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert!(proxies.stop("piarc-browser-a").await);
        assert!(!proxies.stop("piarc-browser-a").await);
    }

    #[tokio::test]
    async fn malformed_requests_are_refused() {
        let proxies = BrowserProxies::new(Arc::new(SystemNetwork));
        let mut bad = request("persist:piarc");
        assert!(proxies.port(bad.clone()).await.is_err());
        bad.partition = "piarc-browser-a".into();
        bad.local_names = vec!["a/b".into()];
        assert!(proxies.port(bad.clone()).await.is_err());
        bad.local_names = Vec::new();
        bad.denied_ports = vec![0];
        assert!(proxies.port(bad).await.is_err());
    }
}
