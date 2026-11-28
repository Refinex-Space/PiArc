//! In-app updates (ADR-0111) against the mock of GitHub's release downloads: a newer release is
//! found, downloaded and verified for macOS and Windows; an equal release is up to date;
//! a tampered artefact, a manifest signed with another key and notes of another version are
//! refused; the proxy carries every request through `CONNECT`; an unreachable feed is a
//! network problem and an unreachable proxy never falls back to a direct connection. The
//! manifests are signed by `scripts/release/release-manifest.mjs` with the test key (node on
//! `PATH`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_core::updates::feed::Os;
use piarc_core::updates::{UpdateConfig, UpdateTestNet, Updates};
use piarc_protocol::updates::{UpdateInstall, UpdateState, UpdateStatus};
use piarc_testkit::connect_proxy::MockProxy;
use piarc_testkit::npm_registry::{REGISTRY_HOST, TEST_CA_PEM};
use piarc_testkit::release_feed::{ASSET_HOST, FEED_HOST, MockReleases};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn key_file(name: &str) -> PathBuf {
    repo()
        .join("scripts")
        .join("release")
        .join("test-keys")
        .join(name)
}

fn public_key(name: &str) -> String {
    let text = std::fs::read_to_string(key_file(name)).expect("public key");
    text.lines().nth(1).expect("key line").trim().to_owned()
}

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "piarc updates 更新 {label} {} {n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        Self(dir)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn notes(version: &str, security: bool) -> Vec<u8> {
    json!({
        "format": "piarc-release-notes/1",
        "version": version,
        "date": "2026-12-01",
        "security": security,
        "notes": { "en": "### Fixed\n- A thing", "zh-CN": "### 修复\n- 一处问题" },
    })
    .to_string()
    .into_bytes()
}

