//! T36's MCP parts of a scenario: the HTTP MCP fixture servers (`mcp_http`) and the
//! `mcp_sign_in` action, which signs in through Core's `mcp_login` with the runner as the
//! user's browser.
use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use super::Driver;
use super::login::get;
use crate::l2::format::{McpSignInAction, ScenarioSpec};
use crate::mcp_server::MockMcpServer;

/// Starts the scenario's HTTP MCP fixture servers.
pub(super) async fn start_servers(
    spec: &ScenarioSpec,
) -> Result<BTreeMap<String, MockMcpServer>, String> {
    let mut servers = BTreeMap::new();
    for (name, server) in &spec.mcp_http {
        let started = MockMcpServer::start(name, server.oauth)
            .await
            .map_err(|e| format!("MCP server `{name}`: {e}"))?;
        servers.insert(name.clone(), started);
    }
    Ok(servers)
}

impl Driver<'_> {
    pub(super) async fn mcp_sign_in(&mut self, spec: &McpSignInAction) -> Result<(), String> {
        if !self.env.mcp_http.contains_key(&spec.server) {
            return Err(format!(
                "mcp_sign_in: no `mcp_http` server `{}`",
                spec.server
            ));
        }
        let provider = format!("mcp:{}", spec.server);
        let seen: Vec<Value> = self
            .events
            .all()
            .into_iter()
            .filter(|(r, _)| r == "core/login")
            .map(|(_, v)| v)
            .collect();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.core
            .mcp_login(
                self.env.workspace.clone(),
                spec.server.clone(),
                move |result| {
                    let _ = tx.send(result);
                },
            )
            .map_err(|e| format!("mcp_login: {e}"))?;
        let step = self
            .login_event("the authorization page", |v| {
                v["provider"] == provider.as_str()
                    && v["interaction"]["type"] == "authUrl"
                    && !seen.contains(v)
            })
            .await?;
        let page = step["interaction"]["url"].as_str().unwrap_or_default();
        let (_, target) = get(page).await?;
        get(&target.ok_or("the authorization page did not redirect")?).await?;
        let id = step["loginId"].as_str().unwrap_or_default().to_owned();
        let _ = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| "the sign-in did not end".to_owned())?;
        let end = self
            .login_event("the sign-in's end", |v| {
                v["loginId"] == id.as_str()
                    && matches!(
                        v["state"].as_str(),
                        Some("succeeded" | "failed" | "cancelled")
                    )
            })
            .await?;
        if end["state"] == spec.outcome.state() {
            Ok(())
        } else {
            Err(format!(
                "mcp_sign_in {}: expected {}, got {end}",
                spec.server,
                spec.outcome.state()
            ))
        }
    }
}
