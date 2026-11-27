//! The mock npm registry and CONNECT proxy (ADR-0102) against real npm: npm installs a package
//! from the mock through the proxy, trusting the test CA only through `NODE_EXTRA_CA_CERTS`,
//! with the user's npm configuration out of the way; the search answers like the registry
//! (filter, order, the offset cap); unknown paths are violations.

use std::path::{Path, PathBuf};

use piarc_testkit::connect_proxy::{MockProxy, ProxyMode};
use piarc_testkit::npm_registry::{MockNpm, NpmPackage, REGISTRY_HOST, TEST_CA_PEM};
use serde_json::json;

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc mock npm 测试 {label} {}",
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

fn packages() -> Vec<NpmPackage> {
    serde_json::from_value(json!([
        {
            "name": "pi-demo",
            "description": "A demo extension",
            "keywords": ["extension"],
            "downloadsMonthly": 300,
            "versions": [
                { "version": "1.0.0", "manifest": { "pi": { "extensions": ["./ext.ts"] } },
                  "files": { "ext.ts": "export default () => {};\n" } },
                { "version": "1.1.0", "manifest": { "pi": { "extensions": ["./ext.ts"] } },
                  "files": { "ext.ts": "export default () => {};\n" } }
            ]
        },
        {
            "name": "@scope/pi-skills",
            "description": "Review skills",
            "downloadsMonthly": 100,
            "versions": [{ "version": "2.0.0", "files": { "skills/review/SKILL.md": "---\nname: review\ndescription: r\n---\nr\n" } }]
        }
    ]))
    .expect("fixtures")
}

fn node() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|p| p.is_file())
        .expect("node on PATH")
}

