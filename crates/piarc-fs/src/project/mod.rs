//! The session's Files tool: each operation works relative to a retained project directory.
//! Paths returned to the renderer use forward slashes on both supported platforms.
mod download;
pub mod images;
mod search;
#[cfg(test)]
mod tests;
mod tree;

pub use download::{chunk, export};
pub use search::{SearchOptions, search};
pub use tree::list;

use crate::{Access, Error, PathLocks, Result, Scope, WriteSpec, encoding};
use piarc_checkpoint::{from_hex, hash_of, to_hex};
use piarc_protocol::fs::{FileKind, LineEndings};
use serde_json::{Value, json};
use std::{io::Read as _, path::Path};

/// The editor limit applies before allocating or decoding project-controlled bytes.
const TEXT_LIMIT: u64 = 1024 * 1024;

fn invalid(message: &str) -> Error {
    Error::InvalidRequest {
        message: message.into(),
    }
}

fn relative(path: &str, allow_root: bool) -> Result<&str> {
    if (path.is_empty() || path == ".") && allow_root {
        return Ok(".");
    }
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.chars().any(|c| c.is_ascii_control())
        || cfg!(windows) && path.contains(':')
        || path
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..")
        || path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic()
    {
        return Err(invalid("expected a project-relative path"));
    }
    Ok(path)
}

/// Resolves a file or directory for an explicit desktop platform action.
///
/// # Errors
/// The path is outside the project or no longer exists.
pub fn resolve(scope: &Scope, path: &str) -> Result<Value> {
    let stat = crate::stat(scope, relative(path, true)?, false)?;
    Ok(json!({"path":stat.path,"kind":stat.kind}))
}

fn media(path: &str) -> Option<(&'static str, &'static str)> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image", "image/png"),
        "jpeg" | "jpg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "bmp" => ("image", "image/bmp"),
        "avif" => ("image", "image/avif"),
        "ico" => ("image", "image/x-icon"),
        "mp3" => ("audio", "audio/mpeg"),
        "wav" => ("audio", "audio/wav"),
        "flac" => ("audio", "audio/flac"),
        "opus" | "ogg" | "oga" => ("audio", "audio/ogg"),
        "aac" => ("audio", "audio/aac"),
        "m4a" => ("audio", "audio/mp4"),
        "mp4" | "m4v" => ("video", "video/mp4"),
        "webm" => ("video", "video/webm"),
        "mov" => ("video", "video/quicktime"),
        "ogv" => ("video", "video/ogg"),
        "pdf" => ("pdf", "application/pdf"),
        _ => return None,
    })
}

