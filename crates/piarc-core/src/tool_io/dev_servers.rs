//! Development servers (ADR-0092, design addendum `docs/architecture/addenda/browser.md` B4):
//! the launch configurations of a session's project, started as background tasks of kind
//! `devServer`.
//!
//! - **Reading** (`launchConfigs`): `piarc_config::launch::load` on the session's project
//!   (settings and trust come from there, T35); `${workspaceFolder}` and the directory are the
//!   session's file root.
//! - **Starting** needs a trusted project (ADR-0025). The user's start from the panel runs at
//!   once; the agent's (`startServer` in a `Browser` script) asks once per session and
//!   configuration fingerprint (`policy/dev_server.rs`). A server runs outside the sandbox with
//!   the session's command environment and the process-tree launcher, like a background `Bash`
//!   command; `autoPort` moves a busy port up to [`DevServerLimits::port_tries`] ports.
//! - **Readiness**: every [`DevServerLimits::probe_interval`] Core connects to `127.0.0.1` and
//!   `::1` on the port; once one answers and the listening process belongs to the task's tree
//!   (`piarc_exec::listeners`) the server is `ready`. It is `failed` when the task ends first or
//!   [`DevServerLimits::ready_timeout`] passes (then the task is stopped); a failed server
//!   carries its last 20 output lines. Stopping ends the whole tree.
//! - Every change goes to the desktop client as a `servers` event on `core/browser`.
//! - **`autoVerify`** (default on): when the agent writes a front-end file under a running
//!   server's directory, the session gets one `browserVerify` reminder per turn.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use piarc_config::launch::{self, LaunchConfig};
use piarc_protocol::browser::BrowserClientEvent;
use piarc_protocol::context::ReminderType;
use piarc_protocol::dev_server::{
    DevServerFailure, DevServerStart, DevServerStarter, DevServerState, DevServerStatus,
    LaunchConfigView, LaunchView,
};
use piarc_protocol::exec::{ExecRunParams, ExecShell};
use piarc_protocol::session::SessionId;
use piarc_protocol::tasks::{TaskKind, TaskStatus};
use piarc_protocol::{ErrorKind, ErrorObject};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::exec::background::{Judge, start_task};
use super::exec::{self, Wrap};
use super::policy::dev_server::{ServerAsk, ServerDecision, refused_start};
use super::{SessionIo, ToolIo, lock};
use crate::events::Event;
use crate::route::RouteKey;
use crate::tasks::{NewTask, Notice, StopBy};

/// Lines of output a failed server carries.
pub const FAILURE_LOG_LINES: usize = 20;

/// Extensions of the files whose change makes the agent look at the page (`autoVerify`).
const FRONT_END: [&str; 17] = [
    "html", "htm", "css", "scss", "sass", "less", "styl", "js", "jsx", "mjs", "cjs", "ts", "tsx",
    "vue", "svelte", "astro", "mdx",
];

/// The timing of development servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevServerLimits {
    /// Between two readiness probes (250 ms).
    pub probe_interval: Duration,
    /// How long a server may take to listen (180 s).
    pub ready_timeout: Duration,
    /// Ports `autoPort` tries above a busy one (20).
    pub port_tries: u16,
    /// How long one connection attempt of a probe may take.
    pub connect_timeout: Duration,
}

impl Default for DevServerLimits {
    fn default() -> Self {
        Self {
            probe_interval: Duration::from_millis(250),
            ready_timeout: Duration::from_secs(180),
            port_tries: 20,
            connect_timeout: Duration::from_millis(200),
        }
    }
}

/// One server a session started.
struct Server {
    state: DevServerState,
    workspace: String,
    /// The directory it runs in, canonical: `autoVerify` watches writes below it.
    dir: PathBuf,
    auto_verify: bool,
    /// The user or the agent stopped it: its end is not a failure.
    stopping: bool,
    changed: watch::Sender<DevServerStatus>,
}

#[derive(Default)]
struct Registry {
    /// Main session → its servers, in start order.
    servers: HashMap<String, Vec<Server>>,
    /// Main session → fingerprints the user allowed the agent to start.
    allowed: HashMap<String, HashSet<String>>,
    /// Counts `browserVerify` reminders, so each has its own source.
    reminders: u64,
}

