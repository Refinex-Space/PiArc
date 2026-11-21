//! Answers the Agent Host's delegated tool I/O: `fs/*` with `piarc-fs`, `exec/*` with
//! `piarc-exec` (ADR-0004, architecture section 6.1.3).
//!
//! [`ToolIo`] knows each open session's [`Scope`] (workspace root, working directory, added
//! directories and the session's temporary directory, read-only); the session layer registers
//! it with [`ToolIo::open_session`] when the session opens (T14). Requests for an unknown
//! session fail with `sessionNotFound`.
//!
//! File operations run on tokio's blocking pool. Each session has its file state table (what it
//! read and wrote, T16), kept while the session is open; the path locks are shared by all
//! sessions; `files.rs` holds the `fs/*` side of the invariants (architecture section 6.1.2).
//! `exec.rs` holds `exec/run` and `exec/shells` (T17, architecture section 6.11): shell,
//! working directory carried between commands, environment, timeout, output budget and the
//! meaning of exit codes. `exec/run` streams the command's output as `exec/output`
//! notifications on the requesting connection ([`Peer`]), all written before the response; it
//! is cancelled by `exec/kill` with the same `requestId`, and stopped with its whole process
//! tree when the connection ends or the session's turn is interrupted.
//!
//! The sandbox (architecture section 6.10, T11, T39, `sandbox.rs`): a Bash command whose call
//! was judged to run sandboxed gets `piarc-sandbox`'s wrapper (`sandbox-exec` with a profile
//! generated for the command from the settings as they stand) and the proxy and cache
//! variables on top of its environment; like every command it runs with the process-tree
//! spawner, so cancelling a command ends everything it started. The session's network proxy
//! starts with its first sandboxed command and stops when the session is closed. A session
//! opened with [`ToolIo::open_sandboxed_session`] (tests) runs every command sandboxed with
//! fixed settings.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

mod checkpoints;
mod context;
mod exec;
mod files;
mod git_status;
mod hooks;
mod memory;
mod memory_reader;
pub(crate) mod policy;
mod sandbox;
mod skills;
pub(crate) mod subagents;
mod tasks;
mod terminals;
mod web;
mod web_search;
pub(crate) use web_search::chosen_backend as chosen_search_backend;

pub use exec::{CommandEnv, DISPLAY_WINDOW};
use piarc_exec::ExecLimits;
use piarc_fs::{EncodingCache, FileStates, Scope};
use piarc_host::{InboundHandler, Peer};
use piarc_ports::BoxFuture;
use piarc_protocol::exec::{ExecKillParams, ExecKillResult, ExecRunParams, ExecShellsParams};
use piarc_protocol::fs::{
    FsGlobParams, FsGrepParams, FsListParams, FsMkdirParams, FsPdfParams, FsReadParams,
    FsSpillParams, FsStatParams, FsWriteParams,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_sandbox::proxy::Allowlist;
pub(crate) use policy::hooks::condition as hook_condition;
pub use sandbox::{DEFAULT_APPROVAL_TIMEOUT, SandboxConfig};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
pub use terminals::UserTerminal;
use tokio_util::sync::CancellationToken;

use crate::events::EventSender;
pub use web::WebConfig;

/// Sees every request [`ToolIo`] answers, before it is answered (tests count and hold
/// requests to observe tool concurrency on Core's side, T14-A06). Production sets none.
pub trait ToolIoObserver: Send + Sync {
    /// Request `method` of `session_id`, made by tool call `tool_call_id` when the Agent Host
    /// named one, is about to run; it runs once the returned future completes.
    fn before(
        &self,
        session_id: &str,
        method: &str,
        tool_call_id: Option<&str>,
    ) -> piarc_ports::BoxFuture<'static, ()>;
}

/// Where [`ToolIo`] keeps its files and what commands inherit.
#[derive(Clone)]
pub struct ToolIoConfig {
    /// PiArc's data directory: blobs go to `sessions/<sessionId>/blobs/` below it, the
    /// user's settings (`shell.gitBashPath`) are read from `settings.json` in it.
    pub data_dir: PathBuf,
    /// The user's home directory for Claude Code's user files (`CoreConfig::home`); `None`
    /// reads none of them.
    pub home: Option<PathBuf>,
    /// Where commands get their environment.
    pub command_env: CommandEnv,
    /// Timeouts and output budgets of commands.
    pub exec_limits: ExecLimits,
    /// Sees every request first (tests only).
    pub observer: Option<Arc<dyn ToolIoObserver>>,
    /// Times the timeout of `AskUserQuestion`'s form (`ui/ask`, T26); tests move it by hand.
    pub clock: Arc<dyn piarc_ports::Clock>,
    /// Limits and allowlist of `web/fetch` (T29).
    pub web: WebConfig,
    /// The Bash sandbox's platform, network and enterprise values (T39).
    pub sandbox: SandboxConfig,
}

impl std::fmt::Debug for ToolIoConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolIoConfig")
            .field("data_dir", &self.data_dir)
            .field("exec_limits", &self.exec_limits)
            .field("observer", &self.observer.is_some())
            .finish_non_exhaustive()
    }
}

