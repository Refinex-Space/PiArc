//! Chrome sign-in import requests from the main process (ADR-0090): the work is in
//! `crate::browser::import`; this checks the arguments.

use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use super::Hub;
use crate::error::{Error, Result};

/// The import request: `{ workspace, profile, sites }`.
#[derive(serde::Deserialize)]
struct ImportRequest {
    workspace: PathBuf,
    profile: String,
    sites: Vec<String>,
}

fn absolute(workspace: &Path) -> Result<()> {
    if workspace.is_absolute() {
        Ok(())
    } else {
        Err(Error::InvalidArgument {
            field: "workspace",
            reason: "must be an absolute path".into(),
        })
    }
}

impl Hub {
    /// `{ chrome, profiles }`.
    pub async fn chrome_profiles(&self) -> Result<serde_json::Value> {
        self.ctx.chrome.profiles().await
    }

    /// `{ sites }` of a profile: names and counts only.
    pub async fn chrome_sites(&self, profile: String) -> Result<serde_json::Value> {
        self.ctx.chrome.sites(profile).await
    }

    /// The import the user confirmed; JSON text with the cookies (secret).
    pub async fn chrome_import(&self, request_json: String) -> Result<Zeroizing<String>> {
        let request: ImportRequest =
            serde_json::from_str(&request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason: "must be { workspace, profile, sites }".into(),
            })?;
        absolute(&request.workspace)?;
        self.ctx
            .chrome
            .import(&request.workspace, request.profile, request.sites)
            .await
    }

    /// `{ imports }` of a workspace.
    pub async fn browser_imports(&self, workspace: PathBuf) -> Result<serde_json::Value> {
        absolute(&workspace)?;
        self.ctx.chrome.list(&workspace).await
    }

    /// Forgets an imported site of a workspace; `{ forgot }`.
    pub async fn forget_browser_import(
        &self,
        workspace: PathBuf,
        site: String,
    ) -> Result<serde_json::Value> {
        absolute(&workspace)?;
        self.ctx.chrome.forget(&workspace, site).await
    }
}
