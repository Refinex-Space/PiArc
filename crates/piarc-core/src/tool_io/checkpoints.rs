//! The file side of checkpoints (architecture section 6.9, ADR-0044): recording the writes of
//! `fs/write`, and the user's rewinds, undos and Changes panel actions over the session's
//! scope, file state table and path locks.
//!
//! Every operation reads the session's records from the index, plans with `piarc-checkpoint`
//! and puts content back with `piarc_fs::replace` (expected content checked under the path
//! lock, replaced bytes stored, the file forgotten by the session's table). Rewinds and
//! discards are themselves recorded (`restore`, `undo`, `discard`) on the session's latest
//! checkpoint, so later conflicts and the Changes base account for them. Files outside the
//! session's writable directories (written with the user's approval) are reached through a
//! scope bound to exactly that path: confirming the rewind or the discard approves them.

use std::path::Path;
use std::sync::Arc;

use piarc_checkpoint::plan::{baselines, plan_restore, plan_undo};
use piarc_checkpoint::{Hash, Operation, Pin, PlannedFile, Step, to_hex};
use piarc_fs::{Access, Current, DirectoryBinding, Replacement, Scope, display};
use piarc_protocol::checkpoint::{
    ABSENT_VERSION, ChangeKind, ChangesFile, ChangesView, ConflictChoice, DiscardRequest,
    FileOutcome, FileResult, RewindAction, RewindFile, RewindPreview, RewindReport,
};
use piarc_protocol::turn::TurnId;
use piarc_protocol::{ErrorKind, ErrorObject};

use super::{SessionIo, ToolIo, lock};
use crate::checkpoints::{Checkpoints, NewRecord};

/// Files larger than this are compared by hash only in the Changes panel (no diff).
const MAX_DIFF_BYTES: u64 = 8 * 1024 * 1024;

/// The version string of a content hash.
fn version(hash: Option<&Hash>) -> String {
    hash.map_or_else(|| ABSENT_VERSION.to_owned(), to_hex)
}

fn core_error(error: &crate::error::Error) -> ErrorObject {
    error.to_error_object()
}

fn fs_error(error: &piarc_fs::Error) -> ErrorObject {
    error.to_error_object()
}

fn not_found(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::NotFound, message, false)
}

/// The session's scope, or one bound to exactly `path` when the session's directories do not
/// allow `access` without asking.
fn scope_for(s: &SessionIo, path: &str, access: Access) -> Result<Scope, piarc_fs::Error> {
    match s.scope.check(path, access) {
        Ok(_) => Ok(s.scope.clone()),
        Err(piarc_fs::Error::NeedsApproval { .. }) => {
            let target = s.scope.locate(path)?;
            let binding = DirectoryBinding::capture(&target)?;
            s.scope.clone().for_bound_path(&binding, target, access)
        }
        Err(error) => Err(error),
    }
}

fn needs_approval(s: &SessionIo, path: &str) -> bool {
    matches!(
        s.scope.check(path, Access::Write),
        Err(piarc_fs::Error::NeedsApproval { .. })
    )
}

fn current_hash(s: &SessionIo, path: &str) -> Result<Option<Hash>, piarc_fs::Error> {
    piarc_fs::current_sha256(&scope_for(s, path, Access::Read)?, path)
}

fn key(s: &SessionIo, path: &str) -> String {
    s.scope.key(Path::new(path))
}

fn label(s: &SessionIo, path: &str) -> String {
    s.scope.label(Path::new(path))
}

/// A recorded content and its pin, or the error message of a missing snapshot.
fn snapshot(
    cp: &Checkpoints,
    hash: Option<Hash>,
) -> Result<(Option<Vec<u8>>, Option<Pin>), String> {
    match hash {
        None => Ok((None, None)),
        Some(hash) => {
            let pin = cp.store().pin(hash);
            let bytes = cp.store().get(&hash).map_err(|e| e.to_string())?;
            Ok((Some(bytes), Some(pin)))
        }
    }
}

/// One file put back: its record and the pins to hold until it is recorded.
struct Applied {
    record: Option<NewRecord>,
    outcome: FileOutcome,
    pins: Vec<Pin>,
}

