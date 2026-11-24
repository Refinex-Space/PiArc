//! The project comes from Core's session registry/index. The renderer supplies only a
//! session identifier and relative paths. User edits and agent writes share a path lock,
//! but browsing a file does not grant the agent a successful Read.
use super::{Hub, lock};
use crate::{Error, Result};
use piarc_fs::{Scope, project};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    List {
        path: String,
        include_child: Option<String>,
    },
    Read {
        path: String,
        #[serde(default)]
        force: bool,
    },
    Resolve {
        path: String,
    },
    Chunk {
        path: String,
        offset: u64,
        length: u32,
        revision: Option<String>,
    },
    Export {
        path: String,
    },
    Save {
        path: String,
        text: String,
        #[serde(deserialize_with = "Option::deserialize")]
        revision: Option<String>,
    },
    Search {
        search_id: String,
        mode: Mode,
        query: String,
        #[serde(default)]
        match_case: bool,
        #[serde(default)]
        whole_word: bool,
        #[serde(default)]
        regexp: bool,
    },
    Cancel {
        search_id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Name,
    Content,
}

impl Request {
    fn run(
        self,
        scope: &Scope,
        locks: &piarc_fs::PathLocks,
        stop: &CancellationToken,
    ) -> piarc_fs::Result<Value> {
        match self {
            Request::List {
                path,
                include_child,
            } => project::list(scope, &path, include_child.as_deref()),
            Request::Read { path, force } => {
                project::read(scope, &path, force, piarc_config::claude::is_claude_path)
            }
            Request::Resolve { path } => project::resolve(scope, &path),
            Request::Chunk {
                path,
                offset,
                length,
                revision,
            } => project::chunk(scope, &path, offset, length, revision.as_deref()),
            Request::Export { path } => project::export(scope, &path),
            Request::Save {
                path,
                text,
                revision,
            } => project::save(
                scope,
                locks,
                &path,
                &text,
                revision.as_deref(),
                piarc_config::claude::is_claude_path,
            ),
            Request::Search {
                query,
                mode,
                match_case,
                whole_word,
                regexp,
                ..
            } => project::search(
                scope,
                &query,
                matches!(mode, Mode::Content),
                project::SearchOptions {
                    match_case,
                    whole_word,
                    regexp,
                },
                &|| stop.is_cancelled(),
            ),
            Request::Cancel { .. } => unreachable!("cancellation is handled without I/O"),
        }
    }
}
impl Hub {
    pub(crate) async fn project_files(&self, id: String, request_json: String) -> Result<Value> {
        if request_json.len() > 8 * 1024 * 1024 {
            return Err(invalid("request is too large"));
        }
        let request: Request = serde_json::from_str(&request_json)
            .map_err(|_| invalid("invalid project file operation"))?;
        if let Request::Cancel { search_id } = &request {
            if let Some(token) = lock(&self.routes)
                .project_searches
                .remove(&(id, search_id.clone()))
            {
                token.cancel();
            }
            return Ok(json!({}));
        }
        let token = self.ctx.cancel.child_token();
        let key = if let Request::Search { search_id, .. } = &request {
            if search_id.is_empty() || search_id.len() > 128 {
                return Err(invalid("invalid search ID"));
            }
            let key = (id.clone(), search_id.clone());
            let mut routes = lock(&self.routes);
            let running = &mut routes.project_searches;
            if running.len() >= 4 && !running.contains_key(&key) {
                return Err(Error::QueueFull);
            }
            if let Some(previous) = running.insert(key.clone(), token.clone()) {
                previous.cancel();
            }
            Some(key)
        } else {
            None
        };
        let result = self.run_file_request(&id, request, token.clone()).await;
        if let Some(key) = key {
            let mut routes = lock(&self.routes);
            let running = &mut routes.project_searches;
            if running.get(&key) == Some(&token) {
                running.remove(&key);
            }
        }
        if token.is_cancelled() {
            return Err(Error::Feature {
                kind: piarc_protocol::ErrorKind::Cancelled,
                retryable: false,
                message: "project search cancelled".into(),
                details: None,
            });
        }
        result
    }

    async fn run_file_request(
        &self,
        id: &str,
        request: Request,
        stop: CancellationToken,
    ) -> Result<Value> {
        let registered = self.ctx.tool_io.scope(id);
        // A stored conversation can be browsed before its model provider resumes. Its indexed
        // checkout and cwd come from Core. Reject a checkout which is now a redirect.
        let fallback = if registered.is_none() {
            Some(self.indexed_file_root(id).await?)
        } else {
            None
        };
        let locks = self.ctx.tool_io.file_locks();

        tokio::task::spawn_blocking(move || {
            let scope = match registered {
                Some(scope) => scope.project_root(),
                None => {
                    let root = fallback.expect("indexed project root");
                    let scope = Scope::new(&root, &root)?;
                    if piarc_fs::display(scope.root()) != piarc_fs::display(&root) {
                        return Err(piarc_fs::Error::ApprovalMismatch {
                            path: piarc_fs::display(&root),
                        });
                    }
                    scope
                }
            };
            request.run(&scope, &locks, &stop)
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("project file operation failed: {e}"),
        })?
        .map_err(|e| Error::feature(&e.to_error_object()))
    }
    /// An imported history's claimed cwd is not authority to browse arbitrary files. Older
    /// records without a PiArc ownership field can use a previously opened enclosing workspace.
    async fn indexed_file_root(&self, id: &str) -> Result<PathBuf> {
        let key = id.to_owned();
        let (record, workspaces) = self
            .ctx
            .storage
            .run(move |s| Ok::<_, piarc_store::Error>((s.session(&key)?, s.workspaces()?)))
            .await??;
        let record = record.ok_or_else(|| super::session_not_found(id))?;
        let cwd = PathBuf::from(
            record
                .meta
                .cwd
                .ok_or_else(|| super::session_not_found(id))?,
        );
        let workspace = workspaces
            .into_iter()
            .map(|w| PathBuf::from(w.path))
            .filter(|p| {
                cwd.starts_with(p)
                    && record
                        .workspace_path
                        .as_ref()
                        .is_none_or(|root| p == std::path::Path::new(root))
            })
            .max_by_key(|p| p.components().count())
            .ok_or_else(|| invalid("session has no registered project directory"))?;
        Ok(piarc_git::worktree::containing(&workspace, &cwd).unwrap_or(workspace))
    }
}
fn invalid(reason: &str) -> Error {
    Error::InvalidArgument {
        field: "request",
        reason: reason.into(),
    }
}
