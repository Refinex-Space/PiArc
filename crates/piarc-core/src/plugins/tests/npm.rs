//! ADR-0102 M1: npm installs each get a prefix of their own, are serialised, leave nothing behind
//! when they fail, never disturb an installed package, uninstall their own files, and run with
//! the user's proxy.

use std::path::{Path, PathBuf};

use piarc_protocol::plugins::{PackageScope, PackageSourceKind};

use super::Fixture;

impl Fixture {
    /// `<root>/packs/<file>.tgz` with `package/` holding `files` (path, text).
    fn tarball(&self, file: &str, files: &[(&str, String)]) -> PathBuf {
        let dir = self.root.join("packs").join(file);
        for (path, text) in files {
            self.write(&format!("packs/{file}/package/{path}"), text);
        }
        let out = self.root.join("packs").join(format!("{file}.tgz"));
        // Relative to the working directory: Windows' tar.exe cannot open a path argument with
        // characters outside the ANSI code page, and the fixture root has Chinese in it.
        let status = std::process::Command::new("tar")
            .args(["-czf"])
            .arg(format!("../{file}.tgz"))
            .arg("package")
            .current_dir(&dir)
            .status()
            .expect("tar");
        assert!(status.success());
        out
    }

    /// A Pi package tarball `name@version` with one extension.
    fn pi_tarball(&self, file: &str, name: &str, version: &str) -> PathBuf {
        self.tarball(
            file,
            &[
                (
                    "package.json",
                    serde_json::json!({
                        "name": name,
                        "version": version,
                        "keywords": ["pi-package"],
                        "pi": { "extensions": ["./ext.ts"] }
                    })
                    .to_string(),
                ),
                ("ext.ts", "export default () => {};\n".to_owned()),
            ],
        )
    }

    async fn install_npm(&self, tarball: &Path) -> crate::error::Result<PathBuf> {
        let result = self
            .manager
            .install(self.request(
                PackageSourceKind::Npm,
                &tarball.display().to_string(),
                PackageScope::User,
            ))
            .await?;
        Ok(PathBuf::from(result.package.path))
    }

    /// Every `node_modules/<name>` directory under `<data>/pi/npm`.
    fn npm_entries(&self, name: &str) -> Vec<PathBuf> {
        let root = self.root.join("data").join("pi").join("npm");
        let mut found = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.ends_with(Path::new("node_modules").join(name)) {
                    found.push(path.clone());
                }
                stack.push(path);
            }
        }
        found
    }
}

fn version_of(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_owned)
}

#[tokio::test]
async fn concurrent_npm_installs_each_get_their_own_prefix_and_package() {
    let f = Fixture::new();
    let a = f.pi_tarball("a", "pi-alpha", "1.0.0");
    let b = f.pi_tarball("b", "pi-beta", "1.0.0");
    let (first, second) = tokio::join!(f.install_npm(&a), f.install_npm(&b));
    let (first, second) = (first.expect("alpha"), second.expect("beta"));
    let pkgs = f
        .root
        .join("data")
        .join("pi")
        .join("npm")
        .join("pkgs")
        .canonicalize()
        .expect("per-package prefixes");
    assert!(first.starts_with(&pkgs), "{}", first.display());
    assert!(second.starts_with(&pkgs), "{}", second.display());
    assert_ne!(first.parent(), second.parent());
    assert!(first.ends_with(Path::new("node_modules").join("pi-alpha")));
    assert!(second.ends_with(Path::new("node_modules").join("pi-beta")));
    let ids: Vec<String> = f
        .manager
        .list(None)
        .await
        .expect("list")
        .packages
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
}

#[tokio::test]
async fn a_failed_npm_registration_leaves_nothing_behind() {
    let f = Fixture::new();
    // Not a package PiArc can read: no pi field, no resource directories, no plugin layout.
    let bad = f.tarball(
        "bad",
        &[(
            "package.json",
            serde_json::json!({ "name": "not-a-pi-package", "version": "1.0.0" }).to_string(),
        )],
    );
    assert!(f.install_npm(&bad).await.is_err());
    assert_eq!(f.npm_entries("not-a-pi-package"), Vec::<PathBuf>::new());
    assert!(
        f.manager
            .list(None)
            .await
            .expect("list")
            .packages
            .is_empty()
    );
}

