//! T29's sign-in actions: Core's public `login`, `answer_login` and `logout`, the `core/login`
//! events, and the mock authorization server (the runner plays the user's browser).
use std::time::Duration;

use piarc_core::providers::Operation;
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::{Driver, MockProvider, call, write_json};
use crate::auth_server::AuthBehavior;
use crate::l2::format::ScenarioSpec;
use crate::l2::login_spec::{SignInAction, SignInBehavior};

/// The test provider's id (`--test-oauth-provider`).
pub(super) const OAUTH_PROVIDER: &str = "piarc-test-oauth";

/// A plain HTTP GET: the status and the `location` header.
pub(super) async fn get(url: &str) -> Result<(u16, Option<String>), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("not an http URL: {url}"))?;
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, "/".to_owned()), |(a, p)| (a, format!("/{p}")));
    let mut stream = tokio::net::TcpStream::connect(authority)
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let request = format!("GET {path} HTTP/1.1\r\nhost: {authority}\r\nconnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let mut text = String::new();
    stream
        .read_to_string(&mut text)
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let location = text.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.eq_ignore_ascii_case("location")
            .then(|| value.trim().to_owned())
    });
    Ok((status, location))
}

impl Driver<'_> {
    /// The first `core/login` event that `pred` accepts, waiting for it.
    pub(super) async fn login_event(
        &self,
        what: &str,
        pred: impl Fn(&Value) -> bool,
    ) -> Result<Value, String> {
        let wait = async {
            loop {
                let notified = self.events.arrived.notified();
                if let Some((_, event)) = self
                    .events
                    .all()
                    .into_iter()
                    .find(|(route, v)| route == "core/login" && pred(v))
                {
                    return event;
                }
                notified.await;
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait)
            .await
            .map_err(|_| format!("no {what} on core/login"))
    }

    async fn signed_in(&self) -> Result<bool, String> {
        let view = call(
            |done| self.core.provider_op(Operation::List, done),
            "listing providers",
        )
        .await?;
        Ok(view["loginProviders"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["id"] == OAUTH_PROVIDER && p["signedIn"] == true))
    }

    pub(super) async fn sign_in(&mut self, spec: &SignInAction) -> Result<(), String> {
        let auth = self
            .env
            .auth
            .as_ref()
            .ok_or("sign_in needs an `oauth` section")?;
        auth.set_behavior(match spec.behavior {
            SignInBehavior::Approve => AuthBehavior::Approve,
            SignInBehavior::Deny => AuthBehavior::Deny,
            SignInBehavior::Expire => AuthBehavior::Expire,
        });
        let seen: Vec<Value> = self
            .events
            .all()
            .into_iter()
            .filter(|(r, _)| r == "core/login")
            .map(|(_, v)| v)
            .collect();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.core
            .login(OAUTH_PROVIDER.into(), move |result| {
                let _ = tx.send(result);
            })
            .map_err(|e| format!("login: {e}"))?;
        let fresh = |v: &Value| !seen.contains(v);
        let step = self
            // Progress lines may arrive before the step the user acts on.
            .login_event("a sign-in step", |v| {
                v["state"] == "interaction"
                    && matches!(
                        v["interaction"]["type"].as_str(),
                        Some("authUrl" | "deviceCode" | "prompt")
                    )
                    && fresh(v)
            })
            .await?;
        let id = step["loginId"].as_str().unwrap_or_default().to_owned();
        if spec.cancel {
            self.core
                .answer_login(&id, None)
                .map_err(|e| format!("cancel: {e}"))?;
        } else if step["interaction"]["type"] == "authUrl" {
            let page = step["interaction"]["url"].as_str().unwrap_or_default();
            let (_, target) = get(page).await?;
            get(&target.ok_or("the authorization page did not redirect")?).await?;
        }
        let result = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| "the sign-in did not end".to_owned())?
            .map_err(|_| "Core dropped the sign-in".to_owned())?;
        let end = self
            .login_event("the sign-in's end", |v| {
                v["loginId"] == id.as_str()
                    && matches!(
                        v["state"].as_str(),
                        Some("succeeded" | "failed" | "cancelled")
                    )
            })
            .await?;
        if end["state"] != spec.outcome.state() {
            return Err(format!(
                "expected {}, got {end} ({result:?})",
                spec.outcome.state()
            ));
        }
        if let Some(text) = &spec.message
            && !end["message"]
                .as_str()
                .is_some_and(|m| m.contains(text.as_str()))
        {
            return Err(format!("the message lacks {text:?}: {end}"));
        }
        let expected = spec.outcome.state() == "succeeded";
        if self.signed_in().await? != expected {
            return Err(format!("signedIn should be {expected} after the sign-in"));
        }
        Ok(())
    }

    pub(super) async fn sign_out(&mut self) -> Result<(), String> {
        call(
            |done| self.core.logout(OAUTH_PROVIDER.into(), done),
            "signing out",
        )
        .await?;
        if self.signed_in().await? {
            return Err("still signed in after signing out".to_owned());
        }
        Ok(())
    }
}

/// The scenario's mock authorization server and the test provider's file, when it has an
/// `oauth` section.
pub(super) async fn oauth_setup(
    spec: &ScenarioSpec,
    mocks: &BTreeMap<String, MockProvider>,
    root: &Path,
) -> Result<(Option<crate::auth_server::MockAuthServer>, Option<PathBuf>), String> {
    let Some(oauth) = spec.oauth else {
        return Ok((None, None));
    };
    let auth = crate::auth_server::MockAuthServer::start(AuthBehavior::Approve, 0)
        .await
        .map_err(|e| format!("authorization server: {e}"))?;
    let base = mocks
        .values()
        .next()
        .map(MockProvider::openai_base_url)
        .unwrap_or_default();
    let file = root.join("oauth-provider.json");
    let flow = match oauth.flow {
        crate::l2::login_spec::OAuthFlow::AuthorizationCode => "authorizationCode",
        crate::l2::login_spec::OAuthFlow::DeviceCode => "deviceCode",
    };
    write_json(
        &file,
        &json!({
            "id": OAUTH_PROVIDER, "baseUrl": base, "flow": flow,
            "tokenUrl": auth.token_url(), "authorizeUrl": auth.authorize_url(),
            "deviceUrl": auth.device_url(),
            "models": [{ "id": "oauth-model", "contextWindow": 32_000, "maxTokens": 1024 }],
        }),
    )?;
    Ok((Some(auth), Some(file)))
}