/// Where the settings turn file checkpointing off (Claude Code's `fileCheckpointingEnabled`).
const CHECKPOINTING_POINTER: &str = "/fileCheckpointingEnabled";

/// Whether `settings` keep file checkpointing on (the default).
pub(crate) fn checkpointing_enabled(settings: &piarc_config::Settings) -> bool {
    settings
        .get(CHECKPOINTING_POINTER)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// Whether the merged settings of the workspace at `root` keep file checkpointing on; on without
/// a settings service (tests of the I/O alone). Settings that cannot be read keep it on: a
/// snapshot too many costs disk space, a missing one loses the user's content.
async fn checkpointing_on(trust: Option<&crate::trust::TrustService>, root: &Path) -> bool {
    let Some(trust) = trust else {
        return true;
    };
    match trust.permission_settings(root).await {
        Ok(settings) => checkpointing_enabled(&settings),
        Err(error) => {
            tracing::warn!(target: "piarc_core::checkpoints",
                "reading fileCheckpointingEnabled failed, snapshots stay on: {error}");
            true
        }
    }
}

impl ToolIo {
    /// Keeps snapshots of writes and answers rewinds and the Changes panel with `checkpoints`.
    pub(crate) fn with_checkpoints(mut self, checkpoints: Checkpoints) -> Self {
        self.checkpoints = Some(checkpoints);
        self
    }

    fn checkpoints_or_err(&self) -> Result<Checkpoints, ErrorObject> {
        self.checkpoints.clone().ok_or_else(|| {
            ErrorObject::new(
                ErrorKind::InternalError,
                "Core keeps no snapshots without a data directory",
                false,
            )
        })
    }

    /// The snapshot store for `s`'s writes: none when its workspace's settings turn file
    /// checkpointing off.
    pub(super) async fn checkpoints_for(&self, s: &SessionIo) -> Option<Checkpoints> {
        let cp = self.checkpoints.clone()?;
        let trust = self.policy.as_ref().map(|p| p.trust.clone());
        checkpointing_on(trust.as_ref(), s.scope.root())
            .await
            .then_some(cp)
    }

    /// A turn of `session_id` started: its writes go to that turn's checkpoint, created now
    /// unless the settings turn file checkpointing off (no checkpoint: no code rewind to it).
    pub(crate) fn turn_started(&self, session_id: &str, turn: &str) {
        let Ok(s) = self.session(session_id) else {
            return;
        };
        *lock(&s.turn) = Some(turn.to_owned());
        if let Some(create) = self.checkpoint_creation(&s, session_id, turn) {
            tokio::spawn(create);
        }
    }

    /// What `turn_started` runs in the background: creates `turn`'s checkpoint after reading
    /// the settings. `None` when Core keeps no snapshots.
    pub(super) fn checkpoint_creation(
        &self,
        s: &SessionIo,
        session_id: &str,
        turn: &str,
    ) -> Option<impl Future<Output = ()> + Send + 'static> {
        let cp = self.checkpoints.clone()?;
        let trust = self.policy.as_ref().map(|p| p.trust.clone());
        let root = s.scope.root().to_owned();
        let (id, turn) = (session_id.to_owned(), turn.to_owned());
        Some(async move {
            if !checkpointing_on(trust.as_ref(), &root).await {
                return;
            }
            let created = tokio::task::spawn_blocking(move || cp.ensure(&id, &turn).map(|_| ()))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()));
            if let Err(error) = created {
                tracing::warn!(target: "piarc_core::checkpoints", "creating a checkpoint failed: {error}");
            }
        })
    }

    /// A turn of `session_id` ended: the session keeps its newest checkpoints.
    pub(crate) fn turn_completed(&self, session_id: &str) {
        let Some(cp) = self.checkpoints.clone() else {
            return;
        };
        let id = session_id.to_owned();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = cp.prune(&id) {
                tracing::warn!(target: "piarc_core::checkpoints", session = %id, "pruning checkpoints failed: {error}");
            }
        });
    }

    /// `session_id` was opened: its snapshots count as used.
    pub(crate) fn session_opened(&self, session_id: &str) {
        let Some(cp) = self.checkpoints.clone() else {
            return;
        };
        let id = session_id.to_owned();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = cp.touch(&id) {
                tracing::warn!(target: "piarc_core::checkpoints", session = %id, "marking snapshots used failed: {error}");
            }
        });
    }

    /// The conversation moved to another branch: what the session read is no longer in the
    /// model's context, so it reads files again before it changes them.
    pub(crate) fn reset_file_states(&self, session_id: &str) {
        if let Ok(s) = self.session(session_id) {
            *lock(&s.files) = piarc_fs::FileStates::default();
        }
    }

    /// What rewinding the files of `session_id` to before `turn` would do.
    pub(crate) async fn rewind_preview(
        &self,
        session_id: &str,
        turn: &str,
    ) -> Result<RewindPreview, ErrorObject> {
        let (s, cp) = (self.session(session_id)?, self.checkpoints_or_err()?);
        let (id, turn) = (session_id.to_owned(), turn.to_owned());
        blocking(move || {
            let since = cp.checkpoint_of(&id, &turn).map_err(|e| core_error(&e))?;
            let files = match since {
                None => Vec::new(),
                Some(since) => plan_files(&s, &cp, &id, since)?
                    .into_iter()
                    .map(|f| preview_file(&s, f))
                    .collect(),
            };
            Ok(RewindPreview {
                turn_id: TurnId(turn),
                code_available: since.is_some(),
                files,
            })
        })
        .await
    }

    /// Rewinds the files of `session_id` to before `turn`, with the user's choices for
    /// conflicts; stops at the first file that fails.
    pub(crate) async fn rewind_code(
        &self,
        session_id: &str,
        turn: &str,
        choices: Vec<ConflictChoice>,
    ) -> Result<RewindReport, ErrorObject> {
        let (s, cp, locks) = (
            self.session(session_id)?,
            self.checkpoints_or_err()?,
            Arc::clone(&self.locks),
        );
        let (id, turn) = (session_id.to_owned(), turn.to_owned());
        blocking(move || {
            let since = cp
                .checkpoint_of(&id, &turn)
                .map_err(|e| core_error(&e))?
                .ok_or_else(|| not_found(format!("turn {turn} has no file snapshots")))?;
            let plan = plan_files(&s, &cp, &id, since)?;
            let restore_id = format!(
                "restore-{}",
                crate::sessions::new_session_id().map_err(|e| core_error(&e))?
            );
            let mut run = Run::new(&s, &cp, &locks, Operation::Restore);
            for file in plan {
                let choice = choices
                    .iter()
                    .find(|c| key(&s, &c.path) == key(&s, &file.path));
                run.step(&file, |step| match (step, choice) {
                    (Step::Conflict, None) => Err(
                        "it changed since the preview; open the rewind again to choose".to_owned(),
                    ),
                    (Step::Conflict, Some(c)) if c.version != version(file.current.as_ref()) => {
                        Err("it changed again after you chose; open the rewind again".to_owned())
                    }
                    (Step::Conflict, Some(c)) => Ok(c.overwrite),
                    _ => Ok(true),
                });
            }
            run.finish(&id, Some(&restore_id))
        })
        .await
    }

    /// Undoes the rewind `restore_id`: files still as it left them get back what it replaced;
    /// files changed since are kept.
    pub(crate) async fn undo_rewind(
        &self,
        session_id: &str,
        restore_id: &str,
    ) -> Result<RewindReport, ErrorObject> {
        let (s, cp, locks) = (
            self.session(session_id)?,
            self.checkpoints_or_err()?,
            Arc::clone(&self.locks),
        );
        let (id, restore_id) = (session_id.to_owned(), restore_id.to_owned());
        blocking(move || {
            let records = cp.records(&id).map_err(|e| core_error(&e))?;
            let plan = plan_undo(
                &records,
                &restore_id,
                |p| key(&s, p),
                |p| current_hash(&s, p),
            )
            .map_err(|e| fs_error(&e))?;
            if plan.is_empty() {
                return Err(not_found(format!("no rewind {restore_id} to undo")));
            }
            let mut run = Run::new(&s, &cp, &locks, Operation::Undo);
            for file in plan {
                run.step(&file, |step| Ok(step != Step::Conflict));
            }
            run.finish(&id, None)
        })
        .await
    }

    /// The session's changed files; with `path`, that file alone, its diff always included.
    pub(crate) async fn changes(
        &self,
        session_id: &str,
        path: Option<String>,
    ) -> Result<ChangesView, ErrorObject> {
        let (s, cp) = (self.session(session_id)?, self.checkpoints_or_err()?);
        let id = session_id.to_owned();
        blocking(move || changes_view(&s, &cp, &id, path.as_deref())).await
    }

    /// Discards a file's change, or one hunk of it, as shown at `request.version`; returns the
    /// file's view afterwards.
    pub(crate) async fn discard(
        &self,
        session_id: &str,
        request: DiscardRequest,
    ) -> Result<ChangesView, ErrorObject> {
        let (s, cp, locks) = (
            self.session(session_id)?,
            self.checkpoints_or_err()?,
            Arc::clone(&self.locks),
        );
        let id = session_id.to_owned();
        blocking(move || {
            discard_file(&s, &cp, &locks, &id, &request)?;
            changes_view(&s, &cp, &id, Some(&request.path))
        })
        .await
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ErrorObject> + Send + 'static,
) -> Result<T, ErrorObject> {
    tokio::task::spawn_blocking(f).await.map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("the task failed: {e}"),
            false,
        )
    })?
}

