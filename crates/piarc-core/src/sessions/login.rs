//! Provider sign-in (architecture section 5.4, T29). A settings Host runs Pi's
//! `ModelRuntime.login` (`models/login/start`) for one sign-in at a time; its interactions
//! (`ui/loginInteraction`: the authorization URL, a device code, progress, questions) go to the
//! client on `core/login`, and the client's answers come back through [`Hub::answer_login`]. The
//! authorization page opens in the system browser; the provider's flow receives the redirect on
//! its own loopback port. The credential reaches the vault through the Host's credential store,
//! never through Core's events or this module. Cancel, refusal and expiry end the request with
//! an error the client shows.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_host::{InboundHandler, Peer};
use piarc_ports::BoxFuture;
use piarc_protocol::models::{
    LoginCancelParams, LoginInteraction, LoginInteractionParams, LoginStartParams, LogoutParams,
    ModelsLoginCancel, ModelsLoginStart, ModelsLogout,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{Hub, host_error, lock};
use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::secrets::SecretsService;

/// How long a sign-in may wait for the user (a device code's usual lifetime).
pub(crate) const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

struct Active {
    id: String,
    provider: String,
    cancel: CancellationToken,
    /// The question on screen and where its answer goes; `None` answers "cancelled".
    prompt: Option<oneshot::Sender<Option<String>>>,
}

/// The sign-in in progress, if any.
#[derive(Default)]
pub(crate) struct Logins {
    active: Mutex<Option<Active>>,
}

pub(crate) async fn emit(events: &EventSender, payload: Value) {
    if let Ok(event) = Event::from_json(RouteKey::login(), &payload) {
        // Only a Core shutting down refuses it.
        let _ = events.send(event).await;
    }
}

fn cancelled() -> ErrorObject {
    ErrorObject::new(ErrorKind::Cancelled, "The sign-in was cancelled", false)
}

impl Logins {
    pub(crate) fn begin(&self, provider: &str) -> Result<(String, CancellationToken)> {
        let mut active = lock(&self.active);
        if active.is_some() {
            return Err(Error::Feature {
                kind: ErrorKind::Busy,
                retryable: true,
                message: "Another sign-in is in progress".into(),
                details: None,
            });
        }
        let id = super::new_session_id()?;
        let cancel = CancellationToken::new();
        *active = Some(Active {
            id: id.clone(),
            provider: provider.to_owned(),
            cancel: cancel.clone(),
            prompt: None,
        });
        Ok((id, cancel))
    }

    pub(crate) fn end(&self, id: &str) {
        let mut active = lock(&self.active);
        if active.as_ref().is_some_and(|a| a.id == id) {
            *active = None;
        }
    }

    /// The user's answer to the question on screen; `None` cancels the sign-in.
    pub(crate) fn answer(&self, id: &str, value: Option<String>) -> Result<()> {
        let mut active = lock(&self.active);
        let Some(login) = active.as_mut().filter(|a| a.id == id) else {
            return Err(Error::InvalidArgument {
                field: "loginId",
                reason: "no such sign-in in progress".into(),
            });
        };
        match value {
            Some(text) => {
                if let Some(prompt) = login.prompt.take() {
                    // The flow may have finished meanwhile: nobody waits for the answer.
                    let _ = prompt.send(Some(text));
                }
            }
            None => login.cancel.cancel(),
        }
        Ok(())
    }

    /// `ui/loginInteraction`: shows the step; a question waits for the user's answer. A later
    /// question of the same sign-in replaces the one on screen.
    pub(crate) async fn interact(
        &self,
        events: &EventSender,
        p: LoginInteractionParams,
    ) -> std::result::Result<Value, ErrorObject> {
        let (receiver, cancel) = {
            let mut active = lock(&self.active);
            let Some(login) = active
                .as_mut()
                .filter(|a| a.id == p.login_id && a.provider == p.provider)
            else {
                return Err(ErrorObject::new(
                    ErrorKind::InvalidParams,
                    "no such sign-in in progress",
                    false,
                ));
            };
            // A new question replaces the one on screen; status lines and links do not (a
            // flow may race a pasted code against its loopback callback).
            let receiver = matches!(p.interaction, LoginInteraction::Prompt { .. }).then(|| {
                if let Some(previous) = login.prompt.take() {
                    // The replaced question's waiter may be gone already.
                    let _ = previous.send(None);
                }
                let (sender, receiver) = oneshot::channel();
                login.prompt = Some(sender);
                receiver
            });
            (receiver, login.cancel.clone())
        };
        emit(
            events,
            json!({
                "loginId": p.login_id, "provider": p.provider, "state": "interaction",
                "interaction": p.interaction,
            }),
        )
        .await;
        let Some(receiver) = receiver else {
            return Ok(json!({}));
        };
        tokio::select! {
            answer = receiver => match answer {
                Ok(Some(value)) => Ok(json!({ "value": value })),
                _ => Err(cancelled()),
            },
            () = cancel.cancelled() => Err(cancelled()),
        }
    }
}

/// The last `core/login` event of a sign-in: `succeeded`, `cancelled` or `failed` with the
/// message (without the method prefix the bridge adds).
pub(crate) fn end_payload(
    id: &str,
    provider: &str,
    error: Option<&Error>,
    cancel: &CancellationToken,
) -> Value {
    let Some(error) = error else {
        return json!({"loginId": id, "provider": provider, "state": "succeeded"});
    };
    let error = error.to_error_object();
    let state = if error.data.kind == ErrorKind::Cancelled || cancel.is_cancelled() {
        "cancelled"
    } else {
        "failed"
    };
    let message = error
        .message
        .split_once(" failed: ")
        .filter(|(method, _)| method.contains('/'))
        .map_or(error.message.as_str(), |(_, rest)| rest)
        .to_owned();
    json!({"loginId": id, "provider": provider, "state": state, "message": message})
}

/// What answers the settings Host during a sign-in: the vault and `ui/loginInteraction`.
pub(crate) struct SettingsInbound {
    pub secrets: SecretsService,
    pub logins: Arc<Logins>,
    pub events: EventSender,
}

impl InboundHandler for SettingsInbound {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, std::result::Result<Value, ErrorObject>> {
        if SecretsService::handles(&method) {
            let secrets = self.secrets.clone();
            return Box::pin(async move { secrets.dispatch(&method, params, peer).await });
        }
        if method == "ui/loginInteraction" {
            let (logins, events) = (Arc::clone(&self.logins), self.events.clone());
            return Box::pin(async move {
                let p: LoginInteractionParams = serde_json::from_value(Value::Object(params))
                    .map_err(|_| {
                        ErrorObject::new(
                            ErrorKind::InvalidParams,
                            "malformed ui/loginInteraction",
                            false,
                        )
                    })?;
                logins.interact(&events, p).await
            });
        }
        Box::pin(async move {
            Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not answer {method} on the settings Host"),
                false,
            ))
        })
    }
}

