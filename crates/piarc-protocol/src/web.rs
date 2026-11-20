//! WebFetch's network request (architecture section 6.1.4, T29, ADR-0045). Needs the handshake
//! capability `webFetch`.
//!
//! - `web/fetch` (Agent Host → Core): fetch a URL for an allowed `WebFetch` call. Core checks
//!   that the call was approved for this URL (`origin`), resolves the host, refuses internal
//!   addresses, connects to the checked address, follows redirects within the same site and
//!   converts HTML to Markdown; a redirect to another site is returned unfollowed. The
//!   extraction by the auxiliary model happens in the Agent Host.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::request;
use crate::session::SessionId;
use crate::tool_call::ToolOrigin;

/// Parameters of `web/fetch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchParams {
    /// The session of the call.
    pub session_id: SessionId,
    /// The approved `WebFetch` call; its input's `url` must equal `url`.
    pub origin: ToolOrigin,
    /// The URL to fetch (`http:` or `https:`).
    pub url: String,
}

/// How `content` was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WebContentFormat {
    /// Converted from HTML.
    Markdown,
    /// Text the server sent as it was.
    Text,
}

/// A redirect to another site that Core did not follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebRedirect {
    /// The absolute target URL.
    pub url: String,
    /// The redirect status (301, 302, 303, 307, 308).
    pub status: u64,
}

/// Result of `web/fetch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    /// The URL the response came from (after same-site redirects), or the redirecting URL.
    pub url: String,
    /// The HTTP status of that response.
    pub status: u64,
    /// The response's `Content-Type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Present when the response redirected to another site; `content` is then empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect: Option<WebRedirect>,
    /// How `content` was produced.
    pub format: WebContentFormat,
    /// The page as Markdown or text, cut to the character limit.
    pub content: String,
    /// Body bytes read.
    pub bytes: u64,
    /// The body was longer than the byte limit and was cut.
    pub body_truncated: bool,
    /// Characters of the converted text before the cut.
    pub total_chars: u64,
    /// The converted text was longer than the character limit and was cut.
    pub content_truncated: bool,
}

request!(
    /// Method marker for `web/fetch` (Agent Host → Core).
    WebFetch, "web/fetch", WebFetchParams, WebFetchResult
);
