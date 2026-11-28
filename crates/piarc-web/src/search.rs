//! WebSearch's third-party backends (T38, ADR-0055): an adapter per service ([`Backend`]: how to
//! ask, how to read the answer) and one search ([`search`]): the request goes through the
//! fetcher's client to the service's fixed endpoint ([`Reach::Configured`]), the results become
//! title, URL and snippet, and the domain filters of the call apply.
//!
//! The API key comes with each search (Core reads it from the vault); it is only put in the
//! request header and never in an error message.

use piarc_protocol::web::WebSearchSource;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::error::FetchError;
use crate::fetch::{Call, Fetcher, Method, Reach, Reply};

/// Results given back at most.
pub const MAX_RESULTS: usize = 10;
/// Response bytes read from a search service.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Characters of a snippet kept.
const MAX_SNIPPET_CHARS: usize = 400;

/// A search service.
pub trait Backend: Send + Sync {
    /// The settings id (`webSearch.backend`) and vault key suffix (`websearch/<id>`).
    fn id(&self) -> &'static str;
    /// The name for the user and the model.
    fn name(&self) -> &'static str;
    /// The service's endpoint.
    fn endpoint(&self) -> &'static str;
    /// The request for `query` to `endpoint` with `key`.
    ///
    /// # Errors
    ///
    /// The endpoint is not a URL.
    fn call(&self, endpoint: &str, query: &str, key: &str) -> Result<Call, FetchError>;
    /// The results of a successful (2xx) response.
    ///
    /// # Errors
    ///
    /// The response is not the service's documented shape.
    fn results(&self, reply: &Reply) -> Result<Vec<WebSearchSource>, FetchError>;
}

/// Brave Search API, web search
/// (<https://api-dashboard.search.brave.com/app/documentation/web-search/get-started>):
/// `GET /res/v1/web/search?q=…&count=…` with `X-Subscription-Token`; results in
/// `web.results[]` with `title`, `url` and `description`.
pub struct Brave;

impl Backend for Brave {
    fn id(&self) -> &'static str {
        "brave"
    }

    fn name(&self) -> &'static str {
        "Brave Search"
    }

    fn endpoint(&self) -> &'static str {
        "https://api.search.brave.com/res/v1/web/search"
    }

    fn call(&self, endpoint: &str, query: &str, key: &str) -> Result<Call, FetchError> {
        let count = MAX_RESULTS.to_string();
        let url = Url::parse_with_params(endpoint, [("q", query), ("count", count.as_str())])
            .map_err(|e| FetchError::InvalidUrl(format!("{endpoint}: {e}")))?;
        Ok(Call {
            method: Method::Get,
            url: url.into(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("X-Subscription-Token".into(), key.to_owned()),
            ],
            body: Vec::new(),
            max_body_bytes: MAX_RESPONSE_BYTES,
        })
    }

    fn results(&self, reply: &Reply) -> Result<Vec<WebSearchSource>, FetchError> {
        let unreadable = |reason: &str| FetchError::UnreadableResponse {
            service: self.name().to_owned(),
            reason: reason.to_owned(),
        };
        let json: Value =
            serde_json::from_slice(&reply.body).map_err(|_| unreadable("the body is not JSON"))?;
        // A query without web results answers without `web`.
        let Some(web) = json.get("web") else {
            return Ok(Vec::new());
        };
        let list = web
            .get("results")
            .and_then(Value::as_array)
            .ok_or_else(|| unreadable("web.results is not a list"))?;
        Ok(list
            .iter()
            .filter_map(|item| {
                let text = |key: &str| item.get(key).and_then(Value::as_str).map(str::trim);
                let url = text("url").filter(|u| !u.is_empty())?;
                Some(WebSearchSource {
                    title: text("title").unwrap_or(url).to_owned(),
                    url: url.to_owned(),
                    snippet: plain(text("description").unwrap_or_default()),
                })
            })
            .collect())
    }
}

/// Every backend, in the settings page's order.
pub const BACKENDS: &[&dyn Backend] = &[&Brave];

/// The backend with settings id `id`.
#[must_use]
pub fn backend(id: &str) -> Option<&'static dyn Backend> {
    BACKENDS.iter().copied().find(|b| b.id() == id)
}

/// Brave marks matched words with `<strong>`; snippets are plain text, cut to a bound.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        match rest[start..].find('>') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = &rest[start..];
                break;
            }
        }
    }
    out.push_str(rest);
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    out.chars().take(MAX_SNIPPET_CHARS).collect()
}