impl ToolIoConfig {
    /// Blobs under `data_dir`; commands get Core's own environment without PiArc's variables
    /// ([`CommandEnv::process`]; Core's runtime asks the login shell instead) and the default
    /// limits.
    #[must_use]
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            home: None,
            data_dir,
            command_env: CommandEnv::process(),
            exec_limits: ExecLimits::default(),
            observer: None,
            clock: Arc::new(crate::clock::SystemClock),
            web: WebConfig::default(),
            sandbox: SandboxConfig::default(),
        }
    }
}

/// See [`ToolIo::session_hold`].
pub(crate) struct SessionHold(Option<std::sync::Weak<SessionIo>>);

impl SessionHold {
    /// How long a closed session's in-flight work may keep it: closing cancels that work, so
    /// it ends as soon as its processes do.
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

    /// Waits until nothing in Core holds the session any more (at most [`Self::LIMIT`]).
    pub(crate) async fn released(self) {
        let Some(held) = self.0 else {
            return;
        };
        let deadline = tokio::time::Instant::now() + Self::LIMIT;
        while held.strong_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

/// A session's scope, file state and running commands.
struct SessionIo {
    scope: Scope,
    /// The workspace whose settings, rules, trust and audit the session uses: the scope's root,
    /// except for a session in a worktree, whose scope is the worktree (T35).
    project: PathBuf,
    memory: memory::State,
    policy: Mutex<policy::State>,
    blob_dir: PathBuf,
    /// `<data dir>/sessions/<id>/tmp/`: long tool results (`fs/spill`), readable by the tools.
    tmp_dir: PathBuf,
    /// What the session read and wrote (architecture section 6.1.2).
    files: Mutex<FileStates>,
    /// Texts arriving in pieces.
    uploads: Mutex<files::Uploads>,
    /// Detected encodings of the files the session reads.
    encodings: EncodingCache,
    running: Mutex<HashMap<String, CancellationToken>>,
    /// Where the session's next bash command without an explicit `cwd` starts.
    shell_cwd: Mutex<PathBuf>,
    /// The session's sandbox: its proxy and the hosts the user allowed (T39).
    sandbox: sandbox::SessionState,
    /// The running (or last) turn: writes without a `turnId` go to its checkpoint (T28).
    turn: Mutex<Option<String>>,
    /// Set for a subagent's session (T31): its main session and how it was started.
    subagent: Option<subagents::Link>,
    /// The directories of the skills the session sees (T37): read-only for its file tools.
    skill_dirs: Mutex<Vec<PathBuf>>,
}

impl SessionIo {
    /// The workspace of the session's settings, rules, trust and audit (T35).
    fn project(&self) -> &Path {
        &self.project
    }
}

/// What a sandboxed session may reach besides its workspace (architecture section 6.10).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SandboxSettings {
    /// Directories added to the session: writable.
    pub extra_dirs: Vec<PathBuf>,
    /// Paths commands may not read.
    pub deny_read: Vec<PathBuf>,
    /// Domains the proxy lets through: exact names and `*.` wildcards. Empty denies all.
    pub allowed_domains: Vec<String>,
}

/// Answers `fs/*` and `exec/*` for the registered sessions. Cheap to clone.
#[derive(Clone)]
pub struct ToolIo {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionIo>>>>,
    config: Arc<ToolIoConfig>,
    /// One file is written by one request at a time, whichever session sends it.
    locks: files::Locks,
    /// Shells, environment and runner of commands.
    exec: Arc<exec::Exec>,
    policy: Option<policy::Services>,
    /// Snapshots of writes, rewinds and the Changes panel (T28); none without a data directory.
    checkpoints: Option<crate::checkpoints::Checkpoints>,
    /// The WebFetch fetcher (T29).
    web: Arc<web::WebState>,
    /// Background commands, subagents and Monitors (T32).
    tasks: crate::tasks::TaskManager,
    /// Terminals (T33); none without Core's state.
    terminals: Option<crate::terminal::Terminals>,
    /// The vault, for search services' API keys (T38); none without Core's state.
    secrets: Option<crate::secrets::SecretsService>,
    /// Notices for the user (`core/notices`).
    notices: Option<EventSender>,
    /// Whether the sandbox failed to start in this Core (T39, R10).
    sandbox_health: Arc<sandbox::Health>,
}

impl std::fmt::Debug for ToolIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolIo")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl ToolIo {
    /// A dispatcher running commands with the process-tree spawner.
    #[must_use]
    pub fn new(config: ToolIoConfig) -> Self {
        Self::with_notices(config, None)
    }

