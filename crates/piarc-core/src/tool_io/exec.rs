//! `exec/run` and `exec/shells`: shell commands as architecture section 6.11 describes them,
//! with `piarc-exec` doing the work (T17).
//!
//! One command, in order:
//!
//! 1. **Shell.** bash (Git Bash on Windows) or PowerShell, found once per Core
//!    ([`piarc_exec::shells`]); Git Bash may be named in the user's settings
//!    (`shell.gitBashPath` in `<data>/settings.json`; project files cannot choose the program).
//! 2. **Working directory.** An explicit `cwd` (inside the workspace) runs there. Otherwise the
//!    session's remembered shell directory, or the workspace root when that no longer exists.
//!    A bash command without `cwd` carries a [`CwdProbe`]; where it ended becomes the
//!    remembered directory when it lies inside the workspace or an added directory, else the
//!    workspace root (`cwdReset` says so). PowerShell commands do not move it.
//! 3. **Environment.** The login shell's environment without PiArc's variables
//!    ([`CommandEnv`]), resolved on first use and kept; the request's overlay on top; on
//!    Windows `LANG=C.UTF-8` for Git Bash when no locale is set (UTF-8 output, section 15.2).
//! 4. **Run.** [`ProcessTreeSpawner`], the timeout from [`ExecLimits`], stopped with its whole
//!    process tree on timeout, `exec/kill`, interruption or the connection's end.
//! 5. **Output.** Every chunk goes to an [`OutputCapture`] (the model's view, the full text in
//!    `<session tmp>/tool-results/<tool call>.txt` once it outgrows the inline budget) and to
//!    the live view: `exec/output` notifications through a window of [`DISPLAY_WINDOW`] bytes,
//!    so a slow connection skips old output instead of slowing the command.
//! 6. **Outcome.** [`piarc_exec::interpret`] for bash; PowerShell by its exit code.

mod utility;

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use piarc_exec::env::{login_shell_env, strip_internal};
use piarc_exec::shells::{Probe, bash_args, detect, msys_to_windows, powershell_args};
use piarc_exec::{
    CapturedOutput, CommandExit, CommandRunner, CommandSpec, CwdProbe, ExecLimits, Launcher,
    OutputCapture, OutputChunk, ProcessTreeSpawner, Shells, Stream, interpret,
};
use piarc_host::Peer;
use piarc_protocol::exec::{
    CommandOutcome, CommandOutput, CwdReset, CwdResetReason, ExecOutput, ExecOutputParams,
    ExecRunParams, ExecRunResult, ExecShell, ExecShellsResult, ExecTimeout, OutputStream,
};
use piarc_protocol::text::incomplete_utf8_suffix;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::{SessionIo, lock};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;

/// Output chunks waiting for the capture; a full buffer pauses the command's pipes.
const OUTPUT_BUFFER: usize = 16;

/// Bytes of live output waiting for the connection; beyond it the oldest are skipped.
pub const DISPLAY_WINDOW: usize = 256 * 1024;

/// Where Git for Windows comes from (the notice when Git Bash is missing).
const GIT_FOR_WINDOWS_URL: &str = "https://git-scm.com/download/win";

/// Where commands get their environment.
#[derive(Debug, Clone)]
pub enum CommandEnv {
    /// The environment the user's login shell builds from `base` (Core's own environment in
    /// production), without PiArc's variables; on Windows `base` itself, stripped.
    LoginShell {
        /// The environment the login shell starts with.
        base: Vec<(OsString, OsString)>,
    },
    /// Exactly these variables, stripped the same way (tests).
    Fixed(Vec<(OsString, OsString)>),
}

impl CommandEnv {
    /// The production source: the login shell of Core's own environment.
    #[must_use]
    pub fn login_shell() -> Self {
        Self::LoginShell {
            base: std::env::vars_os().collect(),
        }
    }

    /// Core's own environment, stripped, without asking a login shell.
    #[must_use]
    pub fn process() -> Self {
        Self::Fixed(std::env::vars_os().collect())
    }
}

