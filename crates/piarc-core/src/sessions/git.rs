//! The Git panel's requests (ADR-0084, ADR-0085): a session's file root and project, the
//! read-only queries the panel makes on its own, and the dispatch of the user's operations
//! (`crate::git::write`) behind trust, busy and lock checks.
//!
//! The renderer names only the session; Core decides where git runs. Every value that reaches
//! git's command line is checked first (`piarc_git::args`).

use std::path::{Path, PathBuf};

use piarc_git::{Git, Reader, args, commit, diff, index, log, refs, status};
use piarc_protocol::git::{
    GitCall, GitEvent, GitFailure, GitFailureKind, GitProbe, GitRequest, GitScope,
    GitTextSource,
};
use serde_json::Value;

use super::Hub;
use crate::git::{self as panel, reply, reply_failure};
use crate::{Error, Result};

/// The most bytes of one `gitRequest` call (a commit message and instructions fit).
const MAX_CALL: usize = 256 * 1024;

/// Where a session's git runs.
#[derive(Debug, Clone)]
pub(crate) struct Place {
    /// The file root: the worktree of a worktree session, else the workspace.
    pub root: PathBuf,
    /// The workspace of settings and trust.
    pub project: PathBuf,
}

impl Hub {
    /// Answers one `gitRequest` call of session `id` (JSON [`GitCall`]) with
    /// `{ "result": … }` or `{ "failure": … }`.
    ///
    /// # Errors
    ///
    /// `invalidParams` for a malformed call; `sessionNotFound` for an unknown session.
    pub(crate) async fn git(&self, id: String, call_json: String) -> Result<Value> {
        if call_json.len() > MAX_CALL {
            return Err(invalid("request is too large"));
        }
        let call: GitCall =
            serde_json::from_str(&call_json).map_err(|_| invalid("invalid Git request"))?;
        let place = self.git_place(&id).await?;
        let (read, user) = match self.ctx.tool_io.git_panel_runners(&place.root).await {
            Ok(runners) => runners,
            Err(_) => return reply_failure(GitFailure::of(GitFailureKind::GitMissing)),
        };
        let (cancel, _registration) = self.ctx.git.begin(call.op_id.as_deref());
        if call.request.is_read_only() {
            return self.git_read(&place, read, call.request).await;
        }
        let reader = match self.open_reader(read, &place).await {
            Ok(reader) => reader,
            Err(failure) => return reply_failure(failure),
        };
        let context = crate::git::write::Context {
            hub: self,
            session: &id,
            place: &place,
            reader,
            user,
            cancel,
            op_id: call.op_id.clone(),
        };
        context.run(call.request).await
    }

    /// Cancels the operation `op_id`; whether one was running.
    pub(crate) fn cancel_git(&self, op_id: &str) -> bool {
        self.ctx.git.cancel(op_id)
    }

    /// The file root and project of session `id`: the registered scope while it is open, the
    /// index otherwise.
    async fn git_place(&self, id: &str) -> Result<Place> {
        if let (Some(scope), Some(project)) = (
            self.ctx.tool_io.scope(id),
            self.ctx.tool_io.session_project(id),
        ) {
            return Ok(Place {
                root: scope.root().to_owned(),
                project,
            });
        }
        let (project, root) = self.indexed_place(id).await?;
        Ok(Place { root, project })
    }

    /// The user's Git settings for `project` (user file and managed settings).
    pub(crate) async fn git_settings(&self, project: &Path) -> panel::GitSettings {
        let storage = self.ctx.storage.clone();
        let project = project.to_owned();
        tokio::task::spawn_blocking(move || {
            let workspace = piarc_git::canonical(&project).unwrap_or(project);
            let table = storage.dirs().layers(&workspace);
            let settings =
                piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
            panel::settings_of(&settings)
        })
        .await
        .unwrap_or_else(|_| panel::GitSettings {
            branch_prefix: String::new(),
            protected: panel::DEFAULT_PROTECTED
                .iter()
                .map(|&s| s.to_owned())
                .collect(),
            always_force_push: false,
            pull_mode: piarc_protocol::git::GitPullMode::Config,
        })
    }

    /// The reader of `place`'s repository, remembered for `probe`.
    pub(crate) async fn open_reader(
        &self,
        git: Git,
        place: &Place,
    ) -> std::result::Result<Reader, GitFailure> {
        match Reader::open(git, &place.root).await {
            Ok(Some(reader)) => {
                self.ctx.git.remember_repo(&place.root, reader.repo.clone());
                Ok(reader)
            }
            Ok(None) => Err(GitFailure::of(GitFailureKind::NotRepo)),
            Err(error) => Err(panel::failure_of(&error)),
        }
    }

