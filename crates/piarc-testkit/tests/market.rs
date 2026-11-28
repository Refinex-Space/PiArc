//! ADR-0102 end to end on Core's public API, against the mock npm registry and the CONNECT
//! proxy, with the real npm next to the test's node: the catalog syncs and classifies, searches
//! live, details read the package document, installs are checked and stay off, refusals leave
//! nothing behind, the user's proxy carries every request (no direct connection when it
//! refuses), and an unreachable registry leaves the cached catalog in place.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::market::{MarketConfig, MarketLimits, MarketTestNet};
use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::sessions::SessionsConfig;
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use piarc_testkit::connect_proxy::{MockProxy, ProxyMode};
use piarc_testkit::npm_registry::{MockNpm, NpmPackage, REGISTRY_HOST, TEST_CA_PEM};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

const WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Events {
    all: Mutex<Vec<(String, Value)>>,
    arrived: Notify,
}

struct Sink(Arc<Events>);

impl EventSink for Sink {
    fn deliver(&self, batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        let mut all = self.0.all.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            let events: Vec<Value> = serde_json::from_slice(&batch.payload).unwrap_or_default();
            for event in events {
                all.push((batch.route.as_str().to_owned(), event));
            }
        }
        drop(all);
        self.0.arrived.notify_waiters();
        Ok(())
    }
}

fn node() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|p| p.is_file())
        .expect("node on PATH")
}

fn packages() -> Vec<NpmPackage> {
    let ext = |v: &str| {
        json!({ "version": v, "manifest": { "pi": { "extensions": ["./ext.ts"] } },
                "files": { "ext.ts": "export default () => {};\n" } })
    };
    serde_json::from_value(json!([
        { "name": "pi-demo", "description": "A demo extension", "keywords": ["extension"],
          "downloadsMonthly": 900, "readme": "# Demo\n\n<script>x()</script>\n",
          "versions": [ext("1.0.0"), ext("1.1.0")] },
        { "name": "@scope/pi-skills", "description": "Review skills", "downloadsMonthly": 500,
          "versions": [{ "version": "2.0.0", "manifest": { "pi": { "skills": ["./skills"] } },
            "files": { "skills/review/SKILL.md": "---\nname: review\ndescription: r\n---\nr\n" } }] },
        { "name": "pi-quiet-prompts", "description": "No keywords, a manifest", "downloadsMonthly": 300,
          "versions": [{ "version": "1.0.0", "manifest": { "pi": { "prompts": ["./prompts"] } },
            "files": { "prompts/fix.md": "---\ndescription: fix\n---\nfix\n" } }] },
        { "name": "pi-dark-theme", "description": "Only a theme", "keywords": ["theme"],
          "downloadsMonthly": 800,
          "versions": [{ "version": "1.0.0", "manifest": { "pi": { "themes": ["./t.json"] } },
            "files": { "t.json": "{}" } }] },
        { "name": "pi-old", "description": "Deprecated", "keywords": ["extension"], "downloadsMonthly": 700,
          "versions": [{ "version": "1.0.0", "deprecated": "use pi-demo",
            "manifest": { "pi": { "extensions": ["./ext.ts"] } }, "files": { "ext.ts": "x" } }] },
        { "name": "pi-git-dep", "description": "Depends on git", "keywords": ["skill"],
          "downloadsMonthly": 100,
          "versions": [{ "version": "1.0.0", "manifest": { "pi": { "skills": ["./s"] },
            "dependencies": { "x": "github:evil/x" } }, "files": { "s/a/SKILL.md": "---\nname: a\ndescription: a\n---\na\n" } }] },
        { "name": "pi-risky", "description": "Flagged insecure", "keywords": ["extension"],
          "downloadsMonthly": 50, "insecure": true, "versions": [ext("0.1.0")] }
    ]))
    .expect("fixtures")
}