/// The command side of [`super::ToolIo`]: shared by all sessions.
pub(super) struct Exec {
    runner: CommandRunner,
    limits: ExecLimits,
    env: CommandEnv,
    resolved: tokio::sync::OnceCell<Arc<Vec<(OsString, OsString)>>>,
    shells: OnceLock<Shells>,
    #[cfg(windows)]
    git_utilities: tokio::sync::OnceCell<Vec<String>>,
    data_dir: PathBuf,
    notices: Option<EventSender>,
    notified: AtomicBool,
}

impl Exec {
    pub(super) fn new(
        limits: ExecLimits,
        env: CommandEnv,
        data_dir: PathBuf,
        notices: Option<EventSender>,
    ) -> Self {
        Self {
            runner: CommandRunner::new(Arc::new(ProcessTreeSpawner)),
            limits,
            env,
            resolved: tokio::sync::OnceCell::new(),
            shells: OnceLock::new(),
            #[cfg(windows)]
            git_utilities: tokio::sync::OnceCell::new(),
            data_dir,
            notices,
            notified: AtomicBool::new(false),
        }
    }

    /// The base environment of every command, resolved once.
    pub(super) async fn base_env(&self) -> Arc<Vec<(OsString, OsString)>> {
        let resolved = self
            .resolved
            .get_or_init(|| async {
                let env = match &self.env {
                    CommandEnv::Fixed(env) => env.clone(),
                    CommandEnv::LoginShell { base } if cfg!(windows) => base.clone(),
                    CommandEnv::LoginShell { base } => {
                        let home = base
                            .iter()
                            .find(|(k, _)| k == "HOME")
                            .map_or_else(std::env::temp_dir, |(_, v)| PathBuf::from(v));
                        match login_shell_env(&self.runner, base, &home).await {
                            Ok(env) => env,
                            Err(error) => {
                                tracing::warn!(target: "piarc_core", %error,
                                    "commands use Core's own environment");
                                base.clone()
                            }
                        }
                    }
                };
                Arc::new(strip_internal(env))
            })
            .await;
        Arc::clone(resolved)
    }

    fn shells(&self) -> &Shells {
        self.shells.get_or_init(|| {
            let env: Vec<_> = std::env::vars_os().collect();
            let setting = git_bash_setting(&self.data_dir);
            let shells = detect(&Probe::system(&env), setting.as_deref());
            tracing::info!(target: "piarc_core", bash = ?shells.bash,
                powershell = ?shells.powershell, "shells for commands");
            shells
        })
    }

    /// `exec/shells`; tells the user once per Core when Windows has no Git Bash.
    pub(super) async fn answer_shells(&self) -> ExecShellsResult {
        let shells = self.shells();
        let result = ExecShellsResult {
            bash: shells.bash.is_some(),
            powershell: shells.powershell.is_some(),
        };
        if !result.bash && !self.notified.swap(true, Ordering::SeqCst) {
            self.notify_missing_bash(shells).await;
        }
        result
    }

    async fn notify_missing_bash(&self, shells: &Shells) {
        let searched: Vec<String> = shells
            .bash_searched
            .iter()
            .map(|p| piarc_fs::display(p))
            .collect();
        let notice = json!({
            "type": "gitBashMissing",
            "message": "Git Bash was not found, so sessions run commands with PowerShell only. \
                        Install Git for Windows (or set shell.gitBashPath in PiArc's settings) \
                        and reopen the workspace to get the Bash tool.",
            "searched": searched,
            "downloadUrl": GIT_FOR_WINDOWS_URL,
        });
        tracing::warn!(target: "piarc_core", ?searched, "Git Bash not found");
        if let Some(events) = &self.notices
            && let Ok(event) = Event::from_json(RouteKey::notices(), &notice)
        {
            // Only a Core shutting down refuses it.
            let _ = events.send(event).await;
        }
    }

