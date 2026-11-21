//! Terminals of a session (T33, ADR-0050): each is a background task of kind `terminal`.
//!
//! - **Screen file.** `<data dir>/sessions/<owner>/tasks/<task id>.log` holds the screen as
//!   text — a short header naming the terminal and its last command, then the formatter's
//!   text of the scrollback and screen — while the model may see the terminal (its own, or a
//!   user's that is shared). It is rewritten at most every [`VIEW_INTERVAL`] while output
//!   arrives, and at once before a notice and before the task's output is read.
//! - **Snapshot.** `<data dir>/sessions/<owner>/terminals/<task id>.snap` (`piarc_term::snapshot`)
//!   is written every [`SAVE_INTERVAL`] while output arrives and when PiArc quits; it goes
//!   away when the user closes the terminal and with the session's directory.
//! - **The model's command.** A terminal the model opened types its command once, after the
//!   first prompt (or after [`PROMPT_WAIT`]); when that command ends (OSC 133) the session gets
//!   a `backgroundTask` reminder. The shell stays for the user.
//! - **Ending.** The task's cancellation (KillShell, the stop button, the session archived or
//!   deleted, PiArc quitting) closes the terminal; the shell's exit ends the task.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use piarc_ports::BoxFuture;
use piarc_protocol::tasks::TerminalOrigin;
use piarc_term::commands::{CommandChange, CommandInfo, CommandState};
use piarc_term::snapshot::{Restored, Saved};
use piarc_term::vt::{TextOptions, TextRange};
use piarc_term::{Event as TermEvent, Program, Session, SessionConfig};
use tokio::runtime::Handle;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{
    Inner, SCROLLBACK_LINES, Terminals, check_size, clipboard_write_allowed, guarded, lock,
};
use crate::error::{Error, Result};
use crate::tasks::{Ended, NewTerminal, Reserved, StopBy, TaskManager, TerminalViews};

/// How often a changed screen is written to the screen file.
pub(crate) const VIEW_INTERVAL: Duration = Duration::from_millis(500);
/// How often a changed terminal's snapshot is saved.
pub(crate) const SAVE_INTERVAL: Duration = Duration::from_secs(30);
/// How long a terminal the model opened waits for the shell's first prompt before typing.
pub(crate) const PROMPT_WAIT: Duration = Duration::from_secs(10);
/// Lines of the screen a reminder quotes.
const NOTICE_LINES: u32 = 10;

/// A terminal of a session, as the tool I/O describes it.
#[derive(Debug, Clone)]
pub(crate) struct BoundSpec {
    pub session_id: String,
    pub owner_session_id: String,
    pub workspace: String,
    /// The session's shell directory.
    pub cwd: PathBuf,
    /// The whole environment (T17's construction); nothing else is inherited.
    pub env: Vec<(String, String)>,
    /// A sandboxed session's wrapper program and its arguments.
    pub launcher: Option<(String, Vec<String>)>,
    /// The shell; the user's shell when unset.
    pub shell: Option<String>,
    /// Start it as a login shell.
    pub login: bool,
    pub origin: TerminalOrigin,
    pub title: String,
    /// The model's command, typed once.
    pub command: Option<String>,
    pub tool_call_id: Option<String>,
    /// Columns, rows, cell width and height in pixels.
    pub size: (u16, u16, u32, u32),
    /// The task id of a terminal saved earlier, to continue from its snapshot.
    pub restore: Option<String>,
}

impl BoundSpec {
    /// The task this terminal runs as: terminal `id`, its screen file under `owner_dir`.
    fn new_terminal(&self, id: u32, owner_dir: &Path) -> NewTerminal {
        NewTerminal {
            session_id: self.session_id.clone(),
            owner_session_id: self.owner_session_id.clone(),
            workspace: self.workspace.clone(),
            title: self.title.clone(),
            command: self.command.clone(),
            cwd: piarc_fs::display(&self.cwd),
            tool_call_id: self.tool_call_id.clone(),
            origin: self.origin,
            terminal_id: id,
            output_dir: owner_dir.join("tasks"),
        }
    }
}

