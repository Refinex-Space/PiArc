//! Terminal exports (ADR-0017, T10, T33, T34): create (with or without a session), input, keys,
//! mouse (selection and scrolling when the program does not track it), focus, paste, resize,
//! pulled frames (parking), viewport scrolling, selected text, links, text, commands, search,
//! sharing, close. The main process calls them on behalf of a window and returns frames to it
//! without reading them.
//! Starting a terminal and everything that reads the screen run off the JavaScript thread and
//! settle a Promise.

use std::collections::HashMap;
use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::{Object, Uint8Array};
use napi_derive::napi;

use crate::boundary;
use crate::runtime::CoreRuntime;

type Json = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;

/// Settles a Promise with `result` as JSON text (the session exports' convention).
fn json<T: serde::Serialize>(result: piarc_core::Result<T>) -> Json {
    let encoded = result.and_then(|value| {
        serde_json::to_string(&value).map_err(|e| piarc_core::Error::Internal {
            reason: format!("cannot encode the result: {e}"),
        })
    });
    Box::new(move |env| encoded.map_err(|error| boundary::js_error(&env, &error.to_error_object())))
}

/// Options of `openSessionTerminal`.
#[napi(object, object_to_js = false)]
pub struct SessionTerminalOptions {
    /// Columns (1 to 1000).
    pub cols: u32,
    /// Rows (1 to 1000).
    pub rows: u32,
    /// Cell width in device-independent pixels. Default 8.
    pub cell_width: Option<u32>,
    /// Cell height. Default 16.
    pub cell_height: Option<u32>,
    /// The task id of a terminal of this session saved earlier, to continue from its snapshot.
    pub restore: Option<String>,
    /// Optional project-relative starting folder selected in Files.
    pub directory: Option<String>,
}

/// A mouse event in pixels of the terminal's surface.
#[napi(object, object_to_js = false)]
pub struct TerminalMouseEvent {
    /// `press`, `release` or `motion`.
    pub action: String,
    /// 1 left, 2 right, 3 middle, 4–7 wheel up, down, left, right, 8–11 extra buttons.
    pub button: Option<u32>,
    /// Bits: 1 Shift, 2 Ctrl, 4 Alt/Option, 8 Meta/Command.
    pub mods: u32,
    /// Horizontal position in pixels.
    pub x: f64,
    /// Vertical position in pixels.
    pub y: f64,
    /// For a press: clicks in a row (`MouseEvent.detail`: 1 single, 2 double, 3 triple),
    /// which picks the selection unit when the program does not track the mouse. Default 1.
    pub clicks: Option<u32>,
}

/// A terminal's default colors as `0xRRGGBB` numbers (T34); absent keeps the built-in one.
#[napi(object, object_to_js = false)]
pub struct TerminalColors {
    /// Text without a color of its own.
    pub foreground: Option<u32>,
    /// Cells without a background of their own.
    pub background: Option<u32>,
    /// The cursor.
    pub cursor: Option<u32>,
}

fn rgb(value: Option<u32>) -> Option<piarc_protocol::term_frame::Rgb> {
    value.map(|v| {
        let [_, r, g, b] = (v & 0x00ff_ffff).to_be_bytes();
        piarc_protocol::term_frame::Rgb { r, g, b }
    })
}

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

fn mouse_event(event: TerminalMouseEvent) -> piarc_core::Result<piarc_core::MouseEvent> {
    let action = match event.action.as_str() {
        "press" => piarc_core::MouseAction::Press,
        "release" => piarc_core::MouseAction::Release,
        "motion" => piarc_core::MouseAction::Motion,
        _ => {
            return Err(piarc_core::Error::InvalidArgument {
                field: "action",
                reason: "must be press, release or motion".into(),
            });
        }
    };
    let button = event
        .button
        .map(|b| {
            u8::try_from(b)
                .ok()
                .filter(|b| (1..=11).contains(b))
                .ok_or_else(|| piarc_core::Error::InvalidArgument {
                    field: "button",
                    reason: "must be between 1 and 11".into(),
                })
        })
        .transpose()?;
    if !event.x.is_finite() || !event.y.is_finite() {
        return Err(piarc_core::Error::InvalidArgument {
            field: "position",
            reason: "must be finite".into(),
        });
    }
    // Pixel positions of a surface at most 1000 cells wide: far inside f32.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "pixel positions are small; f32 is what libghostty-vt takes"
    )]
    Ok(piarc_core::MouseEvent {
        action,
        button,
        mods: u16::try_from(event.mods & 0xf).unwrap_or(0),
        x: event.x as f32,
        y: event.y as f32,
        clicks: u8::try_from(event.clicks.unwrap_or(1).clamp(1, 3)).unwrap_or(1),
    })
}

