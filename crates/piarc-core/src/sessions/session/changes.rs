//! Requests that change an open session's settings or its queue: the permission mode (checked
//! by Core before and recorded after the Agent Host takes it), the model and effort (list,
//! preview of a switch, switch) and edits of the queued inputs.

use piarc_host::HostSupervisor;
use piarc_protocol::models;
use piarc_protocol::queue::{
    QueueDelete, QueueDeleteParams, QueueEdit, QueueEditParams, QueueReorder, QueueReorderParams,
};
use serde_json::Value;

use super::{ModelOp, QueueOp, Request};
use crate::error::{Error, Result};
use crate::sessions::host_error;

impl Request {
    pub(super) async fn set_mode(
        &self,
        supervisor: &HostSupervisor,
        mode: piarc_protocol::policy::PermissionMode,
    ) -> Result<Value> {
        self.tool_io
            .check_mode(&self.id.0, mode)
            .await
            .map_err(|e| Error::feature(&e))?;
        supervisor
            .set_permission_mode(&self.id, mode)
            .await
            .map_err(host_error)?;
        self.tool_io
            .changed_mode(&self.id.0, mode)
            .await
            .map_err(|e| Error::feature(&e))?;
        Ok(Value::Null)
    }

    pub(super) async fn model(
        &self,
        supervisor: &HostSupervisor,
        change: ModelOp,
    ) -> Result<Value> {
        match change {
            ModelOp::List => {
                self.call::<models::ModelsList>(
                    supervisor,
                    None,
                    models::ModelsListParams {
                        session_id: Some(self.id.clone()),
                    },
                )
                .await
            }
            ModelOp::Preview(model) => {
                self.call::<models::SessionPreviewModelSwitch>(
                    supervisor,
                    None,
                    models::ModelSwitchParams {
                        session_id: self.id.clone(),
                        model,
                    },
                )
                .await
            }
            ModelOp::Set(model, effort) => {
                self.call::<models::SessionSetModel>(
                    supervisor,
                    None,
                    models::SetModelParams {
                        session_id: self.id.clone(),
                        model,
                        effort,
                    },
                )
                .await
            }
            ModelOp::Effort(effort) => {
                self.call::<models::SessionSetEffort>(
                    supervisor,
                    None,
                    models::SetEffortParams {
                        session_id: self.id.clone(),
                        effort,
                    },
                )
                .await
            }
        }
    }

    pub(super) async fn queue(
        &self,
        supervisor: &HostSupervisor,
        change: QueueOp,
    ) -> Result<Value> {
        let session_id = self.id.clone();
        match change {
            QueueOp::Edit { item_id, text } => {
                let params = QueueEditParams {
                    session_id,
                    item_id,
                    text,
                };
                self.call::<QueueEdit>(supervisor, None, params).await
            }
            QueueOp::Delete { item_id } => {
                let params = QueueDeleteParams {
                    session_id,
                    item_id,
                };
                self.call::<QueueDelete>(supervisor, None, params).await
            }
            QueueOp::Reorder(item_ids) => {
                let params = QueueReorderParams {
                    session_id,
                    item_ids,
                };
                self.call::<QueueReorder>(supervisor, None, params).await
            }
        }
    }
}