    /// Runs one command for `session` (see the module documentation).
    pub(super) async fn run(
        &self,
        session: &SessionIo,
        p: ExecRunParams,
        launch: Launch,
        wrap: Wrap,
        peer: Peer,
        token: CancellationToken,
    ) -> Result<ExecRunResult, ErrorObject> {
        let kind = p.shell.unwrap_or(ExecShell::Bash);
        let program = self.program(kind)?;
        let (env, probe) = self
            .command_env(session, &p, kind, &launch, wrap.env)
            .await?;
        let args = match kind {
            ExecShell::Bash => bash_args(&p.command),
            ExecShell::Powershell => powershell_args(&program, &p.command),
        };
        let timeout = self.limits.timeout(p.timeout_ms.map(Duration::from_millis));
        let spec = CommandSpec {
            program: program.clone(),
            args,
            cwd: launch.dir.clone(),
            env,
            launcher: wrap.launcher,
            timeout: Some(timeout.duration),
            kill_grace: self.limits.kill_grace,
        };
        let spill_name = p
            .origin
            .as_ref()
            .map_or_else(|| p.request_id.clone(), |o| o.tool_call_id.clone());
        let started = Instant::now();
        let (exit, capture) = self
            .execute(
                spec,
                session.tmp_dir.clone(),
                &spill_name,
                &p.request_id,
                peer,
                token,
            )
            .await;
        let exit = exit.map_err(|e| piarc_fs::Error::io(&program, e).to_error_object())?;
        let duration = started.elapsed();
        let reading = match kind {
            ExecShell::Bash => interpret(&p.command, exit.status.code),
            ExecShell::Powershell => piarc_exec::Interpretation {
                success: exit.status.success(),
                meaning: None,
            },
        };
        let success = !exit.killed && !exit.timed_out && reading.success;
        let mut reset = launch.reset;
        if let Some(probe) = probe {
            reset = reset.or_else(|| remember_cwd(session, probe.finish()));
        }
        Ok(ExecRunResult {
            exit_code: exit.status.code,
            signal: exit.status.signal,
            killed: exit.killed,
            timed_out: Some(exit.timed_out),
            timeout: Some(ExecTimeout {
                ms: millis(timeout.duration),
                requested_ms: timeout
                    .capped
                    .then(|| timeout.requested.map(millis))
                    .flatten(),
            }),
            duration_ms: Some(millis(duration)),
            outcome: Some(if success {
                CommandOutcome::Success
            } else {
                CommandOutcome::Failure
            }),
            meaning: success
                .then_some(reading.meaning)
                .flatten()
                .map(str::to_owned),
            cwd: Some(piarc_fs::display(&launch.dir)),
            cwd_reset: reset,
            output: Some(command_output(capture.finish(success))),
        })
    }

    /// The command's environment, with the directory probe of a tracked bash command.
    async fn command_env(
        &self,
        session: &SessionIo,
        p: &ExecRunParams,
        kind: ExecShell,
        launch: &Launch,
        sandbox_env: Vec<(OsString, OsString)>,
    ) -> Result<(Vec<(OsString, OsString)>, Option<CwdProbe>), ErrorObject> {
        let mut env = super::command_env(&self.base_env().await, p.env.clone().unwrap_or_default());
        env = super::overlay_env(env, sandbox_env);
        let probe = if launch.tracked && kind == ExecShell::Bash {
            let user = env
                .iter()
                .find(|(k, _)| k == "BASH_ENV")
                .map(|(_, v)| v.to_string_lossy().into_owned());
            let (probe, variable) = CwdProbe::prepare(
                &session.tmp_dir.join("exec"),
                &p.request_id,
                user.as_deref(),
            )
            .map_err(|e| piarc_fs::Error::io(&session.tmp_dir, e).to_error_object())?;
            if let Some(utility) = &launch.pinned_utility {
                if user.as_deref().is_some_and(|v| !v.is_empty()) {
                    return Err(super::policy::denied(
                        "Bash startup changed since automatic approval. Request approval again.",
                    ));
                }
                probe
                    .pin_utility(utility)
                    .map_err(|e| piarc_fs::Error::io(utility, e).to_error_object())?;
            }
            env = super::overlay_env(env, vec![variable]);
            Some(probe)
        } else {
            None
        };
        if cfg!(windows) && kind == ExecShell::Bash && !has_locale(&env) {
            env.push(("LANG".into(), "C.UTF-8".into()));
        }
        Ok((env, probe))
    }

