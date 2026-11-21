//! Errors of fetching and calling (coding standards 2.3); messages are written for the model.

use std::net::IpAddr;
use std::time::Duration;

use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;

use crate::ssrf::Blocked;

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
    #[error("{service} answered HTTP {status}: {message}")]
    Service {
        service: String,
        status: u16,
        message: String,
    },
    #[error("{service} sent a response PiArc cannot read: {reason}")]
    UnreadableResponse { service: String, reason: String },
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
            Self::Service { status, .. } if *status == 401 || *status == 403 => {
                ErrorKind::PermissionDenied
            }
            Self::Service { .. } | Self::UnreadableResponse { .. } => ErrorKind::IoError,
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
        ) || matches!(self, Self::Service { status, .. } if *status == 429 || *status >= 500)
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
            Self::Service { .. } => "service",
            Self::UnreadableResponse { .. } => "unreadableResponse",
        }
    }

    /// The AHP error; the message is written for the model.
    pub fn to_error_object(&self) -> ErrorObject {
        let mut error = ErrorObject::new(self.kind(), self.to_string(), self.retryable());
        error.data.details = Some(json!({ "reason": self.reason() }));
        error
    }
}
