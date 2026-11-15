//! A temporary directory tree for the unit tests, removed on drop. Its path contains spaces
//! and Chinese characters (architecture section 15.3).

use std::path::PathBuf;

pub(crate) struct TempTree {
    root: PathBuf,
}

impl TempTree {
    pub(crate) fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc-fs {name} 测试 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old tree removed");
        }
        std::fs::create_dir_all(&root).expect("tree created");
        Self { root }
    }

    pub(crate) fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub(crate) fn dir(&self, rel: &str) {
        std::fs::create_dir_all(self.path(rel)).expect("directory created");
    }

    pub(crate) fn file(&self, rel: &str, content: &str) {
        let path = self.path(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent created");
        }
        std::fs::write(path, content).expect("file written");
    }

    #[cfg(unix)]
    pub(crate) fn symlink(&self, target: &str, rel: &str) {
        std::os::unix::fs::symlink(target, self.path(rel)).expect("symlink created");
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