/// The servers of every session (one per Core, in the tool I/O).
#[derive(Default)]
pub(crate) struct DevServers {
    registry: Mutex<Registry>,
    limits: Mutex<DevServerLimits>,
    /// Sends the `servers` snapshots one at a time, so the last one sent is the latest.
    publishing: tokio::sync::Mutex<()>,
    /// Held from the last check that a server is not running to its registration: two
    /// starts of one configuration start it once.
    starting: tokio::sync::Mutex<()>,
}

fn not_found(name: &str) -> ErrorObject {
    let mut error = ErrorObject::new(
        ErrorKind::NotFound,
        format!("the project has no launch configuration named \"{name}\""),
        false,
    );
    error.data.details = Some(serde_json::json!({ "name": name }));
    error
}

fn untrusted() -> ErrorObject {
    let mut error = ErrorObject::new(
        ErrorKind::PermissionDenied,
        "the project is not trusted: its launch configurations cannot run",
        false,
    );
    error.data.details = Some(serde_json::json!({ "reason": "untrusted" }));
    error
}

impl ToolIo {
    /// Changes the timing of development servers (tests).
    pub fn set_dev_server_limits(&self, limits: DevServerLimits) {
        *lock(&self.dev_servers.limits) = limits;
    }

    fn dev_limits(&self) -> DevServerLimits {
        *lock(&self.dev_servers.limits)
    }

    /// The main session of `session_id` and its I/O.
    fn main_session(
        &self,
        session_id: &str,
    ) -> Result<(String, std::sync::Arc<SessionIo>), ErrorObject> {
        let session = self.session(session_id)?;
        match &session.subagent {
            Some(link) => Ok((link.root_id.clone(), self.session(&link.root_id)?)),
            None => Ok((session_id.to_owned(), session)),
        }
    }

    /// `launchConfigs`: the configurations of the session's project, their problems, whether
    /// they may run, and the servers the session started.
    ///
    /// # Errors
    ///
    /// `sessionNotFound` when the session is not open.
    pub async fn launch_view(&self, session_id: &str) -> Result<LaunchView, ErrorObject> {
        let (owner, s) = self.main_session(session_id)?;
        let project = s.project().to_owned();
        let root = s.scope.root().to_owned();
        let loaded = tokio::task::spawn_blocking(move || launch::load(&project))
            .await
            .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?;
        let trusted = self.project_trusted(&s).await;
        let mut issues: Vec<_> = loaded
            .issues
            .iter()
            .map(launch::LaunchIssue::view)
            .collect();
        for hidden in &loaded.hidden {
            issues.push(piarc_protocol::dev_server::LaunchIssue {
                file: launch::CLAUDE_LAUNCH.to_owned(),
                line: None,
                column: None,
                message: format!(
                    "\"{}\" is hidden by the configuration of the same name in {}",
                    hidden.name,
                    launch::PIARC_LAUNCH
                ),
            });
        }
        Ok(LaunchView {
            configs: loaded
                .configs
                .iter()
                .map(|c| config_view(c, &root))
                .collect(),
            auto_verify: loaded.auto_verify(),
            issues,
            trusted,
            servers: self.servers_of(&owner),
        })
    }

    fn servers_of(&self, owner: &str) -> Vec<DevServerState> {
        lock(&self.dev_servers.registry)
            .servers
            .get(owner)
            .map(|list| list.iter().map(|s| s.state.clone()).collect())
            .unwrap_or_default()
    }