    /// Like [`ToolIo::new`], with notices for the user (`core/notices`) going to `notices`.
    pub(crate) fn with_notices(config: ToolIoConfig, notices: Option<EventSender>) -> Self {
        let exec = exec::Exec::new(
            config.exec_limits,
            config.command_env.clone(),
            config.data_dir.clone(),
            notices.clone(),
        );
        Self {
            sessions: Arc::default(),
            config: Arc::new(config),
            locks: Arc::default(),
            exec: Arc::new(exec),
            policy: None,
            checkpoints: None,
            web: Arc::default(),
            tasks: crate::tasks::TaskManager::new(crate::tasks::TasksConfig::default()),
            terminals: None,
            secrets: None,
            notices,
            sandbox_health: Arc::default(),
        }
    }

    /// Reads search services' API keys from `secrets` (T38).
    #[must_use]
    pub(crate) fn with_secrets(mut self, secrets: crate::secrets::SecretsService) -> Self {
        self.secrets = Some(secrets);
        self
    }

    /// Uses `tasks` as the task manager (Core's runtime gives the one with the database).
    #[must_use]
    pub(crate) fn with_tasks(mut self, tasks: crate::tasks::TaskManager) -> Self {
        self.tasks = tasks;
        self
    }

    /// The task manager.
    #[must_use]
    pub fn tasks(&self) -> &crate::tasks::TaskManager {
        &self.tasks
    }

    /// Whether `method` is one this dispatcher answers.
    #[must_use]
    pub fn handles(method: &str) -> bool {
        method.starts_with("fs/")
            || method.starts_with("exec/")
            || matches!(
                method,
                "policy/evaluate"
                    | "policy/recover"
                    | "policy/cancel"
                    | "policy/inputChunk"
                    | "policy/tools"
                    | "ui/ask"
                    | "context/settings"
                    | "web/fetch"
                    | "web/search"
                    | "web/searchBackend"
            )
    }

    /// Registers `session_id` with its workspace root and working directory, and creates its
    /// temporary directory; a later registration of the same id replaces the scope and starts
    /// a new file state table.
    ///
    /// # Errors
    ///
    /// The id cannot name a directory (empty, `.`, `..` or containing a separator),
    /// [`Scope::new`] fails (missing directories, `cwd` outside `root`), or the temporary
    /// directory cannot be created.
    pub fn open_session(
        &self,
        session_id: &str,
        root: &Path,
        cwd: &Path,
    ) -> Result<(), ErrorObject> {
        self.open_session_in(session_id, root, root, cwd)
    }

