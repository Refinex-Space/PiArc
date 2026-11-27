//! ADR-0092, design addendum B4: launch configurations run as `devServer` tasks of a trusted
//! project; readiness needs the task's own tree on the port; stopping ends the tree; a failure
//! carries the output's end; `autoPort` moves a busy port; the agent's start asks once per
//! fingerprint; `autoVerify` leaves one reminder per turn; the port scan reports the session's
//! listening trees and declared ports. Real `node` processes (on `PATH`, as `npm ci` needs).
use super::*;
use crate::tool_io::DevServerLimits;
use piarc_protocol::browser::BrowserClientEvent;
use piarc_protocol::context::ReminderType;
use piarc_protocol::dev_server::{
    DevServerAgent, DevServerFailure, DevServerStart, DevServerStarter, DevServerStatus,
};
use piarc_protocol::session::SessionId;
use piarc_protocol::tasks::{TaskKind, TaskStatus};
use tokio_util::sync::CancellationToken;

const CALL: &str = "browser-dev-1";
const SERVER: &str = "const http = require('http');\nconst port = Number(process.env.PORT);\nconsole.log('starting on ' + port);\nhttp.createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1', () => console.log('listening ' + port));\n";

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.local_addr().expect("address").port()
}

fn answers(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Writes `launch` as `.piarc/launch.json` and the scripts, then trusts the project again (new
/// configurations are unconfirmed executable items until then, ADR-0029).
async fn launch_file(f: &Fixture, launch: &Value, trust: bool) {
    std::fs::write(f.work.join("server.js"), SERVER).expect("server script");
    std::fs::write(
        f.work.join("fail.js"),
        "console.log('line 1');\nconsole.error('boom');\nprocess.exit(3);\n",
    )
    .expect("fail script");
    std::fs::write(f.work.join("idle.js"), "setTimeout(() => {}, 60000);\n").expect("idle");
    std::fs::write(f.work.join(".piarc/launch.json"), launch.to_string()).expect("launch");
    if trust {
        let service = TrustService::new(f.storage.clone());
        let version = service.view(&f.work).await.expect("view").version;
        service
            .decide(&f.work, true, &version)
            .await
            .expect("trust");
    }
}

fn web(port: u16) -> Value {
    json!({"configurations": [
        {"name": "web", "runtimeExecutable": "node", "runtimeArgs": ["server.js"],
         "env": {"PORT": port.to_string()}, "port": port},
        {"name": "broken", "program": "fail.js", "port": free_port()},
        {"name": "idle", "program": "idle.js", "port": free_port()},
    ]})
}

fn start(name: &str, wait: bool) -> DevServerStart {
    DevServerStart {
        session_id: SessionId(SESSION.into()),
        name: name.into(),
        agent: None,
        wait,
    }
}

#[tokio::test]
async fn an_untrusted_project_lists_but_does_not_start() {
    let f = Fixture::new().await;
    launch_file(&f, &web(free_port()), false).await;
    let view = f.io.launch_view(SESSION).await.expect("view");
    assert!(
        !view.trusted,
        "the new configurations are not confirmed yet"
    );
    assert_eq!(view.configs.len(), 3);
    let error =
        f.io.start_dev_server(start("web", false))
            .await
            .expect_err("refused");
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
    assert!(f.io.tasks().list_for(SESSION).is_empty());
}

#[tokio::test]
async fn a_server_is_ready_once_its_tree_listens_and_stopping_ends_the_tree() {
    let f = Fixture::new().await;
    let port = free_port();
    launch_file(&f, &web(port), true).await;
    let view = f.io.launch_view(SESSION).await.expect("view");
    assert!(view.trusted);
    let config = view.configs.iter().find(|c| c.name == "web").expect("web");
    assert_eq!(config.port, port);
    assert_eq!(config.url, format!("http://localhost:{port}/"));
    let state =
        f.io.start_dev_server(start("web", true))
            .await
            .expect("start");
    assert_eq!(state.status, DevServerStatus::Ready, "{state:?}");
    assert_eq!(state.started_by, DevServerStarter::User);
    assert!(answers(port));
    let task_id = state.task_id.clone().expect("task");
    let task = f.io.tasks().task_view(&task_id).expect("task");
    assert_eq!(task.kind, TaskKind::DevServer);
    assert_eq!(task.title, "web");
    // A second start answers the running one.
    let again =
        f.io.start_dev_server(start("web", false))
            .await
            .expect("again");
    assert_eq!(again.task_id, state.task_id);
    // The port scan reports it under the session, with the declared ports.
    let events = crate::ports::PortWatch::default().scan(&f.io).await;
    let Some(BrowserClientEvent::Ports {
        ports, declared, ..
    }) = events.iter().find(
        |e| matches!(e, BrowserClientEvent::Ports { session_id, .. } if session_id.0 == SESSION),
    )
    else {
        panic!("no ports event: {events:?}");
    };
    assert!(
        ports.iter().any(|p| p.port == port && p.task_id == task_id),
        "{ports:?}"
    );
    assert!(declared.contains(&port));
    let stopped = f.io.stop_dev_server(SESSION, "web").await.expect("stop");
    assert_eq!(stopped.status, DevServerStatus::Stopped);
    assert!(!answers(port), "the tree ended with the task");
    assert_eq!(
        f.io.tasks().task_view(&task_id).expect("task").status,
        TaskStatus::Killed
    );
}

#[tokio::test]
async fn a_server_that_exits_fails_with_its_last_lines() {
    let f = Fixture::new().await;
    launch_file(&f, &web(free_port()), true).await;
    let state =
        f.io.start_dev_server(start("broken", true))
            .await
            .expect("start");
    assert_eq!(state.status, DevServerStatus::Failed);
    assert_eq!(state.failure, Some(DevServerFailure::Exited));
    assert_eq!(state.exit_code, Some(3));
    assert!(
        state.log.iter().any(|l| l.contains("line 1")),
        "{:?}",
        state.log
    );
    assert!(
        state.log.iter().any(|l| l.contains("boom")),
        "{:?}",
        state.log
    );
}

#[tokio::test]
async fn a_server_that_never_listens_times_out_and_is_stopped() {
    let f = Fixture::new().await;
    launch_file(&f, &web(free_port()), true).await;
    f.io.set_dev_server_limits(DevServerLimits {
        ready_timeout: Duration::from_secs(1),
        ..DevServerLimits::default()
    });
    let state =
        f.io.start_dev_server(start("idle", true))
            .await
            .expect("start");
    assert_eq!(state.status, DevServerStatus::Failed);
    assert_eq!(state.failure, Some(DevServerFailure::Timeout));
    let task =
        f.io.tasks()
            .task_view(&state.task_id.expect("task"))
            .expect("task");
    assert_ne!(task.status, TaskStatus::Running);
}

#[tokio::test]
async fn auto_port_takes_the_next_free_port() {
    let f = Fixture::new().await;
    // Below the ephemeral range: the other tests' servers take ephemeral ports, which could
    // be the one above an ephemeral port held here.
    let start_at = 20_000 + u16::try_from(std::process::id() % 5_000).expect("small") * 2;
    let (busy, port) = (start_at..start_at + 2_000)
        .find_map(|port| {
            let next = std::net::TcpListener::bind(("127.0.0.1", port + 1)).ok()?;
            drop(next);
            std::net::TcpListener::bind(("127.0.0.1", port))
                .ok()
                .map(|held| (held, port))
        })
        .expect("a quiet port pair");
    launch_file(
        &f,
        &json!({"configurations": [{"name": "web", "runtimeExecutable": "node",
            "runtimeArgs": ["server.js"], "port": port, "autoPort": true}]}),
        true,
    )
    .await;
    let state =
        f.io.start_dev_server(start("web", true))
            .await
            .expect("start");
    assert!(
        state.port > port && state.port <= port + 20,
        "{port} -> {}",
        state.port
    );
    assert_eq!(state.status, DevServerStatus::Ready, "{state:?}");
    assert_eq!(state.url, format!("http://localhost:{}/", state.port));
    f.io.stop_dev_server(SESSION, "web").await.expect("stop");
    drop(busy);
}

fn agent_start(name: &str) -> DevServerStart {
    DevServerStart {
        agent: Some(DevServerAgent {
            session_id: SessionId(SESSION.into()),
            tool_call_id: CALL.into(),
        }),
        ..start(name, false)
    }
}

fn running_call(f: &Fixture) -> CancellationToken {
    let token = CancellationToken::new();
    let session = f.io.session(SESSION).expect("registered");
    lock(&session.running).insert(format!("browser:{CALL}"), token.clone());
    token
}

#[tokio::test]
async fn the_agent_asks_once_per_fingerprint_in_a_session() {
    let f = Fixture::new().await;
    let port = free_port();
    launch_file(&f, &web(port), true).await;
    // Without a running Browser call there is nobody to ask: refused.
    let error =
        f.io.start_dev_server(agent_start("web"))
            .await
            .expect_err("no call");
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
    let _run = running_call(&f);
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move { io.start_dev_server(agent_start("web")).await })
    };
    let card = f.pending().await;
    assert_eq!(card.tool, "BrowserServer");
    assert_eq!(card.kind, ApprovalKind::Command);
    assert_eq!(card.command.as_deref(), Some("node server.js"));
    assert_eq!(
        card.sandbox,
        Some(piarc_protocol::policy::CommandPlace::Unsandboxed)
    );
    assert_eq!(
        card.protected_path,
        Some(true),
        "outside the sandbox: once or deny"
    );
    f.io.answer_approval(answer(&card, ApprovalDecision::AllowOnce))
        .await
        .expect("answer");
    let state = asking.await.expect("task").expect("started");
    assert_eq!(state.started_by, DevServerStarter::Agent);
    f.io.stop_dev_server(SESSION, "web").await.expect("stop");
    // The same fingerprint starts again without a card.
    let again =
        f.io.start_dev_server(agent_start("web"))
            .await
            .expect("no card");
    assert_eq!(again.started_by, DevServerStarter::Agent);
    f.io.stop_dev_server(SESSION, "web").await.expect("stop");
    // A changed configuration is a new fingerprint: asked again, and refused.
    let mut changed = web(port);
    changed["configurations"][0]["env"]["DEBUG"] = json!("1");
    launch_file(&f, &changed, true).await;
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move { io.start_dev_server(agent_start("web")).await })
    };
    let card = f.pending().await;
    f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
        .await
        .expect("answer");
    let refused = asking.await.expect("task").expect_err("refused");
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);
    let audits = f
        .storage
        .with(|store| store.session_audit_events(SESSION, 100))
        .expect("storage")
        .expect("audit");
    let decisions = audits
        .iter()
        .filter(|row| row.kind == "browser" && row.detail.contains("devServer"))
        .count();
    assert_eq!(decisions, 2, "one row per asked start");
}

