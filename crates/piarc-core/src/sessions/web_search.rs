//! The settings window's WebSearch section (T38, ADR-0055): which third-party backend is chosen
//! (`webSearch.backend` in the user's `settings.json`) and whether its API key is saved; the key
//! itself only goes into the vault and never comes back out.

use piarc_web::search::{self, BACKENDS};
use serde_json::{Value, json};

use super::Hub;
use crate::error::{Error, Result};

/// Longest API key accepted.
const MAX_KEY_CHARS: usize = 512;

fn known(id: &str) -> Result<&'static dyn search::Backend> {
    search::backend(id).ok_or_else(|| Error::InvalidArgument {
        field: "backend",
        reason: format!(
            "one of {}",
            BACKENDS
                .iter()
                .map(|b| b.id())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    })
}

impl Hub {
    /// `{ backend, backends: [{ id, name, hasKey }] }`.
    pub async fn web_search_settings(&self) -> Result<Value> {
        let io = &self.ctx.tool_io;
        let data = self.ctx.storage.dirs().data().to_owned();
        let chosen = crate::tool_io::chosen_search_backend(&data).map(search::Backend::id);
        let mut backends = Vec::new();
        for backend in BACKENDS {
            let has_key = io
                .search_key(*backend)
                .await
                .map_err(|e| Error::feature(&e))?
                .is_some();
            backends.push(json!({ "id": backend.id(), "name": backend.name(), "hasKey": has_key }));
        }
        Ok(json!({ "backend": chosen, "backends": backends }))
    }

    /// Chooses the third-party backend (`None`: no backend).
    pub async fn set_web_search_backend(&self, backend: Option<String>) -> Result<Value> {
        if let Some(id) = &backend {
            known(id)?;
        }
        let data = self.ctx.storage.dirs().data().to_owned();
        let managed = self.ctx.storage.dirs().managed().clone();
        tokio::task::spawn_blocking(move || {
            crate::client_settings::write_user_value(
                &data,
                &managed,
                "/webSearch/backend",
                backend.map(Value::String),
            )
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("writing the web search setting failed: {e}"),
        })??;
        Ok(Value::Null)
    }

    /// Saves (`Some`) or removes `backend`'s API key in the vault.
    pub async fn set_web_search_key(&self, backend: String, key: Option<String>) -> Result<Value> {
        let backend = known(&backend)?;
        let key = key.map(|k| k.trim().to_owned());
        if let Some(key) = &key
            && (key.is_empty()
                || key.chars().count() > MAX_KEY_CHARS
                || key.chars().any(char::is_control))
        {
            return Err(Error::InvalidArgument {
                field: "key",
                reason: format!("an API key of 1-{MAX_KEY_CHARS} printable characters"),
            });
        }
        self.ctx
            .tool_io
            .store_search_key(backend, key.as_deref())
            .await
            .map_err(|e| Error::feature(&e))?;
        Ok(Value::Null)
    }
}