    /// Like [`ToolIo::open_session`] for a session whose files are `root` (a worktree) while
    /// its settings, rules, trust and audit are those of workspace `project` (T35).
    ///
    /// # Errors
    ///
    /// As [`ToolIo::open_session`].
    pub fn open_session_in(
        &self,
        session_id: &str,
        project: &Path,
        root: &Path,
        cwd: &Path,
    ) -> Result<(), ErrorObject> {
        check_session_id(session_id)?;
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        let tasks = self.create_tasks_dir(session_id)?;
        let scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .and_then(|scope| scope.with_read_only_dir(&tasks))
            .map_err(|e| e.to_error_object())?;
        // Spelled like the scope's root (symbolic links resolved), which the rules and the
        // audit compared before worktrees existed.
        let project = if project == root {
            scope.root().to_path_buf()
        } else {
            piarc_git::canonical(project).unwrap_or_else(|_| project.to_path_buf())
        };
        self.register(
            session_id,
            scope,
            &project,
            tmp,
            sandbox::SessionState::default(),
            None,
        );
        Ok(())
    }

    /// Registers a subagent's session (T31) like [`ToolIo::open_session`], linked to its
    /// main session.
    fn open_linked(
        &self,
        session_id: &str,
        project: &Path,
        root: &Path,
        cwd: &Path,
        link: subagents::Link,
    ) -> Result<(), ErrorObject> {
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        // The main session's tasks hold this subagent's output too (ADR-0049 rule 2).
        let tasks = self.create_tasks_dir(&link.root_id)?;
        let scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .and_then(|scope| scope.with_read_only_dir(&tasks))
            .map_err(|e| e.to_error_object())?;
        self.register(
            session_id,
            scope,
            project,
            tmp,
            sandbox::SessionState::default(),
            Some(link),
        );
        Ok(())
    }

    /// `<data dir>/sessions/<id>/tasks/`: background tasks' output, read without asking.
    fn create_tasks_dir(&self, session_id: &str) -> Result<PathBuf, ErrorObject> {
        let dir = self.session_dir(session_id).join("tasks");
        std::fs::create_dir_all(&dir)
            .map_err(|e| piarc_fs::Error::io(&dir, e).to_error_object())?;
        Ok(dir)
    }

    fn create_tmp(&self, session_id: &str) -> Result<PathBuf, ErrorObject> {
        let tmp = self.session_dir(session_id).join("tmp");
        std::fs::create_dir_all(&tmp)
            .map_err(|e| piarc_fs::Error::io(&tmp, e).to_error_object())?;
        Ok(tmp)
    }

    /// The session's attachments (ADR-0030): read without asking, like its temporary files.
    fn create_attachments(&self, session_id: &str) -> Result<PathBuf, ErrorObject> {
        let dir = self
            .session_dir(session_id)
            .join(crate::composer::attachments::ATTACHMENTS_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| piarc_fs::Error::io(&dir, e).to_error_object())?;
        Ok(dir)
    }

