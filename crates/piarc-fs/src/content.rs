//! Reading file content and creating directories: `fs/read`, `fs/mkdir`. Writing is in
//! [`crate::write`].

use std::collections::HashMap;
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::SystemTime;

use piarc_protocol::fs::{BlobRef, FsMkdirResult, FsReadResult, MAX_BLOB_BYTES, MAX_READ_CHUNK};
use piarc_protocol::text::incomplete_utf8_suffix;
use sha2::{Digest, Sha256};

use crate::access::Access;
use crate::encoding::{TextEncoding, decode_range, detect};
use crate::error::{Error, Result};
use crate::scope::{Scope, display};

/// How much of a file encoding detection looks at: the whole file up to this size.
pub const DETECT_BYTES: u64 = 8 * 1024 * 1024;

/// Most files an [`EncodingCache`] remembers before it starts over.
const MAX_CACHED_ENCODINGS: usize = 4096;

/// The detected encoding of each file a session reads, kept while the file's size and
/// modification time stay the same: reading a large file range by range detects once instead
/// of reading its first [`DETECT_BYTES`] for every range.
#[derive(Debug, Default)]
pub struct EncodingCache {
    entries: Mutex<HashMap<PathBuf, (Stamp, TextEncoding)>>,
}

/// A file's size and modification time.
type Stamp = (u64, Option<SystemTime>);

impl EncodingCache {
    fn encoding_of(&self, path: &Path, metadata: &Metadata) -> io::Result<TextEncoding> {
        let stamp = (metadata.len(), metadata.modified().ok());
        let lock = || self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(&(seen, encoding)) = lock().get(path)
            && seen == stamp
        {
            return Ok(encoding);
        }
        let encoding = detect(&read_head(path, DETECT_BYTES)?);
        let mut entries = lock();
        if entries.len() >= MAX_CACHED_ENCODINGS {
            entries.clear();
        }
        entries.insert(path.to_path_buf(), (stamp, encoding));
        Ok(encoding)
    }
}

/// Reads up to `length` bytes (at most [`MAX_READ_CHUNK`]) from `offset` as text.
///
/// The file's encoding is detected from its first [`DETECT_BYTES`] ([`crate::encoding`]) and
/// remembered in `encodings`; text that is not UTF-8 is decoded from it. Unless the range reaches the end of the file, a
/// character cut by the range end is left for the next range, so reading range after range
/// never splits a character. Invalid sequences become U+FFFD.
///
/// # Errors
///
/// The path needs approval, does not exist, is a directory (`EISDIR`) or cannot be read.
pub fn read_text(
    scope: &Scope,
    encodings: &EncodingCache,
    requested: &str,
    offset: u64,
    length: Option<u64>,
) -> Result<FsReadResult> {
    let path = scope.check(requested, Access::Read)?;
    let mut file = open_file(&path)?;
    let metadata = file.metadata().map_err(|e| Error::io(&path, e))?;
    let size = metadata.len();
    let encoding = encodings
        .encoding_of(&path, &metadata)
        .map_err(|e| Error::io(&path, e))?;
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
    let (text, keep) = match encoding {
        TextEncoding::Utf8 { .. } => {
            let keep = if eof {
                buffer.len()
            } else {
                complete_utf8_prefix(&buffer)
            };
            (String::from_utf8_lossy(&buffer[..keep]).into_owned(), keep)
        }
        other => decode_range(other, &buffer, eof),
    };
    Ok(FsReadResult {
        path: display(&path),
        size,
        offset,
        bytes_read: keep as u64,
        eof,
        text: Some(text),
        blob: None,
        encoding: encoding.reported(),
    })
}

/// Distinguishes the temporary files of concurrent blob writes in this process.
static PARTIAL_SEQ: AtomicU64 = AtomicU64::new(0);

