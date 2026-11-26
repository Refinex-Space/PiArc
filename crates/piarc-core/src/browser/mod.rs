//! The built-in browser's Core side (ADR-0088, ADR-0089; design addendum
//! `docs/architecture/addenda/browser.md`).
//!
//! - [`proxies`]: one network proxy per browser partition. The main process points the
//!   partition's Chromium session at it; every non-loopback request is resolved once here and
//!   refused when it leads to cloud metadata, link-local or unspecified addresses, to loopback
//!   behind a name that is not local (DNS rebinding), or to PiArc's own ports.

pub mod proxies;

pub use proxies::{BrowserProxies, BrowserProxyRequest};