fn text_filename(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    const BINARY_EXTENSIONS: &str = "doc docx docm xls xlsx xlsm ppt pptx pptm odt ods odp rtf epub mobi pages numbers key zip gz tgz tar bz2 xz zst 7z rar jar war dmg iso deb rpm apk msi pkg img wasm exe dll so dylib bin class pyc o a db sqlite sqlite3 parquet woff woff2 ttf otf eot avi mkv wmv flv mpg mpeg m2ts 3gp aif aiff wma mid midi tif tiff heic heif jfif psd tga dng svgz";
    media(path).is_none()
        && !BINARY_EXTENSIONS
            .split_ascii_whitespace()
            .any(|other| ext == other)
        && !name.rsplit_once(".so.").is_some_and(|(_, suffix)| {
            suffix
                .split('.')
                .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
}

pub(crate) fn can_create_at(
    scope: &Scope,
    path: &str,
    bound: &crate::bound::BoundPath,
) -> Result<bool> {
    if !text_filename(path) {
        return Ok(false);
    }
    let Some(name) = Path::new(path).file_name() else {
        return Ok(false);
    };
    let parent = path.rsplit_once('/').map_or(".", |(p, _)| p);
    let parent = scope.bind(parent, Access::Read)?;
    if parent.path().join(name) != bound.path() {
        return Ok(false);
    }
    match parent.open_dir()?.symlink_metadata(name) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(Error::io(parent.path(), e)),
    }
}

pub(crate) fn safe_text(bytes: &[u8]) -> Option<String> {
    let encoding = encoding::detect(bytes);
    let text = encoding::decode(encoding, bytes);
    if text
        .chars()
        .any(|ch| ch == '\0' || ch.is_ascii_control() && !matches!(ch, '\n' | '\r' | '\t' | '\x0c'))
        || encoding::encode(encoding, &text).as_deref() != Ok(bytes)
    {
        return None;
    }
    let mut text = text;
    if text.starts_with('\u{feff}') {
        text.drain(..'\u{feff}'.len_utf8());
    }
    Some(text)
}

/// Returns text, media data, or a bounded explanatory state. The revision hashes the exact
/// bytes displayed, including their encoding and original line endings.
///
/// # Errors
/// The file is inaccessible or outside the project.
pub fn read(scope: &Scope, path: &str, force: bool, read_only: fn(&Path) -> bool) -> Result<Value> {
    let requested = relative(path, false)?;
    let bound = scope.bind(requested, Access::Read)?;
    let writable_path = !read_only(&scope.root().join(requested)) && !read_only(bound.path());
    let mut file = match bound.open_file() {
        Ok(f) => f,
        Err(Error::NotFound { .. }) => {
            let editable = writable_path
                && scope.check(path, Access::Write).is_ok()
                && can_create_at(scope, path, &bound).unwrap_or(false);
            return Ok(json!({"path":path,"kind":"missing","size":0,"editable":editable}));
        }
        Err(e) => return Err(e),
    };
    let metadata = file.metadata().map_err(|e| Error::io(bound.path(), e))?;
    let medium = (!force).then(|| media(path)).flatten();
    let size = metadata.len();
    if let Some((kind, mime)) = medium {
        bound.verify()?;
        return Ok(json!({"path":path,"kind":kind,"size":size,"editable":false,"mime":mime}));
    }
    let limit = TEXT_LIMIT;
    let too_large = |size| json!({"path":path,"kind":"tooLarge","size":size,"editable":false});
    if size > limit {
        return Ok(too_large(size));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(bound.path(), e))?;
    bound.verify()?;
    let size = bytes.len() as u64;
    if size > limit {
        return Ok(too_large(size));
    }
    let text = safe_text(&bytes);
    let editable = text.is_some()
        && media(path).is_none()
        && writable_path
        && !metadata.permissions().readonly()
        && scope.check(requested, Access::Write).is_ok();
    match text.or_else(|| force.then(|| String::from_utf8_lossy(&bytes).into_owned())) {
        Some(text) => Ok(
            json!({"path":path,"kind":"text","size":size,"editable":editable,"text":text,"revision":to_hex(&hash_of(&bytes))}),
        ),
        None => Ok(json!({"path":path,"kind":"binary","size":size,"editable":false})),
    }
}

/// Editing a package manifest must not reconfigure a Git hook manager from the Files UI.
pub(crate) fn check_editor_change(path: &Path, before: Option<&str>, next: &str) -> Result<()> {
    if !path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("package.json"))
    {
        return Ok(());
    }
    fn manifest(text: &str) -> Option<serde_json::Map<String, Value>> {
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
    }
    let Some(after) = manifest(next) else {
        return Ok(());
    };
    let previous = before.and_then(manifest).unwrap_or_default();
    let keys = [
        "husky",
        "precommit",
        "pre-commit",
        "lint-staged",
        "nano-staged",
        "gitHooks",
        "commitlint",
    ];
    if keys.iter().any(|key| after.get(*key) != previous.get(*key)) {
        return Err(Error::NeedsApproval {
            path: crate::display(path),
            access: Access::Write,
            reason: crate::ApprovalReason::ProtectedPath {
                name: "Git hook configuration in package.json".to_owned(),
            },
        });
    }
    Ok(())
}

/// Saves the edited text only against its original revision. No agent read is registered.
///
/// # Errors
/// The revision, file contents, encoding, write permission, or size is unsuitable.
pub fn save(
    scope: &Scope,
    locks: &PathLocks,
    path: &str,
    text: &str,
    revision: Option<&str>,
    read_only: fn(&Path) -> bool,
) -> Result<Value> {
    relative(path, false)?;
    if text.len() as u64 > TEXT_LIMIT || text.contains('\0') || media(path).is_some() {
        return Err(invalid("file is not editable text within the editor limit"));
    }
    let expected = revision
        .map(|value| from_hex(value).ok_or_else(|| invalid("invalid file revision")))
        .transpose()?;
    let written = crate::write::write_editor(
        scope,
        locks,
        &WriteSpec {
            requested: path,
            text,
            append: false,
            line_endings: LineEndings::MatchFile,
            snapshots: None,
        },
        expected,
        TEXT_LIMIT,
        read_only,
    )?;
    Ok(json!({"revision":to_hex(&written.after_sha256),"size":written.bytes_written}))
}
