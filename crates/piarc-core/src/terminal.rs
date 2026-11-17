//! Terminal sessions in Core (ADR-0017, T10): a registry of `piarc_term::Session`s, their
//! lifecycle events on the event path, and pulled frames.
//!
//! # Events
//!
//! Each terminal reports on the route `term/<id>` (JSON, one object per event):
//! `{"type":"title","title":…}`, `{"type":"bell","count":…}` and
//! `{"type":"exited","code":…|null}`. The shapes are a T10 draft; T33 moves them into
//! `piarc-protocol`.
//!
//! # Frames
//!
//! Frames are pulled, never pushed: the renderer asks for one per animation frame through
//! [`Terminals::frame`], which encodes on a blocking-pool thread and hands the bytes to a
//! callback (the NAPI layer resolves a Promise with them). A hidden terminal is not asked and
//! produces nothing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use piarc_term::vt::KeyAction;
use piarc_term::{Event as TermEvent, Program, Session, SessionConfig, SessionStats, keymap};
use tokio::runtime::Handle;

use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;

/// Largest accepted grid side.
pub const MAX_TERMINAL_SIDE: u16 = 1000;

/// Scrollback kept per terminal, in lines.
pub const SCROLLBACK_LINES: usize = 10_000;

/// Settings of [`Terminals::create`].
#[derive(Debug, Clone, Default)]
pub struct TerminalOptions {
    /// Columns (1 to [`MAX_TERMINAL_SIDE`]).
    pub cols: u16,
    /// Rows (1 to [`MAX_TERMINAL_SIDE`]).
    pub rows: u16,
    /// Cell size in pixels, for pixel size reports.
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
    /// Program and arguments; the user's login shell when unset.
    pub command: Option<(String, Vec<String>)>,
    /// Absolute working directory; the home directory when unset.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
}

/// A key event as the renderer reports it (`KeyboardEvent` fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    /// Press, repeat or release.
    pub action: KeyAction,
    /// `KeyboardEvent.code`.
    pub code: String,
    /// The character the key produced, empty for named keys.
    pub text: String,
    /// `piarc_term::keymap::MOD_*` bits.
    pub mods: u16,
    /// Part of an input-method composition.
    pub composing: bool,
}

/// The registry of live terminals.
pub(crate) struct Terminals {
    handle: Handle,
    events: EventSender,
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
}