/// A scroll target from its JSON (`{ kind: "top" | "bottom" }`, `{ kind: "delta", rows }`,
/// `{ kind: "row", row }`).
fn scroll_target(text: &str) -> piarc_core::Result<piarc_protocol::terminal::TerminalScroll> {
    serde_json::from_str(text).map_err(|_| piarc_core::Error::InvalidArgument {
        field: "to",
        reason: "must be { kind: top | bottom } or { kind: delta, rows } or { kind: row, row }"
            .into(),
    })
}

/// A text range from its JSON (`{ kind: "screen" | "viewport" | "all" }` or
/// `{ kind: "lastLines", count }`); the viewport when absent.
fn text_range(
    range: Option<String>,
) -> piarc_core::Result<piarc_protocol::terminal::TerminalTextRange> {
    match range {
        None => Ok(piarc_protocol::terminal::TerminalTextRange::Viewport),
        Some(text) => serde_json::from_str(&text).map_err(|_| piarc_core::Error::InvalidArgument {
            field: "range",
            reason: "must be { kind: screen | viewport | all } or { kind: lastLines, count }"
                .into(),
        }),
    }
}

#[napi]
impl CoreRuntime {
    /// Starts a terminal without a session and resolves with its id. Its events arrive on
    /// the route `term/<id>`; frames are pulled with `terminalFrame`. Opening the PTY and
    /// starting the program happen off the JavaScript thread.
    #[napi(ts_return_type = "Promise<number>", catch_unwind)]
    pub fn create_terminal<'env>(
        &self,
        env: &'env Env,
        options: TerminalCreateOptions,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<u32> + Send>;
        let (deferred, promise) = env.create_deferred::<u32, Settle>()?;
        boundary::call(env, "CoreRuntime.createTerminal", || {
            let command = options
                .program
                .map(|program| (program, options.args.unwrap_or_default()));
            let options = piarc_core::TerminalOptions {
                cols: side("cols", options.cols)?,
                rows: side("rows", options.rows)?,
                cell_width: options.cell_width.unwrap_or(8),
                cell_height: options.cell_height.unwrap_or(16),
                command,
                cwd: options.cwd.map(PathBuf::from),
                env: options.env.unwrap_or_default().into_iter().collect(),
            };
            self.core.create_terminal(options, move |id| {
                deferred.resolve(Box::new(move |env| {
                    id.map_err(|error| boundary::js_error(&env, &error.to_error_object()))
                }));
            })
        })?;
        Ok(promise)
    }

    /// Opens a terminal for the user in open session `sessionId` (T33): the session's shell
    /// directory and command environment, the user's shell with PiArc's shell integration,
    /// a background task of kind `terminal`. Resolves with JSON text
    /// `{ terminalId, taskId, restored }` (`restored`: `snapshot`, `replay`, `text` or null).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn open_session_terminal<'env>(
        &self,
        env: &'env Env,
        session_id: String,
        options: SessionTerminalOptions,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Json>()?;
        boundary::call(env, "CoreRuntime.openSessionTerminal", || {
            let request = piarc_core::tool_io::UserTerminal {
                size: (
                    side("cols", options.cols)?,
                    side("rows", options.rows)?,
                    options.cell_width.unwrap_or(8),
                    options.cell_height.unwrap_or(16),
                ),
                restore: options.restore,
                directory: options.directory,
            };
            self.core
                .open_session_terminal(session_id, request, move |result| {
                    deferred.resolve(json(result));
                })
        })?;
        Ok(promise)
    }

    /// Shares a user's terminal of a session with the agent, or stops sharing it (ADR-0050);
    /// resolves with whether anything changed.
    #[napi(ts_return_type = "Promise<boolean>", catch_unwind)]
    pub fn set_terminal_shared<'env>(
        &self,
        env: &'env Env,
        id: u32,
        shared: bool,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<bool> + Send>;
        let (deferred, promise) = env.create_deferred::<bool, Settle>()?;
        boundary::call(env, "CoreRuntime.setTerminalShared", || {
            self.core.set_terminal_shared(id, shared, move |changed| {
                deferred.resolve(Box::new(move |env| {
                    changed.map_err(|error| boundary::js_error(&env, &error.to_error_object()))
                }));
            })
        })?;
        Ok(promise)
    }

    /// A pointer event: encoded with the terminal's mouse mode and format and written while
    /// the program tracks the mouse; otherwise (and for the left button with Shift) it selects
    /// text (`clicks` 2 a word, 3 a line; Shift extends) and the wheel scrolls the scrollback.
    /// Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_mouse(&self, env: Env, id: u32, event: TerminalMouseEvent) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalMouse", || {
            self.core.terminal_mouse(id, mouse_event(event)?)
        })
    }

    /// Reports focus gained or lost to the program when it asked for focus reports (mode
    /// 1004). Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_focus(&self, env: Env, id: u32, gained: bool) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalFocus", || {
            self.core.terminal_focus(id, gained)
        })
    }

    /// Pastes `text` as the terminal's modes require (bracketed paste, Kitty paste events);
    /// resolves with `pasted`, `empty`, or `unsafe` for text that could run commands by itself
    /// (ask the user, then paste again with `allowUnsafe`).
    #[napi(
        ts_return_type = "Promise<'pasted' | 'unsafe' | 'empty'>",
        catch_unwind
    )]
    pub fn terminal_paste<'env>(
        &self,
        env: &'env Env,
        id: u32,
        text: String,
        #[napi(ts_arg_type = "boolean | null")] allow_unsafe: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalPaste", || {
            self.core
                .terminal_paste(id, text, allow_unsafe.unwrap_or(false), move |outcome| {
                    deferred.resolve(Box::new(move |env| {
                        let outcome = outcome
                            .map_err(|error| boundary::js_error(&env, &error.to_error_object()))?;
                        Ok(match outcome {
                            piarc_protocol::terminal::TerminalPasteOutcome::Pasted => "pasted",
                            piarc_protocol::terminal::TerminalPasteOutcome::Unsafe => "unsafe",
                            piarc_protocol::terminal::TerminalPasteOutcome::Empty => "empty",
                        }
                        .to_owned())
                    }));
                })
        })?;
        Ok(promise)
    }

    /// Plain text of the terminal from libghostty-vt's formatter: `range` is JSON text
    /// (`{"kind":"screen"}`, `viewport`, `all`, or `{"kind":"lastLines","count":n}`; the
    /// viewport when absent); `unwrap` joins rows the terminal wrapped.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn terminal_text<'env>(
        &self,
        env: &'env Env,
        id: u32,
        #[napi(ts_arg_type = "string | null")] range: Option<String>,
        #[napi(ts_arg_type = "boolean | null")] unwrap: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalText", || {
            let range = text_range(range)?;
            self.core
                .terminal_text(id, range, unwrap.unwrap_or(false), move |text| {
                    deferred.resolve(Box::new(move |env| {
                        text.map_err(|error| boundary::js_error(&env, &error.to_error_object()))
                    }));
                })
        })?;
        Ok(promise)
    }

    /// Finds `query` in the terminal's screen and scrollback; resolves with JSON text of the
    /// matches (`TerminalMatch[]`), newest first.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn terminal_search<'env>(
        &self,
        env: &'env Env,
        id: u32,
        query: String,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Json>()?;
        boundary::call(env, "CoreRuntime.terminalSearch", || {
            self.core
                .terminal_search(id, query, move |result| deferred.resolve(json(result)))
        })?;
        Ok(promise)
    }

    /// What the terminal shows, as JSON text (`TerminalInfo`): size, title, working
    /// directory, alternate screen, last command, and for a terminal of a session its task and
    /// sharing.
    #[napi(catch_unwind)]
    pub fn terminal_info(&self, env: Env, id: u32) -> napi::Result<String> {
        boundary::call(&env, "CoreRuntime.terminalInfo", || {
            let info = self.core.terminal_info(id)?;
            serde_json::to_string(&info).map_err(|e| piarc_core::Error::Internal {
                reason: format!("cannot encode the result: {e}"),
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

    /// Resolves with the next frame of the terminal for `viewer` (the binary format of
    /// `piarc_protocol::term_frame`, version 2); `full` asks for a RESET frame. An unchanged
    /// terminal gives a 14-byte empty frame. With `park` the viewer stops pulling when this
    /// frame is empty: the next output sends an `output` event on `term/<id>` (T34).
    #[napi(ts_return_type = "Promise<Uint8Array>", catch_unwind)]
    pub fn terminal_frame<'env>(
        &self,
        env: &'env Env,
        id: u32,
        viewer: u32,
        full: bool,
        #[napi(ts_arg_type = "boolean | null")] park: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<Uint8Array> + Send>;
        let (deferred, promise) = env.create_deferred::<Uint8Array, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalFrame", || {
            let park = park.unwrap_or(false);
            self.core
                .terminal_frame_parking(id, viewer, full, park, move |frame| {
                    deferred.resolve(Box::new(move |env| match frame {
                        Ok(bytes) => Ok(Uint8Array::from(bytes)),
                        Err(error) => Err(boundary::js_error(&env, &error.to_error_object())),
                    }));
                })
        })?;
        Ok(promise)
    }

    /// Moves the viewport: `to` is JSON text (`{"kind":"top"}`, `bottom`,
    /// `{"kind":"delta","rows":-3}`, `{"kind":"row","row":120}`). Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_scroll(&self, env: Env, id: u32, to: String) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalScroll", || {
            self.core.terminal_scroll(id, scroll_target(&to)?)
        })
    }

    /// Sets the default foreground, background and cursor colors (the viewer's theme): cells
    /// without colors of their own and programs' color queries use them. Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_set_colors(
        &self,
        env: Env,
        id: u32,
        colors: TerminalColors,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalSetColors", || {
            self.core.terminal_set_colors(
                id,
                piarc_core::TerminalColors {
                    foreground: rgb(colors.foreground),
                    background: rgb(colors.background),
                    cursor: rgb(colors.cursor),
                },
            )
        })
    }

    /// Clears the selection. Never blocks.
    #[napi(catch_unwind)]
    pub fn terminal_clear_selection(&self, env: Env, id: u32) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.terminalClearSelection", || {
            self.core.terminal_clear_selection(id)
        })
    }

    /// The selected text (wrapped rows joined, trailing spaces trimmed); empty when nothing is
    /// selected.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn terminal_selection_text<'env>(
        &self,
        env: &'env Env,
        id: u32,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalSelectionText", || {
            self.core.terminal_selection_text(id, move |text| {
                deferred.resolve(Box::new(move |env| {
                    text.map_err(|error| boundary::js_error(&env, &error.to_error_object()))
                }));
            })
        })?;
        Ok(promise)
    }

    /// The OSC 8 hyperlink at viewport cell (`col`, `row`) as JSON text (`TerminalLink`), or
    /// `null` when the cell has none.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn terminal_link_at<'env>(
        &self,
        env: &'env Env,
        id: u32,
        col: u32,
        row: u32,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Json>()?;
        boundary::call(env, "CoreRuntime.terminalLinkAt", || {
            self.core.terminal_link_at(
                id,
                u16::try_from(col).unwrap_or(u16::MAX),
                u16::try_from(row).unwrap_or(u16::MAX),
                move |result| deferred.resolve(json(result)),
            )
        })?;
        Ok(promise)
    }

    /// Hangs up the terminal's program, ends everything it started and forgets the terminal
    /// (a terminal of a session stops as its task).
    #[napi(catch_unwind)]
    pub fn close_terminal(&self, env: Env, id: u32) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.closeTerminal", || {
            self.core.close_terminal(id)
        })
    }
}
