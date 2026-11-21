//! Terminals of a session through the tool I/O (T33, ADR-0050): a user's terminal for the
//! panel, and `exec/run` with `terminal` for the model. Both start in the session's shell
//! directory with the environment of its commands (T17, ADR-0035) and, in a sandboxed session,
//! inside the same sandbox wrapper; `crate::terminal` runs them as background tasks.

use piarc_protocol::exec::{ExecRunParams, ExecRunResult};
use piarc_protocol::tasks::{TaskStartReason, TaskStarted, TerminalOrigin};
use piarc_protocol::{ErrorKind, ErrorObject};

use super::exec::{Launch, Wrap};
use super::{SessionIo, ToolIo, lock};
use crate::terminal::{BoundSpec, Opened, Terminals};

/// The size of a terminal the model opens (nobody sized it yet; the panel resizes it).
const AGENT_SIZE: (u16, u16, u32, u32) = (120, 40, 8, 16);

/// What a user's terminal of a session is opened with.
#[derive(Debug, Clone)]
pub struct UserTerminal {
    /// Columns, rows, cell width and height in pixels.
    pub size: (u16, u16, u32, u32),
    /// The task id of a terminal saved earlier in this session, to continue from.
    pub restore: Option<String>,
}

impl ToolIo {
    /// Runs terminals of sessions with `terminals` (Core's runtime).
    #[must_use]
    pub(crate) fn with_terminals(mut self, terminals: Terminals) -> Self {
        self.terminals = Some(terminals);
        self
    }

    fn terminals(&self) -> Result<&Terminals, ErrorObject> {
        self.terminals.as_ref().ok_or_else(|| {
            ErrorObject::new(
                ErrorKind::InternalError,
                "terminals need Core's data directory",
                false,
            )
        })
    }

    /// Opens a terminal for the user in session `session_id`: their login shell with PiArc's
    /// integration, in the session's shell directory.
    ///
    /// # Errors
    ///
    /// `sessionNotFound` when the session is not open; the terminal's errors.
    pub(crate) async fn open_user_terminal(
        &self,
        session_id: &str,
        request: UserTerminal,
    ) -> Result<Opened, ErrorObject> {
        let session = self.session(session_id)?;
        let wrap = super::sandbox_wrap(&session)?;
        let cwd = lock(&session.shell_cwd).clone();
        let cwd = if cwd.is_dir() {
            cwd
        } else {
            session.scope.root().to_path_buf()
        };
        let shell = piarc_term::default_shell();
        let title = shell
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&shell)
            .trim_end_matches(".exe")
            .to_owned();
        let spec = self
            .terminal_spec(session_id, &session, cwd, wrap, TerminalOrigin::User)
            .await;
        self.terminals()?
            .open(BoundSpec {
                shell: Some(shell),
                login: true,
                title,
                command: None,
                tool_call_id: None,
                size: request.size,
                restore: request.restore,
                ..spec
            })
            .await
            .map_err(|e| e.to_error_object())
    }

    /// `exec/run` with `terminal`: the approved command typed into a new terminal of the
    /// session (bash, Git Bash on Windows), answered at once as a background task.
    pub(super) async fn exec_terminal(
        &self,
        session: &SessionIo,
        p: &ExecRunParams,
        launch: &Launch,
        wrap: Wrap,
    ) -> Result<ExecRunResult, ErrorObject> {
        // Typed into bash's line editor, control characters act (`^U` erases, a carriage
        // return runs the line): what runs would not be the text judged (R4 M1).
        if piarc_policy::bash::has_control_characters(&p.command) {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "the command has control characters a terminal would act on; run it without `terminal`",
                false,
            ));
        }
        let bash = self.exec.bash()?;
        let mut spec = self
            .terminal_spec(
                &p.session_id.0,
                session,
                launch.dir.clone(),
                wrap,
                TerminalOrigin::Agent,
            )
            .await;
        if cfg!(target_os = "macos") {
            // macOS's bash 3.2 greets every interactive start with a notice that zsh is the
            // default now; on the model's screen it is only noise. The user's own terminals run
            // their shell untouched.
            spec.env
                .push(("BASH_SILENCE_DEPRECATION_WARNING".into(), "1".into()));
        }
        let opened = self
            .terminals()?
            .open(BoundSpec {
                shell: Some(piarc_fs::display(&bash)),
                login: false,
                title: p.command.clone(),
                command: Some(p.command.clone()),
                tool_call_id: p.origin.as_ref().map(|o| o.tool_call_id.clone()),
                size: AGENT_SIZE,
                restore: None,
                ..spec
            })
            .await
            .map_err(|e| e.to_error_object())?;
        Ok(ExecRunResult {
            exit_code: None,
            signal: None,
            killed: false,
            timed_out: None,
            timeout: None,
            duration_ms: None,
            outcome: None,
            meaning: None,
            cwd: Some(piarc_fs::display(&launch.dir)),
            cwd_reset: launch.reset.clone(),
            output: None,
            task: Some(TaskStarted {
                task_id: opened.task_id,
                output_path: opened.output_path,
                reason: TaskStartReason::Requested,
            }),
        })
    }

    /// The parts every terminal of `session` shares: where it belongs, its directory and
    /// environment, the sandbox wrapper.
    async fn terminal_spec(
        &self,
        session_id: &str,
        session: &SessionIo,
        cwd: std::path::PathBuf,
        wrap: Wrap,
        origin: TerminalOrigin,
    ) -> BoundSpec {
        let place = self.place(session_id, session);
        let env = self.exec.terminal_env(wrap.env).await;
        BoundSpec {
            session_id: place.session_id,
            owner_session_id: place.owner_session_id,
            workspace: place.workspace,
            cwd,
            env,
            launcher: wrap.launcher.map(|l| {
                (
                    l.program.to_string_lossy().into_owned(),
                    l.args
                        .iter()
                        .map(|a| a.to_string_lossy().into_owned())
                        .collect(),
                )
            }),
            shell: None,
            login: false,
            origin,
            title: String::new(),
            command: None,
            tool_call_id: None,
            size: AGENT_SIZE,
            restore: None,
        }
    }
}
