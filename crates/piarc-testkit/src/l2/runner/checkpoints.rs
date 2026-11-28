//! T28's actions: rewind (preview, conflict choices, report), undo, the Changes panel's view and
//! discards, branch switching and checks of the current branch and of files.

use std::collections::BTreeMap;

use piarc_core::sessions::{CheckpointOp, Op};
use piarc_protocol::checkpoint::{
    ChangesView, ConflictChoice, DiscardRequest, RewindPreview, RewindReport, RewindRequest,
};
use piarc_protocol::turn::TurnId;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{Driver, call};
use crate::l2::checkpoint_spec::{
    CheckBranchSpec, CheckChangesSpec, CheckFilesSpec, DiscardSpec, RewindSpec, SwitchBranchSpec,
    UndoRewindSpec,
};
use crate::l2::checks::check_files;
use crate::l2::matcher::subset_mismatch;

fn parse<T: DeserializeOwned>(value: Value, what: &str) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("{what}: {e}: {value}"))
}

/// The outcome of each file, by label, against the expected map.
fn check_outcomes(
    report: &RewindReport,
    expected: Option<&BTreeMap<String, piarc_protocol::checkpoint::FileOutcome>>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual: BTreeMap<String, _> = report
        .files
        .iter()
        .map(|f| (f.label.clone(), f.outcome))
        .collect();
    if &actual != expected {
        return Err(format!(
            "rewind outcomes: expected {expected:?}, got {actual:?} ({report:?})"
        ));
    }
    Ok(())
}

