//! One mock conversation with the Agent Host of a packaged app (S6, T12): the test entry of
//! packaged builds. Only the `testing` build of `piarc-napi` exports it
//! (`CoreRuntime.agentHostProbe`); the L4 test `apps/desktop/e2e/agent-host.e2e.ts` drives it
//! with the model pointed at the mock provider through `<data dir>/pi/models.json`.
//!
//! The probe starts the Agent Host exactly as a packaged app does ([`start_bundled`]: the
//! bundled Node, `PI_PACKAGE_DIR`, the minimal environment and, on macOS, `sandbox-exec` with
//! the permissive profile), opens one session in the workspace, sends one prompt, collects the
//! session's notifications until `turn/completed` and shuts the Agent Host down. Core's side
//! answers like production: `trust/get` (the workspace is trusted, so project resources load),
//! delegated tool I/O through [`ToolIo`], credentials through a [`SecretsService`] whose master
//! key lives in memory. There is no user to ask, so the probe approves every tool preflight
//! (`policy/evaluate`) and denies no tool as a whole (`policy/tools`) itself, as the Agent Host
//! test harness of `piarc-testkit` does; the production approval ledger and rules are covered by
//! the session tests and the L2 scenarios. `mcp/servers` lists the servers of
//! `<data dir>/settings.json` only (T36).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_ports::BoxFuture;
use piarc_protocol::session::{ModelRef, SessionCreateParams};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::agent_host::{
    BundledRuntime, HostEvent, HostEvents, InboundHandler, Peer, start_bundled,
};
use crate::error::{Error, Result};
use crate::secrets::{MemorySecretStore, SecretsConfig, SecretsService, test_master_key_name};
use crate::tool_io::{ToolIo, ToolIoConfig};

/// What the probe runs.
#[derive(Debug, Clone)]
pub struct ProbeOptions {
    /// The app's resources directory (Electron's `process.resourcesPath`).
    pub resources_dir: PathBuf,
    /// Workspace root: the session's cwd and a writable directory of the Seatbelt profile.
    pub workspace: PathBuf,
    /// PiArc data directory for the Agent Host (`pi/models.json` names the mock provider).
    pub data_dir: PathBuf,
    /// Model of the session.
    pub model: ModelRef,
    /// The prompt; a `[[piarc-scenario:<id>]]` marker selects the mock scenario.
    pub prompt: String,
    /// Upper bound of the whole conversation.
    pub timeout: Duration,
}

/// What happened, for the test to assert on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// Pi version from the handshake.
    pub pi_version: String,
    /// Process id of the Agent Host (the `node` that `sandbox-exec` replaced itself with).
    pub pid: Option<u32>,
    /// The session id.
    pub session_id: String,
    /// The `turn/completed` payload.
    pub turn: Value,
    /// `item/completed` items of the session, in order.
    pub items: Vec<Value>,
    /// Methods of every session notification, in order.
    pub methods: Vec<String>,
    /// Delegated `fs/*` and `exec/*` requests Core answered.
    pub tool_io: Vec<ToolIoCall>,
}

/// One delegated tool request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolIoCall {
    /// `fs/read`, `exec/run`, ...
    pub method: String,
    /// The canonical tool that asked.
    pub tool: Option<String>,
    /// The error kind when Core refused.
    pub error: Option<String>,
}

struct ProbeCore {
    workspace: String,
    /// `<data dir>/settings.json`: the MCP servers the probe answers `mcp/servers` with.
    settings_file: PathBuf,
    io: ToolIo,
    secrets: SecretsService,
    calls: Arc<Mutex<Vec<ToolIoCall>>>,
}

