//! Commands as background tasks (T32, ADR-0049 rule 2): the consumer of a command's output in
//! either form, a command started as a task (`background: true`, Monitor), and the waiter that
//! tells the task manager how it ended.
//!
//! A command's output chunks always go to one consumer task. In the foreground it feeds the
//! capture (the model's view) and the live display; when the command's timeout moves it to the
//! background, the consumer receives a [`Switch`]: it closes the display, hands the capture's
//! content to the task's [`TaskLog`] (the spilled file is moved into place, or the text written)
//! and from then on appends to the log. The process is never restarted: the runner's future,
//! its pipes and its cancellation token stay the same.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use piarc_exec::{
    CommandExit, CommandRunner, CommandSpec, Interpretation, OutputCapture, OutputChunk, Stream,
    TaskLog, interpret,
};
use piarc_protocol::ErrorObject;
use piarc_protocol::exec::ExecShell;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{Display, OUTPUT_BUFFER};
use crate::tasks::{Ended, NewTask, Reserved, TaskManager};
use crate::tool_io::lock;

/// How a command's exit code is read.
#[derive(Debug, Clone)]
pub(in crate::tool_io) struct Judge {
    pub shell: ExecShell,
    pub command: String,
}

impl Judge {
    fn read(&self, code: Option<i32>, success: bool) -> Interpretation {
        match self.shell {
            ExecShell::Bash => interpret(&self.command, code),
            ExecShell::Powershell => Interpretation {
                success,
                meaning: None,
            },
        }
    }
}

/// Where a command's output goes.
pub(super) enum Sink {
    /// The model's view and the live display.
    Foreground {
        capture: Box<OutputCapture>,
        display: Arc<Display>,
    },
    /// The task's output file.
    Background(Feed),
}

/// A task's output file and whom to tell about new output.
pub(super) struct Feed {
    log: Arc<Mutex<TaskLog>>,
    tasks: TaskManager,
    task_id: String,
    monitor: bool,
}

impl Feed {
    fn push(&self, stream: Stream, bytes: &[u8]) {
        let lines = lock(&self.log).write(stream, bytes);
        self.tell(lines);
    }

    fn tell(&self, lines: Vec<String>) {
        if self.monitor {
            self.tasks.monitor_lines(&self.task_id, lines);
        }
        self.tasks.output_grew();
    }
}

/// Moves a foreground command to the background.
pub(super) struct Switch {
    pub reserved: Reserved,
    /// The real path of the capture's spill file, once it was opened.
    pub spilled: Arc<Mutex<Option<PathBuf>>>,
    pub tasks: TaskManager,
    pub reply: oneshot::Sender<io::Result<Arc<Mutex<TaskLog>>>>,
}

/// Feeds `sink` until the command's output ends; returns the capture when the command stayed
/// in the foreground.
pub(super) async fn consume(
    mut rx: mpsc::Receiver<OutputChunk>,
    mut switch: Option<oneshot::Receiver<Switch>>,
    mut sink: Sink,
) -> Option<OutputCapture> {
    loop {
        let chunk = if let Some(pending) = switch.as_mut() {
            tokio::select! {
                biased;
                order = pending => {
                    switch = None;
                    if let Ok(order) = order {
                        sink = go_background(sink, order);
                    }
                    continue;
                }
                chunk = rx.recv() => chunk,
            }
        } else {
            rx.recv().await
        };
        let Some(chunk) = chunk else {
            break;
        };
        match &mut sink {
            Sink::Foreground { capture, display } => {
                capture.push(chunk.stream, &chunk.bytes);
                display.push(chunk.stream, chunk.bytes);
            }
            Sink::Background(feed) => feed.push(chunk.stream, &chunk.bytes),
        }
    }
    match sink {
        Sink::Foreground { capture, display } => {
            display.close();
            Some(*capture)
        }
        Sink::Background(feed) => {
            let lines = lock(&feed.log).finish();
            feed.tell(lines);
            None
        }
    }
}

