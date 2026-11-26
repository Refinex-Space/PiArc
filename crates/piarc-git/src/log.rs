//! The commits of the branch scope (`base..HEAD`) and a file's complete text at one revision,
//! for the Git panel.

use piarc_protocol::git::{GitBase, GitBlob, GitCommitRow, GitCommits, GitText, GitTextSource};

use crate::diff::MAX_FILE_BYTES;
use crate::exec::ExecOptions;
use crate::git::GitError;
use crate::repo::Reader;

/// The most commits listed.
pub const MAX_COMMITS: usize = 100;

/// Parses `log -z --format=%H%x1f%h%x1f%an%x1f%ct%x1f%s`.
#[must_use]
pub fn parse_log(out: &[u8]) -> Vec<GitCommitRow> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            let f: Vec<&str> = record.splitn(5, '\u{1f}').collect();
            (f.len() == 5).then(|| GitCommitRow {
                sha: f[0].to_owned(),
                short: f[1].to_owned(),
                author: f[2].to_owned(),
                time: f[3].parse().unwrap_or(0),
                subject: f[4].to_owned(),
            })
        })
        .collect()
}

/// The newest commits of `base..HEAD` (at most [`MAX_COMMITS`]) and their total.
///
/// # Errors
///
/// The reader's errors.
pub async fn commits(reader: &Reader, base: Option<GitBase>) -> Result<GitCommits, GitError> {
    let Some(found) = base else {
        return Ok(GitCommits {
            base: None,
            commits: Vec::new(),
            total: 0,
        });
    };
    let Some(merge_base) = found.merge_base.clone() else {
        return Ok(GitCommits {
            base: Some(found),
            commits: Vec::new(),
            total: 0,
        });
    };
    let range = format!("{merge_base}..HEAD");
    let max = format!("--max-count={MAX_COMMITS}");
    let out = reader
        .ok(&[
            "log",
            "--no-show-signature",
            "-z",
            &max,
            "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s",
            "--end-of-options",
            &range,
        ])
        .await?;
    let count = reader
        .ok(&["rev-list", "--count", "--end-of-options", &range])
        .await?;
    Ok(GitCommits {
        base: Some(found),
        commits: parse_log(&out),
        total: String::from_utf8_lossy(&count).trim().parse().unwrap_or(0),
    })
}

/// A file's complete text from a commit, the index or the working tree. `rev` and `path` are
/// checked by the caller.
///
/// # Errors
///
/// The reader's errors.
pub async fn file_text(
    reader: &Reader,
    source: &GitTextSource,
    path: &str,
) -> Result<GitText, GitError> {
    let bytes = match source {
        GitTextSource::Worktree => {
            let full = reader.repo.root.join(path);
            match std::fs::symlink_metadata(&full) {
                Ok(meta) if meta.len() > MAX_FILE_BYTES as u64 => return Ok(too_large()),
                Ok(meta) if meta.file_type().is_symlink() => std::fs::read_link(&full)
                    .map(|t| t.to_string_lossy().into_owned().into_bytes())
                    .ok(),
                Ok(_) => std::fs::read(&full).ok(),
                Err(_) => None,
            }
        }
        GitTextSource::Commit { rev } => match blob(reader, &format!("{rev}:{path}")).await? {
            Blob::TooLarge => return Ok(too_large()),
            Blob::Missing => None,
            Blob::Bytes(bytes) => Some(bytes),
        },
        GitTextSource::Index => match blob(reader, &format!(":{path}")).await? {
            Blob::TooLarge => return Ok(too_large()),
            Blob::Missing => None,
            Blob::Bytes(bytes) => Some(bytes),
        },
    };
    let Some(bytes) = bytes else {
        return Ok(GitText {
            text: None,
            binary: None,
            too_large: None,
        });
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Ok(too_large());
    }
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(GitText {
            text: None,
            binary: Some(true),
            too_large: None,
        });
    }
    Ok(GitText {
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        binary: None,
        too_large: None,
    })
}