/// A session terminal that was opened.
#[derive(Debug, Clone)]
pub(crate) struct Opened {
    pub terminal_id: u32,
    pub task_id: String,
    /// The screen file as the model is told it.
    pub output_path: String,
    /// How a saved terminal came back, when one was asked for and found.
    pub restored: Option<Restored>,
}

#[derive(Default)]
struct AgentCommand {
    /// The command was typed.
    typed: bool,
    /// The number the shell gave it.
    seq: Option<u64>,
    notified: bool,
}

/// The parts of a session terminal its IO thread touches. It holds the task side strongly:
/// the shell's exit must end the task even after the terminal left the registry (closed).
pub(super) struct Hooks {
    prompt: Notify,
    agent: Mutex<AgentCommand>,
    bound: OnceLock<Arc<Bound>>,
    handle: Handle,
}

/// A session terminal's task side.
pub(super) struct Bound {
    pub(super) task_id: String,
    pub(super) session_id: String,
    origin: TerminalOrigin,
    shared: AtomicBool,
    title: String,
    command: Option<String>,
    view: PathBuf,
    output_path: String,
    snapshot: PathBuf,
    tasks: TaskManager,
    /// Bytes read when the screen file and the snapshot were last written.
    view_mark: AtomicU64,
    save_mark: AtomicU64,
    last_save: Mutex<Instant>,
    share_count: AtomicU64,
    session: OnceLock<Weak<Session>>,
}

/// The task manager's way to have a screen file rewritten before it is read.
pub(super) struct Views(pub(super) Weak<Inner>);

impl TerminalViews for Views {
    fn refresh(&self, task_id: &str) -> BoxFuture<'static, ()> {
        let found = self.0.upgrade().and_then(|inner| {
            lock(&inner.entries)
                .values()
                .find(|e| e.bound.as_ref().is_some_and(|b| b.task_id == task_id))
                .map(|e| {
                    (
                        Arc::clone(&e.session),
                        e.bound.clone(),
                        inner.handle.clone(),
                    )
                })
        });
        Box::pin(async move {
            if let Some((session, Some(bound), handle)) = found {
                let _ = handle
                    .spawn_blocking(move || bound.write_view(&session))
                    .await;
            }
        })
    }
}

impl Terminals {
    /// Opens a terminal of a session as a background task (blocking pool).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`] without Core's state; [`Error::InvalidArgument`] for a
    /// size out of range; the terminal's own errors when it cannot start (the task is then
    /// recorded as failed).
    pub(crate) async fn open(&self, spec: BoundSpec) -> Result<Opened> {
        check_size(spec.size.0, spec.size.1)?;
        let me = self.clone();
        self.inner
            .handle
            .spawn_blocking(move || guarded("terminal open", || me.open_blocking(spec)))
            .await
            .map_err(|e| Error::Internal {
                reason: e.to_string(),
            })?
    }

