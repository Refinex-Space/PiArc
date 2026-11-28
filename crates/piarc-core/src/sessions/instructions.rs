//! The settings window's "Instructions" page (ADR-0108): Pi's global instructions in
//! `~/.pi/agent`, read and saved through [`crate::pi_instructions`] on the blocking pool.
//! Running sessions see a saved file on their next turn, as with any memory file.

use std::path::PathBuf;

use serde_json::Value;

use super::Hub;
use crate::error::{Error, Result};
use crate::pi_instructions;

fn home_of(hub: &Hub) -> Result<PathBuf> {
    hub.ctx
        .storage
        .dirs()
        .home()
        .map(std::path::Path::to_owned)
        .ok_or_else(|| Error::Internal {
            reason: "no home directory for Pi's instructions".into(),
        })
}

async fn blocking(
    work: impl FnOnce() -> Result<pi_instructions::View> + Send + 'static,
) -> Result<Value> {
    let view = tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| Error::Internal {
            reason: format!("an instructions task failed: {e}"),
        })??;
    serde_json::to_value(view).map_err(|e| Error::Internal {
        reason: e.to_string(),
    })
}

impl Hub {
    /// Pi's global instructions: `{ path, exists, content, hash }`.
    ///
    /// # Errors
    ///
    /// No home directory, or the file is too large or cannot be read.
    pub async fn pi_instructions(&self) -> Result<Value> {
        let home = home_of(self)?;
        blocking(move || pi_instructions::view(&home)).await
    }

    /// Saves Pi's global instructions over the version `base` names; answers the new view.
    ///
    /// # Errors
    ///
    /// As [`pi_instructions::save`].
    pub async fn save_pi_instructions(
        &self,
        content: String,
        base: Option<String>,
    ) -> Result<Value> {
        let home = home_of(self)?;
        blocking(move || pi_instructions::save(&home, &content, base.as_deref())).await
    }
}
