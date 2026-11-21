//! T35 actions: sessions in worktrees, their cleanup, git checks.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

use super::{Driver, call};
use crate::l2::matcher::subset_mismatch;
use crate::l2::worktree_spec::{
    CheckGitSpec, CheckWorktreeSpec, KeepWorktreeSpec, RemoveWorktreeSpec, SearchSpec,
    SweepWorktreesSpec,
};

/// Worktree retention on the scenario's clock (`advance_clock` moves it). The timer never fires
/// on its own (`sweep_worktrees` runs a cleanup), so a cleanup cannot race the scenario's.
pub(super) fn config(
    clock: &std::sync::Arc<piarc_core::clock::ManualClock>,
) -> piarc_core::worktrees::WorktreeConfig {
    let clock = std::sync::Arc::clone(clock);
    let start = piarc_core::storage::now_ms();
    let base = piarc_ports::Clock::now(clock.as_ref());
    let timer: std::sync::Arc<dyn piarc_ports::Clock> = clock.clone();
    piarc_core::worktrees::WorktreeConfig {
        now_ms: std::sync::Arc::new(move || {
            let elapsed = piarc_ports::Clock::now(clock.as_ref()) - base;
            start + i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        }),
        clock: timer,
        sweep_interval: std::time::Duration::from_secs(100 * 365 * 24 * 60 * 60),
        ..piarc_core::worktrees::WorktreeConfig::default()
    }
}

/// Creates `session` as the runner does, in a worktree when it asks for one.
pub(super) fn create(
    core: &piarc_core::CoreRuntime,
    workspace: std::path::PathBuf,
    cwd: Option<std::path::PathBuf>,
    model: Option<piarc_protocol::session::ModelRef>,
    session: &crate::l2::format::SessionSpec,
    done: impl FnOnce(piarc_core::Result<Value>) + Send + 'static,
) -> piarc_core::Result<()> {
    match &session.worktree {
        Some(tree) => core.create_worktree_session(
            workspace,
            model,
            session.mode,
            piarc_core::sessions::WorktreeRequest {
                name: tree.name.clone(),
                base: tree.base.clone(),
            },
            done,
        ),
        None => core.create_session_with_mode(workspace, cwd, model, session.mode, done),
    }
}

impl Driver<'_> {
    pub(super) async fn sweep_worktrees(&self, spec: &SweepWorktreesSpec) -> Result<(), String> {
        let report = call(|done| self.core.sweep_worktrees(done), "sweeping worktrees").await?;
        for (key, labels) in [("removed", &spec.removed), ("waiting", &spec.waiting)] {
            let expected: BTreeSet<String> = labels
                .iter()
                .map(|label| self.session_id(Some(label)))
                .collect::<Result<_, _>>()?;
            let actual: BTreeSet<String> = report[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if expected != actual {
                return Err(format!(
                    "sweep {key}: expected {expected:?}, got {actual:?} ({report})"
                ));
            }
        }
        Ok(())
    }

    /// Core writes a session's worktree columns after the turn's index sync, which can finish
    /// after the turn's events: the record is read until it matches, at most `RECORD_WAIT`.
    pub(super) async fn check_worktree(&self, spec: &CheckWorktreeSpec) -> Result<(), String> {
        const RECORD_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
        let started = std::time::Instant::now();
        loop {
            match self.compare_worktree(spec) {
                Err(_) if started.elapsed() < RECORD_WAIT => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                result => return result,
            }
        }
    }

    fn compare_worktree(&self, spec: &CheckWorktreeSpec) -> Result<(), String> {
        let id = self.session_id(spec.session.as_deref())?;
        let storage = self.core.storage().map_err(|e| e.to_string())?;
        let record = storage
            .with(|db| db.session(&id))
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let actual = record.and_then(|r| r.worktree).map_or(Value::Null, |tree| {
            let path = Path::new(&tree.path);
            let workspace = std::fs::canonicalize(&self.env.workspace)
                .unwrap_or_else(|_| self.env.workspace.clone());
            let relative = path.strip_prefix(&workspace).map_or_else(
                |_| tree.path.clone(),
                |p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/")
                },
            );
            json!({
                "path": relative,
                "branch": tree.branch,
                "exists": path.is_dir(),
                "removed": tree.removed_at.is_some(),
                "cleanupDue": tree.cleanup_at.is_some(),
                "confirm": tree.confirm,
            })
        });
        subset_mismatch(&spec.fields, &actual, "worktree").map_or(Ok(()), Err)
    }

    pub(super) async fn remove_worktree(&self, spec: &RemoveWorktreeSpec) -> Result<(), String> {
        let id = self.session_id(spec.session.as_deref())?;
        let discard = spec.discard;
        let result = call(
            |done| self.core.remove_session_worktree(id, discard, done),
            "removing the worktree",
        )
        .await;
        match (result, spec.succeeds) {
            (Ok(_), true) | (Err(_), false) => Ok(()),
            (Ok(_), false) => Err("removing the worktree succeeded, expected a refusal".into()),
            (Err(error), true) => Err(error),
        }
    }

    pub(super) async fn keep_worktree(&self, spec: &KeepWorktreeSpec) -> Result<(), String> {
        let id = self.session_id(spec.session.as_deref())?;
        call(
            |done| self.core.keep_session_worktree(id, done),
            "keeping the worktree",
        )
        .await
        .map(drop)
    }

    pub(super) fn check_git(&self, spec: &CheckGitSpec) -> Result<(), String> {
        let output = Command::new("git")
            .args(&spec.args)
            .current_dir(&self.env.workspace)
            .output()
            .map_err(|e| format!("git {:?}: {e}", spec.args))?;
        if !output.status.success() {
            return Err(format!(
                "git {:?} failed: {}",
                spec.args,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for text in &spec.contains {
            if !stdout.contains(text.as_str()) {
                return Err(format!(
                    "git {:?} printed no {text:?}:\n{stdout}",
                    spec.args
                ));
            }
        }
        for text in &spec.not_contains {
            if stdout.contains(text.as_str()) {
                return Err(format!("git {:?} printed {text:?}:\n{stdout}", spec.args));
            }
        }
        let lines = stdout.lines().filter(|l| !l.trim().is_empty()).count();
        if spec.lines.is_some_and(|n| n != lines) {
            return Err(format!(
                "git {:?} printed {lines} lines:\n{stdout}",
                spec.args
            ));
        }
        Ok(())
    }

    pub(super) async fn search(&self, spec: &SearchSpec) -> Result<(), String> {
        let query = spec.query.clone();
        let found = call(
            |done| self.core.search_sessions(query, done),
            "searching sessions",
        )
        .await?;
        let results = found["results"].as_array().cloned().unwrap_or_default();
        let actual: BTreeSet<String> = results
            .iter()
            .filter_map(|r| r["sessionId"].as_str().map(str::to_owned))
            .collect();
        let expected: BTreeSet<String> = spec
            .sessions
            .iter()
            .map(|label| self.session_id(Some(label)))
            .collect::<Result<_, _>>()?;
        if actual != expected {
            return Err(format!(
                "search {:?}: expected {expected:?}, got {actual:?}",
                spec.query
            ));
        }
        let snippets: Vec<&str> = results
            .iter()
            .flat_map(|r| r["hits"].as_array().into_iter().flatten())
            .filter_map(|h| h["snippet"].as_str())
            .collect();
        for text in &spec.snippets {
            if !snippets.iter().any(|s| s.contains(text.as_str())) {
                return Err(format!(
                    "search {:?}: no snippet with {text:?}: {snippets:?}",
                    spec.query
                ));
            }
        }
        Ok(())
    }
}