#[tokio::test]
async fn installing_a_name_again_leaves_the_installed_package_untouched() {
    let f = Fixture::new();
    let one = f.pi_tarball("one", "pi-same", "1.0.0");
    let two = f.pi_tarball("two", "pi-same", "2.0.0");
    let path = f.install_npm(&one).await.expect("first");
    assert!(f.install_npm(&two).await.is_err(), "a second pi-same");
    assert_eq!(version_of(&path).as_deref(), Some("1.0.0"));
    assert_eq!(f.npm_entries("pi-same").len(), 1);
}

#[tokio::test]
async fn uninstalling_removes_the_packages_own_files_when_its_id_is_not_its_npm_name() {
    let f = Fixture::new();
    let tarball = f.tarball(
        "plugin",
        &[
            (
                "package.json",
                serde_json::json!({ "name": "npm-name", "version": "1.0.0" }).to_string(),
            ),
            (
                ".claude-plugin/plugin.json",
                serde_json::json!({ "name": "plugin-id" }).to_string(),
            ),
            (
                "commands/hi.md",
                "---\ndescription: hi\n---\nhi\n".to_owned(),
            ),
        ],
    );
    let path = f.install_npm(&tarball).await.expect("install");
    assert!(path.is_dir());
    f.manager
        .uninstall("plugin-id", None)
        .await
        .expect("uninstall");
    assert!(!path.exists(), "{} is still there", path.display());
    assert_eq!(f.npm_entries("npm-name"), Vec::<PathBuf>::new());
    // M-22: the row names what went (the package's prefix) and the declarations cleared.
    let audit = f.audit().await;
    let row = audit
        .iter()
        .rfind(|r| r["action"] == "uninstall")
        .expect("an uninstall row");
    assert_eq!(row["id"], "plugin-id");
    assert_eq!(row["declarations"], serde_json::json!(["user"]));
    let removed: Vec<&str> = row["removed"]
        .as_array()
        .expect("removed")
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();
    assert!(
        removed.iter().any(|r| path.starts_with(r)),
        "{removed:?} does not cover {}",
        path.display()
    );
}

#[tokio::test]
async fn ids_that_share_a_data_directory_are_refused() {
    let f = Fixture::new();
    for (dir, name) in [("dot", "pi.same"), ("dash", "pi-same")] {
        f.write(
            &format!("{dir}/package.json"),
            &serde_json::json!({ "name": name, "pi": { "skills": ["./skills"] } }).to_string(),
        );
        f.write(
            &format!("{dir}/skills/s/SKILL.md"),
            "---\nname: s\ndescription: s\n---\ns\n",
        );
    }
    let install = |dir: &str| {
        f.manager.install(f.request(
            PackageSourceKind::Directory,
            &f.root.join(dir).display().to_string(),
            PackageScope::User,
        ))
    };
    install("dot").await.expect("first");
    let error = install("dash").await.expect_err("same data directory");
    assert!(error.to_string().contains("data"), "{error}");
}

#[tokio::test]
async fn npm_runs_with_the_users_proxy() {
    let f = Fixture::new();
    let manager = f
        .manager
        .clone()
        .with_proxy(Some("http://127.0.0.1:9".to_owned()));
    let tarball = f.pi_tarball("p", "pi-proxied", "1.0.0");
    manager
        .install(f.request(
            PackageSourceKind::Npm,
            &tarball.display().to_string(),
            PackageScope::User,
        ))
        .await
        .expect("a local tarball needs no network");
    let specs = f.spawner.specs.lock().expect("specs").clone();
    let env = &specs.last().expect("npm ran").env;
    let get = |name: &str| {
        env.iter()
            .find(|(k, _)| k.to_string_lossy() == name)
            .map(|(_, v)| v.to_string_lossy().into_owned())
    };
    assert_eq!(get("HTTPS_PROXY").as_deref(), Some("http://127.0.0.1:9"));
    assert_eq!(
        get("npm_config_https_proxy").as_deref(),
        Some("http://127.0.0.1:9")
    );
    assert_eq!(
        get("npm_config_proxy").as_deref(),
        Some("http://127.0.0.1:9")
    );
    assert!(get("npm_config_noproxy").is_some());
}

