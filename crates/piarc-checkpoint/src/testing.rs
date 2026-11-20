//! A temporary directory for the unit tests, removed on drop. Its path contains spaces and
//! Chinese characters (architecture section 15.3).

use std::path::{Path, PathBuf};

pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc-checkpoint {name} 测试 {}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old directory removed");
        }
        std::fs::create_dir_all(&root).expect("directory created");
        Self(root)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
