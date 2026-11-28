//! The registry client (ADR-0102): HTTPS GETs to the configured registry only, through the
//! user's proxy when there is one (never falling back to a direct connection), bounded in size
//! and time, retried on network failures, timeouts, `429` and `5xx` with the server's
//! `Retry-After` honoured up to a bound.

use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use piarc_protocol::market::MarketProblem;
use piarc_web::get::{GetError, GetJob, Getter};
use piarc_web::{Allowlist, Resolve, SystemResolver};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{MarketConfig, MarketLimits};

/// Names that resolve to loopback (tests only: the mock registry behind a `.test` name).
struct Loopback(Vec<String>);

impl Resolve for Loopback {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>> {
        let local = self.0.iter().any(|n| n.eq_ignore_ascii_case(host));
        Box::pin(async move {
            if local {
                Ok(vec![IpAddr::from([127, 0, 0, 1])])
            } else {
                SystemResolver.resolve(host, port).await
            }
        })
    }
}

/// A failure as the market shows it.
pub(crate) fn problem(error: &GetError) -> MarketProblem {
    MarketProblem {
        code: error.code().to_owned(),
        message: error.to_string(),
    }
}

pub(crate) struct Registry {
    getter: Result<Getter, String>,
    base: String,
    host: String,
    limits: MarketLimits,
}

impl Registry {
    pub(crate) fn new(config: &MarketConfig) -> Self {
        let base = config.registry.trim_end_matches('/').to_owned();
        let host = host_of(&base);
        let getter = match &config.test_net {
            None => Getter::new().map_err(|e| e.to_string()),
            Some(test) => test_getter(&test.ca_pem, test.loopback.clone()),
        };
        Self {
            getter,
            base,
            host,
            limits: config.limits.clone(),
        }
    }

    /// The registry's base URL, without a trailing slash.
    pub(crate) fn base(&self) -> &str {
        &self.base
    }

    /// `GET <base>/<path>` as JSON, retried within the limits.
    pub(crate) async fn json(
        &self,
        path: &str,
        max_bytes: usize,
        proxy: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Value, GetError> {
        let getter = self.getter.as_ref().map_err(|e| GetError::Tls(e.clone()))?;
        let url = format!("{}/{}", self.base, path.trim_start_matches('/'));
        let host = self.host.clone();
        let allows = move |h: &str| h.eq_ignore_ascii_case(&host);
        let mut attempt = 0;
        loop {
            let job = GetJob {
                url: &url,
                allows_host: &allows,
                proxy,
                max_bytes,
                accept: "application/json",
                timeout: self.limits.request_timeout,
            };
            match getter.get(&job, cancel).await {
                Ok(body) => {
                    return serde_json::from_slice(&body)
                        .map_err(|e| GetError::Network(format!("not JSON: {e}")));
                }
                Err(error) if error.retryable() && attempt < self.limits.retries => {
                    let wait = error
                        .retry_after()
                        .map_or(self.limits.retry_wait[attempt.min(1)], |w| {
                            w.min(self.limits.retry_after_max)
                        });
                    attempt += 1;
                    tokio::select! {
                        () = cancel.cancelled() => return Err(GetError::Cancelled),
                        () = tokio::time::sleep(wait) => {}
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn test_getter(ca_pem: &[u8], loopback: Vec<String>) -> Result<Getter, String> {
    let allow = Allowlist::new(&["127.0.0.1".to_owned()])?;
    Getter::trusting(ca_pem, Arc::new(Loopback(loopback)), allow).map_err(|e| e.to_string())
}

/// The host of an `https://host[:port][/path]` base URL, lowercase.
pub(crate) fn host_of(base: &str) -> String {
    let rest = base.strip_prefix("https://").unwrap_or_default();
    let authority = rest.split('/').next().unwrap_or_default();
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .map(|h| format!("{h}]"))
            .unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default().to_owned()
    };
    host.trim_matches(['[', ']']).to_ascii_lowercase()
}

/// The pauses between retries.
pub(crate) const RETRY_WAIT: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];