/// Copies the whole file into `blob_dir`, named by its SHA-256, and returns the reference
/// (ADR-0009 rule 8). An existing blob with the same name is reused. The file is streamed
/// through the hash into a temporary file, never held in memory; files over
/// [`MAX_BLOB_BYTES`] are refused (`EFBIG`).
///
/// # Errors
///
/// The path needs approval, does not exist, is a directory, is too large or cannot be read;
/// the blob cannot be written.
pub fn read_blob(scope: &Scope, requested: &str, blob_dir: &Path) -> Result<FsReadResult> {
    let path = scope.check(requested, Access::Read)?;
    let file = open_file(&path)?;
    let size = file.metadata().map_err(|e| Error::io(&path, e))?.len();
    if size > MAX_BLOB_BYTES {
        return Err(too_large(&path, size));
    }
    std::fs::create_dir_all(blob_dir).map_err(|e| Error::io(blob_dir, e))?;
    // Copied under a temporary name first, so a reader never sees half a blob. The name is
    // unique per call: concurrent reads of the same content must not share (and truncate) one
    // partial file; the last rename wins with identical bytes.
    let partial = blob_dir.join(format!(
        "partial-{}-{}",
        std::process::id(),
        PARTIAL_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let copied = copy_hashed(file, &partial).map_err(|e| Error::io(&path, e));
    let (sha256, copied_size) = match copied {
        Ok(done) => done,
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    };
    if copied_size > MAX_BLOB_BYTES {
        // The file grew while it was copied.
        let _ = std::fs::remove_file(&partial);
        return Err(too_large(&path, copied_size));
    }
    let blob = blob_dir.join(&sha256);
    std::fs::rename(&partial, &blob).map_err(|e| Error::io(&blob, e))?;
    Ok(FsReadResult {
        path: display(&path),
        size: copied_size,
        offset: 0,
        bytes_read: copied_size,
        eof: true,
        text: None,
        blob: Some(BlobRef {
            path: display(&blob),
            sha256,
            size: copied_size,
        }),
        encoding: None,
    })
}

/// Copies at most one byte more than [`MAX_BLOB_BYTES`] of `file` to `to`, hashing it on the
/// way; returns the hex SHA-256 and the size.
fn copy_hashed(file: File, to: &Path) -> io::Result<(String, u64)> {
    let mut out = File::create(to)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut size = 0_u64;
    let mut input = file.take(MAX_BLOB_BYTES + 1);
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        out.write_all(&buffer[..read])?;
        size += read as u64;
    }
    out.sync_all()?;
    Ok((hex(&hasher.finalize()), size))
}

/// The error for a file over [`MAX_BLOB_BYTES`].
pub(crate) fn too_large(path: &Path, size: u64) -> Error {
    Error::coded(
        path,
        "EFBIG",
        &format!(
            "file too large: {size} bytes, at most {} MiB can be read this way",
            MAX_BLOB_BYTES / (1024 * 1024)
        ),
    )
}

/// Creates the directory and any missing parents.
///
/// # Errors
///
/// The path needs approval, or it (or a parent) exists as a file (`EEXIST`), or the directory
/// cannot be created.
pub fn mkdir(scope: &Scope, requested: &str) -> Result<FsMkdirResult> {
    let path = scope.check(requested, Access::Write)?;
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
pub(crate) fn open_file(path: &Path) -> Result<File> {
    if path.is_dir() {
        return Err(Error::coded(path, "EISDIR", "is a directory"));
    }
    File::open(path).map_err(|e| Error::io(path, e))
}

/// Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. A
/// buffer holding only the start of one sequence is kept whole, so a caller reading tiny
/// ranges still makes progress.
fn complete_utf8_prefix(bytes: &[u8]) -> usize {
    match bytes.len() - incomplete_utf8_suffix(bytes) {
        0 => bytes.len(),
        keep => keep,
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
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
    fn concurrent_blob_reads_of_the_same_content_all_succeed_with_an_intact_blob() {
        let tree = TempTree::new("content-blob-race");
        let content: Vec<u8> = (0..4 * 1024 * 1024_u32).map(|i| (i % 251) as u8).collect();
        let path = tree.path("ws/image.bin");
        std::fs::create_dir_all(tree.path("ws")).expect("ws created");
        std::fs::write(&path, &content).expect("written");
        let scope = std::sync::Arc::new(scope(&tree));
        for round in 0..10 {
            let blob_dir = std::sync::Arc::new(tree.path(&format!("blobs-{round}")));
            let start = std::sync::Arc::new(std::sync::Barrier::new(8));
            let readers: Vec<_> = (0..8)
                .map(|_| {
                    let (scope, blob_dir, start) = (scope.clone(), blob_dir.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        read_blob(&scope, "image.bin", &blob_dir)
                    })
                })
                .collect();
            for reader in readers {
                let result = reader.join().expect("reader thread").expect("blob read");
                let blob = result.blob.expect("blob reference");
                let stored = std::fs::read(&blob.path).expect("blob readable");
                assert!(
                    stored == content,
                    "blob holds {} of {} bytes",
                    stored.len(),
                    content.len()
                );
            }
        }
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
            let chunk = read_text(
                &scope,
                &EncodingCache::default(),
                "文 件.txt",
                offset,
                Some(4),
            )
            .expect("reads");
            assert_eq!(chunk.size, text.len() as u64);
            collected.push_str(chunk.text.as_deref().expect("text"));
            offset += chunk.bytes_read;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(collected, text);
        let whole =
            read_text(&scope, &EncodingCache::default(), "文 件.txt", 0, None).expect("reads");
        assert!(whole.eof);
        assert_eq!(whole.text.as_deref(), Some(text));
    }

    #[test]
    fn replaces_invalid_utf8_and_reports_missing_files_and_directories() {
        let tree = TempTree::new("content-errors");
        tree.dir("ws/dir");
        // Binary content (it has a NUL) is read as UTF-8 with U+FFFD ...
        std::fs::write(tree.path("ws/bad.bin"), [b'a', 0xff, 0, b'b']).expect("written");
        // ... text that is not UTF-8 is decoded from its detected legacy encoding.
        std::fs::write(tree.path("ws/latin.txt"), [b'a', 0xff, b'b']).expect("written");
        let scope = scope(&tree);
        let bad = read_text(&scope, &EncodingCache::default(), "bad.bin", 0, None).expect("reads");
        assert_eq!(bad.text.as_deref(), Some("a\u{fffd}\0b"));
        assert_eq!(bad.encoding, None);
        let latin =
            read_text(&scope, &EncodingCache::default(), "latin.txt", 0, None).expect("reads");
        assert_eq!(latin.text.as_deref(), Some("a\u{ff}b"));
        assert_eq!(latin.encoding.as_deref(), Some("windows-1252"));
        assert!(matches!(
            read_text(&scope, &EncodingCache::default(), "missing.txt", 0, None),
            Err(Error::NotFound { .. })
        ));
        let error =
            read_text(&scope, &EncodingCache::default(), "dir", 0, None).expect_err("directory");
        assert_eq!(error.code(), Some("EISDIR"));
    }

    #[test]
    fn creates_directories_and_reads_legacy_encodings_by_range() {
        let tree = TempTree::new("content-mkdir-gbk");
        tree.dir("ws");
        let scope = scope(&tree);
        let made = mkdir(&scope, "a/b 乙").expect("mkdir");
        assert!(made.created);
        assert!(!mkdir(&scope, "a/b 乙").expect("mkdir again").created);
        assert!(matches!(
            mkdir(&scope, ".git/hooks"),
            Err(Error::NeedsApproval { .. })
        ));
        let gbk = crate::encoding::encode(
            TextEncoding::Legacy(encoding_rs::GBK),
            "国标编码的中文文件，第一行。\r\n第二行，结束。\r\n",
        )
        .expect("GBK");
        std::fs::write(tree.path("ws/gbk.txt"), &gbk).expect("written");
        let mut offset = 0;
        let mut collected = String::new();
        loop {
            let chunk = read_text(
                &scope,
                &EncodingCache::default(),
                "gbk.txt",
                offset,
                Some(5),
            )
            .expect("reads");
            assert_eq!(chunk.encoding.as_deref(), Some("GBK"));
            collected.push_str(chunk.text.as_deref().expect("text"));
            offset += chunk.bytes_read;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(
            collected,
            "国标编码的中文文件，第一行。\r\n第二行，结束。\r\n"
        );
    }

    #[test]
    fn the_encoding_is_detected_again_once_the_file_changes() {
        let tree = TempTree::new("content-encoding-cache");
        tree.dir("ws");
        let scope = scope(&tree);
        let cache = EncodingCache::default();
        let gbk = crate::encoding::encode(
            TextEncoding::Legacy(encoding_rs::GBK),
            "国标编码的中文文件，用来检查缓存。\n",
        )
        .expect("GBK");
        std::fs::write(tree.path("ws/f.txt"), &gbk).expect("written");
        let first = read_text(&scope, &cache, "f.txt", 0, None).expect("reads");
        assert_eq!(first.encoding.as_deref(), Some("GBK"));
        // Same file, read again: from the cache.
        let again = read_text(&scope, &cache, "f.txt", 0, None).expect("reads");
        assert_eq!(again.text, first.text);
        // Rewritten as UTF-8 (a different size): detected again.
        std::fs::write(tree.path("ws/f.txt"), "now plain UTF-8 文本\n").expect("written");
        let changed = read_text(&scope, &cache, "f.txt", 0, None).expect("reads");
        assert_eq!(changed.encoding, None);
        assert_eq!(changed.text.as_deref(), Some("now plain UTF-8 文本\n"));
    }

    #[test]
    fn refuses_blobs_over_the_limit() {
        let tree = TempTree::new("content-blob-limit");
        tree.dir("ws");
        let file = File::create(tree.path("ws/huge.png")).expect("created");
        file.set_len(MAX_BLOB_BYTES + 1).expect("sized");
        let error = read_blob(&scope(&tree), "huge.png", &tree.path("blobs")).expect_err("big");
        assert_eq!(error.code(), Some("EFBIG"));
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
