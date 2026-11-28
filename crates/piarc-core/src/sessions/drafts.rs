//! Draft sessions: the new-session view opens one when the user first reaches for a tool
//! (files, terminal, changes, preview) before sending anything. A draft is an ordinary session
//! that lists of sessions leave out until its first input is accepted; its first message then
//! goes to it. A draft left without a message is discarded: Pi wrote no file for it, and its
//! tasks (a terminal the user opened) stop with it.

use std::path::PathBuf;

use serde_json::Value;

use super::{Hub, check_session_id, session_not_found};
use crate::error::{Error, Result};

impl Hub {
    /// Creates a draft session in `workspace`, working in the workspace itself.
    pub async fn create_draft_session(&self, workspace: PathBuf) -> Result<Value> {
        self.create_session_as(workspace, None, None, None, None, true)
            .await
    }

    /// Discards draft session `id`: deletes it as [`Hub::delete_session`] does. A session that
    /// took an input is refused, so a late discard never removes a conversation.
    pub async fn discard_draft_session(&self, id: String) -> Result<()> {
        check_session_id(&id)?;
        let Some(session) = self.live(&id) else {
            return Err(session_not_found(&id));
        };
        if !session.is_draft() {
            return Err(Error::InvalidArgument {
                field: "id",
                reason: "is not a draft session".into(),
            });
        }
        self.delete_session(id).await
    }
}
