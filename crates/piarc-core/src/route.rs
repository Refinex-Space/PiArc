//! Route keys: the topic a batch of events is delivered under.
//!
//! The Electron main process forwards each batch to the windows subscribed to its route key
//! and never looks inside the payload. Today a route key names a test or demo stream; from
//! T14 on it is a `sessionId`.

use std::fmt;
use std::sync::Arc;

use crate::error::{Error, Result};

/// Longest accepted route key, in bytes.
pub const MAX_ROUTE_KEY_LEN: usize = 128;

/// Prefix of the route keys Core emits on its own (for example [`ERROR_ROUTE`]). Clients
/// cannot produce events under it.
pub const RESERVED_PREFIX: &str = "core/";

/// Route of error events: tokio task panics and other failures that have no caller to
/// return an error to. Each event is a structured error object (`code`, `message`, `data`).
pub const ERROR_ROUTE: &str = "core/errors";

/// A validated route key. Cheap to clone.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RouteKey(Arc<str>);

impl RouteKey {
    /// Validates a route key supplied by a client: 1 to [`MAX_ROUTE_KEY_LEN`] ASCII
    /// letters, digits or `.`, `_`, `:`, `/`, `-`, not starting with [`RESERVED_PREFIX`].
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] naming the `route` field when the key is empty, too
    /// long, contains another character or uses the reserved prefix.
    pub fn parse(key: &str) -> Result<Self> {
        let reason = if key.is_empty() {
            Some("must not be empty".to_owned())
        } else if key.len() > MAX_ROUTE_KEY_LEN {
            Some(format!("must be at most {MAX_ROUTE_KEY_LEN} bytes"))
        } else if !key.bytes().all(is_route_byte) {
            Some("may only contain ASCII letters, digits and . _ : / -".to_owned())
        } else if key.starts_with(RESERVED_PREFIX) {
            Some(format!(
                "must not start with the reserved prefix {RESERVED_PREFIX:?}"
            ))
        } else {
            None
        };
        match reason {
            Some(reason) => Err(Error::InvalidArgument {
                field: "route",
                reason,
            }),
            None => Ok(Self(Arc::from(key))),
        }
    }

    /// The route of Core's settings change events (`core/settings`, T13).
    #[must_use]
    pub fn settings() -> Self {
        Self(Arc::from(crate::workspace_settings::SETTINGS_ROUTE))
    }

    /// The route of Core's own error events.
    #[must_use]
    pub fn errors() -> Self {
        Self(Arc::from(ERROR_ROUTE))
    }

    /// The key as a string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RouteKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn is_route_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_session_ids_and_demo_topics() {
        for key in [
            "demo-1",
            "session:0b7c",
            "a",
            "x/y.z_w",
            &"k".repeat(MAX_ROUTE_KEY_LEN),
        ] {
            assert_eq!(
                RouteKey::parse(key).map(|k| k.as_str().to_owned()),
                Ok(key.to_owned())
            );
        }
    }

    #[test]
    fn rejects_empty_long_non_ascii_and_reserved_keys() {
        for key in [
            "",
            &"k".repeat(MAX_ROUTE_KEY_LEN + 1),
            "with space",
            "中文",
            "core/errors",
            "core/anything",
        ] {
            let error = RouteKey::parse(key).expect_err(key);
            assert!(
                matches!(error, Error::InvalidArgument { field: "route", .. }),
                "{key}: {error}"
            );
        }
    }

    #[test]
    fn the_error_route_uses_the_reserved_prefix() {
        assert!(RouteKey::errors().as_str().starts_with(RESERVED_PREFIX));
    }
}