    fn open_blocking(&self, spec: BoundSpec) -> Result<Opened> {
        let context = self.inner.context.get().ok_or(Error::NoDataDirectory)?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let owner_dir = context
            .data_dir
            .join("sessions")
            .join(&spec.owner_session_id);
        let cancel = CancellationToken::new();
        let reserved = context
            .tasks
            .register_terminal(spec.new_terminal(id, &owner_dir), cancel.clone())
            .map_err(|e| Error::feature(&e))?;
        let hooks = Arc::new(Hooks {
            prompt: Notify::new(),
            agent: Mutex::new(AgentCommand::default()),
            bound: OnceLock::new(),
            handle: self.inner.handle.clone(),
        });
        let terminals_dir = owner_dir.join("terminals");
        let saved = spec
            .restore
            .as_ref()
            .and_then(|old| Saved::read_from(&terminals_dir.join(format!("{old}.snap"))).ok());
        let config = self.config(&spec, context, saved.clone());
        let spawned = self
            .event_handler(id, Some(Arc::clone(&hooks)))
            .and_then(|handler| Ok(Session::spawn_restored(config, handler)?));
        let (session, restored) = match spawned {
            Ok(spawned) => spawned,
            Err(error) => {
                context.tasks.ended(
                    &reserved.task_id,
                    Ended {
                        error: Some(error.to_string()),
                        ..Ended::default()
                    },
                );
                return Err(error);
            }
        };
        if restored.is_some()
            && let Some(old) = &spec.restore
        {
            // The new terminal saves under its own task id from now on.
            let _ = std::fs::remove_file(terminals_dir.join(format!("{old}.snap")));
        }
        let snapshot = terminals_dir.join(format!("{}.snap", reserved.task_id));
        let bound = Arc::new(Bound::new(
            &spec,
            &reserved,
            snapshot,
            context.tasks.clone(),
        ));
        let _ = hooks.bound.set(Arc::clone(&bound));
        let entry = self.insert(id, session, Some(Arc::clone(&bound)));
        let _ = bound.session.set(Arc::downgrade(&entry.session));
        if entry.session.exit().is_some() {
            // The shell ended before the hooks knew the task: end it now (a second end is
            // ignored by the task manager).
            let late = Arc::clone(&bound);
            self.inner.handle.spawn_blocking(move || late.exited());
        }
        self.inner.handle.spawn(watch(
            self.clone(),
            id,
            Arc::clone(&bound),
            Arc::clone(&entry.session),
            cancel,
        ));
        if let Some(command) = spec.command {
            self.inner.handle.spawn(type_command(
                Arc::clone(&hooks),
                Arc::clone(&entry.session),
                command,
            ));
        }
        Ok(Opened {
            terminal_id: id,
            task_id: reserved.task_id,
            output_path: reserved.output_path,
            restored: saved.and(restored),
        })
    }

    /// The session configuration of `spec`: its shell with PiArc's integration (inside the
    /// sandbox wrapper when there is one), the given environment only.
    fn config(
        &self,
        spec: &BoundSpec,
        context: &super::Context,
        restore: Option<Saved>,
    ) -> SessionConfig {
        let shell = spec.shell.clone().unwrap_or_else(piarc_term::default_shell);
        let zdotdir = spec
            .env
            .iter()
            .find(|(k, _)| k == "ZDOTDIR")
            .map(|(_, v)| v.as_str());
        let launch = context
            .integration
            .as_ref()
            .and_then(|i| i.launch(&shell, spec.login, zdotdir));
        let (program, mut args, extra) = match launch {
            Some(launch) => (launch.program, launch.args, launch.env),
            None if spec.login && cfg!(unix) => (shell, vec!["-l".to_owned()], Vec::new()),
            None => (shell, Vec::new(), Vec::new()),
        };
        let (program, args) = match &spec.launcher {
            Some((wrapper, wrapper_args)) => {
                let mut all = wrapper_args.clone();
                all.push(program);
                all.append(&mut args);
                (wrapper.clone(), all)
            }
            None => (program, args),
        };
        let mut env = spec.env.clone();
        env.extend(extra);
        let (cols, rows, cell_width, cell_height) = spec.size;
        SessionConfig {
            cols,
            rows,
            cell_width,
            cell_height,
            program: Program::Command { program, args },
            cwd: Some(spec.cwd.clone()),
            env,
            clear_env: true,
            scrollback_lines: SCROLLBACK_LINES,
            clipboard_write: clipboard_write_allowed(Some(&context.data_dir)),
            restore,
            now: None,
        }
    }

