//! The `fs/*` requests on Core's side of the file tools' invariants (architecture section
//! 6.1.2, ADR-0027): each session's file state table, the path locks shared by all sessions,
//! uploads of large texts, the diff of every write, and the decision on operations that need
//! the user's approval.
//!
//! Approval: `piarc-fs` marks reads outside the session's directories and writes outside them
//! or to protected paths ([`piarc_fs::Error::NeedsApproval`]); [`adjudicate`] decides. Until
//! approvals exist (T20) it refuses them with `permissionDenied` and a message that says why
//! and what to do instead.

use std::collections::HashMap;
use std::sync::Arc;

use piarc_fs::{Access, ApprovalReason, PathLocks, WriteSpec};
use piarc_protocol::fs::{
    FsPdfParams, FsReadParams, FsSpillParams, FsSpillResult, FsStatParams, FsWriteParams,
    FsWriteResult, LineEndings, MAX_UPLOAD_BYTES, ReadMode, UploadPart,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};

use super::{SessionIo, lock, to_value};

/// Texts arriving in pieces, by upload id.
#[derive(Debug, Default)]
pub(super) struct Uploads {
    pending: HashMap<String, Upload>,
}

#[derive(Debug)]
struct Upload {
    /// What the pieces are for: `write:<path>` or `spill:<name>`.
    target: String,
    text: String,
}

/// The text of a request with an optional upload: `Some` once complete, `None` while pieces
/// are collected.
fn collect(
    session: &SessionIo,
    part: Option<&UploadPart>,
    target: String,
    content: String,
) -> Result<Option<String>, ErrorObject> {
    let Some(part) = part else {
        return Ok(Some(content));
    };
    let mut uploads = lock(&session.uploads);
    let upload = uploads
        .pending
        .entry(part.id.clone())
        .or_insert_with(|| Upload {
            target: target.clone(),
            text: String::new(),
        });
    if upload.target != target {
        let message = format!(
            "upload {} belongs to {}, not {target}",
            part.id, upload.target
        );
        uploads.pending.remove(&part.id);
        return Err(ErrorObject::new(ErrorKind::InvalidParams, message, false));
    }
    if (upload.text.len() + content.len()) as u64 > MAX_UPLOAD_BYTES {
        uploads.pending.remove(&part.id);
        return Err(ErrorObject::new(
            ErrorKind::InvalidParams,
            format!(
                "the text is larger than {} MiB and was not written",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ),
            false,
        ));
    }
    upload.text.push_str(&content);
    if part.last {
        Ok(uploads.pending.remove(&part.id).map(|u| u.text))
    } else {
        Ok(None)
    }
}

pub(super) fn stat(session: &SessionIo, p: &FsStatParams) -> Result<Value, ErrorObject> {
    let detect = p.detect_image.unwrap_or(false);
    let stat = match &p.read {
        Some(range) => piarc_fs::stat_for_read(
            &session.scope,
            &session.files,
            &p.path,
            detect,
            range.clone(),
        ),
        None => piarc_fs::stat(&session.scope, &p.path, detect),
    };
    to_value(&stat.map_err(adjudicate)?)
}

pub(super) fn read(session: &SessionIo, p: &FsReadParams) -> Result<Value, ErrorObject> {
    let offset = p.offset.unwrap_or(0);
    if p.require_fresh == Some(true) && offset == 0 {
        piarc_fs::check_fresh(&session.scope, &session.files, &p.path).map_err(adjudicate)?;
    }
    let result = match p.mode.unwrap_or(ReadMode::Text) {
        ReadMode::Text => piarc_fs::read_text(
            &session.scope,
            &session.encodings,
            &p.path,
            offset,
            p.length,
        ),
        ReadMode::Blob => piarc_fs::read_blob(&session.scope, &p.path, &session.blob_dir),
    };
    to_value(&result.map_err(adjudicate)?)
}

pub(super) fn write(
    session: &SessionIo,
    locks: &PathLocks,
    p: FsWriteParams,
) -> Result<Value, ErrorObject> {
    let target = format!("write:{}", p.path);
    let Some(text) = collect(session, p.upload.as_ref(), target, p.content)? else {
        return to_value(&FsWriteResult {
            path: p.path,
            bytes_written: 0,
            staged: Some(true),
            diff: None,
            encoding: None,
        });
    };
    let spec = WriteSpec {
        requested: &p.path,
        text: &text,
        append: p.append.unwrap_or(false),
        line_endings: p.line_endings.unwrap_or(LineEndings::AsWritten),
    };
    let written =
        piarc_fs::write(&session.scope, &session.files, locks, &spec).map_err(adjudicate)?;
    let diff = piarc_diff::file_diff(&written.label, written.before.as_deref(), &written.after);
    to_value(&FsWriteResult {
        path: piarc_fs::display(&written.path),
        bytes_written: written.bytes_written,
        staged: None,
        encoding: piarc_fs::reported_encoding(&written),
        diff: Some(diff),
    })
}

pub(super) fn spill(session: &SessionIo, p: FsSpillParams) -> Result<Value, ErrorObject> {
    let target = format!("spill:{}", p.name);
    let Some(text) = collect(session, p.upload.as_ref(), target, p.content)? else {
        return to_value(&FsSpillResult {
            path: String::new(),
            staged: Some(true),
            bytes_written: 0,
        });
    };
    let spilled = piarc_fs::spill(&session.tmp_dir, &p.name, &text).map_err(adjudicate)?;
    to_value(&FsSpillResult {
        path: piarc_fs::model_path(&spilled.path),
        staged: None,
        bytes_written: spilled.bytes,
    })
}

pub(super) fn pdf(session: &SessionIo, p: &FsPdfParams) -> Result<Value, ErrorObject> {
    let result = piarc_fs::read_pdf(&session.scope, &p.path, p.pages.as_deref());
    to_value(&result.map_err(adjudicate)?)
}

/// The wire error of a file operation; operations that need approval are decided here.
pub(super) fn adjudicate(error: piarc_fs::Error) -> ErrorObject {
    let piarc_fs::Error::NeedsApproval {
        path,
        access,
        reason,
    } = &error
    else {
        return error.to_error_object();
    };
    let hint = match (reason, access) {
        (ApprovalReason::OutsideWorkspace { allowed }, Access::Write) => format!(
            "Write inside {} instead, or ask the user to change the file.",
            allowed.first().map_or("the workspace", String::as_str)
        ),
        (ApprovalReason::OutsideWorkspace { .. }, Access::Read) => {
            "Ask the user for its content if you need it.".to_owned()
        }
        (ApprovalReason::ProtectedPath { name }, _) => {
            format!("Leave {name} unchanged unless the user explicitly asks you to change it.")
        }
    };
    let mut object = ErrorObject::new(
        ErrorKind::PermissionDenied,
        format!(
            "{error}. Asking the user is not available yet, so the operation was refused and \
             nothing was changed. {hint}"
        ),
        false,
    );
    object.data.details = Some(json!({
        "path": path,
        "reason": reason.name(),
        "operation": access.name(),
    }));
    object
}

/// Shares the path locks of every session's writes.
pub(super) type Locks = Arc<PathLocks>;