    fn program(&self, kind: ExecShell) -> Result<PathBuf, ErrorObject> {
        let shells = self.shells();
        let (found, missing) = match kind {
            ExecShell::Bash => (
                shells.bash.clone(),
                "bash was not found: on Windows install Git for Windows (Git Bash)",
            ),
            ExecShell::Powershell => (
                shells.powershell.clone(),
                "PowerShell is only available on Windows",
            ),
        };
        found.ok_or_else(|| ErrorObject::new(ErrorKind::InvalidParams, missing, false))
    }

    /// Runs `spec`, feeding the capture and the live view; returns when both are done.
    async fn execute(
        &self,
        spec: CommandSpec,
        tmp_dir: PathBuf,
        spill_name: &str,
        request_id: &str,
        peer: Peer,
        token: CancellationToken,
    ) -> (std::io::Result<CommandExit>, OutputCapture) {
        let name = spill_name.to_owned();
        let target: piarc_exec::SpillTarget = Box::new(move || {
            let (file, path) = piarc_fs::create_spill(&tmp_dir, &name)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            Ok((
                Box::new(file) as Box<dyn std::io::Write + Send>,
                piarc_fs::model_path(&path),
            ))
        });
        let mut capture = OutputCapture::new(self.limits, target);
        let display = Arc::new(Display::default());
        let (tx, mut rx) = mpsc::channel::<OutputChunk>(OUTPUT_BUFFER);
        let consume = {
            let display = Arc::clone(&display);
            async move {
                while let Some(chunk) = rx.recv().await {
                    capture.push(chunk.stream, &chunk.bytes);
                    display.push(chunk.stream, chunk.bytes);
                }
                display.close();
                capture
            }
        };
        let forward = display.forward(peer, request_id.to_owned(), token.clone());
        let (exit, capture, ()) = tokio::join!(self.runner.run(spec, tx, token), consume, forward);
        (exit, capture)
    }
}

/// What a sandbox adds around a command: its wrapper program and variables.
#[derive(Default)]
pub(super) struct Wrap {
    pub launcher: Option<Launcher>,
    pub env: Vec<(OsString, OsString)>,
}

/// Where a command starts, and whether it moves the session's remembered directory.
pub(super) struct Launch {
    pub dir: PathBuf,
    pub tracked: bool,
    /// Physical utility selected by automatic preflight, pinned in the bash startup file.
    pub pinned_utility: Option<PathBuf>,
    /// The remembered directory was gone and the command starts at the root instead.
    pub reset: Option<CwdReset>,
}

/// The working directory of a command of `session`: `requested`, or the remembered one.
pub(super) fn launch_dir(
    session: &SessionIo,
    requested: Option<&str>,
) -> Result<Launch, ErrorObject> {
    if let Some(requested) = requested {
        let dir = session
            .scope
            .resolve(requested)
            .map_err(|e| e.to_error_object())?;
        if !dir.is_dir() {
            return Err(piarc_fs::Error::NotFound {
                path: piarc_fs::display(&dir),
            }
            .to_error_object());
        }
        return Ok(Launch {
            dir,
            tracked: false,
            pinned_utility: None,
            reset: None,
        });
    }
    let mut remembered = lock(&session.shell_cwd);
    let mut reset = None;
    if !remembered.is_dir() {
        let root = session.scope.root().to_path_buf();
        reset = Some(CwdReset {
            ended_in: piarc_fs::display(&remembered),
            reset_to: piarc_fs::display(&root),
            reason: CwdResetReason::Missing,
        });
        *remembered = root;
    }
    Ok(Launch {
        dir: remembered.clone(),
        tracked: true,
        pinned_utility: None,
        reset,
    })
}