fn plan_files(
    s: &SessionIo,
    cp: &Checkpoints,
    id: &str,
    since: i64,
) -> Result<Vec<PlannedFile>, ErrorObject> {
    let records = cp.records(id).map_err(|e| core_error(&e))?;
    plan_restore(&records, since, |p| key(s, p), |p| current_hash(s, p)).map_err(|e| fs_error(&e))
}

fn preview_file(s: &SessionIo, f: PlannedFile) -> RewindFile {
    let action = match f.step {
        Step::Unchanged => RewindAction::Unchanged,
        Step::Write => RewindAction::Restore,
        Step::Delete => RewindAction::Delete,
        Step::Conflict => RewindAction::Conflict,
    };
    RewindFile {
        label: label(s, &f.path),
        approval: needs_approval(s, &f.path).then_some(true),
        deletes: (f.step == Step::Conflict && f.target.is_none()).then_some(true),
        version: version(f.current.as_ref()),
        action,
        path: f.path,
    }
}

/// The files of one rewind or undo, in order, stopping at the first failure.
struct Run<'a> {
    s: &'a SessionIo,
    cp: &'a Checkpoints,
    locks: &'a piarc_fs::PathLocks,
    operation: Operation,
    files: Vec<FileResult>,
    records: Vec<NewRecord>,
    pins: Vec<Pin>,
    failed: Option<String>,
}

