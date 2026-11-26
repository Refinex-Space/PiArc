//! Port discovery (ADR-0092 rule 5, design addendum `docs/architecture/addenda/browser.md`
//! B2.6.2 and B4.4): the TCP ports the process trees of each session's running tasks
//! (background commands, Monitors, terminals, development servers) listen on, and the ports
//! its project's launch configurations declare.
//!
//! While a desktop client runs `Browser` scripts, a scan every [`SCAN_INTERVAL`] asks
//! `piarc_exec::listeners` about every running task's tree and sends a `ports` event on
//! `core/browser` for each open main session whose snapshot changed (every open session once at
//! first). The same snapshot serves the agent's request gate (these ports pass without a site
//! card) and the panel (its start page lists them; a new one shows a toast). Processes outside
//! the session's trees are never reported.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use piarc_protocol::browser::BrowserClientEvent;
use piarc_protocol::dev_server::ListeningPort;
use piarc_protocol::session::SessionId;
use tokio_util::sync::CancellationToken;

use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::tasks::TreeTask;
use crate::tool_io::ToolIo;

/// Between two scans: a new listener shows within two seconds (B4.4).
pub const SCAN_INTERVAL: Duration = Duration::from_millis(1500);

/// One session's ports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SessionPorts {
    pub workspace: String,
    pub ports: Vec<ListeningPort>,
    pub declared: Vec<u16>,
}

/// The launch files' modification stamps of a project and the ports they declare.
type Declared = (Vec<Option<(SystemTime, u64)>>, Vec<u16>);

/// What the scans remember between rounds.
#[derive(Default)]
pub(crate) struct PortWatch {
    sent: HashMap<String, SessionPorts>,
    declared: HashMap<PathBuf, Declared>,
}

/// The ports PiArc's own process group listens on: Core's proxies and servers run in this
/// process, Chromium's helpers in its group. The browser's proxies refuse them (ADR-0088 rule 5).
async fn own_ports() -> Option<Vec<u16>> {
    let tree = piarc_exec::listeners::Tree {
        root: std::process::id(),
        members: Vec::new(),
    };
    tokio::task::spawn_blocking(move || piarc_exec::listeners::listening(&[tree]))
        .await
        .ok()?
        .inspect_err(|error| {
            tracing::debug!(target: "piarc_core::ports", %error, "cannot list PiArc's own ports");
        })
        .ok()?
        .into_iter()
        .next()
}

/// Starts the scans; they end with `cancel`.
pub(crate) fn spawn(
    tool_io: ToolIo,
    browser: std::sync::Arc<crate::browser::BrowserProxies>,
    events: EventSender,
    cancel: CancellationToken,
) {
    tokio::spawn(async move {
        let mut watch = PortWatch::default();
        loop {
            if browser.active().await
                && let Some(ports) = own_ports().await
            {
                browser.set_own_ports(ports).await;
            }
            if tool_io.browser_attached() {
                for event in watch.scan(&tool_io).await {
                    if let Ok(event) = Event::from_json(RouteKey::browser(), &event)
                        && events.send(event).await.is_err()
                    {
                        return;
                    }
                }
            }
            tokio::select! {
                () = tokio::time::sleep(SCAN_INTERVAL) => {}
                () = cancel.cancelled() => return,
            }
        }
    });
}

impl PortWatch {
    /// One round: the `ports` events of the sessions whose snapshot changed.
    pub(crate) async fn scan(&mut self, tool_io: &ToolIo) -> Vec<BrowserClientEvent> {
        let current = self.current(tool_io).await;
        self.sent.retain(|session, _| current.contains_key(session));
        let mut events = Vec::new();
        for (session, ports) in current {
            if self.sent.get(&session) == Some(&ports) {
                continue;
            }
            events.push(BrowserClientEvent::Ports {
                session_id: SessionId(session.clone()),
                workspace: ports.workspace.clone(),
                ports: ports.ports.clone(),
                declared: ports.declared.clone(),
            });
            self.sent.insert(session, ports);
        }
        events
    }

