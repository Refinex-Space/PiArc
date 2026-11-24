//! Downloads and media share the same authorization as text. A range opens only a regular
//! file, verifies its version, and seeks directly to the requested offset.
use super::{Access, Error, Result, Scope, Value, invalid, json, media, relative};
use base64::prelude::*;
use cap_fs_ext::MetadataExt as _;
use piarc_protocol::fs::MAX_BLOB_BYTES;
use std::{
    fs::File,
    io::{Read as _, Seek as _, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

const MAX_CHUNK: u32 = 1024 * 1024;

/// Exports the original bytes of a small regular file. For larger files use [`chunk`].
///
/// # Errors
/// Reading exceeds the one-shot blob limit, fails, or falls outside the project.
pub fn export(scope: &Scope, path: &str) -> Result<Value> {
    let bound = scope.bind(relative(path, false)?, Access::Read)?;
    let file = bound.open_file()?;
    let size = file
        .metadata()
        .map_err(|e| Error::io(bound.path(), e))?
        .len();
    let too_large = || {
        Error::coded(
            bound.path(),
            "EFBIG",
            "file exceeds the one-shot export limit",
        )
    };
    if size > MAX_BLOB_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BLOB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(bound.path(), e))?;
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err(too_large());
    }
    bound.verify()?;
    Ok(
        json!({"base64":BASE64_STANDARD.encode(bytes),"mime":media(path).map_or("application/octet-stream",|(_,mime)|mime)}),
    )
}

/// Reads up to 1 MiB from the requested offset. A zero-length read returns the stream size
/// and version without loading content. Each subsequent range checks that version before
/// and after reading; unrelated replacements cannot be concatenated into the old stream.
///
/// # Errors
/// The file is unavailable, differs from the expected version, or the range is invalid.
pub fn chunk(
    scope: &Scope,
    path: &str,
    offset: u64,
    length: u32,
    expected: Option<&str>,
) -> Result<Value> {
    if length > MAX_CHUNK {
        return Err(invalid("project file range exceeds 1 MiB"));
    }
    let bound = scope.bind(relative(path, false)?, Access::Read)?;
    let mut file = bound.open_file()?;
    let (size, revision) = version(&file, bound.path())?;
    let changed = || Error::Changed {
        path: path.to_owned(),
    };
    if expected.is_some_and(|r| r != revision) {
        return Err(changed());
    }
    if offset > size {
        return Err(invalid("range starts past the end of the file"));
    }
    let take = (size - offset).min(u64::from(length)) as usize;
    let mut bytes = vec![0u8; take];
    if take > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| Error::io(bound.path(), e))?;
        file.read_exact(&mut bytes).map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                changed()
            } else {
                Error::io(bound.path(), e)
            }
        })?;
        if version(&file, bound.path())?.1 != revision {
            return Err(changed());
        }
    }
    bound.verify()?;
    Ok(json!({"size":size,"revision":revision,"base64":BASE64_STANDARD.encode(bytes)}))
}

fn version(file: &File, path: &Path) -> Result<(u64, String)> {
    let metadata = cap_std::fs::Metadata::from_file(file).map_err(|e| Error::io(path, e))?;
    let mtime = metadata
        .modified()
        .map_err(|e| Error::io(path, e))?
        .into_std();
    let time = match mtime.duration_since(UNIX_EPOCH) {
        Ok(t) => t.as_nanos() as i128,
        Err(t) => -(t.duration().as_nanos() as i128),
    };
    let key = format!(
        "{}:{}:{}:{time}",
        metadata.dev(),
        metadata.ino(),
        metadata.len()
    );
    Ok((
        metadata.len(),
        piarc_checkpoint::to_hex(&piarc_checkpoint::hash_of(key.as_bytes())),
    ))
}
