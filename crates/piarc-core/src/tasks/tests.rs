//! The task manager without processes: notices, Monitor pace on a manual clock, who may stop
//! what, subagent ends (T32). Commands with real process trees are in
//! `tests/background_tasks.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_exec::TaskLog;
use piarc_protocol::context::ReminderType;
use piarc_protocol::subagent::SubagentStatus;
use piarc_protocol::tasks::{TaskKind, TaskStatus};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::clock::ManualClock;

struct Fixture {
    dir: PathBuf,
    clock: Arc<ManualClock>,
    tasks: TaskManager,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("piarc tasks {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let clock = ManualClock::new();
        let tasks = TaskManager::new(TasksConfig {
            limits: TaskLimits {
                monitor_wake_interval: Duration::from_secs(30),
                ..TaskLimits::default()
            },
            clock: clock.clone(),
        });
        Self { dir, clock, tasks }
    }

    /// Registers a running task of `kind` for session `session` (main session `owner`);
    /// returns its id and its cancellation token.
    fn start(&self, kind: TaskKind, session: &str, owner: &str) -> (String, CancellationToken) {
        let reserved = self.tasks.reserve(&self.dir).expect("reserve");
        let log = Arc::new(Mutex::new(TaskLog::create(&reserved.file).expect("log")));
        let cancel = CancellationToken::new();
        self.tasks.register(
            &reserved,
            NewTask {
                session_id: session.into(),
                owner_session_id: owner.into(),
                workspace: "/w".into(),
                kind,
                title: "watch the log".into(),
                command: "tail -f app.log".into(),
                cwd: "/w".into(),
                tool_call_id: Some("toolu_1".into()),
                output_dir: self.dir.clone(),
                timeout: None,
            },
            log,
            cancel.clone(),
        );
        (reserved.task_id, cancel)
    }

    /// Ends the task as a process would once its token fires.
    fn end_on_cancel(&self, task_id: &str, cancel: CancellationToken) {
        let (tasks, id) = (self.tasks.clone(), task_id.to_owned());
        tokio::spawn(async move {
            cancel.cancelled().await;
            tasks.ended(
                &id,
                Ended {
                    signal: Some(15),
                    ..Ended::default()
                },
            );
        });
    }

