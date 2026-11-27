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

/// Route of notices for the user (T17): `{ "type": "gitBashMissing", "message", "searched",
/// "downloadUrl" }` when Windows sessions run without the `Bash` tool.
pub const NOTICES_ROUTE: &str = "core/notices";

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

    /// The route of notices for the user that no request answers, such as a missing Git
    /// Bash on Windows (`core/notices`, T17).
    #[must_use]
    pub fn notices() -> Self {
        Self(Arc::from(NOTICES_ROUTE))
    }

    /// The route of MCP server states (`core/mcp`, T36): `{ workspace, servers, overridden,
    /// issues }` whenever a workspace's pool reports a change.
    #[must_use]
    pub fn mcp() -> Self {
        Self(Arc::from(crate::mcp::MCP_ROUTE))
    }

    /// The route of the Git panel's progress and repository changes (`core/git`, ADR-0085).
    #[must_use]
    pub fn git() -> Self {
        Self(Arc::from(crate::git::GIT_ROUTE))
    }

    /// The route of the built-in browser's runs for the desktop client (`core/browser`,
    /// ADR-0089).
    #[must_use]
    pub fn browser() -> Self {
        Self(Arc::from("core/browser"))
    }

    /// The route of the speech models' state (`core/speech`, ADR-0094): every window sees it;
    /// it carries no recognized text.
    #[must_use]
    pub fn speech() -> Self {
        Self(Arc::from(crate::dictation::SPEECH_ROUTE))
    }

    /// The route of provider sign-in progress and questions (`core/login`, T29).
    #[must_use]
    pub fn login() -> Self {
        Self(Arc::from("core/login"))
    }

    /// The route of the workspace list snapshots (`core/workspaces`, T14).
    #[must_use]
    pub fn workspaces() -> Self {
        Self(Arc::from("core/workspaces"))
    }

    /// The route of the session list snapshots (`core/sessions`, T14).
    #[must_use]
    pub fn sessions() -> Self {
        Self(Arc::from("core/sessions"))
    }

    /// The route of the activity counts (`core/activity`, T35): running sessions and the
    /// ones waiting for approval, for the menu-bar or tray icon.
    #[must_use]
    pub fn activity() -> Self {
        Self(Arc::from("core/activity"))
    }

    /// The route of the background task snapshots (`core/tasks`, T32).
    #[must_use]
    pub fn tasks() -> Self {
        Self(Arc::from("core/tasks"))
    }

    /// The route of one session's events: `session/<id>` (T14).
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] when the id makes an invalid route.
    pub fn session(id: &str) -> Result<Self> {
        Self::parse(&format!("session/{id}"))
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
