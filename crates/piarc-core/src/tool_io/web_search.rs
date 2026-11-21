//! WebSearch's third-party backend (T38, ADR-0055): `web/searchBackend` says whether one can be
//! used, `web/search` runs one search for an allowed `WebSearch` call. The backend is the user's
//! choice (`webSearch.backend` in their own settings file, never a project's), its API key is
//! in the vault under `websearch/<backend>` and stays in Core; the request goes through
//! `piarc-web` with WebFetch's client and limits. Every search is audited
//! (`kind: "webSearch"`, the query and the number of results, never the key).

use piarc_host::Peer;
use piarc_protocol::ErrorObject;
use piarc_protocol::web::{
    WebSearchBackendInfo, WebSearchBackendResult, WebSearchParams, WebSearchResult,
    WebSearchUnavailable,
};
use piarc_web::search::{self, Backend};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{ToolIo, lock, policy, to_value};

/// The vault key of `backend`'s API key.
#[must_use]
pub(crate) fn key_name(backend: &str) -> String {
    format!("websearch/{backend}")
}

/// The member of a stored key value that holds the key.
const KEY_FIELD: &str = "apiKey";

/// The backend the user chose in their own settings file, if PiArc knows it.
pub(crate) fn chosen_backend(data_dir: &std::path::Path) -> Option<&'static dyn Backend> {
    let text = std::fs::read_to_string(data_dir.join("settings.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .pointer("/webSearch/backend")
        .and_then(Value::as_str)
        .and_then(search::backend)
}

fn unavailable(message: &str) -> ErrorObject {
    ErrorObject::new(
        piarc_protocol::ErrorKind::PermissionDenied,
        message.to_owned(),
        false,
    )
}

impl ToolIo {
    /// The saved API key of `backend`, or `None`.
    pub(crate) async fn search_key(
        &self,
        backend: &dyn Backend,
    ) -> Result<Option<String>, ErrorObject> {
        let Some(secrets) = &self.secrets else {
            return Ok(None);
        };
        Ok(secrets
            .value_of(&key_name(backend.id()))
            .await?
            .and_then(|v| v.get(KEY_FIELD).and_then(Value::as_str).map(str::to_owned))
            .filter(|k| !k.is_empty()))
    }

    /// Saves (`Some`) or removes `backend`'s API key.
    pub(crate) async fn store_search_key(
        &self,
        backend: &dyn Backend,
        key: Option<&str>,
    ) -> Result<(), ErrorObject> {
        let Some(secrets) = &self.secrets else {
            return Err(unavailable("the vault is not available"));
        };
        let value = key.map(|key| {
            let mut value = Map::new();
            value.insert(KEY_FIELD.into(), json!(key));
            value
        });
        secrets.store_value(&key_name(backend.id()), value).await
    }

    /// `web/searchBackend`: the chosen backend when its key is saved, otherwise why not.
    pub(super) async fn search_backend(&self) -> WebSearchBackendResult {
        let Some(backend) = chosen_backend(&self.config.data_dir) else {
            return WebSearchBackendResult {
                backend: None,
                unavailable: Some(WebSearchUnavailable::NotConfigured),
            };
        };
        match self.search_key(backend).await {
            Ok(Some(_)) => WebSearchBackendResult {
                backend: Some(WebSearchBackendInfo {
                    id: backend.id().to_owned(),
                    name: backend.name().to_owned(),
                }),
                unavailable: None,
            },
            Ok(None) | Err(_) => WebSearchBackendResult {
                backend: None,
                unavailable: Some(WebSearchUnavailable::NoKey),
            },
        }
    }

    /// `web/search` for an allowed `WebSearch` call.
    pub(super) async fn web_search(
        &self,
        p: WebSearchParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        if self.policy.is_some() {
            policy::claim_search(&session, &p, &peer)?;
        }
        let backend = chosen_backend(&self.config.data_dir).ok_or_else(|| {
            unavailable("No web search service is configured in PiArc's settings.")
        })?;
        let key = self.search_key(backend).await?.ok_or_else(|| {
            unavailable(&format!(
                "{} has no API key in PiArc's settings.",
                backend.name()
            ))
        })?;
        let endpoint = self
            .config
            .web
            .search_endpoints
            .get(backend.id())
            .cloned()
            .unwrap_or_else(|| backend.endpoint().to_owned());
        let fetcher = self.web.fetcher(&self.config.web)?;
        let running = format!("search:{}", p.origin.tool_call_id);
        let token = CancellationToken::new();
        lock(&session.running).insert(running.clone(), token.clone());
        let domains = (p.allowed_domains.as_slice(), p.blocked_domains.as_slice());
        let outcome = tokio::select! {
            result = search::search(&fetcher, backend, &endpoint, &key, &p.query, domains, &token) => result,
            () = peer.closed() => Err(piarc_web::FetchError::Cancelled),
        };
        lock(&session.running).remove(&running);
        let detail = match &outcome {
            Ok(results) => json!({
                "tool": "WebSearch", "toolCallId": p.origin.tool_call_id, "query": p.query,
                "backend": backend.id(), "results": results.len(),
            }),
            Err(e) => json!({
                "tool": "WebSearch", "toolCallId": p.origin.tool_call_id, "query": p.query,
                "backend": backend.id(),
                "error": e.to_error_object().data.details.unwrap_or(Value::Null)["reason"],
            }),
        };
        if let Some(services) = &self.policy {
            services
                .record("webSearch", &p.session_id.0, session.project(), &detail)
                .await?;
        }
        let results = outcome.map_err(|e| e.to_error_object())?;
        to_value(&WebSearchResult {
            backend: backend.id().to_owned(),
            results,
        })
    }
}