    fn notice(&self, session: &str) -> Option<Notice> {
        self.tasks.pending(session).into_iter().next()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never held");
}

#[tokio::test]
async fn monitor_lines_go_out_at_once_in_a_turn_and_wake_an_idle_session_at_a_pace() {
    let f = Fixture::new("monitor pace");
    let (id, _cancel) = f.start(TaskKind::Monitor, "s", "s");
    f.tasks.turn_started("s");
    f.tasks.monitor_lines(&id, vec!["error: one".into()]);
    let first = f.notice("s").expect("a notice in the turn");
    assert_eq!(first.kind, ReminderType::MonitorOutput);
    assert_eq!(first.key, format!("monitor:{id}"));
    assert!(!first.wake, "a running turn is not woken");
    assert!(first.text.contains("error: one"), "{}", first.text);
    f.tasks.delivered("s", first.kind, &first.source);
    assert!(f.notice("s").is_none());

    // The turn ends: the next line wakes the idle session.
    f.tasks.turn_completed("s");
    f.tasks.monitor_lines(&id, vec!["error: two".into()]);
    let woke = f.notice("s").expect("a waking notice");
    assert!(woke.wake && woke.text.contains("error: two") && !woke.text.contains("one"));
    f.tasks.delivered("s", woke.kind, &woke.source);

    // Within the interval a new line waits, without waking.
    f.tasks.monitor_lines(&id, vec!["error: three".into()]);
    let waiting = f.notice("s").expect("a notice");
    assert!(!waiting.wake, "too soon to wake again");
    f.clock.advance(Duration::from_secs(29));
    tokio::task::yield_now().await;
    assert!(!f.notice("s").expect("still waiting").wake);
    f.clock.advance(Duration::from_secs(1));
    until(|| f.notice("s").is_some_and(|n| n.wake)).await;
    assert!(f.notice("s").expect("woke").text.contains("error: three"));
}

/// W2: one burst of output can arrive in pieces (Git Bash on Windows writes the first line on
/// its own). Lines that join a waking notice before it went out keep it waking.
#[tokio::test]
async fn lines_joining_a_waking_notice_keep_it_waking() {
    let f = Fixture::new("monitor pieces");
    let (id, _cancel) = f.start(TaskKind::Monitor, "s", "s");
    f.tasks.monitor_lines(&id, vec!["line 1".into()]);
    assert!(f.notice("s").expect("a notice").wake);
    f.tasks
        .monitor_lines(&id, vec!["line 2".into(), "line 3".into()]);
    let joined = f.notice("s").expect("one notice");
    assert!(joined.wake, "the session still has to wake");
    assert!(joined.text.contains("line 3"), "{}", joined.text);
    f.tasks.delivered("s", joined.kind, &joined.source);
    // Delivered: the next line within the interval waits again.
    f.tasks.monitor_lines(&id, vec!["line 4".into()]);
    assert!(!f.notice("s").expect("waiting").wake);
}

#[tokio::test]
async fn a_monitor_that_ends_tells_how_and_its_last_lines() {
    let f = Fixture::new("monitor end");
    let (id, _cancel) = f.start(TaskKind::Monitor, "s", "s");
    f.tasks.turn_started("s");
    f.tasks.monitor_lines(&id, vec!["build ✓".into()]);
    f.tasks.ended(
        &id,
        Ended {
            exit_code: Some(0),
            success: true,
            ..Ended::default()
        },
    );
    let notice = f.notice("s").expect("the last batch");
    assert!(notice.text.contains("build ✓"));
    assert!(
        notice
            .text
            .ends_with("The monitored command has ended (exit code 0).")
    );
    assert!(notice.source.ends_with("/end"));
    f.tasks.delivered("s", notice.kind, &notice.source);
    assert!(f.notice("s").is_none());
    let task = f.tasks.list_for("s").remove(0);
    assert_eq!(
        (task.status, task.exit_code),
        (TaskStatus::Completed, Some(0))
    );
}

#[tokio::test]
async fn a_finished_command_leaves_a_notice_unless_killshell_stopped_it() {
    let f = Fixture::new("notices");
    let (done, _) = f.start(TaskKind::Command, "s", "s");
    f.tasks.ended(
        &done,
        Ended {
            exit_code: Some(3),
            ..Ended::default()
        },
    );
    let notice = f.notice("s").expect("a completion notice");
    assert_eq!(
        (notice.kind, notice.wake),
        (ReminderType::BackgroundTask, false)
    );
    assert_eq!(notice.source, done);
    assert!(
        notice.text.contains("Status: failed (exit code 3)"),
        "{}",
        notice.text
    );
    f.tasks.delivered("s", notice.kind, &notice.source);

    let (killed, cancel) = f.start(TaskKind::Command, "s", "s");
    f.end_on_cancel(&killed, cancel);
    let (task, stopped, _) = f.tasks.kill_for("s", &killed).await.expect("stopped");
    assert!(stopped);
    assert_eq!(task.status, TaskStatus::Killed);
    assert!(f.notice("s").is_none(), "KillShell's result told the model");

    let (by_user, cancel) = f.start(TaskKind::Command, "s", "s");
    f.end_on_cancel(&by_user, cancel);
    f.tasks.stop(&by_user, StopBy::User).await.expect("stopped");
    assert!(
        f.notice("s")
            .expect("the user's stop is told")
            .text
            .contains("stopped by the user")
    );
}

#[tokio::test]
async fn a_subagents_finished_command_tells_its_main_session() {
    // R4 S4: a subagent's session has no session actor to deliver to; its task belongs to the
    // main session (ADR-0049 rule 1), and so does the notice.
    let f = Fixture::new("subagent notice");
    let (done, _) = f.start(TaskKind::Command, "child", "main");
    f.tasks.ended(&done, Ended::default());
    assert!(
        f.notice("child").is_none(),
        "nobody delivers to the subagent"
    );
    let notice = f.notice("main").expect("the main session hears of it");
    assert_eq!(notice.source, done);
}

#[tokio::test]
async fn killshell_reaches_the_session_and_its_subagents_only() {
    let f = Fixture::new("owners");
    let (own, cancel) = f.start(TaskKind::Command, "main", "main");
    f.end_on_cancel(&own, cancel);
    let (child, cancel) = f.start(TaskKind::Command, "child", "main");
    f.end_on_cancel(&child, cancel);
    let (other, _) = f.start(TaskKind::Command, "other", "other");
    let refused = f
        .tasks
        .kill_for("main", &other)
        .await
        .expect_err("not ours");
    assert_eq!(refused.data.kind, ErrorKind::NotFound);
    let unknown = f
        .tasks
        .kill_for("main", "bg-000000000000")
        .await
        .expect_err("none");
    assert_eq!(
        unknown.message,
        refused.message.replace(&other, "bg-000000000000")
    );
    assert!(
        f.tasks.kill_for("child", &own).await.is_err(),
        "a subagent stops only its own"
    );
    assert!(
        f.tasks
            .kill_for("main", &child)
            .await
            .expect("its subagent's")
            .1
    );
    assert!(f.tasks.kill_for("main", &own).await.expect("its own").1);
    let listed: Vec<String> = f
        .tasks
        .list_for("main")
        .into_iter()
        .map(|t| t.task_id)
        .collect();
    assert_eq!(listed.len(), 2);
    assert!(!listed.contains(&other));
}

#[tokio::test]
async fn subagent_tasks_record_how_they_ended() {
    let f = Fixture::new("subagents");
    let subagent = |child: &str| NewSubagent {
        child_session_id: child.into(),
        session_id: "main".into(),
        owner_session_id: "main".into(),
        workspace: "/w".into(),
        agent_type: "Explore".into(),
        title: "Scout ahead".into(),
        cwd: "/w".into(),
        tool_call_id: "toolu_a".into(),
    };
    f.tasks.register_subagent(subagent("c1")).expect("c1");
    f.tasks.register_subagent(subagent("c2")).expect("c2");
    f.tasks
        .subagent_ended("c1", Some(SubagentStatus::Completed));
    f.tasks.subagent_ended("c2", None);
    let mut ended: Vec<(String, TaskStatus)> = f
        .tasks
        .list_for("main")
        .into_iter()
        .map(|t| (t.subagent_session_id.expect("child"), t.status))
        .collect();
    ended.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        ended,
        [
            ("c1".to_owned(), TaskStatus::Completed),
            ("c2".to_owned(), TaskStatus::Interrupted)
        ]
    );
    assert!(
        f.tasks.pending("main").is_empty(),
        "the Agent Host reports subagents itself"
    );
}