fn artefact(seed: u8, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn velopack_feed(version: &str, arch: &str) -> (String, Vec<u8>) {
    let package = format!("cn.piarc.desktop-{version}-win-{arch}-full.nupkg");
    let feed = json!({ "Assets": [
        { "PackageId": "cn.piarc.desktop", "Version": version, "Type": "Full", "FileName": package }
    ]});
    (package, feed.to_string().into_bytes())
}

/// Writes `<root>/<version>/` with every platform's artefacts and signs the manifest with
/// `key` (a file in the test keys).
fn publish(root: &Path, version: &str, key: &str, extra: &[(&str, Vec<u8>)]) {
    let dir = root.join(version);
    std::fs::create_dir_all(&dir).expect("release dir");
    let mut files: Vec<(String, Vec<u8>)> = vec![
        ("piarc-release-notes.json".into(), notes(version, false)),
        (
            format!("PiArc-{version}-macos-arm64.zip"),
            artefact(1, 300_000),
        ),
        (
            format!("PiArc-{version}-macos-x64.zip"),
            artefact(2, 300_000),
        ),
    ];
    for arch in ["x64", "arm64"] {
        let (package, feed) = velopack_feed(version, arch);
        files.push((format!("releases.win-{arch}.json"), feed));
        files.push((package, artefact(3, 200_000)));
    }
    for (name, bytes) in extra {
        files.retain(|(n, _)| n != name);
        files.push(((*name).to_owned(), bytes.clone()));
    }
    for (name, bytes) in &files {
        std::fs::write(dir.join(name), bytes).expect("artefact");
    }
    let manifest = dir.join("piarc-release-manifest.json");
    let status = std::process::Command::new("node")
        .arg(repo().join("scripts/release/release-manifest.mjs"))
        .args(["generate", "--version", version, "--key"])
        .arg(key_file(key))
        .arg("--out")
        .arg(&manifest)
        .args(files.iter().map(|(name, _)| dir.join(name)))
        .stdout(std::process::Stdio::null())
        .status()
        .expect("node runs the manifest script");
    assert!(status.success(), "the manifest script failed");
}

struct Harness {
    updates: Updates,
    seen: Arc<Mutex<Vec<UpdateStatus>>>,
    _cache: Dir,
}

fn harness(releases: &str, os: Os, arch: &str, current: &str) -> Harness {
    harness_with(releases, os, arch, current, &[FEED_HOST, ASSET_HOST])
}

fn harness_with(releases: &str, os: Os, arch: &str, current: &str, hosts: &[&str]) -> Harness {
    let cache = Dir::new(&format!("cache {current} {arch}"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let config = UpdateConfig {
        current: current.to_owned(),
        latest_url: format!("{releases}/latest/download"),
        asset_url: format!("{releases}/download/v{{version}}/{{name}}"),
        page_url: format!("{releases}/tag/v{{version}}"),
        hosts: hosts.iter().map(|h| (*h).to_owned()).collect(),
        keys: vec![public_key("release-manifest.test.pub")],
        platform: Some((os, arch.to_owned())),
        test_net: Some(UpdateTestNet {
            ca_pem: TEST_CA_PEM.to_vec(),
            loopback: vec![FEED_HOST.to_owned()],
        }),
        request_timeout: Duration::from_secs(10),
    };
    let updates = Updates::new(
        config,
        &cache.0,
        Arc::new(move |s: &UpdateStatus| sink.lock().unwrap().push(s.clone())),
        CancellationToken::new(),
    );
    Harness {
        updates,
        seen,
        _cache: cache,
    }
}

async fn until_settled(updates: &Updates) -> UpdateStatus {
    for _ in 0..600 {
        let status = updates.status();
        if status.state != UpdateState::Downloading {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the download never settled: {:?}", updates.status());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_release_downloads_and_verifies_on_macos() {
    let root = Dir::new("mac");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let h = harness(&mock.releases(), Os::Macos, "arm64", "1.0.0");

    let status = h.updates.check(None).await;
    assert_eq!(status.state, UpdateState::Available, "{status:?}");
    let release = status.release.expect("release");
    assert_eq!(release.version, "1.1.0");
    assert_eq!(release.size, 300_000);
    assert_eq!(release.notes["zh-CN"], "### 修复\n- 一处问题");
    assert!(release.page_url.ends_with("/releases/tag/v1.1.0"));

    let started = h.updates.download(None).unwrap();
    assert_eq!(started.state, UpdateState::Downloading);
    let done = until_settled(&h.updates).await;
    assert_eq!(done.state, UpdateState::Ready, "{done:?}");
    assert!(
        h.seen
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.state == UpdateState::Checking)
    );

    let plan = h.updates.install_plan().await.unwrap();
    let UpdateInstall::Macos { version, archive } = plan else {
        panic!("not a macOS plan: {plan:?}");
    };
    assert_eq!(version, "1.1.0");
    assert!(archive.ends_with("PiArc-1.1.0-macos-arm64.zip"));
    assert_eq!(std::fs::read(&archive).unwrap(), artefact(1, 300_000));
    // Only this platform's file was fetched, and the latest link was followed to the assets.
    let requests = mock.requests();
    assert!(
        requests
            .iter()
            .any(|r| r == "/assets/1.1.0/PiArc-1.1.0-macos-arm64.zip")
    );
    assert!(
        !requests
            .iter()
            .any(|r| r.contains("macos-x64") || r.contains(".nupkg"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn windows_downloads_the_velopack_feed_and_its_full_package() {
    let root = Dir::new("win");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let h = harness(&mock.releases(), Os::Windows, "x64", "1.0.0");
    assert_eq!(h.updates.check(None).await.state, UpdateState::Available);
    h.updates.download(None).unwrap();
    assert_eq!(until_settled(&h.updates).await.state, UpdateState::Ready);
    let UpdateInstall::Windows { feed, .. } = h.updates.install_plan().await.unwrap() else {
        panic!("not a Windows plan");
    };
    let feed = PathBuf::from(feed);
    assert!(feed.join("releases.win-x64.json").is_file());
    assert!(
        feed.join("cn.piarc.desktop-1.1.0-win-x64-full.nupkg")
            .is_file()
    );
    assert!(!feed.join("releases.win-arm64.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_version_is_up_to_date_and_a_second_check_finds_a_ready_download() {
    let root = Dir::new("same");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let current = harness(&mock.releases(), Os::Macos, "arm64", "1.1.0");
    let status = current.updates.check(None).await;
    assert_eq!(status.state, UpdateState::UpToDate);
    assert!(status.release.is_none() && status.checked_at.is_some());

    let older = harness(&mock.releases(), Os::Macos, "arm64", "1.0.0");
    older.updates.check(None).await;
    older.updates.download(None).unwrap();
    assert_eq!(
        until_settled(&older.updates).await.state,
        UpdateState::Ready
    );
    assert_eq!(older.updates.check(None).await.state, UpdateState::Ready);
}

#[tokio::test(flavor = "multi_thread")]
async fn thr09_tampered_artefacts_other_keys_and_foreign_notes_are_refused() {
    let root = Dir::new("tamper");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    // The archive changes after signing: the download fails its checksum.
    std::fs::write(
        root.0.join("1.1.0/PiArc-1.1.0-macos-arm64.zip"),
        artefact(9, 300_000),
    )
    .unwrap();
    publish(&root.0, "1.2.0", "other.test.key", &[]);
    publish(
        &root.0,
        "1.3.0",
        "release-manifest.test.key",
        &[("piarc-release-notes.json", notes("1.2.9", false))],
    );
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let h = harness(&mock.releases(), Os::Macos, "arm64", "1.0.0");
    assert_eq!(h.updates.check(None).await.state, UpdateState::Available);
    h.updates.download(None).unwrap();
    let failed = until_settled(&h.updates).await;
    assert_eq!(failed.state, UpdateState::Failed);
    assert_eq!(failed.problem.unwrap().code, "integrity");
    assert!(h.updates.install_plan().await.is_err());

    mock.control("latest 1.2.0").unwrap();
    let other_key = h.updates.check(None).await;
    assert_eq!(other_key.state, UpdateState::Failed);
    assert_eq!(other_key.problem.unwrap().code, "integrity");

    mock.control("latest 1.3.0").unwrap();
    let foreign = h.updates.check(None).await;
    assert_eq!(foreign.state, UpdateState::Failed);
    assert!(foreign.problem.unwrap().message.contains("1.2.9"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_proxy_carries_every_request_and_never_falls_back() {
    let root = Dir::new("proxy");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    // A name only the proxy's route table maps to the mock: a direct connection cannot work.
    let mock = MockReleases::start_with_asset_host(&root.0, "1.1.0", 0, REGISTRY_HOST)
        .await
        .unwrap();
    let proxy = MockProxy::start(0).await.unwrap();
    proxy.route(REGISTRY_HOST, mock.port());
    let feed = format!("https://{REGISTRY_HOST}:{}/releases", mock.port());
    let h = harness_with(&feed, Os::Macos, "arm64", "1.0.0", &[REGISTRY_HOST]);
    assert_eq!(
        h.updates.check(Some(proxy.url())).await.state,
        UpdateState::Available
    );
    h.updates.download(Some(proxy.url())).unwrap();
    assert_eq!(until_settled(&h.updates).await.state, UpdateState::Ready);
    let connects = proxy.connects();
    assert!(connects.len() >= 4, "{connects:?}");
    assert!(
        connects.iter().all(|c| c.starts_with(REGISTRY_HOST)),
        "{connects:?}"
    );
    assert!(
        mock.requests()
            .iter()
            .any(|r| r.starts_with("/assets/1.1.0/"))
    );

    // The loopback is reached directly even with a proxy set (ADR-0082's NO_PROXY).
    let loopback = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let local = harness(&loopback.releases(), Os::Macos, "arm64", "1.0.0");
    let before = proxy.connects().len();
    assert_eq!(
        local.updates.check(Some(proxy.url())).await.state,
        UpdateState::Available
    );
    assert_eq!(proxy.connects().len(), before);

    // An unreachable proxy is a proxy problem, with no request reaching the feed.
    let before = mock.requests().len();
    let fresh = harness_with(&feed, Os::Macos, "arm64", "1.0.0", &[REGISTRY_HOST]);
    let status = fresh
        .updates
        .check(Some("http://127.0.0.1:9".to_owned()))
        .await;
    assert_eq!(status.state, UpdateState::Failed);
    assert_eq!(status.problem.unwrap().code, "proxy");
    assert_eq!(mock.requests().len(), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_feed_and_a_missing_release_are_reported() {
    let root = Dir::new("offline");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    let h = harness(&mock.releases(), Os::Macos, "arm64", "1.0.0");
    mock.control("status /releases/latest 404").unwrap();
    let missing = h.updates.check(None).await;
    assert_eq!(missing.problem.unwrap().code, "notFound");

    // Nothing listens on the feed's port any more: a network problem.
    let releases = mock.releases();
    drop(mock);
    let offline = harness(&releases, Os::Macos, "arm64", "1.0.0");
    let status = offline.updates.check(None).await;
    assert_eq!(status.state, UpdateState::Failed);
    assert_eq!(status.problem.unwrap().code, "network");
}

#[tokio::test(flavor = "multi_thread")]
async fn thr09_only_https_and_the_release_hosts_are_reached() {
    let root = Dir::new("hosts");
    publish(&root.0, "1.1.0", "release-manifest.test.key", &[]);
    let mock = MockReleases::start(&root.0, "1.1.0", 0).await.unwrap();
    // The feed's download link redirects to the asset host, which this build does not allow.
    let feed_only = harness_with(&mock.releases(), Os::Macos, "arm64", "1.0.0", &[FEED_HOST]);
    let status = feed_only.updates.check(None).await;
    assert_eq!(status.state, UpdateState::Failed);
    assert_eq!(status.problem.unwrap().code, "refused");
    assert!(!mock.requests().iter().any(|r| r.starts_with("/assets/")));
    // A plain HTTP feed is refused before any connection.
    let plain = mock.releases().replace("https://", "http://");
    let before = mock.requests().len();
    let http = harness(&plain, Os::Macos, "arm64", "1.0.0");
    let status = http.updates.check(None).await;
    assert_eq!(status.problem.unwrap().code, "refused");
    assert_eq!(mock.requests().len(), before);
}

#[test]
fn a_build_without_trusted_keys_reports_updates_unavailable() {
    let cache = Dir::new("nokey");
    let updates = Updates::new(
        UpdateConfig {
            keys: Vec::new(),
            ..UpdateConfig::default()
        },
        &cache.0,
        Arc::new(|_: &UpdateStatus| {}),
        CancellationToken::new(),
    );
    assert_eq!(
        updates.status().unavailable,
        Some(piarc_protocol::updates::UpdateUnavailable::NoTrustedKey)
    );
}