impl InboundHandler for ProbeCore {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, std::result::Result<Value, ErrorObject>> {
        if method == "trust/get" {
            let trusted = params.get("path").and_then(Value::as_str) == Some(&self.workspace);
            return Box::pin(async move { Ok(json!({ "trusted": trusted })) });
        }
        if method == "policy/evaluate" {
            return Box::pin(async { Ok(json!({ "allowed": true })) });
        }
        if method == "policy/recover" {
            return Box::pin(async { Ok(json!({})) });
        }
        if method == "policy/tools" {
            return Box::pin(async { Ok(json!({ "denied": [] })) });
        }
        if method == "mcp/servers" {
            // The MCP servers of `<data dir>/settings.json` (T36), as the user scope of a real
            // Core: the probe has no database or trust store for the other sources.
            let io = self.io.clone();
            let file = self.settings_file.clone();
            return Box::pin(async move {
                let result = crate::mcp::settings_file_servers(&io, &file).await;
                serde_json::to_value(result)
                    .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))
            });
        }
        if SecretsService::handles(&method) {
            let secrets = self.secrets.clone();
            return Box::pin(async move { secrets.dispatch(&method, params, peer).await });
        }
        if !ToolIo::handles(&method) {
            return Box::pin(async move {
                Err(ErrorObject::new(
                    ErrorKind::MethodNotFound,
                    format!("the probe does not answer {method}"),
                    false,
                ))
            });
        }
        let tool = params
            .get("origin")
            .and_then(|o| o.get("tool"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let io = self.io.clone();
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            let result = io.dispatch(&method, params, peer).await;
            let error = result.as_ref().err().map(|e| format!("{:?}", e.data.kind));
            calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(ToolIoCall {
                    method,
                    tool,
                    error,
                });
            result
        })
    }
}

fn failed(what: &str, reason: impl std::fmt::Display) -> Error {
    Error::Internal {
        reason: format!("agent host probe: {what}: {reason}"),
    }
}

/// Runs the probe described in the module documentation.
///
/// # Errors
///
/// [`Error::BundledRuntime`] when the app's Agent Host files are incomplete; [`Error::Internal`]
/// when the Agent Host does not connect, a call fails or the conversation exceeds the timeout.
pub async fn run(options: ProbeOptions) -> Result<ProbeReport> {
    let runtime = BundledRuntime::locate(&options.resources_dir)?;
    let core = Arc::new(ProbeCore {
        workspace: options.workspace.to_string_lossy().into_owned(),
        settings_file: options.data_dir.join("settings.json"),
        io: ToolIo::new(ToolIoConfig {
            home: Some(options.data_dir.join("test-home")),
            ..ToolIoConfig::new(options.data_dir.clone())
        }),
        secrets: SecretsService::new(
            SecretsConfig::with_master_key(&options.data_dir, test_master_key_name("s6-probe")),
            Arc::new(MemorySecretStore::new()),
        ),
        calls: Arc::default(),
    });
    let (supervisor, mut events) = start_bundled(
        &runtime,
        options.workspace.clone(),
        options.data_dir.clone(),
        Arc::clone(&core) as Arc<dyn InboundHandler>,
    )?;
    let conversation = converse(&supervisor, &mut events, &core, &options);
    let outcome = tokio::time::timeout(options.timeout, conversation).await;
    supervisor.shutdown().await;
    outcome.map_err(|_| failed("timed out", format!("{:?}", options.timeout)))?
}