impl Hub {
    /// Signs in to `provider`; resolves once the credential is in the vault. Progress and
    /// questions go to `core/login` with the sign-in's id.
    pub async fn login(&self, provider: String) -> Result<Value> {
        let _writer = self.ctx.provider_writer.lock().await;
        crate::providers::ensure_pi_defaults(self.ctx.storage.dirs().data())?;
        let (id, cancel) = self.ctx.logins.begin(&provider)?;
        let events = &self.ctx.events;
        emit(
            events,
            json!({"loginId": id, "provider": provider, "state": "started"}),
        )
        .await;
        let result = self.run_login(&id, &provider, &cancel).await;
        self.ctx.logins.end(&id);
        emit(
            events,
            end_payload(&id, &provider, result.as_ref().err(), &cancel),
        )
        .await;
        result?;
        self.reload_models(
            self.ctx
                .catalog_network
                .load(std::sync::atomic::Ordering::Acquire),
        )
        .await?;
        Ok(json!({ "loginId": id }))
    }

    async fn run_login(&self, id: &str, provider: &str, cancel: &CancellationToken) -> Result<()> {
        let inbound = Arc::new(SettingsInbound {
            secrets: self.ctx.secrets.clone(),
            logins: Arc::clone(&self.ctx.logins),
            events: self.ctx.events.clone(),
        });
        let host = self.settings_host_with(inbound).await?;
        let call = host.call_within::<ModelsLoginStart>(
            LoginStartParams {
                login_id: id.to_owned(),
                provider: provider.to_owned(),
            },
            LOGIN_TIMEOUT,
        );
        tokio::pin!(call);
        let outcome = tokio::select! {
            outcome = &mut call => outcome,
            () = cancel.cancelled() => {
                let _ = host
                    .call::<ModelsLoginCancel>(LoginCancelParams { login_id: id.to_owned() })
                    .await;
                call.await
            }
        };
        host.shutdown().await;
        outcome.map(|_| ()).map_err(host_error)
    }

    /// The user's answer to the sign-in's question; `None` cancels the sign-in.
    pub fn answer_login(&self, id: &str, value: Option<String>) -> Result<()> {
        self.ctx.logins.answer(id, value)
    }

    /// Signs out of `provider`: its stored credential is removed.
    pub async fn logout(&self, provider: String) -> Result<Value> {
        let _writer = self.ctx.provider_writer.lock().await;
        let host = self.settings_host().await?;
        let result = host
            .call::<ModelsLogout>(LogoutParams { provider })
            .await
            .map_err(host_error);
        host.shutdown().await;
        result?;
        self.reload_models(
            self.ctx
                .catalog_network
                .load(std::sync::atomic::Ordering::Acquire),
        )
        .await?;
        Ok(json!({}))
    }
}