struct Rig {
    root: PathBuf,
    core: Option<CoreRuntime>,
    events: Arc<Events>,
    npm: MockNpm,
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(core) = self.core.take() {
            let _ = core.shutdown(|| {});
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Core with the market on the mock: `proxy` (when given) is the user's manual proxy, and the
/// registry's name then resolves only through it.
async fn rig(label: &str, proxy: Option<&MockProxy>) -> Rig {
    let root =
        std::env::temp_dir().join(format!("piarc market 市场 {label} {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(&data).expect("data");
    // Behind the proxy the registry is a `.test` name only the proxy resolves; directly it is
    // the loopback address (npm resolves names itself and would not find a `.test` one).
    let host = if proxy.is_some() {
        REGISTRY_HOST
    } else {
        "127.0.0.1"
    };
    let npm = MockNpm::start(packages(), &root.join("work"), host, 0)
        .await
        .expect("mock npm");
    if let Some(proxy) = proxy {
        proxy.route(REGISTRY_HOST, npm.port());
        std::fs::write(
            data.join("settings.json"),
            json!({ "proxy": { "mode": "manual", "url": proxy.url() } }).to_string(),
        )
        .expect("settings");
    }
    let ca = root.join("ca.pem");
    std::fs::write(&ca, TEST_CA_PEM).expect("ca");
    let config = CoreConfig {
        home: Some(root.join("home")),
        dirs: Some(DataDirs::new(data, root.join("cache")).expect("absolute")),
        sessions: SessionsConfig {
            launch: Some(AgentHostLaunch::Custom {
                node: node(),
                // No workspace opens: no Agent Host starts.
                bundle: root.join("no-bundle.mjs"),
                pi_package_dir: None,
                extra_args: Vec::new(),
                extra_env: Vec::new(),
            }),
            ..SessionsConfig::default()
        },
        secret_store: Some(SecretStoreSetup {
            master_key: test_master_key_name("market"),
            store: Arc::new(MemorySecretStore::new()),
        }),
        command_env: Some(piarc_core::tool_io::CommandEnv::Fixed(
            std::env::vars_os()
                .filter(|(k, _)| {
                    ["PATH", "HOME", "SystemRoot", "TEMP", "TMP", "TMPDIR"]
                        .iter()
                        .any(|n| k.to_string_lossy().eq_ignore_ascii_case(n))
                })
                .collect(),
        )),
        market: MarketConfig {
            registry: npm.base(),
            limits: MarketLimits {
                page_size: 3,
                retry_wait: [Duration::from_millis(10); 2],
                ..MarketLimits::default()
            },
            test_net: Some(MarketTestNet {
                ca_pem: TEST_CA_PEM.to_vec(),
                ca_file: Some(ca),
                loopback: Vec::new(),
            }),
        },
        ..CoreConfig::default()
    };
    let events = Arc::new(Events::default());
    let core = CoreRuntime::start(config, Arc::new(Sink(Arc::clone(&events)))).expect("Core");
    Rig {
        root,
        core: Some(core),
        events,
        npm,
    }
}

impl Rig {
    fn core(&self) -> &CoreRuntime {
        self.core.as_ref().expect("running")
    }

    async fn call(
        &self,
        start: impl FnOnce(&CoreRuntime, Box<dyn FnOnce(piarc_core::Result<Value>) + Send>),
    ) -> piarc_core::Result<Value> {
        let (tx, rx) = oneshot::channel();
        start(
            self.core(),
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        tokio::time::timeout(WAIT, rx)
            .await
            .expect("in time")
            .expect("answered")
    }

    async fn query(&self, query: Value) -> Value {
        let text = query.to_string();
        self.call(|core, done| {
            core.market_query(&text, done).expect("queued");
        })
        .await
        .expect("page")
    }

    /// Waits until the sync is idle with a completed index and every manifest read.
    async fn settled(&self) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let page = self.query(json!({ "limit": 50 })).await;
            let status = &page["status"];
            if status["state"] == "idle"
                && status["syncedAt"].is_number()
                && status["classified"] == status["indexed"]
            {
                return page;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "not settled: {status}"
            );
            let _ =
                tokio::time::timeout(Duration::from_millis(200), self.events.arrived.notified())
                    .await;
        }
    }

    async fn install(&self, name: &str, version: &str) -> piarc_core::Result<Value> {
        let text = json!({ "name": name, "version": version, "scope": "user" }).to_string();
        self.call(|core, done| {
            core.market_install(&text, done).expect("queued");
        })
        .await
    }
}

fn names(page: &Value) -> Vec<String> {
    page["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| e["name"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_catalog_syncs_classifies_searches_and_details() {
    let rig = rig("catalog", None).await;
    let page = rig.settled().await;
    // Theme-only and deprecated packages are left out; popular first.
    assert_eq!(
        names(&page),
        [
            "pi-demo",
            "@scope/pi-skills",
            "pi-quiet-prompts",
            "pi-git-dep",
            "pi-risky"
        ]
    );
    assert_eq!(
        page["counts"],
        json!({ "all": 5, "extension": 2, "skill": 2, "prompt": 1 })
    );
    // A package without kind keywords is classified by its manifest.
    let prompts = rig
        .query(json!({ "limit": 50, "category": "prompt" }))
        .await;
    assert_eq!(names(&prompts), ["pi-quiet-prompts"]);
    assert_eq!(prompts["entries"][0]["kindsFromManifest"], true);
    assert_eq!(page["entries"][4]["insecure"], true);
    // Several pages were fetched in order (page size 3 here).
    let searches: Vec<String> = rig
        .npm
        .requests()
        .into_iter()
        .filter(|r| r.starts_with("/-/v1/search"))
        .collect();
    assert!(
        searches.iter().any(|r| r.contains("from=3")),
        "{searches:?}"
    );

    // Live search, and an exact name finds a deprecated package.
    let found = rig.query(json!({ "limit": 50, "query": "review" })).await;
    assert_eq!(found["live"], true);
    assert_eq!(names(&found), ["@scope/pi-skills"]);
    let old = rig.query(json!({ "limit": 50, "query": "pi-old" })).await;
    assert_eq!(names(&old), ["pi-old"]);
    assert_eq!(old["entries"][0]["deprecated"], true);

    // Details read the package document.
    let detail = rig
        .call(|core, done| {
            core.market_detail("pi-demo".into(), None, done)
                .expect("queued")
        })
        .await
        .expect("detail");
    assert!(
        detail["readme"]
            .as_str()
            .is_some_and(|r| r.contains("# Demo"))
    );
    let risky = rig
        .call(|core, done| {
            core.market_detail("pi-git-dep".into(), None, done)
                .expect("queued")
        })
        .await
        .expect("detail");
    assert_eq!(risky["foreignDependencies"], json!(["x@github:evil/x"]));
    assert_eq!(rig.npm.violations(), Vec::<String>::new());
    // Bad queries are refused.
    let long = json!({ "limit": 50, "query": "x".repeat(201) }).to_string();
    assert!(
        rig.call(|core, done| core.market_query(&long, done).expect("queued"))
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installs_are_checked_stay_off_and_refusals_leave_nothing() {
    let rig = rig("install", None).await;
    rig.settled().await;
    let result = rig.install("pi-demo", "1.1.0").await.expect("installed");
    assert_eq!(result["package"]["id"], "pi-demo");
    assert_eq!(result["package"]["source"]["version"], "1.1.0");
    // The location names the market's registry: updates go through the same checks.
    assert_eq!(
        result["package"]["source"]["location"],
        format!("{}/pi-demo", rig.npm.base())
    );
    assert_eq!(result["package"]["enabled"], false);
    let path = PathBuf::from(result["package"]["path"].as_str().expect("path"));
    assert!(path.join("ext.ts").is_file());
    let page = rig.query(json!({ "limit": 50 })).await;
    assert_eq!(page["entries"][0]["installed"]["id"], "pi-demo");

    for (name, version, why) in [
        ("pi-demo", "1.1.0", "installed already"),
        ("pi-demo", "1.0.0", "not the catalog's version"),
        ("pi-git-dep", "1.0.0", "a dependency outside the registry"),
        ("pi-dark-theme", "1.0.0", "themes only"),
        ("pi-demo", "^1", "not an exact version"),
        ("../x", "1.0.0", "not a name"),
    ] {
        assert!(rig.install(name, version).await.is_err(), "{why}");
    }
    let pkgs = rig.root.join("data").join("pi").join("npm").join("pkgs");
    let left: Vec<String> = std::fs::read_dir(&pkgs)
        .expect("prefixes")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left.len(), 1, "only pi-demo's prefix: {left:?}");

    // M-19: updating a market package (from the market or the installed list) installs the
    // catalog's version from the same registry with the same checks.
    let updated = rig
        .call(|core, done| {
            core.package_update("pi-demo".into(), None, done)
                .expect("queued");
        })
        .await
        .expect("updated through the market's checks");
    assert_eq!(updated["package"]["source"]["version"], "1.1.0");
    assert!(
        updated["package"]["source"]["integrity"]
            .as_str()
            .is_some_and(|i| i.starts_with("sha512-")),
        "{updated}"
    );
    assert_eq!(rig.npm.violations(), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_users_proxy_carries_everything_and_its_refusal_is_not_a_direct_connection() {
    let proxy = MockProxy::start(0).await.expect("proxy");
    let rig = rig("proxy", Some(&proxy)).await;
    rig.settled().await;
    rig.install("@scope/pi-skills", "2.0.0")
        .await
        .expect("installed through the proxy");
    let connects = proxy.connects();
    assert!(connects.len() > 2, "{connects:?}");
    let target = format!("{REGISTRY_HOST}:{}", rig.npm.port());
    assert!(connects.iter().all(|c| *c == target), "{connects:?}");

    // The proxy refuses: the refresh fails with `proxy`, nothing reaches the registry
    // directly, and the cached catalog stays.
    proxy.set_mode(ProxyMode::Refuse(407));
    let before = rig.npm.requests().len();
    rig.call(|core, done| core.market_refresh(done).expect("queued"))
        .await
        .expect("refresh starts");
    let deadline = tokio::time::Instant::now() + WAIT;
    let page = loop {
        let page = rig.query(json!({ "limit": 50 })).await;
        if page["status"]["state"] == "failed" {
            break page;
        }
        assert!(tokio::time::Instant::now() < deadline, "{}", page["status"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(page["status"]["problem"]["code"], "proxy");
    assert_eq!(names(&page).len(), 5);
    assert_eq!(rig.npm.requests().len(), before, "no direct request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreachable_registry_keeps_the_cached_catalog() {
    let rig = rig("offline", None).await;
    rig.settled().await;
    rig.npm.set_offline(true);
    rig.call(|core, done| core.market_refresh(done).expect("queued"))
        .await
        .expect("refresh starts");
    let deadline = tokio::time::Instant::now() + WAIT;
    let page = loop {
        let page = rig.query(json!({ "limit": 50 })).await;
        if page["status"]["state"] == "failed" {
            break page;
        }
        assert!(tokio::time::Instant::now() < deadline, "{}", page["status"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(names(&page).len(), 5);
    assert!(
        page["status"]["syncedAt"].is_number(),
        "the last good sync is still known"
    );
    // A search falls back to the cache.
    let found = rig.query(json!({ "limit": 50, "query": "demo" })).await;
    assert_eq!(found["live"], false);
    assert_eq!(names(&found), ["pi-demo"]);
    let _ = Path::new("");
}

/// A first sync that cannot reach the registry: reading the market again does not start another
/// sync right away (the page reads after every sync event, which would otherwise retry in a
/// loop), and a refresh once the registry is back fills the catalog.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_first_sync_backs_off_and_a_refresh_recovers() {
    let rig = rig("first sync offline", None).await;
    rig.npm.set_offline(true);
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let page = rig.query(json!({ "limit": 50 })).await;
        if page["status"]["state"] == "failed" {
            assert!(page["status"]["syncedAt"].is_null());
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "{}", page["status"]);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for _ in 0..5 {
        let page = rig.query(json!({ "limit": 50 })).await;
        assert_eq!(
            page["status"]["state"], "failed",
            "no new sync: {}",
            page["status"]
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    rig.npm.set_offline(false);
    rig.call(|core, done| core.market_refresh(done).expect("queued"))
        .await
        .expect("refresh starts");
    let page = rig.settled().await;
    assert_eq!(names(&page).len(), 5);
    assert!(page["status"]["problem"].is_null(), "{}", page["status"]);
}

/// The catalog is updated once its index pages are in: reading package kinds afterwards does
/// not keep the status at "syncing" (the page would show the last page forever).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_index_is_done_while_kinds_are_still_being_read() {
    let rig = rig("kinds pending", None).await;
    // Every version document waits: the kinds cannot be read yet.
    rig.npm.hold("/pi-demo/");
    let deadline = tokio::time::Instant::now() + WAIT;
    let status = loop {
        let page = rig.query(json!({ "limit": 50 })).await;
        let status = page["status"].clone();
        if status["syncedAt"].is_number() {
            break status;
        }
        assert!(tokio::time::Instant::now() < deadline, "{status}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(status["state"], "idle", "{status}");
    assert!(
        status["classified"].as_u64() < status["indexed"].as_u64(),
        "{status}"
    );
    rig.npm.release();
    rig.settled().await;
}