/// Whether `host` is `domain` or one of its subdomains (case and a trailing dot ignored).
fn on_domain(host: &str, domain: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    !domain.is_empty()
        && (host == domain
            || host
                .strip_suffix(domain.as_str())
                .is_some_and(|rest| rest.ends_with('.')))
}

/// `results` on `allowed` domains (when given) and not on `blocked` ones, at most
/// [`MAX_RESULTS`].
#[must_use]
pub fn filter(
    results: Vec<WebSearchSource>,
    allowed: &[String],
    blocked: &[String],
) -> Vec<WebSearchSource> {
    results
        .into_iter()
        .filter(|r| {
            let Some(host) = Url::parse(&r.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
            else {
                return false;
            };
            (allowed.is_empty() || allowed.iter().any(|d| on_domain(&host, d)))
                && !blocked.iter().any(|d| on_domain(&host, d))
        })
        .take(MAX_RESULTS)
        .collect()
}

/// Asks `backend` at `endpoint` for `query` with `key`, then applies the domain filters.
///
/// # Errors
///
/// The request failed, the service answered with an error status, or its answer is unreadable.
pub async fn search(
    fetcher: &Fetcher,
    backend: &dyn Backend,
    endpoint: &str,
    key: &str,
    query: &str,
    domains: (&[String], &[String]),
    cancel: &CancellationToken,
) -> Result<Vec<WebSearchSource>, FetchError> {
    let call = backend.call(endpoint, query, key)?;
    let reply = fetcher.call(&call, Reach::Configured, cancel).await?;
    if !(200..300).contains(&reply.status) {
        let message = match reply.status {
            401 | 403 => "the API key was refused".to_owned(),
            429 => "too many requests; try again later".to_owned(),
            _ => "the search failed".to_owned(),
        };
        return Err(FetchError::Service {
            service: backend.name().to_owned(),
            status: reply.status,
            message,
        });
    }
    Ok(filter(backend.results(&reply)?, domains.0, domains.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(url: &str) -> WebSearchSource {
        WebSearchSource {
            title: url.into(),
            url: url.into(),
            snippet: String::new(),
        }
    }

    #[test]
    fn brave_requests_carry_the_query_and_key_and_answers_become_sources() {
        let call = Brave
            .call(Brave.endpoint(), "rust 异步 & tokio", "key-1")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(
            call.url
                .starts_with("https://api.search.brave.com/res/v1/web/search?q=rust+")
        );
        assert!(call.url.ends_with("&count=10"));
        assert!(
            call.headers
                .contains(&("X-Subscription-Token".into(), "key-1".into()))
        );
        let reply = Reply {
            status: 200,
            content_type: Some("application/json".into()),
            body: br#"{"web": {"results": [
                {"title": "Tokio", "url": "https://tokio.rs/", "description": "An <strong>async</strong> runtime &amp; more"},
                {"title": "No url"},
                {"url": "https://docs.rs/tokio"}
            ]}}"#
                .to_vec(),
            truncated: false,
        };
        let results = Brave.results(&reply).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].snippet, "An async runtime & more");
        assert_eq!(results[1].title, "https://docs.rs/tokio");
        let empty = Reply {
            body: b"{}".to_vec(),
            ..reply.clone()
        };
        assert_eq!(Brave.results(&empty).map(|r| r.len()).ok(), Some(0));
        let broken = Reply {
            body: b"<html>".to_vec(),
            ..reply
        };
        assert!(Brave.results(&broken).is_err());
    }

    #[test]
    fn domain_filters_match_hosts_and_subdomains() {
        let all = vec![
            source("https://docs.rs/a"),
            source("https://blog.docs.rs/b"),
            source("https://notdocs.rs/c"),
            source("https://EXAMPLE.com./d"),
            source("not a url"),
        ];
        let urls = |list: Vec<WebSearchSource>| -> Vec<String> {
            list.into_iter().map(|s| s.url).collect()
        };
        assert_eq!(
            urls(filter(all.clone(), &["docs.rs".into()], &[])),
            ["https://docs.rs/a", "https://blog.docs.rs/b"]
        );
        assert_eq!(
            urls(filter(
                all.clone(),
                &[],
                &["docs.rs".into(), "example.com".into()]
            )),
            ["https://notdocs.rs/c"]
        );
        assert_eq!(filter(all, &[], &[]).len(), 4);
        assert_eq!(backend("brave").map(Backend::id), Some("brave"));
        assert!(backend("bing").is_none());
    }
}
