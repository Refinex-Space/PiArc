//! T40 on Core's side: installing from a directory, git and npm, scopes, confirmation, trust,
//! and the audit rows (A03, A04, A05, A09, A10).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use piarc_ports::{ProcessSpawner, SpawnSpec, SpawnedProcess};
use piarc_protocol::mcp::McpScope;
use piarc_protocol::plugins::{
    PackageExecutableKind, PackageInstallRequest, PackageScope, PackageSourceKind,
};

use super::*;
use crate::DataDirs;
use crate::mcp::McpConfigSource;
use crate::tool_io::{CommandEnv, ToolIoConfig};

/// Starts processes for real and records what it started.
#[derive(Default)]
struct Recording {
    specs: Mutex<Vec<SpawnSpec>>,
}

impl ProcessSpawner for Recording {
    fn spawn(&self, spec: SpawnSpec) -> std::io::Result<SpawnedProcess> {
        self.specs.lock().expect("specs").push(spec.clone());
        piarc_exec::ProcessTreeSpawner.spawn(spec)
    }
}

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    other: PathBuf,
    storage: Storage,
    trust: TrustService,
    io: ToolIo,
    spawner: Arc<Recording>,
    manager: PluginManager,
}

fn node() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|p| p.is_file())
        .expect("node on PATH")
}

fn process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            let k = k.to_string_lossy().to_ascii_uppercase();
            [
                "PATH",
                "HOME",
                "USERPROFILE",
                "SYSTEMROOT",
                "TEMP",
                "TMP",
                "TMPDIR",
            ]
            .contains(&k.as_str())
        })
        .collect()
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc plugins 中文 {}",
            crate::sessions::new_session_id().expect("unique id")
        ));
        let workspace = root.join("工作 区");
        let other = root.join("other");
        let data = root.join("data");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&other).expect("other");
        let dirs = DataDirs::new(data.clone(), root.join("cache"))
            .expect("directories")
            .with_home(Some(root.join("home")));
        dirs.create_layout().expect("layout");
        let storage = Storage::open(dirs).expect("database");
        let trust = TrustService::new(storage.clone());
        let io = ToolIo::new(ToolIoConfig {
            command_env: CommandEnv::Fixed(process_env()),
            ..ToolIoConfig::new(data)
        });
        let spawner = Arc::new(Recording::default());
        let manager = PluginManager::new(
            storage.clone(),
            trust.clone(),
            io.clone(),
            Some(node()),
            spawner.clone(),
        );
        Self {
            workspace: workspace.canonicalize().expect("canonical"),
            other: other.canonicalize().expect("canonical"),
            root,
            storage,
            trust,
            io,
            spawner,
            manager,
        }
    }

    fn write(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(&path, text).expect("write");
        path
    }

    /// A plugin with a hook and an MCP server.
    fn plugin(&self, dir: &str, name: &str) -> PathBuf {
        self.write(
            &format!("{dir}/.claude-plugin/plugin.json"),
            &format!(r#"{{"name": "{name}"}}"#),
        );
        self.write(
            &format!("{dir}/hooks/hooks.json"),
            r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo one"}]}]}}"#,
        );
        self.write(
            &format!("{dir}/.mcp.json"),
            r#"{"db": {"command": "node", "args": ["server.mjs"]}}"#,
        );
        self.write(
            &format!("{dir}/commands/hi.md"),
            "---\ndescription: hi\n---\nhi\n",
        );
        self.root.join(dir)
    }

    fn request(
        &self,
        kind: PackageSourceKind,
        location: &str,
        scope: PackageScope,
    ) -> PackageInstallRequest {
        PackageInstallRequest {
            kind,
            location: location.to_owned(),
            scope,
            workspace: (scope == PackageScope::Project)
                .then(|| self.workspace.display().to_string()),
        }
    }

    async fn audit(&self) -> Vec<serde_json::Value> {
        let rows = self
            .storage
            .run(|s| s.audit_events(100))
            .await
            .expect("run")
            .expect("rows");
        rows.into_iter()
            .filter(|r| r.kind == AUDIT_KIND)
            .map(|r| serde_json::from_str(&r.detail).expect("detail"))
            .collect()
    }

    async fn active(&self, workspace: &Path) -> Vec<String> {
        self.trust
            .permission_settings(workspace)
            .await
            .expect("settings")
            .packages()
            .active
            .iter()
            .map(|a| a.id().to_owned())
            .collect()
    }

    async fn plugin_servers(&self, workspace: &Path) -> Vec<String> {
        McpConfigSource::new(self.trust.clone(), self.storage.clone(), self.io.clone())
            .servers(workspace)
            .await
            .expect("servers")
            .servers
            .into_iter()
            .filter(|s| s.scope == McpScope::Plugin)
            .map(|s| s.name)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.storage.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=PiArc Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?}");
}