#[tokio::test]
async fn an_npm_update_swaps_in_the_new_version_and_keeps_the_old_one_on_failure() {
    let f = Fixture::new();
    let tarball = f.pi_tarball("up", "pi-up", "1.0.0");
    let path = f.install_npm(&tarball).await.expect("install");
    // The same spec now yields 2.0.0.
    let _ = std::fs::remove_dir_all(f.root.join("packs").join("up"));
    let again = f.pi_tarball("up", "pi-up", "2.0.0");
    assert_eq!(again, tarball);
    let updated = f.manager.update("pi-up", None).await.expect("update");
    assert_eq!(updated.previous_version.as_deref(), Some("1.0.0"));
    assert_eq!(updated.package.source.version.as_deref(), Some("2.0.0"));
    assert_eq!(version_of(&path).as_deref(), Some("2.0.0"));
    assert_eq!(f.npm_entries("pi-up").len(), 1, "no copy left aside");
    // A spec that now installs another package: the update is refused, 2.0.0 stays.
    let _ = std::fs::remove_dir_all(f.root.join("packs").join("up"));
    f.pi_tarball("up", "pi-other", "3.0.0");
    assert!(f.manager.update("pi-up", None).await.is_err());
    assert_eq!(version_of(&path).as_deref(), Some("2.0.0"));
    assert_eq!(f.npm_entries("pi-other"), Vec::<PathBuf>::new());
}

#[tokio::test]
async fn packages_installed_in_the_shared_prefix_uninstall_by_their_npm_name() {
    // Installed before ADR-0102: `<pi>/npm/node_modules/<name>`.
    let f = Fixture::new();
    let tarball = f.pi_tarball("old", "pi-legacy", "1.0.0");
    let pi = f.root.join("data").join("pi");
    let root = super::fetch::npm_root(&pi).expect("shared prefix");
    let status = std::process::Command::new(super::node())
        .arg(super::fetch::npm_cli(&super::node()).expect("bundled npm"))
        .args([
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefix",
        ])
        .arg(&root)
        .arg(&tarball)
        .current_dir(&root)
        .status()
        .expect("npm");
    assert!(status.success());
    let path = root.join("node_modules").join("pi-legacy");
    let now = crate::storage::now_ms();
    let record = piarc_store::PackageRecord {
        id: "pi-legacy".into(),
        kind: "piPackage".into(),
        source_kind: "npm".into(),
        location: tarball.display().to_string(),
        path: path.display().to_string(),
        commit: None,
        version: Some("1.0.0".into()),
        integrity: None,
        confirmed: Vec::new(),
        installed_at: now,
        updated_at: now,
    };
    f.storage
        .run(move |s| s.put_package(&record))
        .await
        .expect("run")
        .expect("put");
    f.manager
        .uninstall("pi-legacy", None)
        .await
        .expect("uninstall");
    assert!(!path.exists());
}

/// An install that cannot be declared (the user settings cannot be written) leaves nothing:
/// no record, no npm files.
#[tokio::test]
async fn an_install_that_cannot_be_declared_is_taken_back() {
    let f = Fixture::new();
    let tarball = f.pi_tarball("undeclared", "pi-undeclared", "1.0.0");
    // A directory where the user settings file goes: writing it fails.
    std::fs::create_dir_all(f.root.join("data").join("settings.json")).expect("block");
    assert!(f.install_npm(&tarball).await.is_err());
    assert_eq!(f.npm_entries("pi-undeclared"), Vec::<PathBuf>::new());
    let list = f.manager.list(None).await.expect("list");
    assert!(list.packages.is_empty(), "{:?}", list.packages);
}