/// Runs `work` (on the blocking pool), turning a panic into an internal error, so the caller's
/// callback always runs and a Promise waiting on it always settles (I55).
fn guarded<T>(location: &str, work: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or_else(|payload| Err(Error::from_panic(location, &*payload)))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Terminals {
    pub(crate) fn new(handle: Handle, events: EventSender) -> Self {
        Self {
            handle,
            events,
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn session(&self, id: u32) -> Result<Arc<Session>> {
        lock(&self.sessions)
            .get(&id)
            .cloned()
            .ok_or(Error::UnknownTerminal { id })
    }

    /// Starts a terminal and returns its id; its events arrive on `term/<id>`.
    pub(crate) fn create(&self, options: TerminalOptions) -> Result<u32> {
        let size_ok = |side: u16| (1..=MAX_TERMINAL_SIDE).contains(&side);
        if !size_ok(options.cols) || !size_ok(options.rows) {
            return Err(Error::InvalidArgument {
                field: "size",
                reason: format!("columns and rows must be between 1 and {MAX_TERMINAL_SIDE}"),
            });
        }
        if let Some(cwd) = &options.cwd
            && !cwd.is_absolute()
        {
            return Err(Error::InvalidArgument {
                field: "cwd",
                reason: "must be an absolute path".into(),
            });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let route = RouteKey::parse(&format!("term/{id}"))?;
        let events = self.events.clone();
        let on_event = Arc::new(move |event: TermEvent| {
            let json = match event {
                TermEvent::Title(title) => serde_json::json!({ "type": "title", "title": title }),
                TermEvent::Bell { count } => serde_json::json!({ "type": "bell", "count": count }),
                TermEvent::Exited { code } => serde_json::json!({ "type": "exited", "code": code }),
            };
            if let Ok(event) = Event::from_json(route.clone(), &json) {
                // Runs on the terminal's IO thread, outside the runtime. The queue only fails
                // when Core is shutting down; nobody listens then.
                let _ = events.blocking_send(event);
            }
        });
        let config = SessionConfig {
            cols: options.cols,
            rows: options.rows,
            cell_width: options.cell_width,
            cell_height: options.cell_height,
            program: match options.command {
                Some((program, args)) => Program::Command { program, args },
                None => Program::DefaultShell,
            },
            cwd: options.cwd,
            env: options.env,
            scrollback_lines: SCROLLBACK_LINES,
        };
        let session = Session::spawn(config, on_event)?;
        lock(&self.sessions).insert(id, Arc::new(session));
        Ok(id)
    }

    pub(crate) fn write(&self, id: u32, bytes: Vec<u8>) -> Result<()> {
        Ok(self.session(id)?.write(bytes)?)
    }

    pub(crate) fn key(&self, id: u32, key: &KeyEvent) -> Result<()> {
        let input = keymap::key_input(key.action, &key.code, &key.text, key.mods, key.composing);
        Ok(self.session(id)?.key(input)?)
    }

    pub(crate) fn resize(&self, id: u32, cols: u16, rows: u16, cell: (u32, u32)) -> Result<()> {
        if cols > MAX_TERMINAL_SIDE || rows > MAX_TERMINAL_SIDE {
            return Err(Error::InvalidArgument {
                field: "size",
                reason: format!("columns and rows must be between 1 and {MAX_TERMINAL_SIDE}"),
            });
        }
        Ok(self.session(id)?.resize(cols, rows, cell.0, cell.1)?)
    }

    /// Encodes the next frame for `viewer` on the blocking pool and calls `on_done` there.
    pub(crate) fn frame(
        &self,
        id: u32,
        viewer: u32,
        full: bool,
        on_done: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
    ) -> Result<()> {
        let session = self.session(id)?;
        self.handle.spawn_blocking(move || {
            on_done(guarded("terminal frame", || {
                session.frame(viewer, full).map_err(Error::from)
            }));
        });
        Ok(())
    }

    pub(crate) fn close(&self, id: u32) -> Result<()> {
        let session = lock(&self.sessions)
            .remove(&id)
            .ok_or(Error::UnknownTerminal { id })?;
        session.close();
        Ok(())
    }

    /// Closes every terminal (shutdown).
    pub(crate) fn close_all(&self) {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.close();
        }
    }

    pub(crate) fn text(
        &self,
        id: u32,
        on_done: impl FnOnce(Result<String>) + Send + 'static,
    ) -> Result<()> {
        let session = self.session(id)?;
        self.handle.spawn_blocking(move || {
            on_done(guarded("terminal text", || {
                session.viewport_text().map_err(Error::from)
            }));
        });
        Ok(())
    }

    pub(crate) fn stats(&self, id: u32) -> Result<SessionStats> {
        Ok(self.session(id)?.stats())
    }

    pub(crate) fn probe_echo(
        &self,
        id: u32,
        byte: u8,
        on_done: impl FnOnce(Result<Duration>) + Send + 'static,
    ) -> Result<()> {
        let session = self.session(id)?;
        self.handle.spawn_blocking(move || {
            on_done(guarded("terminal echo probe", || {
                session
                    .probe_direct_echo(byte, Duration::from_secs(5))
                    .map_err(Error::from)
            }));
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// I55: a panic in work run on the blocking pool settles the caller with an internal error
    /// instead of leaving its Promise unsettled.
    #[test]
    fn a_panic_on_the_blocking_pool_becomes_an_internal_error() {
        let result: Result<u8> = guarded("terminal frame", || panic!("broken frame"));
        let error = result.expect_err("the panic is reported");
        assert_eq!(error.kind(), piarc_protocol::ErrorKind::InternalError);
        assert!(error.to_string().contains("broken frame"), "{error}");
        assert_eq!(
            guarded("terminal frame", || Ok(7)).expect("passes through"),
            7
        );
    }
}