impl Driver<'_> {
    async fn checkpoint<T: DeserializeOwned>(
        &self,
        session: Option<&str>,
        op: CheckpointOp,
        what: &str,
    ) -> Result<T, String> {
        let value = self.op(session, Op::Checkpoint(op)).await?;
        parse(value, what)
    }

    pub(super) async fn rewind(&mut self, spec: &RewindSpec) -> Result<(), String> {
        let id = self.session_id(spec.session.as_deref())?;
        let turn = self
            .turns
            .get(&spec.turn)
            .ok_or_else(|| format!("rewind: no turn labeled {}", spec.turn))?
            .clone();
        let session = spec.session.as_deref();
        let preview: RewindPreview = self
            .checkpoint(session, CheckpointOp::Preview(turn.clone()), "preview")
            .await?;
        if let Some(expected) = &spec.preview {
            let actual: BTreeMap<String, _> = preview
                .files
                .iter()
                .map(|f| (f.label.clone(), f.action))
                .collect();
            if &actual != expected {
                return Err(format!(
                    "rewind preview: expected {expected:?}, got {actual:?}"
                ));
            }
        }
        if spec.cancel {
            return Ok(());
        }
        let choices = preview
            .files
            .iter()
            .filter(|f| f.action == piarc_protocol::checkpoint::RewindAction::Conflict)
            .map(|f| {
                let overwrite = *spec
                    .choices
                    .get(&f.label)
                    .ok_or_else(|| format!("rewind: no choice for the conflict on {}", f.label))?;
                Ok(ConflictChoice {
                    path: f.path.clone(),
                    version: f.version.clone(),
                    overwrite,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let request = RewindRequest {
            turn_id: TurnId(turn),
            scope: spec.scope,
            choices,
        };
        let report: RewindReport = self
            .checkpoint(session, CheckpointOp::Rewind(request), "rewind report")
            .await?;
        if report.completed != spec.completed {
            return Err(format!(
                "rewind: expected completed {}, got {report:?}",
                spec.completed
            ));
        }
        check_outcomes(&report, spec.outcomes.as_ref())?;
        let text = report.conversation.as_ref().and_then(|c| c.text.as_deref());
        if spec.text.is_some() && text != spec.text.as_deref() {
            return Err(format!(
                "rewind: expected the text {:?}, got {text:?}",
                spec.text
            ));
        }
        if let Some(restore) = report.restore_id {
            self.restores.insert(id, restore);
        }
        Ok(())
    }

    pub(super) async fn undo_rewind(&mut self, spec: &UndoRewindSpec) -> Result<(), String> {
        let id = self.session_id(spec.session.as_deref())?;
        let restore = self
            .restores
            .remove(&id)
            .ok_or_else(|| "undo_rewind: the session made no rewind to undo".to_owned())?;
        let report: RewindReport = self
            .checkpoint(
                spec.session.as_deref(),
                CheckpointOp::Undo(restore),
                "undo report",
            )
            .await?;
        if !report.completed {
            return Err(format!("undo_rewind did not complete: {report:?}"));
        }
        check_outcomes(&report, spec.outcomes.as_ref())
    }

    async fn changes(&self, session: Option<&str>) -> Result<(Value, ChangesView), String> {
        let value = self
            .op(session, Op::Checkpoint(CheckpointOp::Changes(None)))
            .await?;
        let view = parse(value.clone(), "changes")?;
        Ok((value, view))
    }

    pub(super) async fn check_changes(&self, spec: &CheckChangesSpec) -> Result<(), String> {
        let (value, _) = self.changes(spec.session.as_deref()).await?;
        subset_mismatch(&spec.fields, &value, "changes").map_or(Ok(()), Err)
    }

    pub(super) async fn discard(&self, spec: &DiscardSpec) -> Result<(), String> {
        let session = spec.session.as_deref();
        let (_, view) = self.changes(session).await?;
        let file = view
            .files
            .iter()
            .find(|f| f.label == spec.path)
            .ok_or_else(|| format!("discard: {} has no change", spec.path))?;
        let request = DiscardRequest {
            path: file.path.clone(),
            version: if spec.stale {
                "0".repeat(64)
            } else {
                file.version.clone()
            },
            hunk: spec.hunk,
        };
        let result = self
            .op(session, Op::Checkpoint(CheckpointOp::Discard(request)))
            .await;
        match (spec.stale, result) {
            (false, Ok(_)) => Ok(()),
            (true, Err(error)) if error.contains("fileModified") || error.contains("changed") => {
                Ok(())
            }
            (true, other) => Err(format!("discard of a stale version: {other:?}")),
            (false, Err(error)) => Err(error),
        }
    }

    async fn branch_history(&self, session: Option<&str>) -> Result<Value, String> {
        let id = self.session_id(session)?;
        call(
            |done| self.core.transcript_window(id, Some(0), 1000, done),
            "reading the session's history",
        )
        .await
    }

    pub(super) async fn switch_branch(&self, spec: &SwitchBranchSpec) -> Result<(), String> {
        let history = self.branch_history(spec.session.as_deref()).await?;
        let entry = history["branches"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|point| point["options"].as_array().into_iter().flatten())
            .find(|option| option["preview"].as_str() == Some(spec.to.as_str()))
            .and_then(|option| option["entryId"].as_str())
            .ok_or_else(|| format!("switch_branch: no branch {:?} in {history}", spec.to))?
            .to_owned();
        self.op(
            spec.session.as_deref(),
            Op::Checkpoint(CheckpointOp::SwitchBranch(entry)),
        )
        .await
        .map(drop)
    }

    pub(super) async fn check_branch(&self, spec: &CheckBranchSpec) -> Result<(), String> {
        let history = self.branch_history(spec.session.as_deref()).await?;
        let texts: Vec<&str> = history["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| {
                matches!(
                    i["item"]["type"].as_str(),
                    Some("userMessage" | "agentMessage")
                )
            })
            .filter_map(|i| i["item"]["text"].as_str())
            .collect();
        if texts != spec.texts {
            return Err(format!(
                "branch texts: expected {:?}, got {texts:?}",
                spec.texts
            ));
        }
        match &spec.branches {
            Some(Value::Null) if !history["branches"].is_null() => Err(format!(
                "expected no branch points, got {}",
                history["branches"]
            )),
            Some(Value::Null) | None => Ok(()),
            Some(fields) => {
                subset_mismatch(fields, &history["branches"], "branches").map_or(Ok(()), Err)
            }
        }
    }

    pub(super) fn check_files_now(&self, spec: &CheckFilesSpec) -> Result<(), String> {
        let failures = check_files(&spec.files, &self.env.workspace);
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}