    /// Shares a user's terminal of a session with the model, or stops sharing it (ADR-0050
    /// rule 5); returns whether anything changed.
    pub(crate) async fn set_shared(&self, id: u32, shared: bool) -> Result<bool> {
        let entry = self.entry(id)?;
        let Some(bound) = entry.bound.clone() else {
            return Err(Error::InvalidArgument {
                field: "terminalId",
                reason: "only a terminal of a session can be shared".into(),
            });
        };
        if bound.origin != TerminalOrigin::User
            || bound
                .tasks
                .set_terminal_shared(&bound.task_id, shared)
                .is_none()
        {
            return Ok(false);
        }
        bound.shared.store(shared, Ordering::Release);
        let session = Arc::clone(&entry.session);
        let task = Arc::clone(&bound);
        self.inner
            .handle
            .spawn_blocking(move || {
                if shared {
                    task.write_view(&session);
                    task.share_notice();
                } else {
                    task.remove_view();
                }
            })
            .await
            .map_err(|e| Error::Internal {
                reason: e.to_string(),
            })?;
        Ok(true)
    }
}

/// Keeps a session terminal's files current until its task is stopped or the shell exits.
async fn watch(
    terminals: Terminals,
    id: u32,
    bound: Arc<Bound>,
    session: Arc<Session>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            () = tokio::time::sleep(VIEW_INTERVAL) => {}
            () = cancel.cancelled() => {
                let keep = bound.tasks.stop_reason(&bound.task_id) == Some(StopBy::Shutdown);
                let _ = tokio::task::spawn_blocking(move || terminals.close_now(id, keep)).await;
                return;
            }
        }
        if session.exit().is_some() {
            return;
        }
        let (b, s) = (Arc::clone(&bound), Arc::clone(&session));
        let _ = tokio::task::spawn_blocking(move || {
            b.write_view_if_changed(&s);
            b.save_if_due(&s);
        })
        .await;
    }
}

/// Types the model's command once the shell shows its first prompt.
async fn type_command(hooks: Arc<Hooks>, session: Arc<Session>, command: String) {
    let _ = tokio::time::timeout(PROMPT_WAIT, hooks.prompt.notified()).await;
    lock(&hooks.agent).typed = true;
    if let Err(error) = session.write(format!("{command}\r").into_bytes()) {
        tracing::warn!(target: "piarc_core::terminal", %error, "cannot type the command into the terminal");
    }
}

impl Hooks {
    /// Runs on the terminal's IO thread: must not block.
    pub(super) fn on_event(&self, event: &TermEvent) {
        match event {
            TermEvent::Pwd(_) => self.prompt.notify_one(),
            TermEvent::Command(CommandChange::Started { seq, .. }) => {
                let mut agent = lock(&self.agent);
                if agent.typed && agent.seq.is_none() {
                    agent.seq = Some(*seq);
                }
            }
            TermEvent::Command(CommandChange::Finished { seq, .. }) => {
                let finished = {
                    let mut agent = lock(&self.agent);
                    let ours = agent.seq == Some(*seq) && !agent.notified;
                    agent.notified |= ours;
                    ours
                };
                if finished && let Some(bound) = self.bound.get().cloned() {
                    let seq = *seq;
                    self.handle
                        .spawn_blocking(move || bound.command_finished(seq));
                }
            }
            TermEvent::Exited { .. } => {
                if let Some(bound) = self.bound.get().cloned() {
                    self.handle.spawn_blocking(move || bound.exited());
                }
            }
            _ => {}
        }
    }
}

impl Bound {
    fn new(spec: &BoundSpec, reserved: &Reserved, snapshot: PathBuf, tasks: TaskManager) -> Self {
        Self {
            task_id: reserved.task_id.clone(),
            session_id: spec.session_id.clone(),
            origin: spec.origin,
            shared: AtomicBool::new(false),
            title: spec.title.clone(),
            command: spec.command.clone(),
            view: reserved.file.clone(),
            output_path: reserved.output_path.clone(),
            snapshot,
            tasks,
            view_mark: AtomicU64::new(u64::MAX),
            save_mark: AtomicU64::new(0),
            last_save: Mutex::new(Instant::now()),
            share_count: AtomicU64::new(0),
            session: OnceLock::new(),
        }
    }