    async fn git_read(&self, place: &Place, git: Git, request: GitRequest) -> Result<Value> {
        if let GitRequest::Probe = request
            && let Some(repo) = self.ctx.git.cached_repo(&place.root)
            && repo.git_dir.is_dir()
        {
            return reply(&GitProbe {
                fingerprint: repo.fingerprint(),
            });
        }
        if let Err(failure) = check_read(&request) {
            return reply_failure(failure);
        }
        let reader = match self.open_reader(git, place).await {
            Ok(reader) => reader,
            Err(failure) => return reply_failure(failure),
        };
        match self.answer_read(place, &reader, request).await {
            Ok(value) => Ok(value),
            Err(error) => reply_failure(panel::failure_of(&error)),
        }
    }

    async fn answer_read(
        &self,
        place: &Place,
        reader: &Reader,
        request: GitRequest,
    ) -> std::result::Result<Value, piarc_git::GitError> {
        let session_base = session_base(reader).await;
        let value = match request {
            GitRequest::Probe => reply(&GitProbe {
                fingerprint: reader.repo.fingerprint(),
            }),
            GitRequest::Status => {
                let mut answer = status::status(reader, None, session_base.as_deref()).await?;
                if let Some(repo) = answer.repository.as_mut() {
                    let settings = self.git_settings(&place.project).await;
                    repo.writable = self.trusted(&place.project).await;
                    repo.protected = repo
                        .branch
                        .as_deref()
                        .is_some_and(|b| panel::is_protected(b, &settings.protected));
                }
                reply(&answer)
            }
            GitRequest::Changes {
                scope,
                ignore_whitespace,
            } => {
                let range = diff::resolve_range(reader, &scope, session_base.as_deref()).await?;
                reply(&diff::changes(reader, range, ignore_whitespace == Some(true)).await?)
            }
            GitRequest::FileDiff {
                scope,
                path,
                old_path,
                ignore_whitespace,
            } => {
                let range = diff::resolve_range(reader, &scope, session_base.as_deref()).await?;
                let one = diff::single(
                    reader,
                    &range,
                    &path,
                    old_path.as_deref(),
                    ignore_whitespace == Some(true),
                )
                .await?;
                reply(&one)
            }
            GitRequest::FileText { source, path } => {
                reply(&log::file_text(reader, &source, &path).await?)
            }
            GitRequest::Commits { base } => {
                let names = refs::ref_names(reader).await?;
                let current = piarc_git::worktree::head_branch(&reader.repo.root);
                let found = status::infer_base(
                    reader,
                    &names,
                    base.as_deref(),
                    session_base.as_deref(),
                    current.as_deref(),
                )
                .await?;
                reply(&log::commits(reader, found).await?)
            }
            GitRequest::Branches => reply(&refs::branches(reader).await?),
            GitRequest::FileStages { path } => reply(&index::file_stages(reader, &path).await?),
            GitRequest::LastCommit => reply(&commit::last_commit(reader).await?),
            _ => reply_failure(GitFailure::of(GitFailureKind::Invalid)),
        };
        Ok(value.unwrap_or(Value::Null))
    }
}

impl Hub {
    /// The Git panel's shared state.
    pub(crate) fn git_state(&self) -> &crate::git::GitState {
        &self.ctx.git
    }

    /// Whether `project` is trusted (failures are untrusted).
    pub(crate) async fn trusted(&self, project: &Path) -> bool {
        self.ctx.trust.state(project).await.is_trusted()
    }

    /// Titles of the sessions in a turn that work in `root` (worktrees under it excluded).
    pub(crate) fn busy_sessions(&self, root: &Path) -> Vec<String> {
        let worktrees = root.join(".piarc").join("worktrees");
        self.ctx
            .snapshots
            .running_sessions()
            .into_iter()
            .filter(|s| {
                s.cwd
                    .as_deref()
                    .map(Path::new)
                    .is_some_and(|cwd| cwd.starts_with(root) && !cwd.starts_with(&worktrees))
            })
            .map(|s| s.title.unwrap_or(s.id))
            .collect()
    }

    /// Sends `event` on `core/git`; a full queue drops it (progress is advisory).
    pub(crate) fn git_event(&self, event: &GitEvent) {
        if let Ok(event) = crate::events::Event::from_json(crate::route::RouteKey::git(), event) {
            let _ = self.ctx.events.try_send(event);
        }
    }

    /// Tells clients that the repository at `root` changed.
    pub(crate) fn git_changed(&self, root: &Path) {
        self.git_event(&GitEvent::Changed {
            root: piarc_fs::display(root),
        });
    }

