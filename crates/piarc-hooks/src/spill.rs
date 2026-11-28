//! Long hook output (Claude Code's limit): `additionalContext`, `systemMessage` and plain stdout
//! each over [`LIMIT`] characters are written to a file in the session's temporary directory;
//! the model or the user gets a [`PREVIEW`]-character preview and the file's path instead.
//! `PreCompact` instructions are cut at the limit instead, with a marker.

use std::path::{Path, PathBuf};

/// Characters a hook's text may have before it is replaced by a preview.
pub const LIMIT: usize = 10_000;

/// Characters of the preview.
pub const PREVIEW: usize = 2_000;

/// The marker appended to cut compaction instructions.
pub const CUT_MARKER: &str = "\n[PiArc cut this hook output at 10,000 characters]";

/// `text`, or when it is longer than [`LIMIT`] characters a preview and the path of a file
/// `<dir>/<name>.txt` holding all of it. When the file cannot be written the preview says so.
#[must_use]
pub fn bound(text: &str, dir: &Path, name: &str) -> String {
    let total = text.chars().count();
    if total <= LIMIT {
        return text.to_owned();
    }
    let preview: String = text.chars().take(PREVIEW).collect();
    let path: PathBuf = dir.join(format!("{name}.txt"));
    let written = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, text));
    match written {
        Ok(()) => format!(
            "{preview}\n[Hook output: {total} characters. The first {PREVIEW} are above; the full text is in {}]",
            path.display()
        ),
        Err(e) => format!(
            "{preview}\n[Hook output: {total} characters. The first {PREVIEW} are above; the rest could not be saved: {e}]"
        ),
    }
}

/// `text` cut at [`LIMIT`] characters with [`CUT_MARKER`].
#[must_use]
pub fn cut(text: &str) -> String {
    if text.chars().count() <= LIMIT {
        return text.to_owned();
    }
    let mut kept: String = text.chars().take(LIMIT).collect();
    kept.push_str(CUT_MARKER);
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_stays_and_long_text_becomes_a_preview_and_a_file() {
        let dir = std::env::temp_dir().join(format!("piarc-hooks-spill {}", std::process::id()));
        assert_eq!(bound("short", &dir, "a"), "short");
        let long: String = "字".repeat(LIMIT + 1);
        let bounded = bound(&long, &dir, "context-1");
        let path = dir.join("context-1.txt");
        assert!(bounded.starts_with(&"字".repeat(PREVIEW)));
        assert!(!bounded.starts_with(&"字".repeat(PREVIEW + 1)));
        assert!(bounded.contains(&path.display().to_string()));
        assert!(bounded.contains("10001 characters"));
        assert_eq!(
            std::fs::read_to_string(&path).ok().as_deref(),
            Some(long.as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn instructions_are_cut_with_a_marker() {
        assert_eq!(cut("keep"), "keep");
        let cut = cut(&"x".repeat(LIMIT + 5));
        assert!(cut.ends_with(CUT_MARKER));
        assert_eq!(cut.chars().count(), LIMIT + CUT_MARKER.chars().count());
    }
}