    /// The model may see this terminal: its own, or a user's that is shared.
    pub(super) fn is_shared(&self) -> bool {
        self.origin == TerminalOrigin::Agent || self.shared.load(Ordering::Acquire)
    }

    fn session(&self) -> Option<Arc<Session>> {
        self.session.get().and_then(Weak::upgrade)
    }

    fn write_view_if_changed(&self, session: &Session) {
        if self.session_bytes(session) != self.view_mark.load(Ordering::Acquire) {
            self.write_view(session);
        }
    }

    fn session_bytes(&self, session: &Session) -> u64 {
        session.stats().bytes_read
    }

    /// Rewrites the screen file (blocking: it formats the terminal), when the model may see
    /// the terminal.
    pub(super) fn write_view(&self, session: &Session) {
        if !self.is_shared() {
            return;
        }
        let mark = self.session_bytes(session);
        let text = match self.view_text(session) {
            Ok(text) => text,
            Err(error) => {
                tracing::warn!(target: "piarc_core::terminal", %error, "cannot read the terminal's screen");
                return;
            }
        };
        if let Err(error) = write_atomically(&self.view, text.as_bytes()) {
            tracing::warn!(target: "piarc_core::terminal", %error, "cannot write the terminal's screen file");
            return;
        }
        self.view_mark.store(mark, Ordering::Release);
        let tail: Vec<String> = text
            .lines()
            .rev()
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .map(str::to_owned)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.tasks.terminal_view_written(
            &self.task_id,
            u64::try_from(text.len()).unwrap_or(u64::MAX),
            tail,
        );
    }

    fn view_text(&self, session: &Session) -> Result<String> {
        let last = session.last_command()?;
        let screen = session.text(
            TextRange::All,
            TextOptions {
                unwrap: true,
                trim: true,
            },
        )?;
        Ok(format!(
            "{}\n\n{screen}\n",
            view_header(&self.task_id, &self.title, last.as_ref(), session.exit())
        ))
    }

    pub(super) fn remove_view(&self) {
        let _ = std::fs::remove_file(&self.view);
    }

    fn save_if_due(&self, session: &Session) {
        let bytes = self.session_bytes(session);
        let due = lock(&self.last_save).elapsed() >= SAVE_INTERVAL;
        if due && bytes != self.save_mark.load(Ordering::Acquire) {
            self.save(session);
        }
    }

    fn save(&self, session: &Session) {
        let bytes = self.session_bytes(session);
        let saved = session
            .save()
            .and_then(|saved| saved.write_to(&self.snapshot));
        match saved {
            Ok(()) => {
                self.save_mark.store(bytes, Ordering::Release);
                *lock(&self.last_save) = Instant::now();
            }
            Err(error) => {
                tracing::warn!(target: "piarc_core::terminal", %error, "cannot save the terminal");
            }
        }
    }

    /// The terminal leaves the registry: `keep` saves its snapshot (PiArc quits), else the
    /// snapshot goes (the terminal was closed for good).
    pub(super) fn closing(&self, session: &Session, keep: bool) {
        if keep {
            self.save(session);
        } else {
            let _ = std::fs::remove_file(&self.snapshot);
        }
        self.write_view(session);
        self.tasks.terminal_detached(&self.task_id);
    }

    /// The shell exited (blocking pool): the screen file shows the end, the task ends with
    /// the exit code (its stop reason, when it was stopped, decides the status).
    fn exited(&self) {
        let code = self.session().and_then(|session| {
            self.write_view(&session);
            session.exit().flatten()
        });
        self.tasks.ended(
            &self.task_id,
            Ended {
                exit_code: code.and_then(|c| i32::try_from(c).ok()),
                success: code == Some(0),
                ..Ended::default()
            },
        );
    }