/// Records where a bash command ended (`ended`, as the shell printed it): kept when inside the
/// workspace or an added directory, else the workspace root and the reason.
fn remember_cwd(session: &SessionIo, ended: Option<String>) -> Option<CwdReset> {
    let ended = ended?;
    let local = if cfg!(windows) {
        msys_to_windows(&ended)
    } else {
        Some(ended.clone())
    };
    let inside = local
        .as_deref()
        .and_then(|path| session.scope.resolve(path).ok())
        .filter(|dir| dir.is_dir());
    let mut remembered = lock(&session.shell_cwd);
    match inside {
        Some(dir) => {
            *remembered = dir;
            None
        }
        None => {
            let root = session.scope.root().to_path_buf();
            *remembered = root.clone();
            Some(CwdReset {
                ended_in: local.unwrap_or(ended),
                reset_to: piarc_fs::display(&root),
                reason: CwdResetReason::OutsideWorkspace,
            })
        }
    }
}

fn command_output(out: CapturedOutput) -> CommandOutput {
    CommandOutput {
        omitted_chars: out.tail.is_some().then_some(out.omitted_chars),
        head: out.head,
        tail: out.tail,
        total_chars: out.total_chars,
        full_output_path: out.full_output_path,
        save_error: out.spill_error,
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn has_locale(env: &[(OsString, OsString)]) -> bool {
    env.iter().any(|(k, _)| {
        ["LANG", "LC_ALL", "LC_CTYPE"]
            .iter()
            .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
    })
}

/// `shell.gitBashPath` of the user's settings file, when it names a path.
fn git_bash_setting(data_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(data_dir.join("settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .pointer("/shell/gitBashPath")
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// The live view of a command's output: chunks in the order they were read, at most
/// [`DISPLAY_WINDOW`] bytes waiting; older chunks are dropped and counted.
#[derive(Default)]
struct Display {
    state: Mutex<DisplayState>,
    notify: Notify,
}

#[derive(Default)]
struct DisplayState {
    queue: VecDeque<(Stream, Vec<u8>)>,
    bytes: usize,
    skipped: [u64; 2],
    closed: bool,
}

fn index(stream: Stream) -> usize {
    usize::from(stream == Stream::Stderr)
}

impl Display {
    fn push(&self, stream: Stream, bytes: Vec<u8>) {
        {
            let mut state = lock(&self.state);
            state.bytes += bytes.len();
            state.queue.push_back((stream, bytes));
            while state.bytes > DISPLAY_WINDOW && state.queue.len() > 1 {
                if let Some((old, dropped)) = state.queue.pop_front() {
                    state.bytes -= dropped.len();
                    state.skipped[index(old)] += dropped.len() as u64;
                }
            }
        }
        self.notify.notify_one();
    }

    fn close(&self) {
        lock(&self.state).closed = true;
        self.notify.notify_one();
    }

    /// Sends what arrives as `exec/output` until the capture is done; a connection that is
    /// gone stops the command.
    async fn forward(self: Arc<Self>, peer: Peer, request_id: String, token: CancellationToken) {
        let mut seq = 0_u64;
        let mut carry: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
        loop {
            let (batch, skipped, closed) = {
                let mut state = lock(&self.state);
                state.bytes = 0;
                (
                    std::mem::take(&mut state.queue),
                    std::mem::take(&mut state.skipped),
                    state.closed,
                )
            };
            if batch.is_empty() && !closed {
                self.notify.notified().await;
                continue;
            }
            let mut skipped = skipped;
            for (stream, mut bytes) in batch {
                let i = index(stream);
                let mut gap = std::mem::take(&mut skipped[i]);
                if gap > 0 {
                    // The dropped chunks may have ended inside a character.
                    gap += carry[i].len() as u64;
                    carry[i].clear();
                    let partial = bytes.iter().take_while(|&&b| b & 0xC0 == 0x80).count();
                    bytes.drain(..partial);
                    gap += partial as u64;
                }
                carry[i].extend_from_slice(&bytes);
                let complete = carry[i].len() - incomplete_utf8_suffix(&carry[i]);
                let rest = carry[i].split_off(complete);
                let text = String::from_utf8_lossy(&carry[i]).into_owned();
                carry[i] = rest;
                self.send(&peer, &request_id, &token, &mut seq, stream, text, gap)
                    .await;
            }
            if closed {
                for stream in [Stream::Stdout, Stream::Stderr] {
                    let rest = std::mem::take(&mut carry[index(stream)]);
                    let text = String::from_utf8_lossy(&rest).into_owned();
                    self.send(&peer, &request_id, &token, &mut seq, stream, text, 0)
                        .await;
                }
                return;
            }
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one notification's fields and its counter"
    )]
    async fn send(
        &self,
        peer: &Peer,
        request_id: &str,
        token: &CancellationToken,
        seq: &mut u64,
        stream: Stream,
        data: String,
        skipped: u64,
    ) {
        if data.is_empty() && skipped == 0 {
            return;
        }
        *seq += 1;
        let params = ExecOutputParams {
            request_id: request_id.to_owned(),
            stream: match stream {
                Stream::Stdout => OutputStream::Stdout,
                Stream::Stderr => OutputStream::Stderr,
            },
            seq: *seq,
            data,
            skipped: (skipped > 0).then_some(skipped),
        };
        if peer.notify::<ExecOutput>(params).await.is_err() {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;
    use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};

    #[derive(Default)]
    struct Collect(StdMutex<Vec<(String, Value)>>);

    use serde_json::Value;

    impl EventSink for Collect {
        fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
            let mut seen = self.0.lock().expect("sink");
            for batch in batches {
                let events: Vec<Value> =
                    serde_json::from_slice(&batch.payload).expect("JSON array");
                for event in events {
                    seen.push((batch.route.as_str().to_owned(), event));
                }
            }
            drop(done);
            Ok(())
        }
    }

    /// T17-A11 (Core side): without Git Bash, `exec/shells` answers no bash and the user gets
    /// one `core/notices` event naming the places searched.
    #[tokio::test]
    async fn a_missing_git_bash_is_announced_once() {
        let sink = Arc::new(Collect::default());
        let close = CancellationToken::new();
        let (events, coalescer, _) =
            crate::events::channel(Duration::from_millis(1), sink.clone(), close.clone());
        let coalescing = tokio::spawn(coalescer.run());
        let exec = Exec::new(
            ExecLimits::default(),
            CommandEnv::Fixed(Vec::new()),
            std::env::temp_dir(),
            Some(events),
        );
        let searched = PathBuf::from("C:/Program Files/Git/bin/bash.exe");
        let _ = exec.shells.set(Shells {
            bash: None,
            powershell: Some(PathBuf::from("pwsh.exe")),
            bash_searched: vec![searched.clone()],
        });
        let first = exec.answer_shells().await;
        let second = exec.answer_shells().await;
        assert_eq!((first.bash, first.powershell), (false, true));
        assert_eq!(second, first);
        drop(exec);
        close.cancel();
        coalescing.await.expect("coalescer");
        let seen = sink.0.lock().expect("sink").clone();
        assert_eq!(seen.len(), 1, "{seen:?}");
        let (route, notice) = &seen[0];
        assert_eq!(route, "core/notices");
        assert_eq!(notice["type"], "gitBashMissing");
        assert_eq!(notice["downloadUrl"], GIT_FOR_WINDOWS_URL);
        assert_eq!(notice["searched"][0], piarc_fs::display(&searched));
    }

    #[test]
    fn reads_the_git_bash_setting_from_the_user_file() {
        let dir =
            std::env::temp_dir().join(format!("piarc-gitbash-setting {}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        assert_eq!(git_bash_setting(&dir), None);
        std::fs::write(
            dir.join("settings.json"),
            r#"{ "shell": { "gitBashPath": "D:\\Git\\bin\\bash.exe" } }"#,
        )
        .expect("settings");
        assert_eq!(
            git_bash_setting(&dir),
            Some(PathBuf::from(r"D:\Git\bin\bash.exe"))
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