/// Closes the display and starts the task's log with what the capture holds.
fn go_background(sink: Sink, order: Switch) -> Sink {
    let Sink::Foreground { capture, display } = sink else {
        let _ = order
            .reply
            .send(Err(io::Error::other("already in the background")));
        return sink;
    };
    display.close();
    let handover = (*capture).hand_over();
    let file = &order.reserved.file;
    let opened = (|| -> io::Result<TaskLog> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let spilled = lock(&order.spilled).take();
        let mut log = match (handover.spilled.as_ref(), spilled) {
            (Some(_), Some(spill)) => {
                std::fs::rename(&spill, file)?;
                TaskLog::resume(file, &handover.tail).map_err(crate::error::exec_io_error)?
            }
            _ => {
                let mut log = TaskLog::create(file).map_err(crate::error::exec_io_error)?;
                log.write_text(handover.text.as_deref().unwrap_or_default());
                log
            }
        };
        log.write(Stream::Stdout, &handover.pending[0]);
        log.write(Stream::Stderr, &handover.pending[1]);
        Ok(log)
    })();
    match opened {
        Ok(log) => {
            let log = Arc::new(Mutex::new(log));
            let _ = order.reply.send(Ok(Arc::clone(&log)));
            Sink::Background(Feed {
                log,
                tasks: order.tasks,
                task_id: order.reserved.task_id,
                monitor: false,
            })
        }
        Err(error) => {
            let _ = order.reply.send(Err(error));
            // The output goes nowhere: the caller stops the command.
            let (capture, display) = (
                Box::new(OutputCapture::new(
                    piarc_exec::ExecLimits::default(),
                    Box::new(|| Err(io::Error::other("no output file"))),
                )),
                Arc::new(Display::default()),
            );
            display.close();
            Sink::Foreground { capture, display }
        }
    }
}

/// Starts `spec` as a task from the start: its output goes to a new file, the task is
/// registered before the first byte, and a waiter records how it ends.
pub(in crate::tool_io) fn start_task(
    runner: &CommandRunner,
    tasks: &TaskManager,
    spec: CommandSpec,
    new: NewTask,
    judge: Judge,
    token: CancellationToken,
) -> Result<Reserved, ErrorObject> {
    let tasks_dir = new.output_dir.clone();
    let monitor = new.kind == piarc_protocol::tasks::TaskKind::Monitor;
    let tasks = tasks.clone();
    let reserved = tasks.reserve(&tasks_dir)?;
    let log = TaskLog::create(&reserved.file).map_err(crate::error::exec_error_object)?;
    let log = Arc::new(Mutex::new(log));
    tasks.register(&reserved, new.clone(), Arc::clone(&log), token.clone());
    let (tx, rx) = mpsc::channel::<OutputChunk>(OUTPUT_BUFFER);
    let feed = Feed {
        log,
        tasks: tasks.clone(),
        task_id: reserved.task_id.clone(),
        monitor,
    };
    let consumer = tokio::spawn(consume(rx, None, Sink::Background(feed)));
    let runner = runner.clone();
    let started = Arc::new(std::sync::OnceLock::new());
    tasks.set_tree(
        &reserved.task_id,
        crate::tasks::command_tree(Arc::clone(&started)),
    );
    let run =
        tokio::spawn(async move { runner.run_reporting(spec, tx, token, Some(started)).await });
    watch_to_end(tasks, reserved.task_id.clone(), run, consumer, judge);
    Ok(reserved)
}

/// Records the task's end once the command exited and its output was written.
pub(super) fn watch_to_end(
    tasks: TaskManager,
    task_id: String,
    run: JoinHandle<io::Result<CommandExit>>,
    consumer: JoinHandle<Option<OutputCapture>>,
    judge: Judge,
) {
    tokio::spawn(async move {
        let exit = run
            .await
            .unwrap_or_else(|e| Err(io::Error::other(format!("the command task failed: {e}"))));
        let _ = consumer.await;
        let ended = match exit {
            Ok(exit) => {
                let reading = judge.read(exit.status.code, exit.status.success());
                Ended {
                    exit_code: exit.status.code,
                    signal: exit.status.signal,
                    success: reading.success && !exit.killed,
                    meaning: reading.meaning.map(str::to_owned),
                    error: None,
                }
            }
            Err(error) => Ended {
                error: Some(error.to_string()),
                ..Ended::default()
            },
        };
        tasks.ended(&task_id, ended);
    });
}
