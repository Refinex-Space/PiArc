//! WebFetch's network request (architecture section 6.1.4, T29, ADR-0045), needing the
//! handshake capability `webFetch`, and WebSearch's third-party backend (T38, ADR-0055),
//! needing `webSearch`.
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

/// One search result: what both backends give the model and the transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSource {
    /// The page title.
    pub title: String,
    /// The page address.
    pub url: String,
    /// A short excerpt; empty when the backend gives none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub snippet: String,
}

/// Parameters of `web/search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchParams {
    /// The session of the call.
    pub session_id: SessionId,
    /// The approved `WebSearch` call; its input's `query` must equal `query`.
    pub origin: ToolOrigin,
    /// The search terms.
    pub query: String,
    /// Keep only results on these hosts (and their subdomains).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
    /// Drop results on these hosts (and their subdomains).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_domains: Vec<String>,
}

/// Result of `web/search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    /// The backend that answered (`brave`).
    pub backend: String,
    /// The results, best first, after the domain filters.
    pub results: Vec<WebSearchSource>,
}

request!(
    /// Method marker for `web/search` (Agent Host → Core).
    WebSearch, "web/search", WebSearchParams, WebSearchResult
);

/// Why no third-party search backend can be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WebSearchUnavailable {
    /// The user chose no backend (`webSearch.backend`).
    NotConfigured,
    /// The chosen backend has no API key in the vault.
    NoKey,
}

/// A third-party search backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchBackendInfo {
    /// Its id (`brave`).
    pub id: String,
    /// Its name for the user and the model.
    pub name: String,
}

/// Parameters of `web/searchBackend`: none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchBackendParams {}

/// Result of `web/searchBackend`: the usable backend, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchBackendResult {
    /// The configured backend with its key saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<WebSearchBackendInfo>,
    /// Why there is no usable backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<WebSearchUnavailable>,
}

request!(
    /// Method marker for `web/searchBackend` (Agent Host → Core).
    WebSearchBackend, "web/searchBackend", WebSearchBackendParams, WebSearchBackendResult
);