    /// Like [`ToolIo::open_session`], with every command of the session sandboxed whatever
    /// the settings say (tests of the sandbox itself): writes limited to the workspace, the
    /// session's temporary directory (`<data dir>/sessions/<id>/tmp/`, created here) and
    /// `settings.extra_dirs`, network only through the session's proxy with
    /// `settings.allowed_domains`.
    ///
    /// # Errors
    ///
    /// The errors of [`ToolIo::open_session`]; an allowlist entry that is not a domain
    /// (`invalidParams`); the temporary directory cannot be created; this platform has no
    /// sandbox, or the proxy cannot start.
    pub async fn open_sandboxed_session(
        &self,
        session_id: &str,
        root: &Path,
        cwd: &Path,
        settings: SandboxSettings,
    ) -> Result<(), ErrorObject> {
        check_session_id(session_id)?;
        Allowlist::new(&settings.allowed_domains)
            .map_err(|e| ErrorObject::new(ErrorKind::InvalidParams, e.to_string(), false))?;
        if self.config.sandbox.platform.is_none() {
            return Err(ErrorObject::new(
                ErrorKind::InternalError,
                piarc_sandbox::Error::Unsupported.to_string(),
                false,
            ));
        }
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        let tasks = self.create_tasks_dir(session_id)?;
        let mut scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .and_then(|scope| scope.with_read_only_dir(&tasks))
            .map_err(|e| e.to_error_object())?;
        for dir in &settings.extra_dirs {
            scope = scope.with_added_dir(dir).map_err(|e| e.to_error_object())?;
        }
        let project = scope.root().to_path_buf();
        self.register(
            session_id,
            scope,
            &project,
            tmp,
            sandbox::SessionState::forced(settings),
            None,
        );
        Ok(())
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.config.data_dir.join("sessions").join(session_id)
    }

    fn register(
        &self,
        session_id: &str,
        scope: Scope,
        project: &Path,
        tmp_dir: PathBuf,
        sandbox: sandbox::SessionState,
        subagent: Option<subagents::Link>,
    ) {
        let blob_dir = self.session_dir(session_id).join("blobs");
        let shell_cwd = Mutex::new(scope.cwd().to_path_buf());
        lock(&self.sessions).insert(
            session_id.to_owned(),
            Arc::new(SessionIo {
                scope,
                project: project.to_owned(),
                memory: memory::State::default(),
                policy: Mutex::default(),
                blob_dir,
                tmp_dir,
                files: Mutex::default(),
                uploads: Mutex::default(),
                encodings: EncodingCache::default(),
                running: Mutex::default(),
                shell_cwd,
                sandbox,
                turn: Mutex::default(),
                skill_dirs: Mutex::default(),
                subagent,
            }),
        );
    }

    /// The environment commands inherit (the user's login shell, T17).
    pub(crate) async fn command_environment(&self) -> Vec<(OsString, OsString)> {
        self.exec.hook_launch().await.env
    }

    /// What `${VAR}` in MCP server definitions expands from (T36): the user's login shell
    /// environment without PiArc's internal variables. Read for expansion only.
    pub(crate) async fn expansion_environment(&self) -> Vec<(OsString, OsString)> {
        self.exec.expansion_env().await
    }

    /// Runs git for worktrees of `workspace` (T35): the commands' environment, the git on its
    /// `PATH` outside the workspace, the process-tree spawner.
    ///
    /// # Errors
    ///
    /// `notFound` when no git is on that `PATH`.
    pub(crate) async fn git_runner(&self, workspace: &Path) -> Result<piarc_git::Git, ErrorObject> {
        let env = self.command_environment().await;
        let path = env
            .iter()
            .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let program = piarc_git::git::find_program(&path, Some(workspace)).ok_or_else(|| {
            ErrorObject::new(
                ErrorKind::NotFound,
                "git was not found on the PATH of commands",
                false,
            )
        })?;
        Ok(piarc_git::Git::new(
            Arc::new(piarc_exec::ProcessTreeSpawner),
            program,
            env,
        ))
    }

    /// The proxy port of a session whose proxy has started (its first sandboxed command).
    #[must_use]
    pub fn sandbox_proxy_port(&self, session_id: &str) -> Option<u16> {
        lock(&self.sessions)
            .get(session_id)
            .and_then(|s| Self::started_proxy_port(s))
    }

    /// Taken before closing session `session_id`, tells when Core has let go of its state:
    /// work that started while it was open (an idle `Notification` hook) keeps it, and with it
    /// the scope's directory handles, which Windows does not let anyone delete (ADR-0036, W2).
    pub(crate) fn session_hold(&self, session_id: &str) -> SessionHold {
        SessionHold(lock(&self.sessions).get(session_id).map(Arc::downgrade))
    }

