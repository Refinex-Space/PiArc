//! piarc-web: WebFetch's network side (T29, ADR-0045).
//!
//! # Responsibilities
//!
//! - Which addresses a fetch may reach ([`ssrf`]): loopback, private, link-local, multicast,
//!   unspecified, broadcast and reserved ranges are refused, IPv6 equivalents and IPv4-mapped,
//!   NAT64 and 6to4 forms included, unless an [`Allowlist`] entry admits the host or address.
//! - Fetching ([`Fetcher`]): every hop resolves the host, checks every address and connects to a
//!   checked address (no second lookup, so DNS rebinding cannot swap it); HTTP/1.1, TLS with the
//!   platform trust store (rustls, ring); same-site redirects are followed with the same checks,
//!   a redirect to another site is returned ([`Outcome::Redirect`]); body size, text length,
//!   redirects and the total time are bounded by [`FetchLimits`].
//! - Conversion ([`convert`]): HTML to Markdown (htmd), other text types decoded by their
//!   charset, binary types refused.
//! - The host a `WebFetch(domain:…)` rule is matched against ([`rule_host`]), from the same URL
//!   parser the fetcher uses.
//!
//! # Not responsible for
//!
//! - Permission decisions, grants and audit (`piarc-core`'s `tool_io`), the extraction model call
//!   (the Agent Host's WebFetch tool).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

use std::net::IpAddr;
use std::time::Duration;

use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;

pub mod convert;
mod fetch;
pub mod ssrf;

pub use convert::{Content, Format};
pub use fetch::{Fetched, Fetcher, Outcome, Resolve, SystemResolver, parse_target, rule_host};
pub use ssrf::{Allowlist, Blocked};

/// The bounds of one fetch. The only place these values are defined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchLimits {
    /// Body bytes read; the rest is dropped and the result says it was cut.
    pub max_body_bytes: usize,
    /// Characters of converted text handed on (the official reference value is 100K).
    pub max_content_chars: usize,
    /// Everything, redirects included.
    pub timeout: Duration,
    pub max_redirects: u8,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("Invalid URL {0}")]
    InvalidUrl(String),
    #[error(
        "Refused to fetch {host}: it resolves to {ip}, {}. Only public addresses can be fetched.",
        why.describe()
    )]
    Blocked {
        host: String,
        ip: IpAddr,
        why: Blocked,
    },
    #[error("Could not resolve {host}: {reason}")]
    Resolve { host: String, reason: String },
    #[error("Could not connect to {host}: {reason}")]
    Connect { host: String, reason: String },
    #[error("TLS failed for {0}")]
    Tls(String),
    #[error("HTTP error from {0}")]
    Http(String),
    #[error("The fetch did not finish within {} seconds and was stopped.", .0.as_secs())]
    Timeout(Duration),
    #[error("More than {0} redirects; the fetch was stopped.")]
    TooManyRedirects(u8),
    #[error("Cannot convert {0} to text; only HTML and text responses can be fetched.")]
    UnsupportedContent(String),
    #[error("The server sent the body with the {0} content encoding, which is not supported.")]
    UnsupportedEncoding(String),
    #[error("Could not convert the page to Markdown: {0}")]
    Conversion(String),
    #[error("The fetch was cancelled.")]
    Cancelled,
}

impl FetchError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::InvalidUrl(_) | Self::UnsupportedContent(_) | Self::UnsupportedEncoding(_) => {
                ErrorKind::InvalidParams
            }
            Self::Blocked { .. } => ErrorKind::PermissionDenied,
            Self::Timeout(_) => ErrorKind::Timeout,
            Self::Cancelled => ErrorKind::Cancelled,
            Self::Resolve { .. }
            | Self::Connect { .. }
            | Self::Tls(_)
            | Self::Http(_)
            | Self::TooManyRedirects(_)
            | Self::Conversion(_) => ErrorKind::IoError,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Resolve { .. } | Self::Connect { .. } | Self::Timeout(_) | Self::Http(_)
        )
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::InvalidUrl(_) => "invalidUrl",
            Self::Blocked { .. } => "blockedAddress",
            Self::Resolve { .. } => "resolve",
            Self::Connect { .. } => "connect",
            Self::Tls(_) => "tls",
            Self::Http(_) => "http",
            Self::Timeout(_) => "timeout",
            Self::TooManyRedirects(_) => "tooManyRedirects",
            Self::UnsupportedContent(_) => "unsupportedContent",
            Self::UnsupportedEncoding(_) => "unsupportedEncoding",
            Self::Conversion(_) => "conversion",
            Self::Cancelled => "cancelled",
        }
    }

    /// The AHP error; the message is written for the model.
    pub fn to_error_object(&self) -> ErrorObject {
        let mut error = ErrorObject::new(self.kind(), self.to_string(), self.retryable());
        error.data.details = Some(json!({ "reason": self.reason() }));
        error
    }
}