    /// The checkpoint object store (rollback snapshots).
    pub(crate) fn snapshot_store(&self) -> Option<piarc_checkpoint::ObjectStore> {
        self.ctx.tool_io.snapshot_store()
    }

    /// Forgets `paths` in open sessions' file states.
    pub(crate) fn forget_paths(&self, paths: &[PathBuf]) {
        self.ctx.tool_io.forget_paths(paths);
    }

    /// Forgets every file under `root` in open sessions' file states.
    pub(crate) fn forget_root(&self, root: &Path) {
        self.ctx.tool_io.forget_root(root);
    }

    /// Writes bytes back under the path lock of open session `session`; `None` when it is not
    /// open.
    pub(crate) fn put_back(
        &self,
        session: &str,
        path: &Path,
        expected: Option<[u8; 32]>,
        content: Option<&[u8]>,
    ) -> Option<std::result::Result<(), String>> {
        self.ctx.tool_io.scope(session)?;
        Some(
            self.ctx
                .tool_io
                .put_back_bytes(session, path, expected, content)
                .map_err(|e| e.message),
        )
    }

    /// One `kind: "git"` audit row (no file contents, no commit message bodies).
    pub(crate) async fn audit_git(&self, session: &str, project: &Path, detail: Value) {
        let workspace = piarc_fs::display(project);
        let session = session.to_owned();
        let written = self
            .ctx
            .storage
            .run(move |db| {
                db.append_audit(&piarc_store::AuditEvent {
                    at: crate::storage::now_ms(),
                    kind: "git".into(),
                    session_id: Some(session),
                    workspace: Some(workspace),
                    detail: detail.to_string(),
                })
                .map(drop)
            })
            .await;
        if !matches!(written, Ok(Ok(()))) {
            tracing::warn!(target: "piarc_core", "could not write the Git audit row");
        }
    }
}

/// The base a branch's creation names (a worktree session's base, ADR-0084 rule 2).
async fn session_base(reader: &Reader) -> Option<String> {
    let branch = piarc_git::worktree::head_branch(&reader.repo.root)?;
    status::created_from(reader, &branch).await.ok().flatten()
}

/// Checks the values of a read-only request before git sees them.
fn check_read(request: &GitRequest) -> std::result::Result<(), GitFailure> {
    let bad = |e: args::ArgError| GitFailure::new(GitFailureKind::Invalid, e.to_string());
    match request {
        GitRequest::Changes { scope, .. } => check_scope(scope),
        GitRequest::FileDiff {
            scope,
            path,
            old_path,
            ..
        } => {
            check_scope(scope)?;
            args::check_path(path).map_err(bad)?;
            old_path
                .as_deref()
                .map_or(Ok(()), args::check_path)
                .map_err(bad)
        }
        GitRequest::FileText { source, path } => {
            args::check_path(path).map_err(bad)?;
            match source {
                GitTextSource::Commit { rev } => args::check_revision(rev).map_err(bad),
                GitTextSource::Index | GitTextSource::Worktree => Ok(()),
            }
        }
        GitRequest::Commits { base: Some(base) } => args::check_revision(base).map_err(bad),
        GitRequest::FileStages { path } => args::check_path(path).map_err(bad),
        _ => Ok(()),
    }
}

/// A commit scope names a full object id; a branch scope's base is a plain revision.
pub(crate) fn check_scope(scope: &GitScope) -> std::result::Result<(), GitFailure> {
    let bad = |e: args::ArgError| GitFailure::new(GitFailureKind::Invalid, e.to_string());
    match scope {
        GitScope::Commit { sha } if args::is_object_id(sha) && sha.len() >= 40 => Ok(()),
        GitScope::Commit { sha } => Err(GitFailure::new(
            GitFailureKind::Invalid,
            format!("not a full commit id: {sha}"),
        )),
        GitScope::Branch { base: Some(base) } => args::check_revision(base).map_err(bad),
        GitScope::Branch { base: None } | GitScope::Uncommitted => Ok(()),
    }
}

/// Requests that only read.
trait ReadOnly {
    fn is_read_only(&self) -> bool;
}

impl ReadOnly for GitRequest {
    fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::Probe
                | Self::Status
                | Self::Changes { .. }
                | Self::FileDiff { .. }
                | Self::FileText { .. }
                | Self::Commits { .. }
                | Self::Branches
                | Self::FileStages { .. }
                | Self::LastCommit
        )
    }
}

fn invalid(reason: &str) -> Error {
    Error::InvalidArgument {
        field: "request",
        reason: reason.to_owned(),
    }
}
