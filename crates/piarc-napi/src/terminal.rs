//! Terminal exports (ADR-0017, T10): create, input, keys, resize, pulled frames, close. The
//! main process calls them on behalf of a window and forwards frames on the window's event
//! port without reading them.

use std::collections::HashMap;
use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::{Object, Uint8Array};
use napi_derive::napi;

use crate::boundary;
use crate::runtime::CoreRuntime;

/// Options of `createTerminal`.
#[napi(object, object_to_js = false)]
pub struct TerminalCreateOptions {
    /// Columns (1 to 1000).
    pub cols: u32,
    /// Rows (1 to 1000).
    pub rows: u32,
    /// Cell width in device-independent pixels, for pixel size reports. Default 8.
    pub cell_width: Option<u32>,
    /// Cell height. Default 16.
    pub cell_height: Option<u32>,
    /// Program to run instead of the user's login shell.
    pub program: Option<String>,
    /// Arguments of `program`.
    #[napi(ts_type = "string[]")]
    pub args: Option<Vec<String>>,
    /// Absolute working directory; the home directory when unset.
    pub cwd: Option<String>,
    /// Extra environment variables.
    pub env: Option<HashMap<String, String>>,
}

/// A key event as the renderer saw it.
#[napi(object, object_to_js = false)]
pub struct TerminalKeyEvent {
    /// `press`, `repeat` or `release`.
    pub action: String,
    /// `KeyboardEvent.code`.
    pub code: String,
    /// The character the key produced; empty for named keys (Enter, arrows, F-keys).
    pub text: String,
    /// Bits: 1 Shift, 2 Ctrl, 4 Alt/Option, 8 Meta/Command.
    pub mods: u32,
    /// The event belongs to an input-method composition.
    pub composing: bool,
}

fn side(field: &'static str, value: u32) -> piarc_core::Result<u16> {
    u16::try_from(value).map_err(|_| piarc_core::Error::InvalidArgument {
        field,
        reason: "must be between 1 and 1000".into(),
    })
}

fn key_event(event: TerminalKeyEvent) -> piarc_core::Result<piarc_core::KeyEvent> {
    let action = match event.action.as_str() {
        "press" => piarc_core::KeyAction::Press,
        "repeat" => piarc_core::KeyAction::Repeat,
        "release" => piarc_core::KeyAction::Release,
        _ => {
            return Err(piarc_core::Error::InvalidArgument {
                field: "action",
                reason: "must be press, repeat or release".into(),
            });
        }
    };
    Ok(piarc_core::KeyEvent {
        action,
        code: event.code,
        text: event.text,
        mods: u16::try_from(event.mods & 0xf).unwrap_or(0),
        composing: event.composing,
    })
}

#[napi]
impl CoreRuntime {
    /// Starts a terminal and returns its id. Its title, bell and exit events arrive on the
    /// route `term/<id>`; frames are pulled with `terminalFrame`.
    #[napi(catch_unwind)]
    pub fn create_terminal(&self, env: Env, options: TerminalCreateOptions) -> napi::Result<u32> {
        boundary::call(&env, "CoreRuntime.createTerminal", || {
            let command = options
                .program
                .map(|program| (program, options.args.unwrap_or_default()));
            self.core.create_terminal(piarc_core::TerminalOptions {
                cols: side("cols", options.cols)?,
                rows: side("rows", options.rows)?,
                cell_width: options.cell_width.unwrap_or(8),
                cell_height: options.cell_height.unwrap_or(16),
                command,
                cwd: options.cwd.map(PathBuf::from),
                env: options.env.unwrap_or_default().into_iter().collect(),
            })
        })
    }

    /// Writes `text` to the terminal as UTF-8 (committed input-method text). Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_input(&self, env: Env, id: u32, text: String) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalInput", || {
            self.core.terminal_write(id, text.into_bytes())
        })
    }

    /// Encodes a key event with the terminal's current modes and writes it. Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_key(&self, env: Env, id: u32, event: TerminalKeyEvent) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalKey", || {
            self.core.terminal_key(id, &key_event(event)?)
        })
    }

    /// Resizes the terminal and its PTY. Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_resize(
        &self,
        env: Env,
        id: u32,
        cols: u32,
        rows: u32,
        cell_width: u32,
        cell_height: u32,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalResize", || {
            self.core.terminal_resize(
                id,
                side("cols", cols)?,
                side("rows", rows)?,
                (cell_width, cell_height),
            )
        })
    }

    /// Resolves with the next frame of the terminal for `viewer` (the draft binary format of
    /// `piarc_protocol::term_frame`); `full` asks for a RESET frame. An unchanged terminal
    /// gives a 14-byte empty frame.
    #[napi(ts_return_type = "Promise<Uint8Array>", catch_unwind)]
    pub fn terminal_frame<'env>(
        &self,
        env: &'env Env,
        id: u32,
        viewer: u32,
        full: bool,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<Uint8Array> + Send>;
        let (deferred, promise) = env.create_deferred::<Uint8Array, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalFrame", || {
            self.core.terminal_frame(id, viewer, full, move |frame| {
                deferred.resolve(Box::new(move |env| match frame {
                    Ok(bytes) => Ok(Uint8Array::from(bytes)),
                    Err(error) => Err(boundary::js_error(&env, &error.to_error_object())),
                }));
            })
        })?;
        Ok(promise)
    }

    /// Kills the terminal's program and forgets the terminal.
    #[napi(catch_unwind)]
    pub fn close_terminal(&self, env: Env, id: u32) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.closeTerminal", || {
            self.core.close_terminal(id)
        })
    }
}
