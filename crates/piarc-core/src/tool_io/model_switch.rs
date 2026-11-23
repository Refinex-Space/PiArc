//! User-initiated, idle-session model changes (T48). A hook-requested confirmation is a
//! Core-originated question in the existing ledger. It cannot grant any tool permission.
use piarc_hooks::{HookEvent, Permission};
use piarc_protocol::{
    ErrorKind, ErrorObject,
    harness::{Question, QuestionOption},
    models::ModelSwitchPreviewResult,
    policy::{ApprovalDecision, ApprovalKind, ApprovalRequest},
    session::ModelRef,
};
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::ToolIo;
use crate::hooks::Request;

fn refused(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::PermissionDenied, message.into(), false)
}

impl ToolIo {
    pub(crate) async fn model_switch_hook(
        &self,
        id: &str,
        event: HookEvent,
        target: &ModelRef,
        preview: &ModelSwitchPreviewResult,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, ErrorObject> {
        let Some(hooks) = self.hook_service() else {
            return Ok(None);
        };
        let session = self.session(id)?;
        let facts = self.session_facts(&session, id, cancel.child_token());
        let from = preview.from_model.as_ref();
        if from == Some(target) {
            return Ok(None);
        }
        let fields = json!({
            "from_model":from.map(|m| &m.id),
            "to_model": target.id,
            "requested_model":target.id,
            "from_provider":from.map(|m| &m.provider),
            "to_provider":target.provider,
            "source":"picker",
            "context_tokens":preview.context_tokens,
            "prompt_cache_warm":preview.prompt_cache_warm,
            "cache_ttl":preview.cache_ttl.map(|seconds| match seconds { 300 => "5m".to_owned(), 3600 => "1h".to_owned(), other => format!("{other}s") }),
            "estimated_cache_write_usd":preview.cache_write_usd,
            "pricing":preview.cache_write_usd.map_or("unknown", |_| "catalog"),
        });
        let request = Request {
            event,
            subject: Some(target.id.clone()),
            fields: fields.as_object().cloned().unwrap_or_default(),
            tool: None,
        };
        let answer = self.run_hooks(hooks, &facts, &request).await;
        if event == HookEvent::PostModelSwitch {
            return Ok(answer.context);
        }
        if let Some(reason) = answer.decision.block.or_else(|| {
            answer
                .decision
                .stop
                .map(|reason| reason.unwrap_or_else(|| "PreModelSwitch stopped the switch.".into()))
        }) {
            return Err(refused(reason));
        }
        match answer.decision.permission {
            Some(Permission::Deny) => {
                Err(refused(answer.decision.permission_reason.unwrap_or_else(
                    || "PreModelSwitch denied the model switch.".into(),
                )))
            }
            Some(Permission::Ask) => {
                let from = from.map_or_else(|| "—".into(), |m| format!("{}/{}", m.provider, m.id));
                let to = format!("{}/{}", target.provider, target.id);
                self.confirm_model_switch(id, from, to, answer.decision.permission_reason, cancel)
                    .await?;
                Ok(None)
            }
            Some(Permission::Allow) | None => Ok(None),
        }
    }

    async fn confirm_model_switch(
        &self,
        id: &str,
        from: String,
        to: String,
        reason: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<(), ErrorObject> {
        let session = self.session(id)?;
        let services = self.services()?;
        let card = ApprovalRequest {
            request_id: crate::sessions::new_session_id().map_err(|e| e.to_error_object())?,
            session_id: id.to_owned(),
            revision: 1,
            connection_epoch: 0,
            tool: "PreModelSwitch".into(),
            kind: ApprovalKind::Question,
            questions: vec![Question {
                question: reason
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| format!("{from} → {to}")),
                header: Some("PreModelSwitch".into()),
                options: vec![
                    QuestionOption {
                        label: to.clone(),
                        description: None,
                        default: None,
                    },
                    QuestionOption {
                        label: from,
                        description: None,
                        default: None,
                    },
                ],
                multi_select: None,
            }],
            command: None,
            cwd: None,
            path: None,
            diff: None,
            rules: Vec::new(),
            directory: None,
            protected_path: None,
            plan: None,
            subagent: None,
            sandbox: None,
            domain: None,
            notification_allow: false,
            review: None,
            elicitation: None,
        };
        let (tx, rx) = oneshot::channel();
        if !super::policy::post_local_card(&session, services, &card, tx) {
            return Err(refused("The model switch could not be confirmed."));
        }
        let answer = tokio::select! { biased; ()=cancel.cancelled()=>None, result=rx=>result.ok() };
        let Some((answer, ack)) = answer else {
            super::policy::withdraw_local_card(&session, services, &card);
            return Err(refused("The model switch was cancelled."));
        };
        let allowed = answer.decision == ApprovalDecision::AllowOnce
            && answer
                .answers
                .first()
                .is_some_and(|a| a.other.is_none() && a.selected.as_slice() == [to]);
        let _ = ack.send(Ok(()));
        if allowed {
            Ok(())
        } else {
            Err(refused("The model switch was declined."))
        }
    }
}
