//! Answers the Agent Host's delegated tool I/O: `fs/*` with `piarc-fs`, `exec/*` with
//! `piarc-exec` (ADR-0004, architecture section 6.1.3).
//!
//! [`ToolIo`] knows each open session's [`Scope`] (workspace root and working directory);
//! the session layer registers it with [`ToolIo::open_session`] when the session opens (T14;
//! the end-to-end tests do it today). Requests for an unknown session fail with
//! `sessionNotFound`.
//!
//! File operations run on tokio's blocking pool. `exec/run` streams the command's output as
//! `exec/output` notifications on the requesting connection ([`Peer`]), all written before the
//! response; it is cancelled by `exec/kill` with the same `requestId`, and terminated when the
//! connection ends.
//!
//! The command environment is Core's allow-listed environment
//! ([`piarc_host::DEFAULT_ENV_PASSTHROUGH`], no credentials) with the request's `env` overlay
//! on top (Pi's `PI_*` session variables and `PATH`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use piarc_exec::{CommandRunner, CommandSpec, OutputChunk, Stream, TokioProcessSpawner};
use piarc_fs::{GrepQuery, Scope};
use piarc_host::{InboundHandler, Peer};
use piarc_ports::BoxFuture;
use piarc_protocol::exec::{
    ExecKillParams, ExecKillResult, ExecOutput, ExecOutputParams, ExecRunParams, ExecRunResult,
    OutputStream,
};
use piarc_protocol::fs::{
    FsGlobParams, FsGrepParams, FsListParams, FsMkdirParams, FsReadParams, FsStatParams,
    FsWriteParams, ReadMode,
};
use piarc_protocol::text::incomplete_utf8_suffix;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Output chunks waiting to become notifications; a full buffer pauses the command's pipes.
const OUTPUT_BUFFER: usize = 16;

/// Where [`ToolIo`] keeps its files and what commands inherit.
#[derive(Debug, Clone)]
pub struct ToolIoConfig {
    /// PiArc's data directory: blobs go to `sessions/<sessionId>/blobs/` below it.
    pub data_dir: PathBuf,
    /// The base environment of every command.
    pub command_env: Vec<(OsString, OsString)>,
}

impl ToolIoConfig {
    /// Blobs under `data_dir`; commands get the variables of
    /// [`piarc_host::DEFAULT_ENV_PASSTHROUGH`] that Core's own environment sets.
    #[must_use]
    pub fn new(data_dir: PathBuf) -> Self {
        let command_env = piarc_host::DEFAULT_ENV_PASSTHROUGH
            .iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
            .collect();
        Self {
            data_dir,
            command_env,
        }
    }
}

/// A session's scope and its running commands.
struct SessionIo {
    scope: Scope,
    blob_dir: PathBuf,
    running: Mutex<HashMap<String, CancellationToken>>,
}

/// Answers `fs/*` and `exec/*` for the registered sessions. Cheap to clone.
#[derive(Clone)]
pub struct ToolIo {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionIo>>>>,
    config: Arc<ToolIoConfig>,
    runner: CommandRunner,
}

