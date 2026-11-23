//! Side requests use the parent's running host without entering its turn or tool pipeline.
use std::time::Duration;

use piarc_host::HostSupervisor;
use piarc_protocol::session::{
    SideChatAsk, SideChatAskParams, SideChatControl, SideChatControlParams,
};
use serde_json::{Value, json};

use super::Request;
use crate::error::{Error, Result};
use crate::sessions::host_error;

fn check_panel(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(Error::InvalidArgument {
            field: "panelId",
            reason: "invalid side chat panel id".into(),
        });
    }
    Ok(())
}

impl Request {
    pub(super) async fn ask_side_chat(
        &self,
        host: &HostSupervisor,
        panel_id: String,
        text: String,
    ) -> Result<Value> {
        check_panel(&panel_id)?;
        if text.trim().is_empty() || text.len() > 1024 * 1024 {
            return Err(Error::InvalidArgument {
                field: "text",
                reason: "expected a non-empty question of at most 1 MiB".into(),
            });
        }
        let params = SideChatAskParams {
            session_id: self.id.clone(),
            panel_id,
            text,
        };
        let answer = host
            .session_call_within::<SideChatAsk>(&self.id, params, Duration::from_secs(610))
            .await
            .map_err(host_error)?;
        let id = self.id.0.clone();
        if !answer.usage.is_empty() {
            let workspace = crate::sessions::path_text(&self.ws.path);
            self.storage
                .run(move |db| {
                    let records: Vec<_> = answer
                        .usage
                        .into_iter()
                        .map(|u| piarc_store::RequestUsage {
                            entry_id: None,
                            at: Some(crate::storage::now_ms()),
                            kind: "auxiliary",
                            purpose: Some("sideChat".into()),
                            provider: u.model.provider,
                            model: u.model.id,
                            input: u.input.into(),
                            output: u.output.into(),
                            cache_read: u.cache_read.into(),
                            cache_write: u.cache_write.into(),
                            cache_write_1h: u.cache_write_1h.into(),
                            reasoning: u.reasoning.into(),
                        })
                        .collect();
                    db.record_side_chat(&id, &workspace, &records)
                })
                .await??;
        }
        if let Some(message) = answer.error {
            return Err(Error::Internal { reason: message });
        }
        Ok(json!({"text": answer.text, "stopped": answer.stopped}))
    }

    pub(super) async fn control_side_chat(
        &self,
        host: &HostSupervisor,
        panel_id: String,
        close: bool,
    ) -> Result<Value> {
        check_panel(&panel_id)?;
        self.call::<SideChatControl>(
            host,
            None,
            SideChatControlParams {
                session_id: self.id.clone(),
                panel_id,
                close,
            },
        )
        .await?;
        Ok(Value::Null)
    }
}