impl<'a> Run<'a> {
    fn new(
        s: &'a SessionIo,
        cp: &'a Checkpoints,
        locks: &'a piarc_fs::PathLocks,
        operation: Operation,
    ) -> Self {
        Self {
            s,
            cp,
            locks,
            operation,
            files: Vec::new(),
            records: Vec::new(),
            pins: Vec::new(),
            failed: None,
        }
    }

    /// One file: `decide` says whether a write or a conflict goes ahead (`Ok(false)`: keep),
    /// or fails the run.
    fn step(&mut self, file: &PlannedFile, decide: impl FnOnce(Step) -> Result<bool, String>) {
        let mut result = FileResult {
            path: file.path.clone(),
            label: label(self.s, &file.path),
            outcome: FileOutcome::Skipped,
            error: None,
        };
        if self.failed.is_none() {
            let outcome = match (file.step, decide(file.step)) {
                (Step::Unchanged, _) => Ok(FileOutcome::Unchanged),
                (_, Err(reason)) => Err(reason),
                (_, Ok(false)) => Ok(FileOutcome::Kept),
                (_, Ok(true)) => self.apply(file),
            };
            match outcome {
                Ok(outcome) => result.outcome = outcome,
                Err(reason) => {
                    result.outcome = FileOutcome::Failed;
                    self.failed = Some(format!("{}: {reason}", result.label));
                    result.error = Some(reason);
                }
            }
        }
        self.files.push(result);
    }

    fn apply(&mut self, file: &PlannedFile) -> Result<FileOutcome, String> {
        let (bytes, pin) = snapshot(self.cp, file.target)?;
        self.pins.extend(pin);
        let applied = put_back(
            self.s,
            self.cp,
            self.locks,
            &file.path,
            file.current,
            bytes.as_deref(),
            self.operation,
        )?;
        self.pins.extend(applied.pins);
        self.records.extend(applied.record);
        Ok(applied.outcome)
    }