    /// Forgets the session and terminates its running commands.
    pub fn close_session(&self, session_id: &str) {
        self.clear_approvals(session_id, policy::Cleanup::Interrupted);
        // The hooks of the skills it invoked stop with it (T37).
        if let Some(hooks) = self.policy.as_ref().and_then(|p| p.hooks.as_ref()) {
            hooks.unscope_hooks(session_id);
        }
        if let Some(session) = lock(&self.sessions).remove(session_id) {
            for token in lock(&session.running).values() {
                token.cancel();
            }
        }
    }

    /// Terminates the commands `session_id` is running and keeps the session (its turn was
    /// interrupted: the cancellation reaches the tool calls' processes even if the Agent Host
    /// never sends their `exec/kill`). Uploads are left alone: a write already sending its
    /// pieces finishes them, and dropping the collected start would turn the next piece into a
    /// complete, truncated text.
    pub fn cancel_running(&self, session_id: &str) {
        let children = self.attached(session_id);
        let sessions = lock(&self.sessions);
        for id in std::iter::once(session_id).chain(children.iter().map(String::as_str)) {
            if let Some(session) = sessions.get(id) {
                for token in lock(&session.running).values() {
                    token.cancel();
                }
            }
        }
    }

    /// The registered scope of `session_id`.
    #[must_use]
    pub fn scope(&self, session_id: &str) -> Option<Scope> {
        lock(&self.sessions)
            .get(session_id)
            .map(|s| s.scope.clone())
    }

    /// Answers one request; `peer` carries `exec/output` notifications.
    pub async fn dispatch(
        &self,
        method: &str,
        params: Map<String, Value>,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        if let Some(observer) = &self.config.observer {
            let text = |name: &str| params.get(name).and_then(Value::as_str).unwrap_or_default();
            let call = params
                .get("origin")
                .and_then(|origin| origin.get("toolCallId"))
                .and_then(Value::as_str);
            observer.before(text("sessionId"), method, call).await;
        }
        match method {
            "fs/memory" => return self.memory_snapshot(parse(method, params)?, &peer).await,
            "policy/inputChunk" => return self.stage_input(parse(method, params)?, &peer),
            "policy/evaluate" => return self.evaluate(parse(method, params)?, peer).await,
            "policy/tools" => return self.denied_tools(parse(method, params)?).await,
            "ui/ask" => return self.ask(parse(method, params)?, peer).await,
            "web/fetch" => return self.web_fetch(parse(method, params)?, peer).await,
            "web/search" => return self.web_search(parse(method, params)?, peer).await,
            "web/searchBackend" => return to_value(&self.search_backend().await),
            "context/settings" => return self.context_settings(&parse(method, params)?).await,
            "fs/changes" => return self.external_changes(&parse(method, params)?).await,
            "fs/forgetReads" => return self.forget_reads(&parse(method, params)?),
            "policy/cancel" => {
                let p: piarc_protocol::policy::PolicyPendingParams = parse(method, params)?;
                return self.cancel_wait(&p.session_id, &p.tool_call_id, &peer);
            }
            "policy/recover" => {
                let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("");
                return self.recover(text("sessionId"), text("toolCallId"));
            }
            "exec/run" | "exec/shells" | "exec/kill" | "fs/spill" => {}
            "exec/monitor" => return self.exec_monitor(parse(method, params)?, peer).await,
            "exec/background/list" => return self.task_list(&parse(method, params)?),
            "exec/background/read" => return self.task_read(parse(method, params)?).await,
            "exec/background/kill" => return self.task_kill(parse(method, params)?).await,
            _ if self.policy.is_some() => {
                let s = self.session(
                    params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )?;
                let scope = policy::file_permit(&s, method, &params, &peer)?;
                return self.dispatch_io(method, params, peer, Some(scope)).await;
            }
            _ => {}
        }
        self.dispatch_io(method, params, peer, None).await
    }

