//! The task side of the tool I/O (T32, ADR-0049): `exec/monitor`, `exec/background/list`,
//! `exec/background/read` and `exec/background/kill`, and where a session's tasks go.

use std::time::Duration;

use piarc_exec::CommandSpec;
use piarc_host::Peer;
use piarc_protocol::ErrorObject;
use piarc_protocol::exec::{ExecRunParams, ExecShell};
use piarc_protocol::tasks::{
    ExecMonitorParams, ExecMonitorResult, TaskKillParams, TaskKillResult, TaskKind, TaskList,
    TaskListParams, TaskReadParams,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::exec::background::{Judge, start_task};
use super::exec::{self, Place};
use super::{SessionIo, ToolIo, to_value};
use crate::tasks::NewTask;

/// Where the settings turn off Monitor's waking of idle sessions (ADR-0049 rule 6).
const WAKE_SETTING: &str = "/monitor/wakeIdleSession";

impl ToolIo {
    /// Where the commands of `session_id` become tasks: its main session's `tasks/`.
    pub(super) fn place(&self, session_id: &str, session: &SessionIo) -> Place {
        let owner = session
            .subagent
            .as_ref()
            .map_or_else(|| session_id.to_owned(), |link| link.root_id.clone());
        Place {
            tasks: self.tasks.clone(),
            session_id: session_id.to_owned(),
            output_dir: self.session_dir(&owner).join("tasks"),
            owner_session_id: owner,
            workspace: piarc_fs::display(session.project()),
        }
    }

    /// `exec/monitor`: the approved Monitor call's command, run as a task whose new lines
    /// reach the session's model.
    pub(super) async fn exec_monitor(
        &self,
        p: ExecMonitorParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        let mut launch = exec::launch_dir(&session, None)?;
        launch.tracked = false;
        if self.policy.is_some() {
            launch.pinned = super::policy::claim_monitor(&session, &p, &peer, &launch.dir)?;
        }
        let limits = *self.tasks.limits();
        let (timeout, capped) = limits.monitor_timeout(p.timeout_ms.map(Duration::from_millis));
        // The command's environment and wrapper are those of a background `exec/run`.
        let run = ExecRunParams {
            session_id: p.session_id.clone(),
            request_id: p.request_id.clone(),
            command: p.command.clone(),
            cwd: None,
            env: None,
            origin: p.origin.clone(),
            shell: Some(ExecShell::Bash),
            timeout_ms: None,
            background: true,
            terminal: false,
        };
        let spec = self.monitor_spec(&session, &run, &launch).await?;
        let place = self.place(&p.session_id.0, &session);
        let new = NewTask {
            session_id: place.session_id.clone(),
            owner_session_id: place.owner_session_id.clone(),
            workspace: place.workspace.clone(),
            kind: TaskKind::Monitor,
            title: p.description.trim().to_owned(),
            command: p.command.clone(),
            cwd: piarc_fs::display(&launch.dir),
            tool_call_id: p.origin.as_ref().map(|o| o.tool_call_id.clone()),
            output_dir: place.output_dir.clone(),
            timeout: Some(timeout),
        };
        let judge = Judge {
            shell: ExecShell::Bash,
            command: p.command.clone(),
        };
        let reserved = start_task(
            self.exec.runner(),
            &place.tasks,
            spec,
            new,
            judge,
            CancellationToken::new(),
        )?;
        to_value(&ExecMonitorResult {
            task_id: reserved.task_id,
            output_path: reserved.output_path,
            timeout_ms: millis(timeout),
            requested_timeout_ms: capped.then_some(p.timeout_ms).flatten(),
        })
    }

    async fn monitor_spec(
        &self,
        session: &SessionIo,
        run: &ExecRunParams,
        launch: &exec::Launch,
    ) -> Result<CommandSpec, ErrorObject> {
        let wrap = match &session.sandbox {
            Some(sandbox) => {
                let launch = sandbox.launch().map_err(|e| super::sandbox_error(&e))?;
                exec::Wrap {
                    launcher: Some(piarc_exec::Launcher {
                        program: launch.program,
                        args: launch.args,
                    }),
                    env: launch.env,
                }
            }
            None => exec::Wrap::default(),
        };
        self.exec.background_spec(session, run, launch, wrap).await
    }

    /// Whether a Monitor may wake `session_id` when it is idle: the merged setting
    /// `monitor.wakeIdleSession` (default true, I03).
    pub(crate) async fn monitor_wake_allowed(&self, session_id: &str) -> bool {
        let (Ok(session), Some(services)) = (self.session(session_id), &self.policy) else {
            return true;
        };
        match services.trust.permission_settings(session.project()).await {
            Ok(settings) => settings
                .get(WAKE_SETTING)
                .and_then(Value::as_bool)
                .unwrap_or(true),
            Err(_) => true,
        }
    }

    /// `exec/background/list`.
    pub(super) fn task_list(&self, p: &TaskListParams) -> Result<Value, ErrorObject> {
        self.session(&p.session_id.0)?;
        to_value(&TaskList {
            tasks: self.tasks.list_for(&p.session_id.0),
        })
    }

    /// `exec/background/read`.
    pub(super) async fn task_read(&self, p: TaskReadParams) -> Result<Value, ErrorObject> {
        self.session(&p.session_id.0)?;
        let chunk = self
            .tasks
            .read(
                Some(&p.session_id.0),
                &p.task_id,
                p.offset.unwrap_or(0),
                p.length,
            )
            .await?;
        to_value(&chunk)
    }

    /// `exec/background/kill`: `KillShell`.
    pub(super) async fn task_kill(&self, p: TaskKillParams) -> Result<Value, ErrorObject> {
        self.session(&p.session_id.0)?;
        let (task, stopped, tail) = self.tasks.kill_for(&p.session_id.0, &p.task_id).await?;
        to_value(&TaskKillResult {
            task,
            stopped,
            tail,
        })
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