    /// The model's command ended: the screen file is current, and the session gets a reminder.
    fn command_finished(&self, seq: u64) {
        let Some(session) = self.session() else {
            return;
        };
        self.write_view(&session);
        let info = session.command(seq).ok().flatten();
        let tail = session
            .text(TextRange::LastRows(NOTICE_LINES), TextOptions::default())
            .unwrap_or_default();
        let text = command_notice(
            &self.task_id,
            self.command.as_deref().unwrap_or(&self.title),
            info.as_ref(),
            &self.output_path,
            &tail,
        );
        self.tasks.terminal_command_finished(
            &self.task_id,
            &self.session_id,
            format!("{}#{seq}", self.task_id),
            text,
            info.and_then(|i| i.exit_code),
        );
    }

    fn share_notice(&self) {
        let n = self.share_count.fetch_add(1, Ordering::AcqRel) + 1;
        self.tasks.terminal_notice(
            &self.session_id,
            format!("terminal:{}", self.task_id),
            format!("{}#share{n}", self.task_id),
            share_notice(&self.task_id, &self.title, &self.output_path),
        );
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)
        .and_then(|()| std::fs::rename(&temp, path))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })
}

/// The first lines of a screen file: which terminal, and how its last command stands.
fn view_header(
    task_id: &str,
    title: &str,
    last: Option<&CommandInfo>,
    exit: Option<Option<u32>>,
) -> String {
    let mut header = format!("PiArc terminal {task_id} ({title}).");
    let command = match last {
        None => "No command has finished in it yet.".to_owned(),
        Some(info) => {
            let state = match (info.state, info.exit_code) {
                (CommandState::Running, _) => "is still running".to_owned(),
                (CommandState::Finished, Some(code)) => format!("ended with exit code {code}"),
                (CommandState::Finished, None) => "ended (no exit code reported)".to_owned(),
            };
            format!("Last command: `{}` {state}.", info.command)
        }
    };
    header.push('\n');
    header.push_str(&command);
    if let Some(code) = exit {
        header.push('\n');
        header.push_str(&match code {
            Some(code) => format!("The shell has exited (exit code {code})."),
            None => "The shell has exited.".to_owned(),
        });
    }
    header.push_str("\nScreen and scrollback below, oldest first:");
    header
}

fn command_notice(
    task_id: &str,
    command: &str,
    info: Option<&CommandInfo>,
    output_path: &str,
    tail: &str,
) -> String {
    let status = match info.and_then(|i| i.exit_code) {
        Some(code) => format!("exit code {code}"),
        None => "no exit code reported".to_owned(),
    };
    let mut lines = vec![
        format!("The command in terminal {task_id} has finished."),
        format!("Command: {command}"),
        format!("Status: {status}"),
        format!(
            "The terminal stays open. Its screen is in {output_path}; read it with Read. \
             KillShell {task_id} closes the terminal."
        ),
    ];
    if tail.trim().is_empty() {
        lines.push("The screen is empty.".to_owned());
    } else {
        lines.push("Last lines on the screen:".to_owned());
        lines.push(tail.to_owned());
    }
    lines.join("\n")
}

fn share_notice(task_id: &str, title: &str, output_path: &str) -> String {
    format!(
        "The user shared a terminal with you: {task_id} ({title}). Its screen and scrollback \
         are in {output_path}; read it with Read when it helps. The screen keeps changing, and \
         the user can stop sharing it at any time."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_says_how_the_last_command_ended() {
        let info = CommandInfo {
            seq: 2,
            command: "npm test".into(),
            state: CommandState::Finished,
            exit_code: Some(1),
            started_at: std::time::SystemTime::UNIX_EPOCH,
            ended_at: None,
            output_start: None,
            output_end: None,
            output: String::new(),
            output_complete: true,
        };
        let header = view_header("bg-1", "zsh", Some(&info), None);
        assert_eq!(
            header,
            "PiArc terminal bg-1 (zsh).\nLast command: `npm test` ended with exit code 1.\n\
             Screen and scrollback below, oldest first:"
        );
        let none = view_header("bg-1", "zsh", None, Some(Some(0)));
        assert!(none.contains("No command has finished") && none.contains("exit code 0"));
    }
}
