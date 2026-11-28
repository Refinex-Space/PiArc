//! Pi's global instructions (ADR-0108): the context file in Pi's agent directory under the
//! home (`~/.pi/agent`), which Pi itself loads before any project file. Memory discovery puts it
//! first among the user documents; the settings window's "Instructions" page reads and edits it
//! here.
//!
//! - The file is the first of [`CONTEXT_FILES`] that exists, as in Pi 1.5.2
//!   (`loadContextFileFromDir`); with none, a save creates `AGENTS.md`.
//! - A save names the SHA-256 of the bytes it was based on (`None` for a file that did not
//!   exist) and is refused with `fileModified` when the file changed since, so an edit in Pi's
//!   own CLI or an editor is never overwritten.
//! - The file keeps its encoding, byte order mark and dominant line ending; a symlink is written
//!   through to its target (dotfile managers link this file), atomically in the target's
//!   directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use piarc_fs::encoding::{self, TextEncoding};
use piarc_protocol::ErrorKind;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// The context files Pi looks for in its agent directory, in Pi's order.
pub const CONTEXT_FILES: [&str; 5] = [
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
];

/// The largest file the page reads or writes: the memory reader's limit, so a saved file is
/// always delivered.
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Pi's agent directory under `home` (Pi's default `agentDir`).
#[must_use]
pub fn agent_dir(home: &Path) -> PathBuf {
    home.join(".pi").join("agent")
}

/// Pi's global instructions file: the first of [`CONTEXT_FILES`] in the canonical agent
/// directory, or `None` when the directory or every file is missing.
///
/// # Errors
///
/// The directory or an entry cannot be inspected.
pub fn global_file(home: &Path) -> io::Result<Option<PathBuf>> {
    let dir = match agent_dir(home).canonicalize() {
        Ok(dir) => dir,
        Err(e) if missing(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    for name in CONTEXT_FILES {
        let file = dir.join(name);
        match fs::symlink_metadata(&file) {
            Ok(m) if m.is_file() || m.is_symlink() => return Ok(Some(file)),
            Ok(_) => {}
            Err(e) if missing(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

fn missing(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

/// What the page shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// The file the page edits (displayed form).
    pub path: String,
    /// Whether it exists.
    pub exists: bool,
    /// Its text, without a byte order mark; empty for a missing file.
    pub content: String,
    /// SHA-256 (hex) of its bytes, the base of the next save; `None` for a missing file.
    pub hash: Option<String>,
}

fn target(home: &Path) -> io::Result<PathBuf> {
    Ok(global_file(home)?.unwrap_or_else(|| agent_dir(home).join("AGENTS.md")))
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn io_error(error: io::Error) -> Error {
    Error::Internal {
        reason: format!("Pi's instructions: {error}"),
    }
}

fn too_large() -> Error {
    Error::InvalidArgument {
        field: "content",
        reason: format!("larger than {MAX_BYTES} bytes"),
    }
}

/// The file's bytes, or `None` when it does not exist.
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::metadata(path) {
        Ok(m) if m.len() > MAX_BYTES as u64 => return Err(too_large()),
        Ok(_) => {}
        Err(e) if missing(&e) => return Ok(None),
        Err(e) => return Err(io_error(e)),
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if missing(&e) => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}

fn text_of(bytes: &[u8]) -> String {
    let text = encoding::decode(encoding::detect(bytes), bytes);
    text.strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(text)
}

/// The page's view of the file.
///
/// # Errors
///
/// The file is larger than [`MAX_BYTES`] or cannot be read.
pub fn view(home: &Path) -> Result<View> {
    let path = target(home).map_err(io_error)?;
    let bytes = read_bytes(&path)?;
    Ok(View {
        path: piarc_fs::display(&path),
        exists: bytes.is_some(),
        content: bytes.as_deref().map(text_of).unwrap_or_default(),
        hash: bytes.as_deref().map(hash),
    })
}

/// Saves `content` over the file the view showed; answers the new view.
///
/// # Errors
///
/// `fileModified` when the file is not the one `base` names, `invalidParams` for content
/// larger than [`MAX_BYTES`] or that the file's encoding cannot hold, and an internal error
/// when the directory or the file cannot be written.
pub fn save(home: &Path, content: &str, base: Option<&str>) -> Result<View> {
    let path = target(home).map_err(io_error)?;
    let current = read_bytes(&path)?;
    if current.as_deref().map(hash).as_deref() != base {
        return Err(Error::Feature {
            kind: ErrorKind::FileModified,
            retryable: false,
            message: "Pi's instructions changed on disk after they were read".into(),
            details: None,
        });
    }
    let (coding, ending) = match current.as_deref() {
        Some(bytes) => {
            let coding = encoding::detect(bytes);
            let ending = encoding::dominant_line_ending(&encoding::decode(coding, bytes));
            (coding, ending)
        }
        None => (TextEncoding::NEW_FILE, None),
    };
    let text = encoding::with_line_endings(content, ending.unwrap_or("\n"));
    let bytes = encoding::encode(coding, &text).map_err(|_| Error::InvalidArgument {
        field: "content",
        reason: "has characters the file's encoding cannot hold".into(),
    })?;
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    // A link is written through, so the user's dotfiles keep pointing at the file.
    let written = match fs::canonicalize(&path) {
        Ok(real) => real,
        Err(e) if missing(&e) => {
            fs::create_dir_all(agent_dir(home)).map_err(io_error)?;
            path
        }
        Err(e) => return Err(io_error(e)),
    };
    piarc_config::write::replace_file(&written, &bytes).map_err(|e| Error::Internal {
        reason: format!("Pi's instructions: {e}"),
    })?;
    view(home)
}

#[cfg(test)]
#[path = "pi_instructions_tests.rs"]
mod tests;
