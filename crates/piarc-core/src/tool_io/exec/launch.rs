//! Where a command starts and what wraps it, moved out of `exec.rs` (R4 I165).

use std::ffi::OsString;
use std::path::PathBuf;

use piarc_exec::Launcher;
use piarc_exec::shells::msys_to_windows;
use piarc_protocol::ErrorObject;
use piarc_protocol::exec::{CwdReset, CwdResetReason};

use crate::tool_io::{SessionIo, lock};

/// What a sandbox adds around a command: its wrapper program and variables.
#[derive(Default)]
pub(in crate::tool_io) struct Wrap {
    pub launcher: Option<Launcher>,
    pub env: Vec<(OsString, OsString)>,
}

/// Where a command starts, and whether it moves the session's remembered directory.
pub(in crate::tool_io) struct Launch {
    pub dir: PathBuf,
    pub tracked: bool,
    /// Programs an automatic preflight relied on, pinned in the bash startup file.
    pub pinned: Vec<(String, PathBuf)>,
    /// The remembered directory was gone and the command starts at the root instead.
    pub reset: Option<CwdReset>,
}

/// The working directory of a command of `session`: `requested`, or the remembered one.
pub(in crate::tool_io) fn launch_dir(
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
            pinned: Vec::new(),
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
        pinned: Vec::new(),
        reset,
    })
}

/// Records where a bash command ended (`ended`, as the shell printed it): kept when inside the
/// workspace or an added directory, else the workspace root and the reason.
pub(super) fn remember_cwd(session: &SessionIo, ended: Option<String>) -> Option<CwdReset> {
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