fn npm_cli(node: &Path) -> PathBuf {
    let bin = node.parent().expect("bin");
    [
        bin.join("..")
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        bin.join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .expect("npm next to node")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::too_many_lines,
    reason = "one story: install twice through the proxy, then a refusal"
)]
async fn npm_installs_from_the_mock_through_the_proxy_only() {
    let dir = Dir::new("install");
    let npm = MockNpm::start(packages(), &dir.0.join("work"), REGISTRY_HOST, 0)
        .await
        .expect("mock npm");
    let proxy = MockProxy::start(0).await.expect("proxy");
    proxy.route(REGISTRY_HOST, npm.port());
    let ca = dir.0.join("ca.pem");
    std::fs::write(&ca, TEST_CA_PEM).expect("ca");
    let empty = dir.0.join("empty npmrc");
    std::fs::write(&empty, "").expect("npmrc");
    let prefix = dir.0.join("prefix");
    std::fs::create_dir_all(&prefix).expect("prefix");
    std::fs::write(
        prefix.join("package.json"),
        r#"{"name":"p","private":true}"#,
    )
    .expect("stub");
    // npm writes broken lock paths through a symbolic link (macOS `/var`): the real path.
    let prefix = prefix.canonicalize().expect("real path");
    let node = node();
    let run = |spec: &str| {
        std::process::Command::new(&node)
            .arg(npm_cli(&node))
            .args([
                "install",
                spec,
                "--save-exact",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--prefix",
            ])
            .arg(&prefix)
            .current_dir(&prefix)
            .env("npm_config_registry", format!("{}/", npm.base()))
            .env("npm_config_https_proxy", proxy.url())
            .env("npm_config_proxy", proxy.url())
            .env("npm_config_userconfig", &empty)
            .env("npm_config_cache", dir.0.join("cache"))
            .env("npm_config_fetch_retries", "0")
            .env("npm_config_update_notifier", "false")
            .env("NODE_EXTRA_CA_CERTS", &ca)
            .output()
            .expect("npm")
    };
    let out = run("pi-demo@1.0.0");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let installed: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            prefix
                .join("node_modules")
                .join("pi-demo")
                .join("package.json"),
        )
        .expect("installed"),
    )
    .expect("json");
    assert_eq!(installed["version"], "1.0.0");
    let out = run("@scope/pi-skills@2.0.0");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        prefix
            .join("node_modules/@scope/pi-skills/skills/review/SKILL.md")
            .is_file()
    );
    // `--save-exact`: installing another package does not move this one to 1.1.0.
    let installed: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            prefix
                .join("node_modules")
                .join("pi-demo")
                .join("package.json"),
        )
        .expect("installed"),
    )
    .expect("json");
    assert_eq!(installed["version"], "1.0.0");
    // Every connection went through the proxy; nothing npm asked for was unexpected.
    let connects = proxy.connects();
    assert!(!connects.is_empty());
    assert!(
        connects
            .iter()
            .all(|c| c == &format!("{REGISTRY_HOST}:{}", npm.port())),
        "{connects:?}"
    );
    assert_eq!(npm.violations(), Vec::<String>::new());
    let lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(prefix.join("package-lock.json")).expect("lock"))
            .expect("json");
    let entry = &lock["packages"]["node_modules/pi-demo"];
    assert!(
        entry["integrity"]
            .as_str()
            .is_some_and(|i| i.starts_with("sha512-"))
    );
    assert!(
        entry["resolved"]
            .as_str()
            .is_some_and(|r| r.starts_with(&npm.base()))
    );

    // A refusing proxy: npm fails without reaching the registry directly.
    proxy.set_mode(ProxyMode::Refuse(407));
    let before = npm.requests().len();
    let out = run("pi-demo@1.1.0");
    assert!(!out.status.success());
    assert_eq!(npm.requests().len(), before, "no direct request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_filters_orders_and_caps_like_the_registry() {
    let dir = Dir::new("search");
    let npm = MockNpm::start(packages(), &dir.0.join("work"), "127.0.0.1", 0)
        .await
        .expect("mock npm");
    let client = std::process::Command::new("curl").arg("--version").output();
    if client.is_err() {
        return;
    }
    let ca = dir.0.join("ca.pem");
    std::fs::write(&ca, TEST_CA_PEM).expect("ca");
    let get = |path: &str| -> serde_json::Value {
        let out = std::process::Command::new("curl")
            .args(["-sS", "--cacert"])
            .arg(&ca)
            .arg(format!("{}{path}", npm.base()))
            .output()
            .expect("curl");
        serde_json::from_slice(&out.stdout).expect("json")
    };
    let names = |v: &serde_json::Value| -> Vec<String> {
        v["objects"]
            .as_array()
            .expect("objects")
            .iter()
            .map(|o| o["package"]["name"].as_str().unwrap_or_default().to_owned())
            .collect()
    };
    let all = get("/-/v1/search?text=keywords:pi-package&size=250");
    assert_eq!(names(&all), ["pi-demo", "@scope/pi-skills"]);
    assert_eq!(all["objects"][0]["downloads"]["monthly"], 300);
    assert_eq!(
        names(&get("/-/v1/search?text=keywords:pi-package+review&size=5")),
        ["@scope/pi-skills"]
    );
    assert_eq!(
        names(&get("/-/v1/search?text=keywords:pi-package&size=1&from=1")),
        ["@scope/pi-skills"]
    );
    assert_eq!(
        names(&get(
            "/-/v1/search?text=keywords:pi-package&size=1&from=6000"
        )),
        ["pi-demo"]
    );
    let latest = get("/@scope%2fpi-skills/latest");
    assert_eq!(latest["version"], "2.0.0");
    assert!(
        latest["dist"]["integrity"]
            .as_str()
            .is_some_and(|i| i.starts_with("sha512-"))
    );
    let packument = get("/pi-demo");
    assert_eq!(packument["dist-tags"]["latest"], "1.1.0");
    assert_eq!(npm.violations(), Vec::<String>::new());
    get("/nope");
    assert_eq!(npm.violations(), ["/nope"]);
}