#[tokio::test]
async fn npm_installs_run_the_bundled_npm_without_scripts() {
    // T40-A05: the process is the bundled node running npm-cli.js with --ignore-scripts, and the
    // fixture's postinstall did not run.
    let f = Fixture::new();
    let marker = f.root.join("postinstall-ran");
    let marker_js = marker.display().to_string().replace('\\', "\\\\");
    f.write(
        "pack/package/package.json",
        &serde_json::json!({
            "name": "pi-scripted",
            "version": "1.0.0",
            "scripts": {
                "postinstall": format!("node -e \"require('fs').writeFileSync('{marker_js}', 'ran')\"")
            },
            "pi": { "extensions": ["./ext.ts"] }
        })
        .to_string(),
    );
    f.write("pack/package/ext.ts", "export default () => {};\n");
    let status = std::process::Command::new("tar")
        .args(["-czf", "pi-scripted-1.0.0.tgz", "package"])
        .current_dir(f.root.join("pack"))
        .status()
        .expect("tar");
    assert!(status.success());
    let tarball = f.root.join("pack").join("pi-scripted-1.0.0.tgz");
    let result = f
        .manager
        .install(f.request(
            PackageSourceKind::Npm,
            &tarball.display().to_string(),
            PackageScope::User,
        ))
        .await
        .expect("install");
    assert_eq!(result.package.id, "pi-scripted");
    assert_eq!(result.package.source.version.as_deref(), Some("1.0.0"));
    assert!(
        result
            .package
            .source
            .integrity
            .as_deref()
            .is_some_and(|i| i.starts_with("sha512-")),
        "{:?}",
        result.package.source
    );
    assert!(
        result.notes.iter().any(|n| n.contains("postinstall")),
        "{:?}",
        result.notes
    );
    assert!(!marker.exists(), "the postinstall script ran");
    let specs = f.spawner.specs.lock().expect("specs").clone();
    let npm = specs.last().expect("npm ran");
    assert_eq!(npm.program, node());
    let args: Vec<String> = npm
        .args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert!(args[0].ends_with("npm-cli.js"), "{args:?}");
    assert!(args.contains(&"--ignore-scripts".to_owned()), "{args:?}");
    assert!(args.contains(&"install".to_owned()), "{args:?}");
    let path = npm
        .env
        .iter()
        .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v.clone())
        .expect("PATH");
    assert_eq!(
        std::env::split_paths(&path).next().as_deref(),
        node().parent(),
        "the bundled node comes first on PATH"
    );
    // Installed off: nothing of it applies until it is turned on.
    assert!(!result.package.enabled);
    assert!(f.active(&f.workspace).await.is_empty());
    assert_eq!(
        result.package.components.extensions,
        ["ext.ts"],
        "the pi field's extension is listed"
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one end-to-end story of scopes, switches and audit rows"
)]
async fn scopes_confirmation_and_audit() {
    // T40-A09 (Core) and A10: a user package applies everywhere, a project one only in its
    // workspace; off and uninstalled packages are gone at once; every step is audited.
    let f = Fixture::new();
    let user_dir = f.plugin("src/user-plugin", "user-plugin");
    let project_dir = f.plugin("src/project-plugin", "project-plugin");
    f.manager
        .install(f.request(
            PackageSourceKind::Directory,
            &user_dir.display().to_string(),
            PackageScope::User,
        ))
        .await
        .expect("user install");
    let project = f
        .manager
        .install(f.request(
            PackageSourceKind::Directory,
            &project_dir.display().to_string(),
            PackageScope::Project,
        ))
        .await
        .expect("project install");
    assert_eq!(project.package.scope, Some(PackageScope::Project));

    // Turning on confirms what the dialog listed: here, every item of the user plugin.
    let list = f.manager.list(None).await.expect("list");
    let user = list
        .packages
        .iter()
        .find(|p| p.id == "user-plugin")
        .expect("listed");
    let items: Vec<String> = user.executables.iter().map(|e| e.name.clone()).collect();
    assert_eq!(items.len(), 2, "{items:?}");
    f.manager
        .set_enabled("user-plugin", true, PackageScope::User, None, &items)
        .await
        .expect("on");
    // The project is trusted, then the project plugin is turned on (confirming its items).
    let view = f.trust.view(&f.workspace).await.expect("view");
    f.trust
        .decide(&f.workspace, true, &view.version)
        .await
        .expect("trust");
    let project_items: Vec<String> = project
        .package
        .executables
        .iter()
        .map(|e| e.name.clone())
        .collect();
    f.manager
        .set_enabled(
            "project-plugin",
            true,
            PackageScope::Project,
            Some(&f.workspace),
            &project_items,
        )
        .await
        .expect("project on");
    assert!(
        f.trust.state(&f.workspace).await.is_trusted(),
        "the native confirmation keeps the project trusted"
    );

    assert_eq!(
        f.active(&f.workspace).await,
        ["project-plugin", "user-plugin"]
    );
    assert_eq!(f.active(&f.other).await, ["user-plugin"]);
    assert_eq!(
        f.plugin_servers(&f.workspace).await,
        ["plugin_project-plugin_db", "plugin_user-plugin_db"]
    );
    assert_eq!(f.plugin_servers(&f.other).await, ["plugin_user-plugin_db"]);

    // Off: gone at once.
    f.manager
        .set_enabled("user-plugin", false, PackageScope::User, None, &[])
        .await
        .expect("off");
    assert_eq!(f.active(&f.other).await, Vec::<String>::new());
    assert!(f.plugin_servers(&f.other).await.is_empty());
    // Uninstalled: gone from the workspace, the record and the settings.
    let list = f
        .manager
        .uninstall("project-plugin", Some(&f.workspace))
        .await
        .expect("uninstall");
    assert!(list.packages.iter().all(|p| p.id != "project-plugin"));
    assert_eq!(f.active(&f.workspace).await, Vec::<String>::new());
    assert!(project_dir.exists(), "a directory source is not deleted");

    let actions: Vec<(String, String)> = f
        .audit()
        .await
        .into_iter()
        .rev()
        .map(|d| {
            (
                d["action"].as_str().unwrap_or_default().to_owned(),
                d["id"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        actions,
        [
            ("install".to_owned(), "user-plugin".to_owned()),
            ("install".to_owned(), "project-plugin".to_owned()),
            ("enable".to_owned(), "user-plugin".to_owned()),
            ("enable".to_owned(), "project-plugin".to_owned()),
            ("disable".to_owned(), "user-plugin".to_owned()),
            ("uninstall".to_owned(), "project-plugin".to_owned()),
        ]
    );
    let enable = f
        .audit()
        .await
        .into_iter()
        .find(|d| d["action"] == "enable")
        .expect("row");
    assert_eq!(enable["confirmed"].as_array().map(Vec::len), Some(2));
}

#[tokio::test]
async fn an_untrusted_project_loads_no_project_package_and_trust_confirms_its_items() {
    // T40-A04 (Core): no hook, server or extension of a project package before trust; after
    // trusting, the dialog's listing is confirmed and the package applies.
    let f = Fixture::new();
    let dir = f.plugin("src/p", "proj");
    let installed = f
        .manager
        .install(f.request(
            PackageSourceKind::Directory,
            &dir.display().to_string(),
            PackageScope::Project,
        ))
        .await
        .expect("install");
    assert!(installed.package.executables.iter().all(|e| !e.confirmed));
    // The repository turns it on (as a cloned `.piarc/settings.json` would).
    f.write(
        "工作 区/.piarc/settings.json",
        r#"{"plugins": {"proj": true}}"#,
    );
    assert!(f.active(&f.workspace).await.is_empty());
    assert!(f.plugin_servers(&f.workspace).await.is_empty());
    let view = f.trust.view(&f.workspace).await.expect("view");
    let listed: Vec<&str> = view
        .items
        .iter()
        .filter(|i| i.source == "plugin:proj")
        .map(|i| i.name.as_str())
        .collect();
    assert_eq!(
        listed.len(),
        2,
        "the dialog lists the package's items: {:?}",
        view.items
    );
    f.trust
        .decide(&f.workspace, true, &view.version)
        .await
        .expect("trust");
    assert_eq!(f.active(&f.workspace).await, ["proj"]);
    assert_eq!(f.plugin_servers(&f.workspace).await, ["plugin_proj_db"]);
    let settings = f
        .trust
        .permission_settings(&f.workspace)
        .await
        .expect("settings");
    assert!(
        settings.packages().active[0].hooks().is_some(),
        "the hook runs"
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "install, upstream change, update and confirm in one story"
)]
async fn a_git_update_leaves_new_items_off_until_confirmed() {
    // T40-A03: an update that adds a hook and a server runs neither until confirmed.
    let f = Fixture::new();
    let repo = f.plugin("repo", "gitplug");
    git(&repo, &["init", "--quiet"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "--quiet", "-m", "one"]);
    // The clone directory repeats a local source's whole path under `<pi>/git/local/`: from
    // inside the fixture it would pass the length Git for Windows accepts for a git
    // directory (W3), so the source sits right in the temporary directory.
    let id = crate::sessions::new_session_id().expect("unique id");
    let upstream = std::env::temp_dir().join(format!("pgb-{}", &id[..8]));
    let _cleanup = RemoveOnDrop(upstream.clone());
    let bare = upstream.join("bare.git");
    git(
        &f.root,
        &[
            "clone",
            "--quiet",
            "--bare",
            "repo",
            bare.to_str().expect("utf-8"),
        ],
    );
    // `file:///C:/…` on Windows: `file://C:\…` is no file URL (W3).
    let text = bare.display().to_string().replace('\\', "/");
    let url = if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    };
    let installed = f
        .manager
        .install(f.request(PackageSourceKind::Git, &url, PackageScope::User))
        .await
        .expect("install");
    let first = installed.package.source.commit.clone().expect("commit");
    assert!(
        installed.package.path.contains("pi"),
        "{}",
        installed.package.path
    );
    let all: Vec<String> = installed
        .package
        .executables
        .iter()
        .map(|e| e.name.clone())
        .collect();
    f.manager
        .set_enabled("gitplug", true, PackageScope::User, None, &all)
        .await
        .expect("on");

    // Upstream adds a second hook and a second server.
    f.write(
        "repo/hooks/hooks.json",
        r#"{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo one"}, {"type": "command", "command": "echo two"}]}]}}"#,
    );
    f.write(
        "repo/.mcp.json",
        r#"{"db": {"command": "node", "args": ["server.mjs"]}, "extra": {"command": "node", "args": ["extra.mjs"]}}"#,
    );
    git(&repo, &["commit", "--quiet", "-am", "two"]);
    git(
        &repo,
        &[
            "push",
            "--quiet",
            bare.to_str().expect("utf-8"),
            "HEAD:main",
        ],
    );
    let updated = f.manager.update("gitplug", None).await.expect("update");
    assert_eq!(updated.previous_commit.as_deref(), Some(first.as_str()));
    assert_ne!(
        updated.package.source.commit.as_deref(),
        Some(first.as_str())
    );
    let pending: Vec<&str> = updated
        .package
        .executables
        .iter()
        .filter(|e| !e.confirmed)
        .map(|e| e.name.as_str())
        .collect();
    assert_eq!(pending.len(), 2, "{pending:?}");
    let settings = f
        .trust
        .permission_settings(&f.other)
        .await
        .expect("settings");
    let active = &settings.packages().active[0];
    let hooks = active.hooks().expect("the confirmed hook").to_string();
    assert!(
        hooks.contains("echo one") && !hooks.contains("echo two"),
        "{hooks}"
    );
    assert_eq!(
        active.mcp_servers().keys().cloned().collect::<Vec<_>>(),
        ["plugin_gitplug_db"]
    );
    // Confirmed: both apply.
    let names: Vec<String> = pending.iter().map(|s| (*s).to_owned()).collect();
    f.manager
        .confirm("gitplug", &names, None)
        .await
        .expect("confirm");
    let settings = f
        .trust
        .permission_settings(&f.other)
        .await
        .expect("settings");
    let active = &settings.packages().active[0];
    assert!(
        active
            .hooks()
            .expect("hooks")
            .to_string()
            .contains("echo two")
    );
    assert_eq!(active.mcp_servers().len(), 2);
    assert!(
        updated
            .package
            .executables
            .iter()
            .any(|e| e.kind == PackageExecutableKind::McpServer && e.name.contains("extra")),
    );
    // Uninstalling removes the clone.
    let path = PathBuf::from(&updated.package.path);
    f.manager
        .uninstall("gitplug", None)
        .await
        .expect("uninstall");
    assert!(!path.exists());
}

/// Removes a directory outside the fixture when the test ends, even when it fails.
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A `file://` URL of a local repository, also on Windows (`file:///C:/…`).
#[cfg(unix)]
fn file_url(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

#[cfg(unix)]
#[tokio::test]
async fn thr03_a_cloned_packages_npmrc_cannot_choose_what_npm_runs() {
    // R5: npm installs a git package's dependencies in its clone, before the user confirmed
    // anything, and reads the clone's `.npmrc`; its `git` setting names the program npm runs
    // to fetch a git dependency. A package must not be able to run a program that way.
    let f = Fixture::new();
    let id = crate::sessions::new_session_id().expect("unique id");
    let upstream = std::env::temp_dir().join(format!("pgn-{}", &id[..8]));
    let _cleanup = RemoveOnDrop(upstream.clone());
    std::fs::create_dir_all(&upstream).expect("upstream");
    let marker = upstream.join("npmrc-git-ran");

    // The dependency: any repository npm would fetch with git.
    f.write("dep/package.json", r#"{"name": "dep", "version": "1.0.0"}"#);
    let dep = f.root.join("dep");
    git(&dep, &["init", "--quiet"]);
    git(&dep, &["add", "."]);
    git(&dep, &["commit", "--quiet", "-m", "dep"]);
    let dep_bare = upstream.join("dep.git");
    git(
        &f.root,
        &[
            "clone",
            "--quiet",
            "--bare",
            "dep",
            dep_bare.to_str().expect("utf-8"),
        ],
    );

    // The package: a git dependency and a `.npmrc` that points npm's git at its own script.
    let script = upstream.join("fake-git.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho ran > '{}'\nexit 1\n", marker.display()),
    )
    .expect("script");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let repo = f.plugin("evil", "evilplug");
    std::fs::write(
        repo.join("package.json"),
        serde_json::json!({
            "name": "evilplug",
            "version": "1.0.0",
            "dependencies": { "dep": format!("git+{}", file_url(&dep_bare)) }
        })
        .to_string(),
    )
    .expect("package.json");
    std::fs::write(repo.join(".npmrc"), format!("git={}\n", script.display())).expect("npmrc");
    git(&repo, &["init", "--quiet"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "--quiet", "-m", "one"]);
    let bare = upstream.join("evil.git");
    git(
        &f.root,
        &[
            "clone",
            "--quiet",
            "--bare",
            "evil",
            bare.to_str().expect("utf-8"),
        ],
    );

    let installed = f
        .manager
        .install(f.request(PackageSourceKind::Git, &file_url(&bare), PackageScope::User))
        .await;
    assert!(
        !marker.exists(),
        "npm ran the program the package's .npmrc named"
    );
    // npm fetched the dependency with git as usual, and the checkout is left as fetched.
    let installed = installed.expect("install");
    let clone = PathBuf::from(&installed.package.path);
    assert!(
        clone
            .join("node_modules")
            .join("dep")
            .join("package.json")
            .is_file()
    );
    assert!(
        clone.join(".npmrc").is_file(),
        "the package's .npmrc is back"
    );
}