#[tokio::test]
async fn auto_verify_reminds_once_per_turn() {
    let f = Fixture::new().await;
    let port = free_port();
    launch_file(&f, &web(port), true).await;
    let state =
        f.io.start_dev_server(start("web", true))
            .await
            .expect("start");
    assert_eq!(state.status, DevServerStatus::Ready);
    let session = f.io.session(SESSION).expect("session");
    let verify = |io: &ToolIo| {
        io.tasks()
            .pending(SESSION)
            .into_iter()
            .filter(|n| n.kind == ReminderType::BrowserVerify)
            .collect::<Vec<_>>()
    };
    f.io.tasks().turn_started(SESSION);
    f.io.dev_file_written(SESSION, &session, "notes.rs");
    assert!(verify(&f.io).is_empty(), "not a front-end file");
    f.io.dev_file_written(SESSION, &session, "src/App.tsx");
    let first = verify(&f.io);
    assert_eq!(first.len(), 1);
    assert!(
        first[0]
            .text
            .starts_with(&format!("http://localhost:{port}/\n"))
    );
    assert!(first[0].text.contains("App.tsx"));
    f.io.dev_file_written(SESSION, &session, "src/index.css");
    assert_eq!(verify(&f.io), first, "at most one per turn");
    f.io.tasks().turn_completed(SESSION);
    f.io.tasks().turn_started(SESSION);
    f.io.dev_file_written(SESSION, &session, "src/index.css");
    let second = verify(&f.io);
    assert_eq!(second.len(), 1, "the key replaces the waiting one");
    assert_ne!(
        second[0].source, first[0].source,
        "a new reminder for the new turn"
    );
    f.io.stop_dev_server(SESSION, "web").await.expect("stop");
    f.io.tasks().turn_started(SESSION);
    f.io.tasks()
        .delivered(SESSION, ReminderType::BrowserVerify, &second[0].source);
    f.io.dev_file_written(SESSION, &session, "src/App.tsx");
    assert!(verify(&f.io).is_empty(), "no running server, no reminder");
}

