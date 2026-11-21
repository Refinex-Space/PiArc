//! `web/fetch` (T29, ADR-0045): the network side of WebFetch runs here, where the connection
//! is made. The call must hold an approval for exactly this URL (consumed by the fetch); the
//! fetch itself is `piarc-web` (address checks, pinned connection, same-site redirects,
//! limits); every fetch is audited (`kind: "webFetch"`). A turn interruption or a lost
//! connection stops it.
use std::sync::{Arc, OnceLock};

use piarc_host::Peer;
use piarc_protocol::ErrorObject;
use piarc_protocol::web::{WebContentFormat, WebFetchParams, WebFetchResult, WebRedirect};
use piarc_web::{Allowlist, FetchLimits, Fetcher, Format, Outcome};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ToolIo, lock, policy, to_value};

/// The limits and allowlist of `web/fetch`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebConfig {
    pub limits: FetchLimits,
    /// Hosts and address ranges reachable although not public (`piarc_web::Allowlist`); the
    /// test HTTP servers of L2 and L4 are admitted through it. Not read from project settings:
    /// a repository must not open the user's network to its own commands.
    pub allowlist: Vec<String>,
    /// Search backend id → endpoint used instead of the service's own (T38): the local mock
    /// search services of L2 and L4. Empty in the app.
    pub search_endpoints: std::collections::BTreeMap<String, String>,
}

/// The fetcher, built on first use (the platform verifier loads the trust store).
#[derive(Default)]
pub(super) struct WebState(OnceLock<Result<Arc<Fetcher>, ErrorObject>>);

impl WebState {
    pub(super) fn fetcher(&self, config: &WebConfig) -> Result<Arc<Fetcher>, ErrorObject> {
        self.0
            .get_or_init(|| {
                let allow = Allowlist::new(&config.allowlist).map_err(|reason| {
                    piarc_web::FetchError::InvalidUrl(reason).to_error_object()
                })?;
                Fetcher::new(config.limits.clone(), allow)
                    .map(Arc::new)
                    .map_err(|e| e.to_error_object())
            })
            .clone()
    }
}

fn result_of(outcome: Outcome) -> WebFetchResult {
    match outcome {
        Outcome::Content(page) => WebFetchResult {
            url: page.url,
            status: u64::from(page.status),
            content_type: page.content_type,
            redirect: None,
            format: match page.content.format {
                Format::Markdown => WebContentFormat::Markdown,
                Format::Text => WebContentFormat::Text,
            },
            total_chars: page.content.total_chars as u64,
            content_truncated: page.content.truncated,
            content: page.content.text,
            bytes: page.bytes,
            body_truncated: page.body_truncated,
        },
        Outcome::Redirect { from, to, status } => WebFetchResult {
            url: from,
            status: u64::from(status),
            content_type: None,
            redirect: Some(WebRedirect {
                url: to,
                status: u64::from(status),
            }),
            format: WebContentFormat::Text,
            content: String::new(),
            bytes: 0,
            body_truncated: false,
            total_chars: 0,
            content_truncated: false,
        },
    }
}

impl ToolIo {
    pub(super) async fn web_fetch(
        &self,
        p: WebFetchParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        if self.policy.is_some() {
            policy::claim_fetch(&session, &p, &peer)?;
        }
        let fetcher = self.web.fetcher(&self.config.web)?;
        let key = format!("web:{}", p.origin.tool_call_id);
        let token = CancellationToken::new();
        lock(&session.running).insert(key.clone(), token.clone());
        let outcome = tokio::select! {
            result = fetcher.fetch(&p.url, &token) => result,
            () = peer.closed() => Err(piarc_web::FetchError::Cancelled),
        };
        lock(&session.running).remove(&key);
        let detail = match &outcome {
            Ok(Outcome::Content(page)) => json!({
                "tool": "WebFetch", "toolCallId": p.origin.tool_call_id, "url": p.url,
                "finalUrl": page.url, "status": page.status, "bytes": page.bytes,
                "bodyTruncated": page.body_truncated,
            }),
            Ok(Outcome::Redirect { to, status, .. }) => json!({
                "tool": "WebFetch", "toolCallId": p.origin.tool_call_id, "url": p.url,
                "redirect": to, "status": status,
            }),
            Err(e) => json!({
                "tool": "WebFetch", "toolCallId": p.origin.tool_call_id, "url": p.url,
                "error": e.to_error_object().data.details.unwrap_or(Value::Null)["reason"],
            }),
        };
        if let Some(services) = &self.policy {
            services
                .record("webFetch", &p.session_id.0, session.project(), &detail)
                .await?;
        }
        to_value(&result_of(outcome.map_err(|e| e.to_error_object())?))
    }
}