impl std::fmt::Debug for ToolIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolIo")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl ToolIo {
    /// A dispatcher running commands with the production process spawner.
    #[must_use]
    pub fn new(config: ToolIoConfig) -> Self {
        Self {
            sessions: Arc::default(),
            config: Arc::new(config),
            runner: CommandRunner::new(Arc::new(TokioProcessSpawner)),
        }
    }

    /// Whether `method` is one this dispatcher answers.
    #[must_use]
    pub fn handles(method: &str) -> bool {
        method.starts_with("fs/") || method.starts_with("exec/")
    }

    /// Registers `session_id` with its workspace root and working directory; a later
    /// registration of the same id replaces the scope.
    ///
    /// # Errors
    ///
    /// The id cannot name a directory (empty, `.`, `..` or containing a separator), or
    /// [`Scope::new`] fails (missing directories, `cwd` outside `root`).
    pub fn open_session(
        &self,
        session_id: &str,
        root: &Path,
        cwd: &Path,
    ) -> Result<(), ErrorObject> {
        let usable = !session_id.is_empty()
            && session_id != "."
            && session_id != ".."
            && session_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if !usable {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                format!("unusable session id {session_id:?}"),
                false,
            ));
        }
        let scope = Scope::new(root, cwd).map_err(|e| e.to_error_object())?;
        let blob_dir = self
            .config
            .data_dir
            .join("sessions")
            .join(session_id)
            .join("blobs");
        lock(&self.sessions).insert(
            session_id.to_owned(),
            Arc::new(SessionIo {
                scope,
                blob_dir,
                running: Mutex::default(),
            }),
        );
        Ok(())
    }

    /// Forgets the session and terminates its running commands.
    pub fn close_session(&self, session_id: &str) {
        if let Some(session) = lock(&self.sessions).remove(session_id) {
            for token in lock(&session.running).values() {
                token.cancel();
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
        match method {
            "fs/stat" => {
                let p: FsStatParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || piarc_fs::stat(&s.scope, &p.path, p.detect_image.unwrap_or(false)))
                    .await
            }
            "fs/read" => {
                let p: FsReadParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || match p.mode.unwrap_or(ReadMode::Text) {
                    ReadMode::Text => {
                        piarc_fs::read_text(&s.scope, &p.path, p.offset.unwrap_or(0), p.length)
                    }
                    ReadMode::Blob => piarc_fs::read_blob(&s.scope, &p.path, &s.blob_dir),
                })
                .await
            }
            "fs/write" => {
                let p: FsWriteParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || {
                    piarc_fs::write(&s.scope, &p.path, &p.content, p.append.unwrap_or(false))
                })
                .await
            }
            "fs/mkdir" => {
                let p: FsMkdirParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || piarc_fs::mkdir(&s.scope, &p.path)).await
            }
            "fs/list" => {
                let p: FsListParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || piarc_fs::list(&s.scope, &p.path, p.limit)).await
            }
            "fs/glob" => {
                let p: FsGlobParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || {
                    let exclude = p.exclude.unwrap_or_default();
                    piarc_fs::glob(&s.scope, &p.path, &p.pattern, &exclude, p.limit)
                })
                .await
            }
            "fs/grep" => {
                let p: FsGrepParams = parse(method, params)?;
                let s = self.session(&p.session_id.0)?;
                blocking(move || {
                    let query = GrepQuery {
                        pattern: &p.pattern,
                        glob: p.glob.as_deref(),
                        ignore_case: p.ignore_case.unwrap_or(false),
                        literal: p.literal.unwrap_or(false),
                        context: p.context.unwrap_or(0),
                        limit: p.limit,
                    };
                    piarc_fs::grep(&s.scope, &p.path, &query)
                })
                .await
            }
            "exec/run" => self.exec_run(parse(method, params)?, peer).await,
            "exec/kill" => self.exec_kill(&parse(method, params)?),
            _ => Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not handle {method}"),
                false,
            )),
        }
    }

    async fn exec_run(&self, p: ExecRunParams, peer: Peer) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        let cwd = match &p.cwd {
            Some(cwd) => session
                .scope
                .resolve(cwd)
                .map_err(|e| e.to_error_object())?,
            None => session.scope.cwd().to_path_buf(),
        };
        if !cwd.is_dir() {
            return Err(piarc_fs::Error::NotFound {
                path: piarc_fs::display(&cwd),
            }
            .to_error_object());
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
        let spec = CommandSpec {
            command: p.command,
            cwd,
            env: command_env(&self.config.command_env, p.env.unwrap_or_default()),
            launcher: None,
        };
        let (tx, rx) = mpsc::channel(OUTPUT_BUFFER);
        let watcher = {
            let (peer, token) = (peer.clone(), token.clone());
            tokio::spawn(async move {
                tokio::select! {
                    () = peer.closed() => token.cancel(),
                    () = token.cancelled() => {}
                }
            })
        };
        let forward = forward_output(rx, peer, p.request_id.clone(), token.clone());
        let (exit, ()) = tokio::join!(self.runner.run(spec, tx, token.clone()), forward);
        watcher.abort();
        lock(&session.running).remove(&p.request_id);
        // Starting the shell is what can fail here (the working directory was checked).
        let exit =
            exit.map_err(|e| piarc_fs::Error::io(self.runner.shell(), e).to_error_object())?;
        to_value(&ExecRunResult {
            exit_code: exit.status.code,
            signal: exit.status.signal,
            killed: exit.killed,
        })
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

/// Turns output chunks into `exec/output` notifications, never splitting a UTF-8 sequence; a
/// closed connection cancels the command.
async fn forward_output(
    mut rx: mpsc::Receiver<OutputChunk>,
    peer: Peer,
    request_id: String,
    token: CancellationToken,
) {
    let mut seq = 0_u64;
    let mut pending: HashMap<Stream, Vec<u8>> = HashMap::new();
    let mut send = async |stream: Stream, data: String| {
        if data.is_empty() {
            return;
        }
        seq += 1;
        let params = ExecOutputParams {
            request_id: request_id.clone(),
            stream: match stream {
                Stream::Stdout => OutputStream::Stdout,
                Stream::Stderr => OutputStream::Stderr,
            },
            seq,
            data,
        };
        if peer.notify::<ExecOutput>(params).await.is_err() {
            token.cancel();
        }
    };
    while let Some(chunk) = rx.recv().await {
        let buffer = pending.entry(chunk.stream).or_default();
        buffer.extend_from_slice(&chunk.bytes);
        let complete = buffer.len() - incomplete_utf8_suffix(buffer);
        let rest = buffer.split_off(complete);
        let text = String::from_utf8_lossy(buffer).into_owned();
        *buffer = rest;
        send(chunk.stream, text).await;
    }
    // Whatever is left can no longer complete: U+FFFD.
    for stream in [Stream::Stdout, Stream::Stderr] {
        if let Some(rest) = pending.remove(&stream) {
            send(stream, String::from_utf8_lossy(&rest).into_owned()).await;
        }
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

/// Runs a file operation on the blocking pool.
async fn blocking<T: Serialize + Send + 'static>(
    operation: impl FnOnce() -> piarc_fs::Result<T> + Send + 'static,
) -> Result<Value, ErrorObject> {
    let result = tokio::task::spawn_blocking(operation).await.map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("file operation panicked or was cancelled: {e}"),
            false,
        )
    })?;
    to_value(&result.map_err(|e| e.to_error_object())?)
}

/// Locks `mutex`, recovering the data if a panicking thread poisoned it: every critical
/// section here leaves the maps consistent.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