    async fn dispatch_io(
        &self,
        method: &str,
        params: Map<String, Value>,
        peer: Peer,
        permit: Option<policy::FilePermit>,
    ) -> Result<Value, ErrorObject> {
        let scope = permit.as_ref().map(|p| p.scope.clone());
        match method {
            "fs/stat" => {
                let p: FsStatParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                answer(move || files::stat(scope.as_ref().unwrap_or(&s.scope), &s, &p)).await
            }
            "fs/read" => {
                let p: FsReadParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                answer(move || files::read(scope.as_ref().unwrap_or(&s.scope), &s, &p)).await
            }
            "fs/write" => {
                let p: FsWriteParams = parse(method, params)?;
                let (s, locks) = (self.session(&p.session_id.0)?, Arc::clone(&self.locks));
                let checkpoints = self.checkpoints_for(&s).await;
                answer(move || files::write(permit, &s, &locks, checkpoints.as_ref(), p)).await
            }
            "fs/spill" => {
                let p: FsSpillParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                answer(move || files::spill(&s, p)).await
            }
            "fs/pdf" => {
                let p: FsPdfParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                answer(move || files::pdf(scope.as_ref().unwrap_or(&s.scope), &s, &p)).await
            }
            "fs/mkdir" => {
                let p: FsMkdirParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || piarc_fs::mkdir(scope.as_ref().unwrap_or(&s.scope), &p.path)).await
            }
            "fs/list" => {
                let p: FsListParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || {
                    piarc_fs::list(scope.as_ref().unwrap_or(&s.scope), &p.path, p.limit)
                })
                .await
            }
            "fs/glob" => {
                let p: FsGlobParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || {
                    let exclude = p.exclude.unwrap_or_default();
                    piarc_fs::glob(
                        scope.as_ref().unwrap_or(&s.scope),
                        &p.path,
                        &p.pattern,
                        &exclude,
                        p.limit,
                    )
                })
                .await
            }
            "fs/grep" => {
                let p: FsGrepParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || files::grep(scope.as_ref().unwrap_or(&s.scope), &p)).await
            }
            "exec/run" | "exec/shells" | "exec/kill" => {
                self.dispatch_exec(method, params, peer).await
            }
            _ => Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not handle {method}"),
                false,
            )),
        }
    }

    async fn dispatch_exec(
        &self,
        method: &str,
        params: Map<String, Value>,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        match method {
            "exec/run" => self.exec_run(parse(method, params)?, peer).await,
            "exec/shells" => {
                // No session: asked before Core registered the one being created.
                let _: ExecShellsParams = parse(method, params)?;
                to_value(&self.exec.answer_shells().await)
            }
            _ => self.exec_kill(&parse(method, params)?),
        }
    }

    async fn exec_run(&self, p: ExecRunParams, peer: Peer) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        let mut launch = exec::launch_dir(&session, p.cwd.as_deref())?;
        let mut sandboxed = session.sandbox.forced.is_some();
        if self.policy.is_some() {
            let claimed = policy::claim_command(&session, &p, &peer, &launch.dir)?;
            launch.pinned = claimed.pinned;
            sandboxed |= claimed.sandboxed;
        }
        let (wrap, run) = if sandboxed {
            let (wrap, run) = self.sandbox_launch(&session, &p.session_id.0).await?;
            (wrap, Some(run))
        } else {
            (exec::Wrap::default(), None)
        };
        if p.terminal {
            // A terminal task outlives the turn and the connection (ADR-0050).
            return to_value(&self.exec_terminal(&session, &p, &launch, wrap).await?);
        }
        let token = CancellationToken::new();
        {
            let mut running = lock(&session.running);
            if running.contains_key(&p.request_id) {
                return Err(ErrorObject::new(
                    ErrorKind::InvalidParams,
                    format!("a command with requestId {} is running", p.request_id),
                    false,
                ));
            }
            running.insert(p.request_id.clone(), token.clone());
        }
        let watcher = {
            let (peer, token) = (peer.clone(), token.clone());
            tokio::spawn(async move {
                tokio::select! {
                    () = peer.closed() => token.cancel(),
                    () = token.cancelled() => {}
                }
            })
        };
        let request_id = p.request_id.clone();
        let session_id = p.session_id.0.clone();
        let call = p.origin.as_ref().map(|o| o.tool_call_id.clone());
        let place = self.place(&p.session_id.0, &session);
        let result = self
            .exec
            .run(&session, p, launch, wrap, peer, token, place)
            .await;
        watcher.abort();
        lock(&session.running).remove(&request_id);
        let mut result = result?;
        if let Some(run) = &run {
            if result.task.is_none() {
                self.sandbox_report(&session, &session_id, call.as_deref(), run, &mut result)
                    .await;
            } else {
                result.sandbox = Some(piarc_protocol::exec::SandboxReport::default());
            }
        }
        to_value(&result)
    }

    fn exec_kill(&self, p: &ExecKillParams) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        let token = lock(&session.running).get(&p.request_id).cloned();
        if let Some(token) = &token {
            token.cancel();
        }
        to_value(&ExecKillResult {
            killed: token.is_some(),
        })
    }

    fn session(&self, session_id: &str) -> Result<Arc<SessionIo>, ErrorObject> {
        lock(&self.sessions)
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                let mut error = ErrorObject::new(
                    ErrorKind::SessionNotFound,
                    format!("Core has no workspace for session {session_id}"),
                    false,
                );
                error.data.details = Some(serde_json::json!({ "sessionId": session_id }));
                error
            })
    }
}

