use std::sync::Arc;

use piarc_ports::PolicyProduct;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};
use crate::managed::store::{FixedPolicy, Layout, macos_files_dir, windows_files_dir};
use crate::managed::{ManagedConfig, ManagedSettings};
use crate::storage::Storage;

/// Hands every settings event's payload to the test.
struct Settings(mpsc::UnboundedSender<Value>);

impl EventSink for Settings {
    fn deliver(&self, batches: Vec<EventBatch>, _: DeliveryDone) -> Result<(), SinkClosed> {
        for batch in batches {
            if batch.route.as_str() != SETTINGS_ROUTE {
                continue;
            }
            let events: Vec<Value> = serde_json::from_slice(&batch.payload).unwrap_or_default();
            for event in events {
                let _ = self.0.send(event);
            }
        }
        Ok(())
    }
}

/// T47-A11: a managed settings change is reported (and `ConfigChange` hears it) while the
/// watcher's first registration is still running. FSEvents can take tens of seconds to start a
/// stream under load, and the workspace does not wait for it on macOS; managed settings must
/// not wait behind it (the L2 scenario `managed-change` waited 16–30 s under the full suite).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::await_holding_lock,
    reason = "the test holds the watcher's lock on purpose: the registration must wait for it"
)]
async fn a_managed_change_is_reported_while_the_first_registration_runs() {
    let root = std::env::temp_dir().join(format!(
        "piarc-settings-managed-{}",
        crate::sessions::new_session_id().expect("unique id")
    ));
    let workspace = root.join("work space 工作区");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace = piarc_git::canonical(&workspace).expect("canonical workspace");
    let system = root.join("admin 管理");
    let (layout, files) = if cfg!(windows) {
        let program_files = system.join("Program Files");
        let files = windows_files_dir(&program_files, PolicyProduct::Piarc);
        (Layout::Windows(program_files), files)
    } else {
        let files = macos_files_dir(&system, PolicyProduct::Piarc);
        (Layout::MacOs(system.clone()), files)
    };
    std::fs::create_dir_all(&files).expect("managed files");
    std::fs::write(files.join("managed-settings.json"), "{}").expect("managed file");
    let managed = ManagedSettings::load(&ManagedConfig {
        store: Some(Arc::new(FixedPolicy {
            layout: Some(layout),
            preferences: None,
            user: None,
            registry: None,
        })),
        poll: Duration::from_secs(3600),
    })
    .expect("managed settings");
    let dirs = DataDirs::new(root.join("data"), root.join("cache"))
        .expect("directories")
        .with_managed(managed.clone());
    dirs.create_layout().expect("layout");
    let storage = Storage::open(dirs.clone()).expect("database");
    let trust = TrustService::new(storage);
    let (seen, mut events) = mpsc::unbounded_channel();
    let (sender, coalescer, _) = crate::events::channel(
        Duration::from_millis(1),
        Arc::new(Settings(seen)),
        CancellationToken::new(),
    );
    tokio::spawn(coalescer.run());

    // The loop as `WorkspaceSettings::open` starts it, with its watcher held by the test: the
    // first registration cannot finish until the test lets it.
    let watcher = Arc::new(Mutex::new(Watcher::new(|_| {}).expect("watcher")));
    let held = watcher.lock().expect("watcher lock");
    let settings = super::Settings::load(dirs.layers(&workspace), TrustState::Untrusted);
    let (_notify, notifications) = mpsc::unbounded_channel();
    let (changed, _changes) = watch::channel(0);
    let (layer_changes, mut heard) = broadcast::channel(8);
    let (registered, mut ready) = oneshot::channel();
    let task = tokio::spawn(run(
        Loop {
            inner: Arc::new(Mutex::new(settings)),
            watcher: Arc::clone(&watcher),
            workspace: workspace.clone(),
            resources: (dirs.data().to_path_buf(), None),
            trust: trust.clone(),
            events: sender,
            notifications,
            changed,
            layer_changes,
            managed: managed.clone(),
        },
        trust.subscribe(),
        managed.changes(),
        registered,
    ));

    std::fs::write(
        files.join("managed-settings.json"),
        r#"{"permissions":{"deny":["Bash(curl *)"]}}"#,
    )
    .expect("managed change");
    assert!(managed.refresh(), "the managed settings changed");
    let reported = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = events.recv().await {
            if event["changed"]
                .as_array()
                .is_some_and(|c| c.contains(&Value::from("/permissions/deny")))
            {
                return event;
            }
        }
        Value::Null
    })
    .await
    .expect("the change is reported while the registration waits");
    assert_eq!(reported["workspace"], workspace.to_string_lossy().as_ref());
    let layer = heard
        .try_recv()
        .expect("ConfigChange hears the managed layer");
    assert_eq!(layer.layer, piarc_config::ids::ENTERPRISE);
    assert!(
        matches!(ready.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "the registration was still waiting"
    );

    drop(held);
    tokio::time::timeout(Duration::from_secs(30), &mut ready)
        .await
        .expect("the registration finishes")
        .expect("registered");
    task.abort();
    let _ = std::fs::remove_dir_all(&root);
}
