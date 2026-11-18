//! The fuzzy file search behind `@` mentions (ADR-0030).
//!
//! A search lists the files below a directory (with ignore files honored, `piarc_fs::fuzzy`)
//! and ranks them against the query. The listing of a directory is kept for [`LIST_TTL`], so
//! typing narrows the same list instead of walking the tree on every key. Each search has a
//! client-chosen id; a newer search with the same id, or `cancel`, stops the older one, which
//! then fails with `cancelled`. Searching only works inside a workspace Core knows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use piarc_fs::fuzzy::{self, FileList};
use piarc_protocol::ErrorKind;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

/// The most matches one search returns.
pub const MAX_RESULTS: usize = 50;

/// How long a directory's file list is reused.
pub const LIST_TTL: Duration = Duration::from_secs(10);

/// File lists kept at most (one per searched directory).
const MAX_LISTS: usize = 8;

#[derive(Default)]
struct Inner {
    lists: HashMap<PathBuf, (Instant, Arc<FileList>)>,
    running: HashMap<String, CancellationToken>,
}

/// The search service. Cheap to clone.
#[derive(Clone, Default)]
pub struct FileSearch {
    inner: Arc<Mutex<Inner>>,
}

fn lock(mutex: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl FileSearch {
    /// Searches `root` (a directory inside a known workspace, checked by the caller) for
    /// `query`; at most `limit` (capped at [`MAX_RESULTS`]) matches, best first:
    /// `{ root, results: [{ path, name, positions }], truncated }`.
    ///
    /// # Errors
    ///
    /// `cancelled` when a newer search with the same id or `cancel` stopped it; the errors of
    /// listing the directory.
    pub async fn search(
        &self,
        search_id: String,
        root: PathBuf,
        query: String,
        limit: usize,
    ) -> Result<Value> {
        let token = CancellationToken::new();
        if let Some(previous) = lock(&self.inner)
            .running
            .insert(search_id.clone(), token.clone())
        {
            previous.cancel();
        }
        let this = self.clone();
        let job_token = token.clone();
        let result = tokio::task::spawn_blocking(move || {
            this.run(&root, &query, limit.min(MAX_RESULTS), &job_token)
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("a file search failed: {e}"),
        })
        .and_then(|result| result);
        let mut inner = lock(&self.inner);
        if inner
            .running
            .get(&search_id)
            .is_some_and(|current| current.is_cancelled() || current == &token)
        {
            inner.running.remove(&search_id);
        }
        result
    }

    /// Stops search `search_id` if it is still running.
    pub fn cancel(&self, search_id: &str) {
        if let Some(token) = lock(&self.inner).running.remove(search_id) {
            token.cancel();
        }
    }

    fn run(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
        token: &CancellationToken,
    ) -> Result<Value> {
        let cancelled = || token.is_cancelled();
        let list = self.list(root, &cancelled)?;
        let matches =
            fuzzy::rank(&list.files, query, limit, &cancelled).map_err(|_| cancelled_error())?;
        let results: Vec<Value> = matches
            .into_iter()
            .map(|found| {
                let name = found
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&found.path)
                    .to_owned();
                json!({ "path": found.path, "name": name, "positions": found.positions })
            })
            .collect();
        Ok(json!({
            "root": piarc_fs::display(root),
            "results": results,
            "truncated": list.truncated,
        }))
    }

    fn list(&self, root: &Path, cancelled: &dyn Fn() -> bool) -> Result<Arc<FileList>> {
        if let Some((at, list)) = lock(&self.inner).lists.get(root)
            && at.elapsed() < LIST_TTL
        {
            return Ok(Arc::clone(list));
        }
        let scope =
            piarc_fs::Scope::new(root, root).map_err(|e| Error::feature(&e.to_error_object()))?;
        let list = Arc::new(fuzzy::list_files(&scope, cancelled).map_err(|e| {
            if cancelled() {
                cancelled_error()
            } else {
                Error::feature(&e.to_error_object())
            }
        })?);
        let mut inner = lock(&self.inner);
        if inner.lists.len() >= MAX_LISTS {
            let oldest = inner
                .lists
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                inner.lists.remove(&oldest);
            }
        }
        inner
            .lists
            .insert(root.to_path_buf(), (Instant::now(), Arc::clone(&list)));
        Ok(list)
    }
}

fn cancelled_error() -> Error {
    Error::Feature {
        kind: ErrorKind::Cancelled,
        retryable: false,
        message: "the file search was cancelled by a newer one".into(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-core file search {name} 中文 {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for file in ["src/main.rs", "src/lib.rs", "target/x.rs", "README.md"] {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            std::fs::write(path, "").expect("file");
        }
        std::fs::write(dir.join(".gitignore"), "target/\n").expect("ignore");
        dir
    }

    #[tokio::test]
    async fn finds_files_outside_ignored_directories_and_caps_the_results() {
        let root = tree("find");
        let search = FileSearch::default();
        let found = search
            .search("s".into(), root.clone(), "rs".into(), 1)
            .await
            .expect("searched");
        let results = found["results"].as_array().expect("results");
        assert_eq!(results.len(), 1);
        let all = search
            .search("s".into(), root.clone(), "rs".into(), 100)
            .await
            .expect("searched");
        let paths: Vec<&str> = all["results"]
            .as_array()
            .expect("results")
            .iter()
            .filter_map(|r| r["path"].as_str())
            .collect();
        assert!(paths.contains(&"src/main.rs") && paths.contains(&"src/lib.rs"));
        assert!(!paths.iter().any(|p| p.starts_with("target/")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_cancelled_search_reports_cancellation() {
        let root = tree("cancel");
        let search = FileSearch::default();
        let token = CancellationToken::new();
        token.cancel();
        let error = search.run(&root, "x", 5, &token).expect_err("cancelled");
        assert_eq!(error.kind(), ErrorKind::Cancelled);
        search.cancel("unknown");
        let _ = std::fs::remove_dir_all(root);
    }
}