impl InboundHandler for ToolIo {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let io = self.clone();
        Box::pin(async move { io.dispatch(&method, params, peer).await })
    }
}

/// `base` with `overlay` applied: an overlay variable replaces a base variable of the same
/// name (ignoring case on Windows, where names are case-insensitive).
fn command_env(
    base: &[(OsString, OsString)],
    overlay: std::collections::BTreeMap<String, String>,
) -> Vec<(OsString, OsString)> {
    let same = |a: &OsString, b: &str| {
        if cfg!(windows) {
            a.to_string_lossy().eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut env: Vec<(OsString, OsString)> = base
        .iter()
        .filter(|(name, _)| !overlay.keys().any(|k| same(name, k)))
        .cloned()
        .collect();
    env.extend(
        overlay
            .into_iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v))),
    );
    env
}

/// `env` with every variable of `overlay` replacing one of the same name (ignoring case on
/// Windows).
fn overlay_env(
    env: Vec<(OsString, OsString)>,
    overlay: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let overlay = overlay
        .into_iter()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    command_env(&env, overlay)
}

fn check_session_id(session_id: &str) -> Result<(), ErrorObject> {
    let usable = !session_id.is_empty()
        && session_id != "."
        && session_id != ".."
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(ErrorObject::new(
            ErrorKind::InvalidParams,
            format!("unusable session id {session_id:?}"),
            false,
        ))
    }
}

fn parse<T: DeserializeOwned>(method: &str, params: Map<String, Value>) -> Result<T, ErrorObject> {
    serde_json::from_value(Value::Object(params)).map_err(|e| {
        ErrorObject::new(
            ErrorKind::InvalidParams,
            format!("{method}: invalid params: {e}"),
            false,
        )
    })
}

fn to_value<T: Serialize>(result: &T) -> Result<Value, ErrorObject> {
    serde_json::to_value(result).map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("result does not serialize: {e}"),
            false,
        )
    })
}

/// Runs a file operation on the blocking pool; operations that need approval are decided by
/// [`files::adjudicate`].
async fn blocking<T: Serialize + Send + 'static>(
    operation: impl FnOnce() -> piarc_fs::Result<T> + Send + 'static,
) -> Result<Value, ErrorObject> {
    answer(move || to_value(&operation().map_err(files::adjudicate)?)).await
}

/// Runs a request's answer on the blocking pool.
async fn answer(
    operation: impl FnOnce() -> Result<Value, ErrorObject> + Send + 'static,
) -> Result<Value, ErrorObject> {
    tokio::task::spawn_blocking(operation).await.map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("file operation panicked or was cancelled: {e}"),
            false,
        )
    })?
}

/// Locks `mutex`, recovering the data if a panicking thread poisoned it: every critical
/// section here leaves the maps consistent.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
