//! The Agent Host's stderr reaches `tracing` line by line, tagged with workspace, session and
//! connection epoch (architecture section 7.5).

mod support;

use std::io::Write;
use std::sync::{Arc, Mutex};

use piarc_host::{HostEvent, HostSupervisor};
use support::{FakeSpawner, TestClock, config, deps, script, until};

/// Collects formatted log output.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "current_thread")]
async fn tags_each_stderr_line_with_workspace_session_and_epoch() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.log("connected: AHP 1.0").await;
        host.log("[session s-42] opened in /work (trusted: false)")
            .await;
        host.hello("1.0", &[]).await;
        host.until_stdin_closes().await;
        0
    })]);
    let (supervisor, mut events) = HostSupervisor::start(config(), deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    supervisor.shutdown().await;

    let output = String::from_utf8(captured.0.lock().expect("lock").clone()).expect("UTF-8");
    let lines: Vec<&str> = output
        .lines()
        .filter(|l| l.contains("piarc_host::agent_host"))
        .collect();
    println!("{}", lines.join("\n"));
    assert_eq!(lines.len(), 2, "{output}");
    assert!(
        lines[0].contains("workspace=work space/项目")
            && lines[0].contains("session= ")
            && lines[0].contains("epoch=1")
    );
    assert!(lines[0].contains("connected: AHP 1.0"));
    assert!(
        lines[1].contains("session=s-42") && lines[1].contains("opened in /work (trusted: false)"),
        "{}",
        lines[1]
    );
}
