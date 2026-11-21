//! Runtime entry points for terminals (ADR-0017, T10, T33). Everything that touches the PTY
//! or formats the screen runs off the caller's thread and answers through `on_done`.

use std::time::Duration;

use piarc_protocol::terminal::{
    TerminalCommand, TerminalInfo, TerminalLink, TerminalMatch, TerminalPasteOutcome,
    TerminalScroll, TerminalTextRange,
};

use super::CoreRuntime;
use crate::error::Result;
use crate::terminal::{KeyEvent, MouseEvent, TerminalOptions};
use crate::tool_io::UserTerminal;

impl CoreRuntime {
    /// Starts a terminal without a session (ADR-0017) on the blocking pool; `on_done` gets its
    /// id. Its events arrive on the route `term/<id>`; frames are pulled with
    /// [`terminal_frame`](Self::terminal_frame).
    ///
    /// # Errors
    ///
    /// [`crate::Error::InvalidArgument`] for a bad size or a relative working directory,
    /// [`crate::Error::ShuttingDown`]; start failures go to `on_done`.
    pub fn create_terminal(
        &self,
        options: TerminalOptions,
        on_done: impl FnOnce(Result<u32>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.create(options, on_done)
    }

    /// Opens a terminal for the user in open session `session_id` (T33): the session's shell
    /// directory and command environment, the user's shell with PiArc's integration, a
    /// background task of kind `terminal`. `on_done` gets `{ terminalId, taskId, restored? }`.
    ///
    /// # Errors
    ///
    /// [`crate::Error::NoDataDirectory`], [`crate::Error::ShuttingDown`]; the rest goes to
    /// `on_done`.
    pub fn open_session_terminal(
        &self,
        session_id: String,
        request: UserTerminal,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.open_terminal(session_id, request).await
        })
    }

    /// Shares a user's terminal of a session with the model, or stops sharing it
    /// (ADR-0050 rule 5); `on_done` gets whether anything changed.
    ///
    /// # Errors
    ///
    /// [`crate::Error::ShuttingDown`]; the rest goes to `on_done`.
    pub fn set_terminal_shared(
        &self,
        id: u32,
        shared: bool,
        on_done: impl FnOnce(Result<bool>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let terminals = self.shared.terminals.clone();
        self.shared
            .handle
            .spawn(async move { on_done(terminals.set_shared(id, shared).await) });
        Ok(())
    }

    /// Writes `bytes` to terminal `id` as they are (committed input-method text). Never
    /// blocks.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], the terminal's errors once it is closed or its
    /// input queue is full, [`crate::Error::ShuttingDown`].
    pub fn terminal_write(&self, id: u32, bytes: Vec<u8>) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.write(id, bytes)
    }

    /// Encodes `key` with the terminal's current modes and writes it. Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write).
    pub fn terminal_key(&self, id: u32, key: &KeyEvent) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.key(id, key)
    }

    /// Encodes a mouse event with the terminal's mouse mode and format and writes it;
    /// nothing when the program does not track the mouse. Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write); an invalid button.
    pub fn terminal_mouse(&self, id: u32, event: MouseEvent) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.mouse(id, event)
    }

    /// Reports focus gained or lost when the program asked for it (mode 1004). Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write).
    pub fn terminal_focus(&self, id: u32, gained: bool) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.focus(id, gained)
    }

    /// Pastes `text` as the terminal's modes require, on the blocking pool; text that could
    /// run commands by itself comes back `unsafe` unless `allow_unsafe`.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`]; the rest goes to
    /// `on_done`.
    pub fn terminal_paste(
        &self,
        id: u32,
        text: String,
        allow_unsafe: bool,
        on_done: impl FnOnce(Result<TerminalPasteOutcome>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.paste(id, text, allow_unsafe, on_done)
    }

    /// Resizes terminal `id`. Never blocks.
    ///
    /// # Errors
    ///
    /// [`crate::Error::InvalidArgument`] for a bad size, otherwise as
    /// [`terminal_write`](Self::terminal_write).
    pub fn terminal_resize(&self, id: u32, cols: u16, rows: u16, cell: (u32, u32)) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.resize(id, cols, rows, cell)
    }

    /// Encodes the next frame of terminal `id` for `viewer` (`full` asks for a RESET frame)
    /// on the blocking pool and calls `on_done` there with the bytes.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`]; encoding errors go
    /// to `on_done`.
    pub fn terminal_frame(
        &self,
        id: u32,
        viewer: u32,
        full: bool,
        on_done: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
    ) -> Result<()> {
        self.terminal_frame_parking(id, viewer, full, false, on_done)
    }

    /// [`terminal_frame`](Self::terminal_frame) for a viewer that stops pulling when the frame
    /// is empty (`park`, T34): the next output then sends an `output` event on `term/<id>`.
    ///
    /// # Errors
    ///
    /// As [`terminal_frame`](Self::terminal_frame).
    pub fn terminal_frame_parking(
        &self,
        id: u32,
        viewer: u32,
        full: bool,
        park: bool,
        on_done: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.frame(id, viewer, full, park, on_done)
    }

    /// Moves terminal `id`'s viewport (T34). Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write).
    pub fn terminal_scroll(&self, id: u32, to: TerminalScroll) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.scroll(id, to)
    }

    /// Clears terminal `id`'s selection (T34). Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write).
    pub fn terminal_clear_selection(&self, id: u32) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.clear_selection(id)
    }

    /// The selected text of terminal `id`, on the blocking pool (T34).
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`]; the rest goes to
    /// `on_done`.
    pub fn terminal_selection_text(
        &self,
        id: u32,
        on_done: impl FnOnce(Result<String>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.selection_text(id, on_done)
    }

    /// The OSC 8 hyperlink at viewport cell (`col`, `row`) of terminal `id`, on the blocking
    /// pool (T34).
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`]; the rest goes to
    /// `on_done`.
    pub fn terminal_link_at(
        &self,
        id: u32,
        col: u16,
        row: u16,
        on_done: impl FnOnce(Result<Option<TerminalLink>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.link_at(id, col, row, on_done)
    }

    /// Closes terminal `id`: hangs up its program, ends its process tree and forgets it (a
    /// terminal of a session stops as its task).
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`].
    pub fn close_terminal(&self, id: u32) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.close(id)
    }

    /// `range` of terminal `id` as plain text (libghostty-vt's formatter; `unwrap` joins
    /// wrapped rows), on the blocking pool.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`].
    pub fn terminal_text(
        &self,
        id: u32,
        range: TerminalTextRange,
        unwrap: bool,
        on_done: impl FnOnce(Result<String>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.text(id, range, unwrap, on_done)
    }

    /// The newest command of terminal `id` (OSC 133) with its output, on the blocking pool.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`].
    pub fn terminal_last_command(
        &self,
        id: u32,
        on_done: impl FnOnce(Result<Option<TerminalCommand>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.last_command(id, on_done)
    }

    /// Finds `query` in terminal `id`'s screen and scrollback, newest first, on the blocking
    /// pool; the program's output keeps flowing meanwhile.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`].
    pub fn terminal_search(
        &self,
        id: u32,
        query: String,
        on_done: impl FnOnce(Result<Vec<TerminalMatch>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.search(id, query, on_done)
    }

    /// What terminal `id` shows: size, title, working directory, screen, last command and,
    /// for a terminal of a session, its task and sharing.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`].
    pub fn terminal_info(&self, id: u32) -> Result<TerminalInfo> {
        self.shared.terminals.info(id)
    }

    /// Counters of terminal `id`.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`].
    pub fn terminal_stats(&self, id: u32) -> Result<piarc_term::SessionStats> {
        self.shared.terminals.stats(id)
    }

    /// Measures the PTY's own echo time for `byte` (the baseline of the S7 echo budget), on
    /// the blocking pool. Only the `testing` build of piarc-napi exports it.
    ///
    /// # Errors
    ///
    /// [`crate::Error::UnknownTerminal`], [`crate::Error::ShuttingDown`].
    pub fn terminal_probe_echo(
        &self,
        id: u32,
        byte: u8,
        on_done: impl FnOnce(Result<Duration>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.probe_echo(id, byte, on_done)
    }
}
