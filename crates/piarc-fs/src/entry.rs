//! What a path names: `fs/stat` and `fs/list`.

use std::fs::Metadata;
use std::time::UNIX_EPOCH;

use piarc_protocol::fs::{DirEntry, FileKind, FileStat, FsListResult};

use crate::content::read_head;
use crate::error::{Error, Result};
use crate::image;
use crate::scope::{Scope, display};

/// Most entries one `fs/list` returns.
pub const MAX_LIST_ENTRIES: u64 = 10_000;

/// Inspects the path, following symlinks; with `detect_image`, also sniffs a regular file for
/// a supported image type.
///
/// # Errors
///
/// The path is outside the scope, does not exist or cannot be inspected.
pub fn stat(scope: &Scope, requested: &str, detect_image: bool) -> Result<FileStat> {
    let path = scope.resolve(requested)?;
    let metadata = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    let kind = kind_of(&metadata);
    let image_mime_type = if detect_image && kind == FileKind::File {
        let head = read_head(&path, image::SNIFF_BYTES).map_err(|e| Error::io(&path, e))?;
        image::detect(&head).map(str::to_owned)
    } else {
        None
    };
    Ok(FileStat {
        path: display(&path),
        kind,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        readonly: metadata.permissions().readonly(),
        image_mime_type,
    })
}

/// Lists a directory in file name order, dotfiles included, at most `limit` entries (capped at
/// [`MAX_LIST_ENTRIES`]).
///
/// # Errors
///
/// The path is outside the scope, does not exist, is not a directory (`ENOTDIR`) or cannot be
/// read.
pub fn list(scope: &Scope, requested: &str, limit: Option<u64>) -> Result<FsListResult> {
    let path = scope.resolve(requested)?;
    if path.is_file() {
        // Windows reports this differently; the code is the same everywhere.
        return Err(Error::coded(&path, "ENOTDIR", "not a directory"));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| Error::io(&path, e))? {
        let entry = entry.map_err(|e| Error::io(&path, e))?;
        // A dangling symlink or an entry removed meanwhile is listed as `other`.
        let kind = std::fs::metadata(entry.path()).map_or(FileKind::Other, |m| kind_of(&m));
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let limit = usize::try_from(limit.unwrap_or(MAX_LIST_ENTRIES).min(MAX_LIST_ENTRIES))
        .unwrap_or(usize::MAX);
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(FsListResult {
        path: display(&path),
        entries,
        truncated,
    })
}

fn kind_of(metadata: &Metadata) -> FileKind {
    if metadata.is_file() {
        FileKind::File
    } else if metadata.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    }
}

fn modified_ms(metadata: &Metadata) -> Option<u64> {
    let since_epoch = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since_epoch.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn stats_files_directories_and_images() {
        let tree = TempTree::new("entry-stat");
        tree.file("ws/a b.txt", "hello");
        tree.dir("ws/子目录");
        std::fs::write(tree.path("ws/p.gif"), b"GIF89a....").expect("written");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        let file = stat(&scope, "a b.txt", true).expect("stat");
        assert_eq!((file.kind, file.size), (FileKind::File, 5));
        assert_eq!(file.image_mime_type, None);
        assert!(file.modified_ms.is_some());
        assert_eq!(
            stat(&scope, "子目录", false).expect("stat").kind,
            FileKind::Directory
        );
        assert_eq!(
            stat(&scope, "p.gif", true).expect("stat").image_mime_type,
            Some("image/gif".to_owned())
        );
        assert_eq!(
            stat(&scope, "p.gif", false).expect("stat").image_mime_type,
            None
        );
        assert!(matches!(
            stat(&scope, "nope", false),
            Err(Error::NotFound { .. })
        ));
    }

    #[test]
    fn lists_sorted_entries_with_a_limit() {
        let tree = TempTree::new("entry-list");
        tree.file("ws/b.txt", "");
        tree.file("ws/.hidden", "");
        tree.dir("ws/a");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        let all = list(&scope, ".", None).expect("list");
        let names: Vec<(&str, FileKind)> = all
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.kind))
            .collect();
        assert_eq!(
            names,
            [
                (".hidden", FileKind::File),
                ("a", FileKind::Directory),
                ("b.txt", FileKind::File)
            ]
        );
        assert!(!all.truncated);
        let two = list(&scope, ".", Some(2)).expect("list");
        assert_eq!((two.entries.len(), two.truncated), (2, true));
        let error = list(&scope, "b.txt", None).expect_err("not a directory");
        assert_eq!(error.code(), Some("ENOTDIR"), "{error}");
    }
}
