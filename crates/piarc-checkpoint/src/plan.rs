//! What a rewind, an undo or the Changes panel does with a session's file records
//! (ADR-0044 rules 3, 4 and 8). Pure functions: the records come from the index, the current
//! content hashes from the caller, so the rules are tested without files.
//!
//! The records of a session are in write order (their ids). The workspace has one copy of each
//! file, so "the files as they were when turn T started" is a matter of time, not of the
//! conversation's branches: of the records written from T's checkpoint on, each path's first
//! record says what the file was before (absent: the session created it), and its last record
//! says what the session left there. The current content decides:
//!
//! | current content | step |
//! |---|---|
//! | the target | [`Step::Unchanged`] |
//! | what the session left | [`Step::Write`] the target, or [`Step::Delete`] a created file |
//! | anything else (changed outside, by Bash, deleted) | [`Step::Conflict`]: the user chooses |
//!
//! A rewind's own writes are records too (`restore`, attached to the session's latest
//! checkpoint), so a second rewind sees the content the first one left, not a conflict.

use std::collections::HashMap;

use crate::store::Hash;

/// What wrote a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
    /// A file tool created the file.
    Create,
    /// A file tool replaced the file.
    Modify,
    /// A rewind put back an earlier content (or deleted a created file).
    Restore,
    /// Undoing a rewind put back what the rewind replaced.
    Undo,
    /// The Changes panel discarded a file's or a hunk's change.
    Discard,
}

impl Operation {
    /// The name stored in the index.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Modify => "modify",
            Self::Restore => "restore",
            Self::Undo => "undo",
            Self::Discard => "discard",
        }
    }

    /// The operation stored as `name`.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "create" => Self::Create,
            "modify" => Self::Modify,
            "restore" => Self::Restore,
            "undo" => Self::Undo,
            "discard" => Self::Discard,
            _ => return None,
        })
    }
}

/// One write recorded in the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecord {
    /// Write order within the database.
    pub id: i64,
    /// The checkpoint (turn) it belongs to; checkpoint ids are in turn order.
    pub checkpoint: i64,
    /// The file, as it was written (display form).
    pub path: String,
    /// The content before the write; `None`: the file did not exist.
    pub before: Option<Hash>,
    /// The content after the write; `None`: the file was deleted.
    pub after: Option<Hash>,
    /// What wrote it.
    pub operation: Operation,
    /// The rewind it belongs to (`restore` records).
    pub restore_id: Option<String>,
}

/// What happens to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The file already has the target content.
    Unchanged,
    /// The file gets the target content.
    Write,
    /// The file is removed: the target is "did not exist".
    Delete,
    /// The file changed since the session last wrote it; the user decides.
    Conflict,
}

/// One file of a rewind or an undo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// The file (the spelling of its latest record).
    pub path: String,
    /// The content to put back; `None`: the file must not exist.
    pub target: Option<Hash>,
    /// The content the session left there; `None`: it left no file.
    pub expected: Option<Hash>,
    /// The content now; `None`: there is no file.
    pub current: Option<Hash>,
    /// What happens.
    pub step: Step,
}

/// A file's earliest recorded content: the Changes panel's base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Baseline {
    /// The file (the spelling of its latest record).
    pub path: String,
    /// The content before the session first wrote it; `None`: the session created it.
    pub before: Option<Hash>,
}

fn step(target: Option<Hash>, expected: Option<Hash>, current: Option<Hash>) -> Step {
    if current == target {
        Step::Unchanged
    } else if current == expected {
        if target.is_none() {
            Step::Delete
        } else {
            Step::Write
        }
    } else {
        Step::Conflict
    }
}

/// Groups records by file key, in the order of each file's first record.
fn by_file<'a>(
    records: impl Iterator<Item = &'a FileRecord>,
    key: &impl Fn(&str) -> String,
) -> Vec<Vec<&'a FileRecord>> {
    let mut order: Vec<Vec<&FileRecord>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut sorted: Vec<&FileRecord> = records.collect();
    sorted.sort_by_key(|r| r.id);
    for record in sorted {
        let slot = *index.entry(key(&record.path)).or_insert_with(|| {
            order.push(Vec::new());
            order.len() - 1
        });
        order[slot].push(record);
    }
    order
}

fn planned<E>(
    path: &str,
    target: Option<Hash>,
    expected: Option<Hash>,
    current: &mut impl FnMut(&str) -> Result<Option<Hash>, E>,
) -> Result<PlannedFile, E> {
    let now = current(path)?;
    Ok(PlannedFile {
        path: path.to_owned(),
        target,
        expected,
        current: now,
        step: step(target, expected, now),
    })
}

/// The files of "restore the code to before the checkpoint `since`": every file the session
/// wrote from that checkpoint on. `key` folds paths the way the session's file state table
/// does; `current` hashes a file now (`None` when it does not exist).
///
/// # Errors
///
/// The first error of `current`.
pub fn plan_restore<E>(
    records: &[FileRecord],
    since: i64,
    key: impl Fn(&str) -> String,
    mut current: impl FnMut(&str) -> Result<Option<Hash>, E>,
) -> Result<Vec<PlannedFile>, E> {
    by_file(records.iter().filter(|r| r.checkpoint >= since), &key)
        .into_iter()
        .filter_map(|file| Some((*file.first()?, *file.last()?)))
        .map(|(first, last)| planned(&last.path, first.before, last.after, &mut current))
        .collect()
}

/// The files of undoing the rewind `restore_id`: each goes back to what the rewind replaced,
/// unless it changed again since.
///
/// # Errors
///
/// The first error of `current`.
pub fn plan_undo<E>(
    records: &[FileRecord],
    restore_id: &str,
    key: impl Fn(&str) -> String,
    mut current: impl FnMut(&str) -> Result<Option<Hash>, E>,
) -> Result<Vec<PlannedFile>, E> {
    let restored = records.iter().filter(|r| {
        r.operation == Operation::Restore && r.restore_id.as_deref() == Some(restore_id)
    });
    by_file(restored, &key)
        .into_iter()
        .filter_map(|file| file.last().copied())
        .map(|record| planned(&record.path, record.before, record.after, &mut current))
        .collect()
}

/// Every file the records touch with its earliest content, in the order of first writes.
#[must_use]
pub fn baselines(records: &[FileRecord], key: impl Fn(&str) -> String) -> Vec<Baseline> {
    by_file(records.iter(), &key)
        .into_iter()
        .filter_map(|file| {
            let (first, last) = (file.first()?, file.last()?);
            Some(Baseline {
                path: last.path.clone(),
                before: first.before,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