    /// `startDevServer`: starts configuration `name` of the session's project (or answers how
    /// the one already running stands). With `wait`, answers once it is ready or failed.
    ///
    /// # Errors
    ///
    /// `sessionNotFound`; `notFound` for an unknown configuration; `permissionDenied` for an
    /// untrusted project or an agent's start the user refused; `invalidParams` for a directory
    /// outside the session's files; the task cannot start.
    pub async fn start_dev_server(
        &self,
        request: DevServerStart,
    ) -> Result<DevServerState, ErrorObject> {
        let (owner, s) = self.main_session(&request.session_id.0)?;
        if owner != request.session_id.0 {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "start a server through the main session",
                false,
            ));
        }
        if let Some(state) = self.running_server(&owner, &request.name) {
            return self
                .answer(&owner, &request.name, state, request.wait)
                .await;
        }
        if !self.project_trusted(&s).await {
            return Err(untrusted());
        }
        let project = s.project().to_owned();
        let loaded = tokio::task::spawn_blocking(move || launch::load(&project))
            .await
            .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?;
        let config = loaded
            .get(&request.name)
            .cloned()
            .ok_or_else(|| not_found(&request.name))?;
        let root = s.scope.root().to_owned();
        if let Some(agent) = &request.agent {
            self.agent_may_start(&owner, &config, &root, agent).await?;
        }
        let starting = self.dev_servers.starting.lock().await;
        if let Some(state) = self.running_server(&owner, &request.name) {
            return self
                .answer(&owner, &request.name, state, request.wait)
                .await;
        }
        let config = self.free_port(config).await;
        let started_by = if request.agent.is_some() {
            DevServerStarter::Agent
        } else {
            DevServerStarter::User
        };
        let tool_call = request.agent.as_ref().map(|a| a.tool_call_id.clone());
        let state = self
            .launch_server(
                &owner,
                &s,
                &config,
                started_by,
                tool_call,
                loaded.auto_verify(),
            )
            .await?;
        drop(starting);
        self.answer(&owner, &request.name, state, request.wait)
            .await
    }

    fn running_server(&self, owner: &str, name: &str) -> Option<DevServerState> {
        lock(&self.dev_servers.registry)
            .servers
            .get(owner)
            .and_then(|list| list.iter().find(|s| s.state.name == name))
            .filter(|s| {
                matches!(
                    s.state.status,
                    DevServerStatus::Starting | DevServerStatus::Ready
                )
            })
            .map(|s| s.state.clone())
    }

    /// The state now, or (`wait`) once the server left `starting`.
    async fn answer(
        &self,
        owner: &str,
        name: &str,
        state: DevServerState,
        wait: bool,
    ) -> Result<DevServerState, ErrorObject> {
        if !wait || state.status != DevServerStatus::Starting {
            return Ok(state);
        }
        let receiver = lock(&self.dev_servers.registry)
            .servers
            .get(owner)
            .and_then(|list| list.iter().find(|s| s.state.name == name))
            .map(|s| s.changed.subscribe());
        if let Some(mut receiver) = receiver {
            let _ = receiver
                .wait_for(|status| *status != DevServerStatus::Starting)
                .await;
        }
        Ok(self
            .servers_of(owner)
            .into_iter()
            .find(|s| s.name == name)
            .unwrap_or(state))
    }

    /// The agent's start: asks the user the first time the session starts this fingerprint.
    async fn agent_may_start(
        &self,
        owner: &str,
        config: &LaunchConfig,
        root: &Path,
        agent: &piarc_protocol::dev_server::DevServerAgent,
    ) -> Result<(), ErrorObject> {
        let (call_owner, _) = self.main_session(&agent.session_id.0)?;
        if call_owner != owner {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "the Browser call belongs to another session",
                false,
            ));
        }
        let fingerprint = config.fingerprint();
        let known = lock(&self.dev_servers.registry)
            .allowed
            .get(owner)
            .is_some_and(|set| set.contains(&fingerprint));
        if known {
            return Ok(());
        }
        let timeout =
            super::browser::user_setting(&self.config.data_dir, "/browser/approvalTimeout")
                .and_then(|v| v.as_u64())
                .map_or(super::browser::SITE_TIMEOUT, |seconds| {
                    let (low, high) = super::browser::SITE_TIMEOUT_SECONDS;
                    Duration::from_secs(seconds.clamp(low, high))
                });
        let command = config.display(root);
        let cwd = config.cwd(root);
        let ask = ServerAsk {
            call_session: &agent.session_id.0,
            tool_call_id: &agent.tool_call_id,
            name: &config.name,
            command: &command,
            cwd: &cwd,
            fingerprint: &fingerprint,
        };
        match self.ask_dev_server(&ask, timeout).await? {
            ServerDecision::Refused => Err(refused_start(&config.name)),
            ServerDecision::Allowed => {
                lock(&self.dev_servers.registry)
                    .allowed
                    .entry(owner.to_owned())
                    .or_default()
                    .insert(fingerprint);
                Ok(())
            }
        }
    }

    /// `config`, moved to a free port when `autoPort` is on and its port is busy.
    async fn free_port(&self, config: LaunchConfig) -> LaunchConfig {
        if !config.auto_port {
            return config;
        }
        let limits = self.dev_limits();
        let first = config.port();
        let found = tokio::task::spawn_blocking(move || {
            (0..=limits.port_tries)
                .filter_map(|step| first.checked_add(step))
                .find(|port| port_free(*port, limits.connect_timeout))
        })
        .await
        .ok()
        .flatten();
        match found {
            Some(port) if port != first => config.on_port(port),
            _ => config,
        }
    }

    /// Starts `config` as a task of `owner` and follows it until it is ready or ends.
    async fn launch_server(
        &self,
        owner: &str,
        s: &SessionIo,
        config: &LaunchConfig,
        started_by: DevServerStarter,
        tool_call_id: Option<String>,
        auto_verify: bool,
    ) -> Result<DevServerState, ErrorObject> {
        let root = s.scope.root().to_owned();
        let command = config.display(&root);
        let launch_at = exec::launch_dir(s, Some(&config.cwd(&root)))?;
        let run = ExecRunParams {
            session_id: SessionId(owner.to_owned()),
            request_id: format!("devserver-{}", config.name),
            command: command.clone(),
            cwd: None,
            env: Some(config.env(&root)),
            origin: None,
            shell: Some(ExecShell::Bash),
            timeout_ms: None,
            background: true,
            terminal: false,
        };
        // A server binds ports: it never runs in the sandbox (ADR-0092 rule 2).
        let spec = self
            .exec
            .background_spec(s, &run, &launch_at, Wrap::default())
            .await?;
        let place = self.place(owner, s);
        let new = NewTask {
            session_id: place.session_id.clone(),
            owner_session_id: place.owner_session_id.clone(),
            workspace: place.workspace.clone(),
            kind: TaskKind::DevServer,
            title: config.name.clone(),
            command: command.clone(),
            cwd: piarc_fs::display(&launch_at.dir),
            tool_call_id,
            output_dir: place.output_dir.clone(),
            timeout: None,
        };
        let judge = Judge {
            shell: ExecShell::Bash,
            command,
        };
        let reserved = start_task(
            self.exec.runner(),
            &place.tasks,
            spec,
            new,
            judge,
            CancellationToken::new(),
        )?;
        let port = config.port();
        let state = DevServerState {
            name: config.name.clone(),
            status: DevServerStatus::Starting,
            started_by,
            task_id: Some(reserved.task_id.clone()),
            port,
            url: config.url(&root),
            failure: None,
            exit_code: None,
            log: Vec::new(),
        };
        self.add_server(owner, &place.workspace, launch_at.dir, auto_verify, &state);
        self.publish_servers(owner).await;
        let tool_io = self.clone();
        let (owner, name, task_id) = (owner.to_owned(), config.name.clone(), reserved.task_id);
        tokio::spawn(async move { tool_io.follow(owner, name, task_id, port).await });
        Ok(state)
    }

    fn add_server(
        &self,
        owner: &str,
        workspace: &str,
        dir: PathBuf,
        auto_verify: bool,
        state: &DevServerState,
    ) {
        let (changed, _) = watch::channel(DevServerStatus::Starting);
        let server = Server {
            state: state.clone(),
            workspace: workspace.to_owned(),
            dir,
            auto_verify,
            stopping: false,
            changed,
        };
        let mut registry = lock(&self.dev_servers.registry);
        let list = registry.servers.entry(owner.to_owned()).or_default();
        list.retain(|s| s.state.name != state.name);
        list.push(server);
    }

    /// Probes the server until it is ready, then waits for its end.
    async fn follow(&self, owner: String, name: String, task_id: String, port: u16) {
        let limits = self.dev_limits();
        let started = Instant::now();
        let tasks = self.tasks.clone();
        let Some(mut ended) = tasks.ended_receiver(&task_id) else {
            return;
        };
        let ready = loop {
            if *ended.borrow() {
                break false;
            }
            if self.probe(&task_id, port, limits.connect_timeout).await {
                break true;
            }
            if started.elapsed() >= limits.ready_timeout {
                // Stopped before it is reported failed: whoever waits sees it ended.
                let _ = tasks.stop(&task_id, StopBy::User).await;
                self.fail(&owner, &name, &task_id, DevServerFailure::Timeout);
                self.publish_servers(&owner).await;
                return;
            }
            tokio::select! {
                () = tokio::time::sleep(limits.probe_interval) => {}
                _ = ended.wait_for(|done| *done) => {}
            }
        };
        if ready {
            self.set_status(&owner, &name, DevServerStatus::Ready);
            self.publish_servers(&owner).await;
            let _ = ended.wait_for(|done| *done).await;
        }
        self.ended(&owner, &name, &task_id);
        self.publish_servers(&owner).await;
    }

    /// Whether `port` answers on loopback and the listener belongs to task `task_id`'s tree.
    async fn probe(&self, task_id: &str, port: u16, connect: Duration) -> bool {
        let Some(tree) = self.tasks.tree_of(task_id) else {
            return false;
        };
        tokio::task::spawn_blocking(move || {
            loopback_answers(port, connect)
                && piarc_exec::listeners::listening(&[tree])
                    .is_ok_and(|found| found.first().is_some_and(|ports| ports.contains(&port)))
        })
        .await
        .unwrap_or(false)
    }

    fn set_status(&self, owner: &str, name: &str, status: DevServerStatus) {
        self.with_server(owner, name, |server| {
            server.state.status = status;
            let _ = server.changed.send(status);
        });
    }

    fn fail(&self, owner: &str, name: &str, task_id: &str, failure: DevServerFailure) {
        let log = self.tasks.log_tail(task_id, FAILURE_LOG_LINES);
        let exit_code = self.tasks.task_view(task_id).and_then(|t| t.exit_code);
        self.with_server(owner, name, |server| {
            server.state.status = DevServerStatus::Failed;
            server.state.failure = Some(failure);
            server.state.exit_code = exit_code;
            server.state.log.clone_from(&log);
            let _ = server.changed.send(DevServerStatus::Failed);
        });
    }

    /// The server's task ended: stopped on purpose, or a failure.
    fn ended(&self, owner: &str, name: &str, task_id: &str) {
        let stopping = self
            .with_server(owner, name, |server| {
                server.stopping || server.state.status == DevServerStatus::Failed
            })
            .unwrap_or(true);
        if stopping {
            self.with_server(owner, name, |server| {
                if server.state.status != DevServerStatus::Failed {
                    server.state.status = DevServerStatus::Stopped;
                    let _ = server.changed.send(DevServerStatus::Stopped);
                }
            });
        } else {
            self.fail(owner, name, task_id, DevServerFailure::Exited);
        }
    }

    fn with_server<T>(
        &self,
        owner: &str,
        name: &str,
        f: impl FnOnce(&mut Server) -> T,
    ) -> Option<T> {
        let mut registry = lock(&self.dev_servers.registry);
        registry
            .servers
            .get_mut(owner)
            .and_then(|list| list.iter_mut().find(|s| s.state.name == name))
            .map(f)
    }

    /// `stopDevServer`: stops server `name` of the session with its whole process tree.
    ///
    /// # Errors
    ///
    /// `sessionNotFound`; `notFound` when the session started no such server.
    pub async fn stop_dev_server(
        &self,
        session_id: &str,
        name: &str,
    ) -> Result<DevServerState, ErrorObject> {
        let (owner, _) = self.main_session(session_id)?;
        let task_id = self
            .with_server(&owner, name, |server| {
                server.stopping = true;
                server.state.task_id.clone()
            })
            .ok_or_else(|| not_found(name))?;
        if let Some(task_id) = task_id {
            let (task, _, _) = self.tasks.stop(&task_id, StopBy::User).await?;
            if task.status != TaskStatus::Running {
                self.with_server(&owner, name, |server| {
                    if server.state.status != DevServerStatus::Failed {
                        server.state.status = DevServerStatus::Stopped;
                        let _ = server.changed.send(DevServerStatus::Stopped);
                    }
                });
            }
        }
        self.publish_servers(&owner).await;
        self.servers_of(&owner)
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| not_found(name))
    }

    /// Sends session `owner`'s servers to the desktop client.
    async fn publish_servers(&self, owner: &str) {
        let Some(events) = self.notices.clone() else {
            return;
        };
        let _turn = self.dev_servers.publishing.lock().await;
        let (servers, workspace) = {
            let registry = lock(&self.dev_servers.registry);
            let list = registry.servers.get(owner);
            (
                list.map(|l| l.iter().map(|s| s.state.clone()).collect())
                    .unwrap_or_default(),
                list.and_then(|l| l.first())
                    .map(|s| s.workspace.clone())
                    .unwrap_or_default(),
            )
        };
        let event = BrowserClientEvent::Servers {
            session_id: SessionId(owner.to_owned()),
            workspace,
            servers,
        };
        if let Ok(event) = Event::from_json(RouteKey::browser(), &event) {
            let _ = events.send(event).await;
        }
    }

    /// The agent wrote `path` in session `session_id`: a front-end file under a running server
    /// with `autoVerify` leaves one `browserVerify` reminder for this turn.
    pub(super) fn dev_file_written(&self, session_id: &str, s: &SessionIo, path: &str) {
        let extension = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        if !extension.is_some_and(|e| FRONT_END.contains(&e.as_str())) {
            return;
        }
        let Ok(written) = s.scope.locate(path) else {
            return;
        };
        let owner = s
            .subagent
            .as_ref()
            .map_or_else(|| session_id.to_owned(), |link| link.root_id.clone());
        let hit = {
            let mut registry = lock(&self.dev_servers.registry);
            let server = registry.servers.get(&owner).and_then(|list| {
                list.iter()
                    .find(|server| {
                        server.auto_verify
                            && matches!(
                                server.state.status,
                                DevServerStatus::Starting | DevServerStatus::Ready
                            )
                            && written.starts_with(&server.dir)
                    })
                    .map(|server| (server.state.name.clone(), server.state.url.clone()))
            });
            server.map(|found| {
                registry.reminders += 1;
                (found, registry.reminders)
            })
        };
        let Some(((name, url), count)) = hit else {
            return;
        };
        let shown = written
            .strip_prefix(s.scope.root())
            .map_or_else(|_| piarc_fs::display(&written), |p| p.display().to_string());
        let notice = Notice {
            key: "browserVerify".to_owned(),
            source: format!("devServer:{name}:{count}"),
            kind: ReminderType::BrowserVerify,
            text: format!("{url}\n{shown}"),
            wake: false,
        };
        self.tasks.remind_once_per_turn(&owner, notice);
    }

    /// The open main sessions with their projects and file roots (port discovery).
    pub(crate) fn open_main_sessions(&self) -> Vec<(String, PathBuf, PathBuf)> {
        lock(&self.sessions)
            .iter()
            .filter(|(_, s)| s.subagent.is_none())
            .map(|(id, s)| {
                (
                    id.clone(),
                    s.project().to_owned(),
                    s.scope.root().to_owned(),
                )
            })
            .collect()
    }
}

fn config_view(config: &LaunchConfig, root: &Path) -> LaunchConfigView {
    LaunchConfigView {
        name: config.name.clone(),
        source: config.source,
        command: config.display(root),
        cwd: config.cwd(root),
        port: config.port(),
        url: config.url(root),
        auto_port: config.auto_port,
        fingerprint: config.fingerprint(),
    }
}

/// Whether something answers on `127.0.0.1` or `::1` at `port`.
fn loopback_answers(port: u16, timeout: Duration) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
    .into_iter()
    .any(|ip| TcpStream::connect_timeout(&SocketAddr::new(ip, port), timeout).is_ok())
}

/// Whether `port` is free on loopback: nothing answers and it can be bound.
fn port_free(port: u16, timeout: Duration) -> bool {
    !loopback_answers(port, timeout) && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}
