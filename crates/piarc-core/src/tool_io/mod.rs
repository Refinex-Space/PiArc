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
//! A session opened with [`ToolIo::open_sandboxed_session`] runs its commands sandboxed
//! (architecture section 6.10, T11): `piarc-sandbox` gives the wrapper (`sandbox-exec` with a
//! profile generated for the command) and the proxy and cache variables, which go on top of
//! the environment; like every command it runs with the process-tree spawner, so cancelling a
//! command ends everything it started. The session's network proxy stops when the session is
//! closed. Output, exit status and cancellation are those of any `exec/run`. Which sessions
//! are sandboxed, and the Bash tool's two sandbox modes, are T39's.

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
pub(crate) mod subagents;
mod web;

pub use exec::{CommandEnv, DISPLAY_WINDOW};
use piarc_exec::{ExecLimits, Launcher};
use piarc_fs::{EncodingCache, FileStates, Scope};
use piarc_host::{InboundHandler, Peer};
use piarc_ports::BoxFuture;
use piarc_protocol::exec::{ExecKillParams, ExecKillResult, ExecRunParams, ExecShellsParams};
use piarc_protocol::fs::{
    FsGlobParams, FsGrepParams, FsListParams, FsMkdirParams, FsPdfParams, FsReadParams,
    FsSpillParams, FsStatParams, FsWriteParams,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_sandbox::proxy::{Allowlist, SystemNetwork};
use piarc_sandbox::{SandboxPolicy, SessionSandbox};
pub(crate) use policy::hooks::condition as hook_condition;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
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
        }
    }
}

/// A session's scope, file state and running commands.
struct SessionIo {
    scope: Scope,
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
    /// Present when the session's commands run sandboxed; owns the session's proxy.
    sandbox: Option<SessionSandbox>,
    /// The running (or last) turn: writes without a `turnId` go to its checkpoint (T28).
    turn: Mutex<Option<String>>,
    /// Set for a subagent's session (T31): its main session and how it was started.
    subagent: Option<subagents::Link>,
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
            notices,
        );
        Self {
            sessions: Arc::default(),
            config: Arc::new(config),
            locks: Arc::default(),
            exec: Arc::new(exec),
            policy: None,
            checkpoints: None,
            web: Arc::default(),
        }
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
        check_session_id(session_id)?;
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        let scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .map_err(|e| e.to_error_object())?;
        self.register(session_id, scope, tmp, None, None);
        Ok(())
    }

    /// Registers a subagent's session (T31) like [`ToolIo::open_session`], linked to its
    /// main session.
    fn open_linked(
        &self,
        session_id: &str,
        root: &Path,
        cwd: &Path,
        link: subagents::Link,
    ) -> Result<(), ErrorObject> {
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        let scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .map_err(|e| e.to_error_object())?;
        self.register(session_id, scope, tmp, None, Some(link));
        Ok(())
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

    /// Like [`ToolIo::open_session`], with every command of the session sandboxed: writes
    /// limited to the workspace, the session's temporary directory
    /// (`<data dir>/sessions/<id>/tmp/`, created here) and `settings.extra_dirs`, network only
    /// through a proxy started for the session with `settings.allowed_domains`.
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
        let allowlist = Allowlist::new(&settings.allowed_domains)
            .map_err(|e| ErrorObject::new(ErrorKind::InvalidParams, e.to_string(), false))?;
        let tmp = self.create_tmp(session_id)?;
        let attachments = self.create_attachments(session_id)?;
        let mut scope = Scope::new(root, cwd)
            .and_then(|scope| scope.with_read_only_dir(&tmp))
            .and_then(|scope| scope.with_read_only_dir(&attachments))
            .map_err(|e| e.to_error_object())?;
        for dir in &settings.extra_dirs {
            scope = scope.with_added_dir(dir).map_err(|e| e.to_error_object())?;
        }
        let mut policy = SandboxPolicy::new(scope.root().to_path_buf(), tmp.clone());
        policy.extra_dirs = settings.extra_dirs;
        policy.deny_read = settings.deny_read;
        let sandbox = SessionSandbox::start(&policy, allowlist, Arc::new(SystemNetwork))
            .await
            .map_err(|e| sandbox_error(&e))?;
        self.register(session_id, scope, tmp, Some(sandbox), None);
        Ok(())
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.config.data_dir.join("sessions").join(session_id)
    }

    fn register(
        &self,
        session_id: &str,
        scope: Scope,
        tmp_dir: PathBuf,
        sandbox: Option<SessionSandbox>,
        subagent: Option<subagents::Link>,
    ) {
        let blob_dir = self.session_dir(session_id).join("blobs");
        let shell_cwd = Mutex::new(scope.cwd().to_path_buf());
        lock(&self.sessions).insert(
            session_id.to_owned(),
            Arc::new(SessionIo {
                scope,
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
                subagent,
            }),
        );
    }

    /// The proxy port of a sandboxed session.
    #[must_use]
    pub fn sandbox_proxy_port(&self, session_id: &str) -> Option<u16> {
        lock(&self.sessions)
            .get(session_id)
            .and_then(|s| s.sandbox.as_ref().map(SessionSandbox::proxy_port))
    }

    /// Forgets the session and terminates its running commands.
    pub fn close_session(&self, session_id: &str) {
        self.clear_approvals(session_id, policy::Cleanup::Interrupted);
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
        if self.policy.is_some() {
            launch.pinned = policy::claim_command(&session, &p, &peer, &launch.dir)?;
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
        let wrap = match &session.sandbox {
            Some(sandbox) => match sandbox.launch() {
                Ok(launch) => exec::Wrap {
                    launcher: Some(Launcher {
                        program: launch.program,
                        args: launch.args,
                    }),
                    env: launch.env,
                },
                Err(e) => {
                    lock(&session.running).remove(&p.request_id);
                    return Err(sandbox_error(&e));
                }
            },
            None => exec::Wrap::default(),
        };
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
        let result = self.exec.run(&session, p, launch, wrap, peer, token).await;
        watcher.abort();
        lock(&session.running).remove(&request_id);
        to_value(&result?)
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

fn sandbox_error(error: &piarc_sandbox::Error) -> ErrorObject {
    ErrorObject::new(error.kind(), error.to_string(), error.retryable())
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