    fn finish(self, id: &str, restore_id: Option<&str>) -> Result<RewindReport, ErrorObject> {
        let changed = !self.records.is_empty();
        if changed {
            self.cp
                .record(id, None, &self.records, restore_id)
                .map_err(|e| core_error(&e))?;
        }
        drop(self.pins);
        Ok(RewindReport {
            files: self.files,
            restore_id: restore_id.filter(|_| changed).map(str::to_owned),
            completed: self.failed.is_none(),
            conversation: None,
            error: self.failed,
        })
    }
}

/// Puts `content` (`None`: no file) at `path`, expected to hold `current`.
fn put_back(
    s: &SessionIo,
    cp: &Checkpoints,
    locks: &piarc_fs::PathLocks,
    path: &str,
    current: Option<Hash>,
    content: Option<&[u8]>,
    operation: Operation,
) -> Result<Applied, String> {
    let scope = scope_for(s, path, Access::Write).map_err(|e| e.to_string())?;
    let replaced = piarc_fs::replace(
        &scope,
        &s.files,
        locks,
        &Replacement {
            requested: path,
            expected: current,
            content,
            snapshots: cp.store(),
        },
    )
    .map_err(|e| e.to_string())?;
    let outcome = if replaced.after_sha256.is_none() {
        FileOutcome::Deleted
    } else if replaced.changed {
        FileOutcome::Restored
    } else {
        FileOutcome::Unchanged
    };
    Ok(Applied {
        record: replaced.changed.then(|| NewRecord {
            path: display(&replaced.path),
            before: replaced.before_sha256,
            after: replaced.after_sha256,
            operation,
        }),
        outcome,
        pins: replaced.snapshot.into_iter().collect(),
    })
}

/// The part of a file encoding detection looks at.
fn head(bytes: &[u8]) -> &[u8] {
    let limit = usize::try_from(piarc_fs::DETECT_BYTES).unwrap_or(usize::MAX);
    &bytes[..bytes.len().min(limit)]
}

/// A file's text for the diff: decoded in its encoding, without a byte order mark; `None` for
/// binary content.
fn text_of(bytes: &[u8]) -> Option<String> {
    let head = head(bytes);
    if head.contains(&0) {
        return None;
    }
    let text = piarc_fs::encoding::decode(piarc_fs::encoding::detect(head), bytes);
    Some(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    })
}

/// One changed file with its base and current content.
struct Compared {
    file: ChangesFile,
    base: Option<Vec<u8>>,
    current: Option<Vec<u8>>,
}

fn compare(
    s: &SessionIo,
    cp: &Checkpoints,
    path: &str,
    before: Option<Hash>,
) -> Result<Option<Compared>, ErrorObject> {
    let scope = scope_for(s, path, Access::Read).map_err(|e| fs_error(&e))?;
    let now = piarc_fs::read_current(&scope, path, MAX_DIFF_BYTES).map_err(|e| fs_error(&e))?;
    let (current_hash, current, too_large) = match now {
        Current::Missing => (None, None, false),
        Current::Bytes(bytes) => (Some(piarc_checkpoint::hash_of(&bytes)), Some(bytes), false),
        Current::TooLarge { sha256, .. } => (Some(sha256), None, true),
    };
    if current_hash == before {
        return Ok(None);
    }
    let base = match before {
        None => None,
        Some(hash) => Some(cp.store().get(&hash).map_err(|e| e.to_error_object())?),
    };
    let label = label(s, path);
    let kind = match (&before, &current_hash) {
        (None, _) => ChangeKind::Created,
        (_, None) => ChangeKind::Deleted,
        _ => ChangeKind::Modified,
    };
    let base_text = base.as_deref().map(text_of);
    let current_text = current.as_deref().map(text_of);
    let binary = too_large || matches!(base_text, Some(None)) || matches!(current_text, Some(None));
    let diff = (!binary).then(|| {
        piarc_diff::file_diff(
            &label,
            base_text.flatten().as_deref(),
            current_text.flatten().as_deref().unwrap_or(""),
        )
    });
    Ok(Some(Compared {
        file: ChangesFile {
            path: path.to_owned(),
            label,
            kind,
            version: version(current_hash.as_ref()),
            added: diff.as_ref().map_or(0, |d| d.added),
            removed: diff.as_ref().map_or(0, |d| d.removed),
            binary: binary.then_some(true),
            diff,
        },
        base,
        current,
    }))
}