/// The most bytes [`file_blob`] returns.
pub const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

/// A file's bytes from a commit, the index or the working tree, base64, for an image diff.
/// `rev` and `path` are checked by the caller; a link in the working tree is not followed.
///
/// # Errors
///
/// The reader's errors.
pub async fn file_blob(
    reader: &Reader,
    source: &GitTextSource,
    path: &str,
) -> Result<GitBlob, GitError> {
    use base64::Engine as _;
    let too_large = |size: u64| GitBlob {
        data: None,
        size,
        too_large: Some(true),
    };
    let missing = GitBlob {
        data: None,
        size: 0,
        too_large: None,
    };
    let bytes = match source {
        GitTextSource::Worktree => {
            let full = reader.repo.root.join(path);
            match std::fs::symlink_metadata(&full) {
                Ok(meta) if meta.is_file() && meta.len() > MAX_BLOB_BYTES as u64 => {
                    return Ok(too_large(meta.len()));
                }
                Ok(meta) if meta.is_file() => std::fs::read(&full).ok().map(Ok),
                _ => None,
            }
        }
        GitTextSource::Commit { rev } => {
            sized_blob(reader, &format!("{rev}:{path}"), MAX_BLOB_BYTES).await?
        }
        GitTextSource::Index => sized_blob(reader, &format!(":{path}"), MAX_BLOB_BYTES).await?,
    };
    Ok(match bytes {
        None => missing,
        Some(Err(size)) => too_large(size),
        Some(Ok(bytes)) if bytes.len() > MAX_BLOB_BYTES => too_large(bytes.len() as u64),
        Some(Ok(bytes)) => GitBlob {
            size: bytes.len() as u64,
            data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            too_large: None,
        },
    })
}

/// The bytes of `object`; `Some(Err(size))` past `limit`, `None` when missing.
async fn sized_blob(
    reader: &Reader,
    object: &str,
    limit: usize,
) -> Result<Option<Result<Vec<u8>, u64>>, GitError> {
    let size = reader
        .run(&["cat-file", "-s", object], ExecOptions::default())
        .await?;
    if !size.success() {
        return Ok(None);
    }
    let bytes: u64 = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse()
        .unwrap_or(u64::MAX);
    if bytes > limit as u64 {
        return Ok(Some(Err(bytes)));
    }
    let out = reader
        .run(
            &["cat-file", "blob", object],
            ExecOptions {
                stdout_limit: Some(limit),
                ..ExecOptions::default()
            },
        )
        .await?;
    Ok(out.success().then_some(Ok(out.stdout)))
}

fn too_large() -> GitText {
    GitText {
        text: None,
        binary: None,
        too_large: Some(true),
    }
}

enum Blob {
    Missing,
    TooLarge,
    Bytes(Vec<u8>),
}

/// The raw bytes of `object` (`<rev>:<path>`).
async fn blob(reader: &Reader, object: &str) -> Result<Blob, GitError> {
    let size = reader
        .run(&["cat-file", "-s", object], ExecOptions::default())
        .await?;
    if !size.success() {
        return Ok(Blob::Missing);
    }
    let bytes: usize = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse()
        .unwrap_or(usize::MAX);
    if bytes > MAX_FILE_BYTES {
        return Ok(Blob::TooLarge);
    }
    let out = reader
        .run(
            &["cat-file", "blob", object],
            ExecOptions {
                stdout_limit: Some(MAX_FILE_BYTES),
                ..ExecOptions::default()
            },
        )
        .await?;
    Ok(if out.success() {
        Blob::Bytes(out.stdout)
    } else {
        Blob::Missing
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_records() {
        let out = b"aaaa\x1faa\x1fAda\x1f1700000000\x1ffeat: one\0bbbb\x1fbb\x1f\xe7\x8e\x8b\x1f1700000100\x1ffix: two\0";
        let rows = parse_log(out);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].subject, "feat: one");
        assert_eq!(rows[1].author, "王");
        assert_eq!(rows[1].time, 1_700_000_100);
    }
}