    /// Every open main session's snapshot now, and that of sessions with running trees.
    async fn current(&mut self, tool_io: &ToolIo) -> BTreeMap<String, SessionPorts> {
        let tasks = tool_io.tasks().running_trees();
        let trees: Vec<_> = tasks.iter().map(|(_, tree)| tree.clone()).collect();
        let found = tokio::task::spawn_blocking(move || piarc_exec::listeners::listening(&trees))
            .await
            .ok()
            .and_then(|found| {
                found
                    .inspect_err(|error| {
                        tracing::debug!(target: "piarc_core::ports", %error, "cannot list listening ports");
                    })
                    .ok()
            });
        let listening: Vec<(TreeTask, Vec<u16>)> = match found {
            Some(found) => tasks.into_iter().map(|(task, _)| task).zip(found).collect(),
            None => Vec::new(),
        };
        let mut current = group(listening);
        for (session, project, _) in tool_io.open_main_sessions() {
            let declared = self.declared_ports(&project).await;
            let entry = current.entry(session).or_default();
            if entry.workspace.is_empty() {
                entry.workspace = piarc_fs::display(&project);
            }
            entry.declared = declared;
        }
        current
    }

    /// The ports `project`'s launch configurations declare, read again when a file changed.
    async fn declared_ports(&mut self, project: &Path) -> Vec<u16> {
        let stamps = launch_stamps(project);
        if let Some((known, ports)) = self.declared.get(project)
            && *known == stamps
        {
            return ports.clone();
        }
        let dir = project.to_owned();
        let ports = tokio::task::spawn_blocking(move || piarc_config::launch::load(&dir).ports())
            .await
            .unwrap_or_default();
        self.declared
            .insert(project.to_owned(), (stamps, ports.clone()));
        ports
    }
}

fn launch_stamps(project: &Path) -> Vec<Option<(SystemTime, u64)>> {
    [
        piarc_config::launch::PIARC_LAUNCH,
        piarc_config::launch::CLAUDE_LAUNCH,
    ]
    .iter()
    .map(|file| {
        std::fs::metadata(project.join(file))
            .ok()
            .and_then(|meta| meta.modified().ok().map(|at| (at, meta.len())))
    })
    .collect()
}

/// The listening ports by main session, each port once (the first task that listens on it),
/// sorted by port.
pub(crate) fn group(listening: Vec<(TreeTask, Vec<u16>)>) -> BTreeMap<String, SessionPorts> {
    let mut by_session: BTreeMap<String, SessionPorts> = BTreeMap::new();
    for (task, ports) in listening {
        let entry = by_session.entry(task.owner_session_id.clone()).or_default();
        if entry.workspace.is_empty() {
            entry.workspace.clone_from(&task.workspace);
        }
        for port in ports {
            if entry.ports.iter().all(|p| p.port != port) {
                entry.ports.push(ListeningPort {
                    port,
                    task_id: task.task_id.clone(),
                    kind: task.kind,
                    title: task.title.clone(),
                });
            }
        }
    }
    for entry in by_session.values_mut() {
        entry
            .ports
            .sort_by(|a, b| a.port.cmp(&b.port).then(a.task_id.cmp(&b.task_id)));
    }
    by_session
}

#[cfg(test)]
mod tests {
    use piarc_protocol::tasks::TaskKind;

    use super::*;

    fn task(id: &str, owner: &str, kind: TaskKind) -> TreeTask {
        TreeTask {
            task_id: id.into(),
            owner_session_id: owner.into(),
            workspace: format!("/work/{owner}"),
            kind,
            title: format!("title {id}"),
        }
    }

    #[test]
    fn ports_group_by_main_session_once_each() {
        let grouped = group(vec![
            (task("bg-1", "s1", TaskKind::Command), vec![8080, 3000]),
            (task("bg-2", "s1", TaskKind::Terminal), vec![3000, 5173]),
            (task("bg-3", "s2", TaskKind::DevServer), vec![4000]),
            (task("bg-4", "s3", TaskKind::Monitor), vec![]),
        ]);
        let s1 = &grouped["s1"];
        assert_eq!(s1.workspace, "/work/s1");
        let ports: Vec<(u16, &str)> = s1
            .ports
            .iter()
            .map(|p| (p.port, p.task_id.as_str()))
            .collect();
        assert_eq!(ports, [(3000, "bg-1"), (5173, "bg-2"), (8080, "bg-1")]);
        assert_eq!(grouped["s2"].ports[0].kind, TaskKind::DevServer);
        assert!(grouped["s3"].ports.is_empty());
    }
}