async fn converse(
    supervisor: &crate::agent_host::HostSupervisor,
    events: &mut HostEvents,
    core: &ProbeCore,
    options: &ProbeOptions,
) -> Result<ProbeReport> {
    let (pi_version, pid) = loop {
        match events.recv().await {
            Some(HostEvent::Connected {
                pi_version, pid, ..
            }) => break (pi_version, pid),
            Some(HostEvent::Exited { reason, status, .. }) => {
                return Err(failed(
                    "the Agent Host exited before the handshake",
                    format!("{reason:?}, {status:?}"),
                ));
            }
            Some(_) => {}
            None => return Err(failed("events", "the supervisor is gone")),
        }
    };
    let cwd = options.workspace.to_string_lossy().into_owned();
    let opened = supervisor
        .create_session(
            SessionCreateParams::new(cwd.clone()).with_model(Some(options.model.clone())),
        )
        .await
        .map_err(|e| failed("session/create", e))?;
    let session_id = opened.session_id;
    let workspace = Path::new(&cwd);
    core.io
        .open_session(&session_id.0, workspace, workspace)
        .map_err(|e| failed("registering the workspace", e.message))?;
    let accepted = supervisor
        .prompt(&session_id, "s6-probe", &options.prompt)
        .await
        .map_err(|e| failed("session/prompt", e))?;
    let mut methods = Vec::new();
    let mut items = Vec::new();
    let turn = loop {
        match events.recv().await {
            Some(HostEvent::Notification { notification, .. })
                if notification.params.header.session_id == session_id =>
            {
                let payload = Value::Object(notification.params.payload.clone());
                methods.push(notification.method.clone());
                if notification.method == "item/completed" {
                    items.push(payload["item"].clone());
                } else if notification.method == "turn/completed"
                    && payload["turnId"] == accepted.turn_id.0.as_str()
                {
                    break payload;
                }
            }
            Some(HostEvent::Exited { reason, status, .. }) => {
                return Err(failed(
                    "the Agent Host exited during the turn",
                    format!("{reason:?}, {status:?}"),
                ));
            }
            Some(_) => {}
            None => return Err(failed("events", "the supervisor is gone")),
        }
    };
    let tool_io = core
        .calls
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    Ok(ProbeReport {
        pi_version,
        pid,
        session_id: session_id.0,
        turn,
        items,
        methods,
        tool_io,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Agent Host asks `policy/tools` before every run (T23). The probe has no rules, so it
    /// removes no tool instead of failing the call.
    #[tokio::test]
    async fn the_probe_denies_no_tool_as_a_whole() {
        let data = std::env::temp_dir().join(crate::sessions::new_session_id().expect("id"));
        let core = ProbeCore {
            workspace: String::new(),
            settings_file: data.join("settings.json"),
            io: ToolIo::new(ToolIoConfig::new(data.clone())),
            secrets: SecretsService::new(
                SecretsConfig::with_master_key(&data, test_master_key_name("probe-tools")),
                Arc::new(MemorySecretStore::new()),
            ),
            calls: Arc::default(),
        };
        let (peer, _frames) = Peer::channel(1);
        let mut params = Map::new();
        params.insert("sessionId".into(), json!("main"));
        params.insert("tools".into(), json!(["Read", "Bash"]));
        let answer = core.handle("policy/tools".into(), params, peer).await;
        assert_eq!(answer.expect("answered"), json!({ "denied": [] }));
        let calls = core.calls.lock().expect("calls");
        assert!(calls.iter().all(|call| call.error.is_none()), "{calls:?}");
    }
    /// The Agent Host's MCP pool asks `mcp/servers` when it starts (T36): the probe lists the
    /// servers of `<data dir>/settings.json`, so the packaged app's L4 can start one with the
    /// bundled `npx`.
    #[tokio::test]
    async fn the_probe_lists_the_mcp_servers_of_the_settings_file() {
        let data = std::env::temp_dir().join(crate::sessions::new_session_id().expect("id"));
        std::fs::create_dir_all(&data).expect("data dir");
        std::fs::write(
            data.join("settings.json"),
            json!({ "mcpServers": {
                "probe": { "command": "npx", "args": ["-y", "probe-server"] },
                "legacy": { "type": "sse", "url": "https://legacy.example/sse" }
            } })
            .to_string(),
        )
        .expect("settings");
        let core = ProbeCore {
            workspace: String::new(),
            settings_file: data.join("settings.json"),
            io: ToolIo::new(ToolIoConfig::new(data.clone())),
            secrets: SecretsService::new(
                SecretsConfig::with_master_key(&data, test_master_key_name("probe-mcp")),
                Arc::new(MemorySecretStore::new()),
            ),
            calls: Arc::default(),
        };
        let (peer, _frames) = Peer::channel(1);
        let answer = core
            .handle("mcp/servers".into(), Map::new(), peer)
            .await
            .expect("answered");
        let _ = std::fs::remove_dir_all(&data);
        let servers = answer["servers"].as_array().expect("servers");
        let probe = servers
            .iter()
            .find(|s| s["name"] == "probe")
            .expect("probe");
        assert_eq!(probe["scope"], "user");
        assert_eq!(probe["availability"], "ready");
        assert_eq!(probe["stdio"]["command"], "npx");
        let legacy = servers
            .iter()
            .find(|s| s["name"] == "legacy")
            .expect("legacy");
        assert_eq!(legacy["availability"], "unsupported");
        assert!(answer["env"].is_object(), "{answer}");
    }
}