fn changes_view(
    s: &SessionIo,
    cp: &Checkpoints,
    id: &str,
    path: Option<&str>,
) -> Result<ChangesView, ErrorObject> {
    let records = cp.records(id).map_err(|e| core_error(&e))?;
    let wanted = path.map(|p| key(s, p));
    let mut files = Vec::new();
    for base in baselines(&records, |p| key(s, p)) {
        if wanted.as_ref().is_some_and(|w| *w != key(s, &base.path)) {
            continue;
        }
        match compare(s, cp, &base.path, base.before) {
            Ok(Some(compared)) => files.push(compared.file),
            Ok(None) => {}
            // One unreadable file does not hide the others.
            Err(error) if wanted.is_none() => {
                tracing::warn!(target: "piarc_core::checkpoints", session = %id, path = %base.path,
                    "a changed file cannot be compared: {}", error.message);
            }
            Err(error) => return Err(error),
        }
    }
    let added = files.iter().map(|f| f.added).sum();
    let removed = files.iter().map(|f| f.removed).sum::<u64>();
    let degraded = path.is_none()
        && (files.len() > piarc_diff::MAX_PANEL_FILES
            || added + removed > piarc_diff::MAX_PANEL_LINES);
    if degraded {
        for file in &mut files {
            file.diff = None;
        }
    }
    Ok(ChangesView {
        files,
        added,
        removed,
        degraded: degraded.then_some(true),
    })
}

fn discard_file(
    s: &SessionIo,
    cp: &Checkpoints,
    locks: &piarc_fs::PathLocks,
    id: &str,
    request: &DiscardRequest,
) -> Result<(), ErrorObject> {
    let records = cp.records(id).map_err(|e| core_error(&e))?;
    let wanted = key(s, &request.path);
    let base = baselines(&records, |p| key(s, p))
        .into_iter()
        .find(|b| key(s, &b.path) == wanted)
        .ok_or_else(|| not_found(format!("{} has no recorded change", request.path)))?;
    let changed = || {
        piarc_fs::Error::Changed {
            path: request.path.clone(),
        }
        .to_error_object()
    };
    let compared = compare(s, cp, &base.path, base.before)?.ok_or_else(changed)?;
    if compared.file.version != request.version {
        return Err(changed());
    }
    let current = piarc_checkpoint::from_hex(&compared.file.version);
    let (content, pin) = match request.hunk {
        None => snapshot(cp, base.before)
            .map_err(|reason| ErrorObject::new(ErrorKind::NotFound, reason, false))?,
        Some(index) => (
            Some(reverted_hunk(&compared, index).ok_or_else(changed)?),
            None,
        ),
    };
    let applied = put_back(
        s,
        cp,
        locks,
        &base.path,
        current,
        content.as_deref(),
        Operation::Discard,
    )
    .map_err(|reason| ErrorObject::new(ErrorKind::FileModified, reason, false))?;
    if let Some(record) = applied.record {
        cp.record(id, None, &[record], None)
            .map_err(|e| core_error(&e))?;
    }
    drop((applied.pins, pin));
    Ok(())
}

/// The current content with hunk `index` of the shown diff reverted, in the file's encoding.
fn reverted_hunk(compared: &Compared, index: u64) -> Option<Vec<u8>> {
    let diff = compared.file.diff.as_ref()?;
    let hunk = diff.hunks.get(usize::try_from(index).ok()?)?;
    let encoded_from = compared.current.as_deref().or(compared.base.as_deref())?;
    let encoding = piarc_fs::encoding::detect(head(encoded_from));
    let current = compared
        .current
        .as_deref()
        .map_or(Some(String::new()), text_of)?;
    let text = piarc_diff::revert_hunks(&current, &[hunk]).ok()?;
    piarc_fs::encoding::encode(encoding, &text).ok()
}

#[cfg(test)]
mod tests;