#[tokio::test]
async fn the_port_scan_finds_a_background_commands_listener() {
    let f = Fixture::new().await;
    let port = free_port();
    std::fs::write(f.work.join("server.js"), SERVER).expect("server script");
    let session = f.io.session(SESSION).expect("session");
    let place = f.io.place(SESSION, &session);
    let launch_at = super::super::exec::launch_dir(&session, None).expect("dir");
    let run = piarc_protocol::exec::ExecRunParams {
        session_id: SessionId(SESSION.into()),
        request_id: "bg".into(),
        command: "node server.js".into(),
        cwd: None,
        env: Some([("PORT".to_owned(), port.to_string())].into()),
        origin: None,
        shell: Some(piarc_protocol::exec::ExecShell::Bash),
        timeout_ms: None,
        background: true,
        terminal: false,
    };
    let spec =
        f.io.exec
            .background_spec(
                &session,
                &run,
                &launch_at,
                super::super::exec::Wrap::default(),
            )
            .await
            .expect("spec");
    let reserved = super::super::exec::background::start_task(
        f.io.exec.runner(),
        &place.tasks,
        spec,
        crate::tasks::NewTask {
            session_id: SESSION.into(),
            owner_session_id: SESSION.into(),
            workspace: place.workspace.clone(),
            kind: TaskKind::Command,
            title: "node server.js".into(),
            command: "node server.js".into(),
            cwd: piarc_fs::display(&launch_at.dir),
            tool_call_id: None,
            output_dir: place.output_dir.clone(),
            timeout: None,
        },
        super::super::exec::background::Judge {
            shell: piarc_protocol::exec::ExecShell::Bash,
            command: "node server.js".into(),
        },
        CancellationToken::new(),
    )
    .expect("task");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !answers(port) {
        assert!(Instant::now() < deadline, "the server did not start");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut watch = crate::ports::PortWatch::default();
    let events = watch.scan(&f.io).await;
    let found = events.iter().any(|e| {
        matches!(e, BrowserClientEvent::Ports { ports, .. }
            if ports.iter().any(|p| p.port == port && p.task_id == reserved.task_id && p.kind == TaskKind::Command))
    });
    assert!(found, "{events:?}");
    assert!(
        watch.scan(&f.io).await.is_empty(),
        "nothing changed, nothing sent"
    );
    f.io.tasks()
        .stop(&reserved.task_id, crate::tasks::StopBy::User)
        .await
        .expect("stop");
    assert!(!answers(port));
    let after = watch.scan(&f.io).await;
    assert!(
        matches!(after.as_slice(), [BrowserClientEvent::Ports { ports, .. }] if ports.is_empty()),
        "{after:?}"
    );
}
