//! Long tool results kept in the session's temporary directory (architecture section 6.15,
//! "工具结果截断"): the model gets a preview and the file's path, and reads the rest with
//! `Read` (the temporary directory is readable without asking, see [`crate::Scope`]).
//!
//! The file is `<temporary directory>/tool-results/<name>.txt`, written atomically, UTF-8. The
//! path the model sees ([`model_path`]) starts with `~` below the home directory, so no user
//! name reaches the model; the `Read` tool expands `~` as Pi's path rules do.

use std::path::{MAIN_SEPARATOR, Path, PathBuf};

use crate::error::{Error, Result};
use crate::scope::display;

/// Subdirectory of the session's temporary directory that holds the results.
pub const SPILL_DIR: &str = "tool-results";

/// Longest file name stem kept from the requested name.
const MAX_NAME_CHARS: usize = 96;

/// A tool result written to disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spilled {
    /// Where it is.
    pub path: PathBuf,
    /// Bytes written.
    pub bytes: u64,
}

/// Writes `text` as `<tmp_dir>/tool-results/<name>.txt`, replacing an earlier file of the same
/// name. Characters of `name` other than ASCII letters, digits, `-` and `_` become `_`.
///
/// # Errors
///
/// The directory or the file cannot be written.
pub fn spill(tmp_dir: &Path, name: &str, text: &str) -> Result<Spilled> {
    let dir = tmp_dir.join(SPILL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let path = dir.join(format!("{}.txt", file_stem(name)));
    let existing = std::fs::metadata(&path).ok();
    crate::atomic::replace(&path, text.as_bytes(), existing.as_ref())
        .map_err(|e| Error::io(&path, e))?;
    Ok(Spilled {
        path,
        bytes: text.len() as u64,
    })
}

/// Creates (or truncates) `<tmp_dir>/tool-results/<name>.txt` for text written as it arrives
/// (a command's output, T17): the same directory and naming as [`spill`], but not atomic,
/// since the text is longer than memory should hold.
///
/// # Errors
///
/// The directory or the file cannot be created.
pub fn create(tmp_dir: &Path, name: &str) -> Result<(std::fs::File, PathBuf)> {
    let dir = tmp_dir.join(SPILL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let path = dir.join(format!("{}.txt", file_stem(name)));
    let file = std::fs::File::create(&path).map_err(|e| Error::io(&path, e))?;
    Ok((file, path))
}

/// `path` as the model is told about it: `~` plus the rest below the home directory, otherwise
/// the usual absolute spelling. Both are canonicalized first when they exist, so a path spelled
/// through a symlink or a Windows short name (`RUNNER~1`) is still recognized below home.
#[must_use]
pub fn model_path(path: &Path) -> String {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let shown = display(&canonical(path));
    let Some(home) = std::env::home_dir() else {
        return shown;
    };
    let home = display(&canonical(&home));
    let home = home.trim_end_matches(['/', '\\']);
    match shown.strip_prefix(home) {
        Some(rest) if rest.starts_with(['/', '\\']) => format!("~{MAIN_SEPARATOR}{}", &rest[1..]),
        _ => shown,
    }
}

fn file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .take(MAX_NAME_CHARS)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "result".to_owned()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn writes_under_a_safe_name_and_replaces_an_earlier_file() {
        let tree = TempTree::new("spill-write");
        let first = spill(&tree.path("tmp"), "call_1|../../x", "長い結果").expect("spilled");
        assert_eq!(
            first.path,
            tree.path("tmp").join(SPILL_DIR).join("call_1_______x.txt")
        );
        assert_eq!(first.bytes, "長い結果".len() as u64);
        let again = spill(&tree.path("tmp"), "call_1|../../x", "second").expect("spilled");
        assert_eq!(again.path, first.path);
        assert_eq!(
            std::fs::read_to_string(&first.path).expect("reads"),
            "second"
        );
        assert!(
            spill(&tree.path("tmp"), "", "x")
                .expect("spilled")
                .path
                .ends_with("result.txt")
        );
    }

    #[test]
    fn creates_a_streaming_file_under_the_same_name() {
        use std::io::Write;
        let tree = TempTree::new("spill-create");
        let (mut file, path) = create(&tree.path("tmp"), "toolu 1").expect("created");
        file.write_all("部分".as_bytes()).expect("writes");
        assert_eq!(path, tree.path("tmp").join(SPILL_DIR).join("toolu_1.txt"));
        assert_eq!(std::fs::read_to_string(&path).expect("reads"), "部分");
    }

    #[test]
    fn the_model_path_hides_the_home_directory() {
        let home = std::env::home_dir().expect("home");
        let inside = home.join("Library").join("PiArc").join("r.txt");
        let shown = model_path(&inside);
        assert!(shown.starts_with('~'), "{shown}");
        assert!(!shown.contains(&*home.to_string_lossy()), "{shown}");
        assert!(shown.ends_with("r.txt"));
        let outside = Path::new(if cfg!(windows) {
            r"Z:\elsewhere\r.txt"
        } else {
            "/opt/elsewhere/r.txt"
        });
        assert_eq!(model_path(outside), display(outside));
    }
}
