//! Reading and writing file content: `fs/read`, `fs/write`, `fs/mkdir`.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use piarc_protocol::fs::{BlobRef, FsMkdirResult, FsReadResult, FsWriteResult, MAX_READ_CHUNK};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::scope::{Scope, display};

/// Reads up to `length` bytes (at most [`MAX_READ_CHUNK`]) from `offset` as UTF-8 text.
///
/// Unless the range reaches the end of the file, a UTF-8 sequence cut by the range end is left
/// for the next range, so reading range after range never splits a character. Invalid UTF-8
/// becomes U+FFFD.
///
/// # Errors
///
/// The path is outside the scope, does not exist, is a directory (`EISDIR`) or cannot be
/// read.
pub fn read_text(
    scope: &Scope,
    requested: &str,
    offset: u64,
    length: Option<u64>,
) -> Result<FsReadResult> {
    let path = scope.resolve(requested)?;
    let mut file = open_file(&path)?;
    let size = file.metadata().map_err(|e| Error::io(&path, e))?.len();
    let want = length.map_or(MAX_READ_CHUNK, |n| n.min(MAX_READ_CHUNK));
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| Error::io(&path, e))?;
    let mut buffer = Vec::new();
    file.take(want)
        .read_to_end(&mut buffer)
        .map_err(|e| Error::io(&path, e))?;
    let read = buffer.len() as u64;
    // A short read means the end, even if the file grew after it was opened.
    let eof = read < want || offset.saturating_add(read) >= size;
    let keep = if eof {
        buffer.len()
    } else {
        complete_utf8_prefix(&buffer)
    };
    buffer.truncate(keep);
    Ok(FsReadResult {
        path: display(&path),
        size,
        offset,
        bytes_read: keep as u64,
        eof,
        text: Some(String::from_utf8_lossy(&buffer).into_owned()),
        blob: None,
    })
}

/// Copies the whole file into `blob_dir`, named by its SHA-256, and returns the reference
/// (ADR-0009 rule 8). An existing blob with the same name is reused.
///
/// # Errors
///
/// The path is outside the scope, does not exist, is a directory or cannot be read; the blob
/// cannot be written.
pub fn read_blob(scope: &Scope, requested: &str, blob_dir: &Path) -> Result<FsReadResult> {
    let path = scope.resolve(requested)?;
    let mut file = open_file(&path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| Error::io(&path, e))?;
    let sha256 = hex(&Sha256::digest(&bytes));
    let blob = blob_dir.join(&sha256);
    if !blob.is_file() {
        std::fs::create_dir_all(blob_dir).map_err(|e| Error::io(blob_dir, e))?;
        // Written under a temporary name first, so a reader never sees half a blob.
        let partial = blob_dir.join(format!("{sha256}.partial-{}", std::process::id()));
        std::fs::write(&partial, &bytes).map_err(|e| Error::io(&partial, e))?;
        std::fs::rename(&partial, &blob).map_err(|e| Error::io(&blob, e))?;
    }
    let size = bytes.len() as u64;
    Ok(FsReadResult {
        path: display(&path),
        size,
        offset: 0,
        bytes_read: size,
        eof: true,
        text: None,
        blob: Some(BlobRef {
            path: display(&blob),
            sha256,
            size,
        }),
    })
}

