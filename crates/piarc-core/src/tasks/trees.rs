//! The process trees of running tasks (ADR-0092 rule 5) and the `browserVerify` reminder
//! (rule 6): what `crate::ports` asks about, and the one reminder per turn.

use std::sync::{Arc, OnceLock};

use piarc_exec::listeners::Tree;
use piarc_protocol::tasks::{BackgroundTask, TaskKind, TaskStatus};
use tokio::sync::watch;

use super::{Notice, TaskManager, lock};

/// Answers a running task's process tree now; `None` while it is not known yet.
pub(crate) type TreeSource = Arc<dyn Fn() -> Option<Tree> + Send + Sync>;

/// The tree of a command started with `piarc_exec::CommandRunner::run_reporting`: its process
/// group (Unix) or its descendants (Windows), once the process id is known.
#[must_use]
pub(crate) fn command_tree(started: Arc<OnceLock<u32>>) -> TreeSource {
    Arc::new(move || {
        started.get().map(|&root| Tree {
            root,
            members: Vec::new(),
        })
    })
}

/// A running task with a process tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TreeTask {
    pub task_id: String,
    pub owner_session_id: String,
    pub workspace: String,
    pub kind: TaskKind,
    pub title: String,
}

impl TaskManager {
    /// Task `task_id`'s process tree, for as long as it runs.
    pub(crate) fn set_tree(&self, task_id: &str, tree: TreeSource) {
        if let Some(entry) = lock(&self.inner.state).tasks.get_mut(task_id) {
            entry.tree = Some(tree);
        }
    }

    /// The tree of running task `task_id`, when it has one.
    pub(crate) fn tree_of(&self, task_id: &str) -> Option<Tree> {
        let source = lock(&self.inner.state)
            .tasks
            .get(task_id)
            .filter(|e| e.task.status == TaskStatus::Running)
            .and_then(|e| e.tree.clone());
        source.and_then(|source| source())
    }

    /// Every running task with a known tree, with the tree now.
    pub(crate) fn running_trees(&self) -> Vec<(TreeTask, Tree)> {
        let sources: Vec<(TreeTask, TreeSource)> = lock(&self.inner.state)
            .tasks
            .values()
            .filter(|e| e.task.status == TaskStatus::Running)
            .filter_map(|e| {
                e.tree.clone().map(|tree| {
                    (
                        TreeTask {
                            task_id: e.task.task_id.clone(),
                            owner_session_id: e.task.owner_session_id.clone(),
                            workspace: e.task.workspace.clone(),
                            kind: e.task.kind,
                            title: e.task.title.clone(),
                        },
                        tree,
                    )
                })
            })
            .collect();
        // Outside the lock: a terminal's tree lists the processes of its terminal.
        sources
            .into_iter()
            .filter_map(|(task, source)| source().map(|tree| (task, tree)))
            .collect()
    }

    /// Fires when task `task_id` ended (its value turns true); `None` for an unknown task.
    pub(crate) fn ended_receiver(&self, task_id: &str) -> Option<watch::Receiver<bool>> {
        self.done_receiver(task_id)
    }

    /// Task `task_id` as it stands.
    pub(crate) fn task_view(&self, task_id: &str) -> Option<BackgroundTask> {
        lock(&self.inner.state)
            .tasks
            .get(task_id)
            .map(|e| e.task.clone())
    }

    /// The last `lines` lines of task `task_id`'s output.
    pub(crate) fn log_tail(&self, task_id: &str, lines: usize) -> Vec<String> {
        let log = lock(&self.inner.state)
            .tasks
            .get(task_id)
            .and_then(|e| e.log.clone());
        log.map(|log| lock(&log).tail(lines)).unwrap_or_default()
    }

    /// Leaves `notice` (a `browserVerify` reminder) for main session `owner` unless it got one
    /// in its current turn; whether it was left.
    pub(crate) fn remind_once_per_turn(&self, owner: &str, notice: Notice) -> bool {
        if !lock(&self.inner.state).verified.insert(owner.to_owned()) {
            return false;
        }
        self.add_notice(owner, notice);
        true
    }
}
