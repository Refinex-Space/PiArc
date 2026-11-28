//! In-app updates (ADR-0111): the About page's status, checks, downloads and the install plan,
//! each through the effective proxy at the time of the call (ADR-0082).

use serde::Serialize;
use serde_json::Value;

use super::Hub;
use crate::error::{Error, Result};

fn encode(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the update status: {e}"),
    })
}

impl Hub {
    fn update_proxy(&self) -> Option<String> {
        self.ctx.proxy.effective(self.ctx.storage.dirs().data())
    }

    /// The update status.
    pub fn update_status(&self) -> Result<Value> {
        encode(&self.ctx.updates.status())
    }

    /// Reads the latest release; answers the new status.
    pub async fn check_for_updates(&self) -> Result<Value> {
        encode(&self.ctx.updates.check(self.update_proxy()).await)
    }

    /// Starts downloading the newer release; answers the new status.
    pub fn download_update(&self) -> Result<Value> {
        encode(&self.ctx.updates.download(self.update_proxy())?)
    }

    /// Cancels the running download; answers the status.
    pub fn cancel_update_download(&self) -> Result<Value> {
        encode(&self.ctx.updates.cancel_download())
    }

    /// The verified files of the ready release (`UpdateInstall`).
    pub async fn update_install_plan(&self) -> Result<Value> {
        encode(&self.ctx.updates.install_plan().await?)
    }
}
