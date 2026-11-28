//! T45-A08 (THR-04): the diagnostic bundle Core exports holds the logs, versions, settings and
//! diagnostics with credentials and the home directory replaced, and never the vault, the
//! database or session content. Its own test binary: the log subscriber is process-wide.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;

use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use serde_json::{Value, json};

const KEY: &str = "thr04-websearch-key-0a1b2c3d";
const SESSION_TEXT: &str = "SESSION-CONTENT-MARKER-77";

struct Discard;

impl EventSink for Discard {
    fn deliver(&self, _batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        Ok(())
    }
}

/// Runs one of Core's callback methods and waits for its answer.
fn call(
    start: impl FnOnce(
        Box<dyn FnOnce(piarc_core::Result<Value>) + Send + 'static>,
    ) -> piarc_core::Result<()>,
) -> piarc_core::Result<Value> {
    let (tx, rx) = channel();
    start(Box::new(move |result| {
        let _ = tx.send(result);
    }))?;
    rx.recv_timeout(Duration::from_secs(30))
        .expect("Core answers")
}

/// The stored entries of a ZIP archive written by `piarc_telemetry::zip`: (name, contents).
fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while bytes.get(at..at + 4) == Some(&[0x50, 0x4b, 0x03, 0x04][..]) {
        let field = |offset: usize, len: usize| -> usize {
            bytes[at + offset..at + offset + len]
                .iter()
                .rev()
                .fold(0, |n, b| (n << 8) | usize::from(*b))
        };
        let (size, name_len, extra) = (field(18, 4), field(26, 2), field(28, 2));
        let name = String::from_utf8_lossy(&bytes[at + 30..at + 30 + name_len]).into_owned();
        let start = at + 30 + name_len + extra;
        out.push((name, bytes[start..start + size].to_vec()));
        at = start + size;
    }
    out
}

fn fixture(root: &Path) -> DataDirs {
    let dirs = DataDirs::new(root.join("data 数据"), root.join("cache")).expect("absolute");
    let session = dirs.data().join("pi").join("sessions").join("w");
    std::fs::create_dir_all(&session).expect("sessions");
    std::fs::write(
        session.join("s.jsonl"),
        format!("{{\"text\":\"{SESSION_TEXT}\"}}\n"),
    )
    .expect("session");
    std::fs::write(
        dirs.data().join("settings.json"),
        json!({"mcpServers": {"x": {"command": "node", "env": {"TOKEN": "settings-env-secret"}}},
               "permissions": {"allow": ["Bash(npm test)"]}})
        .to_string(),
    )
    .expect("settings");
    dirs
}

fn start(root: &Path, dirs: DataDirs) -> CoreRuntime {
    CoreRuntime::start(
        CoreConfig {
            home: Some(root.join("home")),
            dirs: Some(dirs),
            secret_store: Some(SecretStoreSetup {
                master_key: test_master_key_name("diagnostics"),
                store: Arc::new(MemorySecretStore::new()),
            }),
            ..CoreConfig::default()
        },
        Arc::new(Discard),
    )
    .expect("Core starts")
}

/// The archive holds exactly the previewed files and none of what must stay out.
fn check_archive(zip: &Path, names: &[&str], home: &Path) {
    let bytes = std::fs::read(zip).expect("bundle");
    let archive = entries(&bytes);
    let mut written: Vec<&str> = archive.iter().map(|(n, _)| n.as_str()).collect();
    written.retain(|n| *n != "manifest.json");
    assert_eq!(
        written, names,
        "the archive holds exactly the previewed files"
    );
    let home_text = home.to_string_lossy().into_owned();
    for (name, contents) in &archive {
        let text = String::from_utf8_lossy(contents);
        for needle in [KEY, "settings-env-secret", SESSION_TEXT, home_text.as_str()] {
            assert!(!text.contains(needle), "{name} holds something it must not");
        }
        assert!(!name.contains("vault") && !name.contains("sqlite") && !name.contains("sessions/"));
    }
    let core_log = archive
        .iter()
        .find(|(n, _)| n.starts_with("logs/core-"))
        .map(|(_, c)| String::from_utf8_lossy(c).into_owned())
        .expect("core log");
    assert!(core_log.contains("search backend refused [REDACTED:secret] (config in ~/x)"));
    println!(
        "THR-04: bundle of {} files, {} bytes, scanned clean",
        archive.len(),
        bytes.len()
    );
}

#[test]
fn thr04_the_exported_bundle_holds_no_credential_session_content_or_home_path() {
    let root: PathBuf = std::env::temp_dir().join(format!(
        "piarc-core diagnostics 中文 {}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("root");
    let dirs = fixture(&root);
    let core = start(&root, dirs);
    call(|done| core.set_web_search_key("brave".into(), Some(KEY.into()), done)).expect("key");
    let home = std::env::home_dir().expect("a home directory");
    tracing::warn!(target: "piarc_core", "search backend refused {KEY} (config in {}/x)", home.display());

    let manifest = call(|done| core.prepare_diagnostics(None, r#"{"app":"0.0.0-test"}"#, done))
        .expect("prepared");
    let names: Vec<&str> = manifest["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|f| f["name"].as_str())
        .collect();
    assert!(
        names.iter().any(|n| n.starts_with("logs/core-")),
        "{manifest}"
    );
    assert!(names.contains(&"versions.json") && names.contains(&"settings/settings.json"));
    // The log line was redacted when written; the settings' `env` value is replaced here.
    assert!(
        manifest["redactions"]["secret"].as_u64().unwrap_or(0) >= 1,
        "{manifest}"
    );
    assert!(
        manifest["redactions"]["home"].as_u64().unwrap_or(0) >= 1,
        "{manifest}"
    );
    assert!(
        manifest["excluded"]
            .as_array()
            .is_some_and(|e| e.contains(&json!("secrets.vault")))
    );

    let id = manifest["id"].as_str().expect("id").to_owned();
    let stale = call(|done| core.export_diagnostics("diag-0".into(), root.join("x.zip"), done));
    assert!(stale.is_err(), "only the prepared bundle is written");
    assert!(
        core.export_diagnostics(id.clone(), "relative.zip".into(), Box::new(|_| {}))
            .is_err()
    );
    let zip = root.join("导出 bundle.zip");
    let exported = call(|done| core.export_diagnostics(id, zip.clone(), done)).expect("exported");
    assert_eq!(exported["path"], json!(zip));

    check_archive(&zip, &names, &home);
    let (tx, rx) = channel();
    core.shutdown(move || {
        let _ = tx.send(());
    })
    .expect("shutdown");
    rx.recv_timeout(Duration::from_secs(30)).expect("stopped");
    let _ = std::fs::remove_dir_all(&root);
}