/// Writes `content` as UTF-8, replacing the file or appending to it. The parent directory must
/// exist.
///
/// # Errors
///
/// The path is outside the scope, its parent does not exist (`notFound`), it is a directory
/// (`EISDIR`) or cannot be written.
pub fn write(scope: &Scope, requested: &str, content: &str, append: bool) -> Result<FsWriteResult> {
    let path = scope.resolve(requested)?;
    if path.is_dir() {
        return Err(Error::coded(&path, "EISDIR", "is a directory"));
    }
    let mut options = OpenOptions::new();
    if append {
        options.append(true).create(true);
    } else {
        options.write(true).create(true).truncate(true);
    }
    let mut file = options.open(&path).map_err(|e| Error::io(&path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| Error::io(&path, e))?;
    Ok(FsWriteResult {
        path: display(&path),
        bytes_written: content.len() as u64,
    })
}

/// Creates the directory and any missing parents.
///
/// # Errors
///
/// The path is outside the scope, or it (or a parent) exists as a file (`EEXIST`), or the
/// directory cannot be created.
pub fn mkdir(scope: &Scope, requested: &str) -> Result<FsMkdirResult> {
    let path = scope.resolve(requested)?;
    let existed = path.is_dir();
    if !existed {
        std::fs::create_dir_all(&path).map_err(|e| Error::io(&path, e))?;
    }
    Ok(FsMkdirResult {
        path: display(&path),
        created: !existed,
    })
}

/// Opens a regular file for reading; a directory is `EISDIR` on every platform (Windows
/// would report access denied).
fn open_file(path: &Path) -> Result<File> {
    if path.is_dir() {
        return Err(Error::coded(path, "EISDIR", "is a directory"));
    }
    File::open(path).map_err(|e| Error::io(path, e))
}

/// Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. A
/// buffer holding only the start of one sequence is kept whole, so a caller reading tiny
/// ranges still makes progress.
fn complete_utf8_prefix(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let index = bytes.len() - back;
        let byte = bytes[index];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // a continuation byte: keep looking for its lead byte
        }
        let needed = match byte {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needed > back && index > 0 {
            index
        } else {
            bytes.len()
        };
    }
    bytes.len()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Reads the first `n` bytes of a file (fewer if it is shorter).
pub(crate) fn read_head(path: &Path, n: u64) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    File::open(path)?.take(n).read_to_end(&mut head)?;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn scope(tree: &TempTree) -> Scope {
        Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope")
    }

    #[test]
    fn reads_ranges_without_splitting_utf8_sequences() {
        let tree = TempTree::new("content-ranges");
        let text = "ab中文🙂z\r\nend";
        tree.file("ws/文 件.txt", text);
        let scope = scope(&tree);
        let mut offset = 0;
        let mut collected = String::new();
        loop {
            let chunk = read_text(&scope, "文 件.txt", offset, Some(4)).expect("reads");
            assert_eq!(chunk.size, text.len() as u64);
            collected.push_str(chunk.text.as_deref().expect("text"));
            offset += chunk.bytes_read;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(collected, text);
        let whole = read_text(&scope, "文 件.txt", 0, None).expect("reads");
        assert!(whole.eof);
        assert_eq!(whole.text.as_deref(), Some(text));
    }

    #[test]
    fn replaces_invalid_utf8_and_reports_missing_files_and_directories() {
        let tree = TempTree::new("content-errors");
        tree.dir("ws/dir");
        std::fs::write(tree.path("ws/bad.bin"), [b'a', 0xff, b'b']).expect("written");
        let scope = scope(&tree);
        let bad = read_text(&scope, "bad.bin", 0, None).expect("reads");
        assert_eq!(bad.text.as_deref(), Some("a\u{fffd}b"));
        assert!(matches!(
            read_text(&scope, "missing.txt", 0, None),
            Err(Error::NotFound { .. })
        ));
        let error = read_text(&scope, "dir", 0, None).expect_err("directory");
        assert_eq!(error.code(), Some("EISDIR"));
    }

    #[test]
    fn writes_appends_and_creates_directories() {
        let tree = TempTree::new("content-write");
        tree.dir("ws");
        let scope = scope(&tree);
        let made = mkdir(&scope, "a/b 乙").expect("mkdir");
        assert!(made.created);
        assert!(!mkdir(&scope, "a/b 乙").expect("mkdir again").created);
        write(&scope, "a/b 乙/f.txt", "第一\r\n", false).expect("write");
        let appended = write(&scope, "a/b 乙/f.txt", "second", true).expect("append");
        assert_eq!(appended.bytes_written, 6);
        assert_eq!(
            std::fs::read_to_string(tree.path("ws/a/b 乙/f.txt")).expect("reads"),
            "第一\r\nsecond"
        );
        write(&scope, "a/b 乙/f.txt", "replaced", false).expect("replace");
        assert_eq!(
            std::fs::read_to_string(tree.path("ws/a/b 乙/f.txt")).expect("reads"),
            "replaced"
        );
        assert!(matches!(
            write(&scope, "missing/f.txt", "x", false),
            Err(Error::NotFound { .. })
        ));
    }

    #[test]
    fn copies_blobs_by_content_hash() {
        let tree = TempTree::new("content-blob");
        std::fs::create_dir_all(tree.path("ws")).expect("dir");
        std::fs::write(tree.path("ws/img.png"), [0x89, b'P', b'N', b'G']).expect("written");
        let scope = scope(&tree);
        let blobs = tree.path("blobs");
        let first = read_blob(&scope, "img.png", &blobs).expect("blob");
        let blob = first.blob.expect("blob ref");
        assert_eq!(blob.size, 4);
        assert_eq!(blob.sha256.len(), 64);
        assert_eq!(
            std::fs::read(&blob.path).expect("blob reads"),
            [0x89, b'P', b'N', b'G']
        );
        let again = read_blob(&scope, "img.png", &blobs).expect("blob again");
        assert_eq!(again.blob.map(|b| b.path), Some(blob.path));
    }

    #[test]
    fn complete_prefix_keeps_whole_sequences() {
        let text = "a中";
        let bytes = text.as_bytes();
        assert_eq!(complete_utf8_prefix(&bytes[..2]), 1);
        assert_eq!(complete_utf8_prefix(&bytes[..3]), 1);
        assert_eq!(complete_utf8_prefix(bytes), 4);
        assert_eq!(complete_utf8_prefix(&bytes[1..2]), 1);
    }
}