#[tokio::test]
async fn reads_a_task_output_in_parts() {
    let f = Fixture::new("read");
    let (id, _) = f.start(TaskKind::Command, "s", "s");
    let file = f.dir.join(format!("{id}.log"));
    std::fs::write(&file, "第一行\nsecond\n").expect("output");
    let first = f
        .tasks
        .read(Some("s"), &id, 0, Some(5))
        .await
        .expect("read");
    assert_eq!((first.text.as_str(), first.next_offset), ("第", 3));
    let rest = f
        .tasks
        .read(None, &id, first.next_offset, None)
        .await
        .expect("read");
    assert_eq!(rest.text, "一行\nsecond\n");
    assert_eq!(rest.status, TaskStatus::Running);
    assert!(f.tasks.read(Some("t"), &id, 0, None).await.is_err());
}

#[tokio::test]
async fn removing_a_workspace_stops_its_tasks() {
    let f = Fixture::new("workspace removed");
    let (main, cancel) = f.start(TaskKind::Command, "main", "main");
    f.end_on_cancel(&main, cancel);
    let (child, cancel) = f.start(TaskKind::Command, "child", "main");
    f.end_on_cancel(&child, cancel);
    assert_eq!(f.tasks.running_in("/w"), 2);
    assert_eq!(f.tasks.running_in("/other"), 0);

    f.tasks.workspace_removed("/other").await;
    assert_eq!(f.tasks.running_in("/w"), 2, "another workspace's removal");

    f.tasks.workspace_removed("/w").await;
    assert_eq!(f.tasks.running_in("/w"), 0);
    let snapshot = f.tasks.snapshot();
    for id in [&main, &child] {
        let task = snapshot
            .tasks
            .iter()
            .find(|t| &t.task_id == id)
            .expect("the task stays listed");
        assert_eq!(task.status, TaskStatus::Killed);
    }
}
