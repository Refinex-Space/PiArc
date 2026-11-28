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
//! - One request to an address the user configured ([`Fetcher::call`] with
//!   [`Reach::Configured`]): `http` hooks and search services. Same client, TLS, timeout and
//!   size bounds; no address check (the user wrote the address), no redirect.
//! - Search backends ([`search`]): the adapter interface and Brave Search; results filtered by
//!   domain.
//! - Downloads ([`download`], ADR-0097) and small answers read into memory ([`get`], ADR-0102:
//!   the Pi package market's catalog), both over one connection layer (`connect`): hosts checked
//!   on every hop, `https:` only, the user's proxy through `CONNECT`, otherwise checked addresses.
//!
//! # Not responsible for
//!
//! - Permission decisions, grants and audit (`piarc-core`'s `tool_io`), the extraction model call
//!   (the Agent Host's WebFetch tool), API keys (Core reads them from the vault and passes them
//!   per call).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

use std::time::Duration;

mod connect;
pub mod convert;
pub mod download;
mod error;
mod fetch;
pub mod get;
pub mod search;
pub mod ssrf;

pub use convert::{Content, Format};
pub use error::FetchError;
pub use fetch::{
    Call, Fetched, Fetcher, Method, Outcome, Reach, Reply, Resolve, SystemResolver, parse_target,
    rule_host,
};
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
