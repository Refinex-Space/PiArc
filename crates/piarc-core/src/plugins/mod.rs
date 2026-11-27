//! Extension packages on Core's side (architecture section 6.7, T40, ADR-0058): installing,
//! updating, turning on and off, confirming and uninstalling Claude Code plugins and Pi
//! packages, with an audit row for each; the list the settings window shows; and the Pi
//! extension entries the Agent Host loads (`plugins/extensions`).
//!
//! - **Records** are `core.sqlite`'s `packages` (`piarc-store`): source, version, directory and
//!   the executable items the user confirmed. **Declarations** are the settings' `plugins`
//!   key: the user file (user scope) or the workspace's `.piarc/settings.json` (project scope).
//!   `TrustService::permission_settings` attaches the packages in effect to every settings
//!   load (`piarc_config::plugins::active`), so hooks, MCP servers, skills, commands and
//!   subagent definitions all see the same set.
//! - **Installing never runs package code.** npm runs as the bundled `node npm-cli.js` with
//!   [`fetch::NPM_SAFE_ARGS`] (`--ignore-scripts` among them), `PATH` starting with the bundled
//!   Node's directory; git clones are pinned to a commit. A package is installed off; turning
//!   it on takes the user's confirmation of its executable items (the main process shows the
//!   native dialog), and items added later wait for another confirmation.

pub(crate) mod fetch;
mod info;

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_config::plugins::{self as config, Installed};
use piarc_ports::ProcessSpawner;
use piarc_protocol::ErrorKind;
use piarc_protocol::plugins::{
    PackageInstallRequest, PackageInstallResult, PackageKind, PackageScope, PackageSourceKind,
    PackagesList, PluginExtension, PluginsExtensions,
};
use piarc_store::PackageRecord;
use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::storage::{Storage, now_ms};
use crate::tool_io::ToolIo;
use crate::trust::TrustService;
use fetch::failed;

/// The audit kind of package operations.
pub const AUDIT_KIND: &str = "plugin";

/// Installs and manages extension packages. Cheap to clone.
#[derive(Clone)]
pub struct PluginManager {
    storage: Storage,
    trust: TrustService,
    tool_io: ToolIo,
    /// The bundled `node` (npm runs as `node npm-cli.js` next to it).
    node: Option<PathBuf>,
    spawner: Arc<dyn ProcessSpawner>,
    /// The proxy npm uses (`network::Proxy::effective`), `None` for direct.
    proxy: Option<String>,
    /// Held by every install, update and uninstall: one npm operation at a time (ADR-0102).
    npm_lock: Arc<tokio::sync::Mutex<()>>,
}

impl std::fmt::Debug for PluginManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginManager")
            .field("node", &self.node)
            .finish_non_exhaustive()
    }
}

/// The installed records as `piarc-config` takes them.
pub(crate) fn installed(records: &[PackageRecord]) -> Vec<Installed> {
    records
        .iter()
        .map(|r| Installed {
            id: r.id.clone(),
            path: PathBuf::from(&r.path),
            confirmed: r.confirmed.iter().cloned().collect(),
        })
        .collect()
}

fn kind_name(kind: PackageKind) -> &'static str {
    match kind {
        PackageKind::ClaudePlugin => "claudePlugin",
        PackageKind::PiPackage => "piPackage",
    }
}

fn source_name(kind: PackageSourceKind) -> &'static str {
    match kind {
        PackageSourceKind::Directory => "directory",
        PackageSourceKind::Git => "git",
        PackageSourceKind::Npm => "npm",
    }
}

/// The settings pointer of package `id` (`/plugins/<id>`, escaped).
fn pointer(id: &str) -> String {
    format!(
        "/{}/{}",
        config::SETTINGS_KEY,
        id.replace('~', "~0").replace('/', "~1")
    )
}

/// What one install fetched, before the record is written.
struct Fetched {
    path: PathBuf,
    commit: Option<String>,
    version: Option<String>,
    integrity: Option<String>,
    notes: Vec<String>,
    /// The per-package npm prefix (removed again when registering fails).
    prefix: Option<PathBuf>,
}

impl PluginManager {
    /// Over Core's storage, trust and command environment; `node` is the bundled Node and
    /// `spawner` starts npm (tests inject a recording one).
    #[must_use]
    pub fn new(
        storage: Storage,
        trust: TrustService,
        tool_io: ToolIo,
        node: Option<PathBuf>,
        spawner: Arc<dyn ProcessSpawner>,
    ) -> Self {
        Self {
            storage,
            trust,
            tool_io,
            node,
            spawner,
            proxy: None,
            npm_lock: Arc::default(),
        }
    }

    /// The same manager sharing `lock` with the other managers of this Core.
    #[must_use]
    pub fn with_npm_lock(mut self, lock: Arc<tokio::sync::Mutex<()>>) -> Self {
        self.npm_lock = lock;
        self
    }

    /// The same manager with npm going through `proxy` (ADR-0082, ADR-0102).
    #[must_use]
    pub fn with_proxy(mut self, proxy: Option<String>) -> Self {
        self.proxy = proxy;
        self
    }

    fn data(&self) -> PathBuf {
        self.storage.dirs().data().to_owned()
    }

    async fn records(&self) -> Result<Vec<PackageRecord>> {
        self.storage
            .run(|s| s.packages())
            .await?
            .map_err(Error::from)
    }

    async fn record(&self, id: &str) -> Result<PackageRecord> {
        let key = id.to_owned();
        self.storage
            .run(move |s| s.package(&key))
            .await??
            .ok_or_else(|| {
                failed(
                    ErrorKind::NotFound,
                    format!("no package {id:?} is installed"),
                )
            })
    }

    async fn put(&self, record: PackageRecord) -> Result<()> {
        self.storage.run(move |s| s.put_package(&record)).await??;
        Ok(())
    }

    /// Writes one audit row (`kind: "plugin"`); a failure to write is logged, not raised: the
    /// operation already happened.
    async fn audit(&self, workspace: Option<&Path>, detail: Value) {
        let row = piarc_store::AuditEvent {
            at: now_ms(),
            kind: AUDIT_KIND.into(),
            session_id: None,
            workspace: workspace.map(|w| w.display().to_string()),
            detail: detail.to_string(),
        };
        if let Err(error) = self
            .storage
            .run(move |s| s.append_audit(&row))
            .await
            .and_then(|r| r.map_err(Error::from))
        {
            tracing::warn!(target: "piarc_core::plugins", "cannot record a package audit row: {error}");
        }
    }

    /// The environment npm runs in: the command environment with the bundled Node first and,
    /// with a proxy, its variables (npm reads `npm_config_*` before `HTTPS_PROXY`; a proxy in the
    /// user's `.npmrc` still wins, ADR-0058 rule 4).
    async fn npm_env(&self, node: &Path) -> Vec<(OsString, OsString)> {
        let env = self.tool_io.command_environment().await;
        let mut env = fetch::with_path_first(env, node.parent().unwrap_or(node));
        env.push(("npm_config_update_notifier".into(), "false".into()));
        if let Some(proxy) = &self.proxy {
            let ours = crate::network::env_for(Some(proxy));
            env.retain(|(k, _)| {
                let k = k.to_string_lossy();
                !ours
                    .iter()
                    .any(|(o, _)| o.to_string_lossy().eq_ignore_ascii_case(&k))
            });
            env.extend(ours);
            for key in ["npm_config_https_proxy", "npm_config_proxy"] {
                env.push((key.into(), proxy.into()));
            }
            env.push(("npm_config_noproxy".into(), crate::network::NO_PROXY.into()));
        }
        env
    }

    async fn run_npm(&self, cwd: &Path, args: Vec<OsString>) -> Result<()> {
        let node = self.node.clone().ok_or_else(|| {
            failed(
                ErrorKind::NotFound,
                "Core has no bundled Node to run npm with",
            )
        })?;
        let env = self.npm_env(&node).await;
        let out = fetch::npm(&self.spawner, &node, cwd, env, &args).await?;
        if out.code == Some(0) {
            Ok(())
        } else {
            Err(failed(
                ErrorKind::IoError,
                format!("npm failed ({:?}): {}", out.code, out.stderr),
            ))
        }
    }

    fn npm_args(head: &[&str], tail: &[&OsString]) -> Vec<OsString> {
        let mut args: Vec<OsString> = head.iter().map(OsString::from).collect();
        args.extend(tail.iter().map(|a| (*a).clone()));
        args.extend(fetch::NPM_SAFE_ARGS.iter().map(OsString::from));
        args
    }

    async fn git(&self) -> Result<piarc_git::Git> {
        let data = self.data();
        self.tool_io
            .git_runner(&data)
            .await
            .map_err(|e| failed(e.data.kind, e.message))
    }

    /// Installs a package (off) and declares it in `request.scope`.
    ///
    /// # Errors
    ///
    /// The source cannot be fetched or is not a package, a package of that id is installed
    /// already, or the settings cannot be written.
    pub async fn install(&self, request: PackageInstallRequest) -> Result<PackageInstallResult> {
        let _npm = self.npm_lock.lock().await;
        let workspace = scope_workspace(request.scope, request.workspace.as_deref())?;
        let fetched = self.fetch(&request).await;
        let outcome = match fetched {
            Ok(fetched) => self.register(&request, fetched).await,
            Err(error) => Err(error),
        };
        let detail = |result: &str| {
            json!({
                "action": "install",
                "source": source_name(request.kind),
                "location": request.location,
                "scope": request.scope,
                "result": result,
            })
        };
        match outcome {
            Ok((record, notes)) => {
                self.declare(&record.id, request.scope, workspace.as_deref(), Some(false))
                    .await?;
                let mut detail = detail("installed");
                detail["id"] = json!(record.id);
                detail["version"] = json!(record.version);
                detail["commit"] = json!(record.commit);
                self.audit(workspace.as_deref(), detail).await;
                let package = self.info(&record, workspace.as_deref()).await?;
                Ok(PackageInstallResult {
                    package,
                    previous_commit: None,
                    previous_version: None,
                    notes,
                })
            }
            Err(error) => {
                self.audit(workspace.as_deref(), detail(&format!("failed: {error}")))
                    .await;
                Err(error)
            }
        }
    }

    async fn fetch(&self, request: &PackageInstallRequest) -> Result<Fetched> {
        let pi = self.storage.dirs().pi();
        match request.kind {
            PackageSourceKind::Directory => {
                let path = Path::new(&request.location);
                if !path.is_absolute() {
                    return Err(failed(
                        ErrorKind::InvalidParams,
                        "the directory must be an absolute path",
                    ));
                }
                let path = path
                    .canonicalize()
                    .map_err(|e| failed(ErrorKind::NotFound, format!("{}: {e}", path.display())))?;
                Ok(Fetched {
                    path,
                    commit: None,
                    version: None,
                    integrity: None,
                    notes: Vec::new(),
                    prefix: None,
                })
            }
            PackageSourceKind::Git => {
                fetch::check_git_url(&request.location)?;
                let dir = fetch::git_dir(&pi, &request.location)?;
                if dir.exists() {
                    return Err(failed(
                        ErrorKind::InvalidParams,
                        format!(
                            "{} exists already: uninstall that package first",
                            dir.display()
                        ),
                    ));
                }
                if let Some(parent) = dir.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        failed(ErrorKind::IoError, format!("{}: {e}", parent.display()))
                    })?;
                }
                let git = self.git().await?;
                let commit = piarc_git::package::clone_pinned(&git, &request.location, &dir)
                    .await
                    .map_err(|e| failed(ErrorKind::IoError, e.to_string()))?;
                let notes = match self.install_dependencies(&dir).await {
                    Ok(notes) => notes,
                    Err(error) => {
                        let _ = std::fs::remove_dir_all(&dir);
                        return Err(error);
                    }
                };
                Ok(Fetched {
                    path: dir,
                    commit: Some(commit),
                    version: None,
                    integrity: None,
                    notes,
                    prefix: None,
                })
            }
            PackageSourceKind::Npm => self.fetch_npm(&request.location).await,
        }
    }

    /// A clone's dependencies, through the bundled npm without scripts and without the
    /// package's own npm settings.
    async fn install_dependencies(&self, dir: &Path) -> Result<Vec<String>> {
        let mut notes = scripts_note(dir);
        if fetch::has_dependencies(dir) {
            // npm reads the clone's `.npmrc` as project settings: its `git` names the program
            // npm runs for a git dependency, `cache` and `prefix` where it writes, before the
            // user confirmed anything (R5, THR-03). It is set aside while npm runs.
            let hidden = fetch::HiddenNpmrc::set_aside(dir)?;
            let installed = self
                .run_npm(dir, Self::npm_args(&["install", "--omit=dev"], &[]))
                .await;
            hidden.restore()?;
            installed?;
            notes.push("dependencies installed without their install scripts".to_owned());
        }
        Ok(notes)
    }

    /// Installs `spec` into a prefix of its own (`<pi>/npm/pkgs/<key>`); refuses an npm name
    /// that is installed already, leaving that installation as it is.
    async fn fetch_npm(&self, spec: &str) -> Result<Fetched> {
        fetch::check_npm_spec(spec)?;
        let pi = self.storage.dirs().pi();
        let (staging, name) = self.stage_npm(spec).await?;
        let prefix = fetch::pkgs_root(&pi)?.join(fetch::prefix_key(&name));
        if prefix.exists() || self.npm_installed(&name).await? {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(failed(
                ErrorKind::InvalidParams,
                format!("{name} is installed already: update or uninstall it"),
            ));
        }
        std::fs::rename(&staging, &prefix).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            failed(ErrorKind::IoError, format!("{}: {e}", prefix.display()))
        })?;
        let path = npm_package_dir(&prefix, &name);
        let (version, integrity) = fetch::npm_lock_entry(&prefix, &name);
        Ok(Fetched {
            notes: scripts_note(&path),
            path,
            commit: None,
            version,
            integrity,
            prefix: Some(prefix),
        })
    }

    /// Runs `npm install <spec>` in a fresh staging prefix; answers the prefix and the one
    /// package it installed (the staging prefix is gone when this fails).
    async fn stage_npm(&self, spec: &str) -> Result<(PathBuf, String)> {
        let staging = fetch::staging_prefix(&self.storage.dirs().pi())?;
        let spec_arg = OsString::from(spec);
        let prefix_arg = staging.clone().into_os_string();
        let installed = self
            .run_npm(
                &staging,
                Self::npm_args(
                    &["install"],
                    &[&spec_arg, &OsString::from("--prefix"), &prefix_arg],
                ),
            )
            .await
            .and_then(|()| {
                fetch::prefix_dependency(&staging).ok_or_else(|| {
                    failed(
                        ErrorKind::IoError,
                        format!("npm did not install exactly one package for {spec:?}"),
                    )
                })
            });
        match installed {
            Ok(name) => Ok((staging, name)),
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(error)
            }
        }
    }

    /// The npm name of an npm record: the only dependency of its prefix, or its directory in the
    /// shared prefix of packages installed before ADR-0102.
    fn npm_name_of(&self, record: &PackageRecord) -> Option<String> {
        let pi = self.storage.dirs().pi();
        let path = Path::new(&record.path);
        match fetch::prefix_of(&pi, path) {
            Some(prefix) => fetch::prefix_dependency(&prefix),
            None => fetch::shared_prefix_name(&pi, path),
        }
    }

    async fn npm_installed(&self, name: &str) -> Result<bool> {
        Ok(self
            .records()
            .await?
            .iter()
            .any(|r| r.source_kind == "npm" && self.npm_name_of(r).as_deref() == Some(name)))
    }

    /// Reads the fetched package and writes its record (no item confirmed).
    async fn register(
        &self,
        request: &PackageInstallRequest,
        fetched: Fetched,
    ) -> Result<(PackageRecord, Vec<String>)> {
        let data = self.data();
        let path = fetched.path.clone();
        let manifest = tokio::task::spawn_blocking(move || {
            // The id is not known yet: read with a placeholder data directory.
            config::read(&path, &data.join("plugins").join("data"))
        })
        .await
        .map_err(|e| Error::Internal {
            reason: e.to_string(),
        })?;
        let manifest = match manifest {
            Ok(manifest) => manifest,
            Err(reason) => {
                self.discard(request.kind, &fetched);
                return Err(failed(ErrorKind::InvalidParams, reason));
            }
        };
        let records = self.records().await?;
        let data = self.data();
        let conflict = if records.iter().any(|r| r.id == manifest.id) {
            Some(format!(
                "a package named {:?} is installed already",
                manifest.id
            ))
        } else {
            let own = config::data_dir(&data, &manifest.id);
            records
                .iter()
                .find(|r| config::data_dir(&data, &r.id) == own)
                .map(|r| {
                    format!(
                        "{:?} would share its data directory with the installed {:?}",
                        manifest.id, r.id
                    )
                })
        };
        if let Some(reason) = conflict {
            self.discard(request.kind, &fetched);
            return Err(failed(ErrorKind::InvalidParams, reason));
        }
        let now = now_ms();
        let record = PackageRecord {
            id: manifest.id.clone(),
            kind: kind_name(manifest.kind).to_owned(),
            source_kind: source_name(request.kind).to_owned(),
            location: request.location.clone(),
            path: manifest.root.display().to_string(),
            commit: fetched.commit,
            version: fetched.version.or(manifest.version),
            integrity: fetched.integrity,
            confirmed: Vec::new(),
            installed_at: now,
            updated_at: now,
        };
        self.put(record.clone()).await?;
        Ok((record, fetched.notes))
    }

    /// Removes what a failed install fetched: a clone or an npm prefix, never a directory
    /// source.
    fn discard(&self, kind: PackageSourceKind, fetched: &Fetched) {
        match (kind, &fetched.prefix) {
            (PackageSourceKind::Git, _) => {
                let _ = std::fs::remove_dir_all(&fetched.path);
            }
            (PackageSourceKind::Npm, Some(prefix)) => {
                let _ = fetch::remove_prefix(&self.storage.dirs().pi(), prefix);
            }
            _ => {}
        }
    }

    /// Writes `plugins.<id>` in the scope's settings file (`None` removes it).
    async fn declare(
        &self,
        id: &str,
        scope: PackageScope,
        workspace: Option<&Path>,
        value: Option<bool>,
    ) -> Result<()> {
        let dirs = self.storage.dirs().clone();
        let pointer = pointer(id);
        let workspace = workspace.map(Path::to_owned);
        tokio::task::spawn_blocking(move || match (scope, workspace) {
            (PackageScope::Project, Some(workspace)) => piarc_config::write_value(
                &dirs.layers(&workspace),
                piarc_config::ids::PROJECT,
                &pointer,
                value.map(Value::Bool),
            )
            .map(drop)
            .map_err(Error::from),
            (PackageScope::Project, None) => Err(failed(
                ErrorKind::InvalidParams,
                "the project scope needs a workspace",
            )),
            (PackageScope::User, _) => crate::client_settings::write_user_value(
                dirs.data(),
                dirs.managed(),
                &pointer,
                value.map(Value::Bool),
            ),
        })
        .await
        .map_err(|e| Error::Internal {
            reason: e.to_string(),
        })?
    }

    /// Turns package `id` on or off in `scope`. Turning on confirms `confirm` (the items the
    /// user's confirmation listed, intersected with the package's current ones).
    ///
    /// # Errors
    ///
    /// No such package, or the settings cannot be written.
    pub async fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        scope: PackageScope,
        workspace: Option<&Path>,
        confirm: &[String],
    ) -> Result<PackagesList> {
        let workspace = scope_workspace(scope, workspace.and_then(Path::to_str))?;
        let mut record = self.record(id).await?;
        let mut confirmed = Vec::new();
        if enabled {
            confirmed = self.add_confirmed(&mut record, confirm).await?;
        }
        self.declare(id, scope, workspace.as_deref(), Some(enabled))
            .await?;
        if enabled
            && scope == PackageScope::Project
            && let Some(workspace) = workspace.as_deref()
        {
            // The user confirmed it natively: the new project item does not need the trust
            // dialog again (only extends an existing trust decision).
            let item = piarc_config::Item {
                category: piarc_config::Category::Plugin,
                source: ".piarc/settings.json".to_owned(),
                name: id.to_owned(),
            };
            self.trust.confirm_items(workspace, vec![item]).await?;
        }
        self.audit(
            workspace.as_deref(),
            json!({
                "action": if enabled { "enable" } else { "disable" },
                "id": id,
                "scope": scope,
                "confirmed": confirmed,
            }),
        )
        .await;
        self.list(workspace.as_deref()).await
    }

    /// Adds `confirm` ∩ the package's current executable items to its record; returns them.
    async fn add_confirmed(
        &self,
        record: &mut PackageRecord,
        confirm: &[String],
    ) -> Result<Vec<String>> {
        let current: BTreeSet<String> = self
            .manifest(record)
            .await
            .map(|m| m.executables().into_iter().map(|e| e.name).collect())
            .unwrap_or_default();
        let added: Vec<String> = confirm
            .iter()
            .filter(|c| current.contains(*c) && !record.confirmed.contains(c))
            .cloned()
            .collect();
        if !added.is_empty() {
            record.confirmed.extend(added.iter().cloned());
            record.confirmed.sort();
            record.confirmed.dedup();
            record.updated_at = now_ms();
            self.put(record.clone()).await?;
        }
        Ok(added)
    }

    /// Confirms executable items of package `id` (after an update or a change added them).
    ///
    /// # Errors
    ///
    /// No such package, or the database failed.
    pub async fn confirm(
        &self,
        id: &str,
        items: &[String],
        workspace: Option<&Path>,
    ) -> Result<PackagesList> {
        let mut record = self.record(id).await?;
        let added = self.add_confirmed(&mut record, items).await?;
        self.audit(
            workspace,
            json!({ "action": "confirm", "id": id, "confirmed": added }),
        )
        .await;
        self.list(workspace).await
    }

    /// Fetches the newest version of package `id` (git: the remote's default branch; npm: its
    /// spec again; a directory: read again). New executable items stay off until confirmed.
    ///
    /// # Errors
    ///
    /// No such package, or fetching failed (the previous version stays).
    pub async fn update(&self, id: &str, workspace: Option<&Path>) -> Result<PackageInstallResult> {
        let _npm = self.npm_lock.lock().await;
        let mut record = self.record(id).await?;
        let previous_commit = record.commit.clone();
        let previous_version = record.version.clone();
        let result = self.refetch(&mut record).await;
        let detail = |result: String| json!({ "action": "update", "id": id, "from": previous_commit, "result": result });
        match result {
            Ok(notes) => {
                record.updated_at = now_ms();
                self.put(record.clone()).await?;
                let mut detail = detail("updated".into());
                detail["to"] = json!(record.commit);
                detail["version"] = json!(record.version);
                self.audit(workspace, detail).await;
                Ok(PackageInstallResult {
                    package: self.info(&record, workspace).await?,
                    previous_commit,
                    previous_version,
                    notes,
                })
            }
            Err(error) => {
                self.audit(workspace, detail(format!("failed: {error}")))
                    .await;
                Err(error)
            }
        }
    }

    async fn refetch(&self, record: &mut PackageRecord) -> Result<Vec<String>> {
        let path = PathBuf::from(&record.path);
        match record.source_kind.as_str() {
            "git" => {
                let git = self.git().await?;
                let (_, commit) = piarc_git::package::update_pinned(&git, &path)
                    .await
                    .map_err(|e| failed(ErrorKind::IoError, e.to_string()))?;
                record.commit = Some(commit);
                let notes = self.install_dependencies(&path).await?;
                record.version = self.manifest(record).await.ok().and_then(|m| m.version);
                Ok(notes)
            }
            "npm" => self.refetch_npm(record).await,
            _ => {
                record.version = self.manifest(record).await.ok().and_then(|m| m.version);
                Ok(Vec::new())
            }
        }
    }

    /// Uninstalls package `id`: its declarations in the user settings and in `workspace`'s, its
    /// record, its clone or npm install (a directory source stays) and its data directory.
    ///
    /// # Errors
    ///
    /// No such package, or the settings or the database failed.
    pub async fn uninstall(&self, id: &str, workspace: Option<&Path>) -> Result<PackagesList> {
        let _npm = self.npm_lock.lock().await;
        let record = self.record(id).await?;
        self.declare(id, PackageScope::User, None, None).await?;
        if let Some(workspace) = workspace {
            self.declare(id, PackageScope::Project, Some(workspace), None)
                .await?;
        }
        let path = PathBuf::from(&record.path);
        let mut result = "uninstalled".to_owned();
        match record.source_kind.as_str() {
            "git" => {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    result = format!("uninstalled; the clone could not be removed: {e}");
                }
            }
            "npm" => {
                if let Err(e) = self.remove_npm(&record).await {
                    result = format!("uninstalled; npm could not remove it: {e}");
                }
            }
            _ => {}
        }
        let _ = std::fs::remove_dir_all(config::data_dir(&self.data(), id));
        let key = id.to_owned();
        self.storage.run(move |s| s.remove_package(&key)).await??;
        self.audit(
            workspace,
            json!({ "action": "uninstall", "id": id, "result": result }),
        )
        .await;
        self.list(workspace).await
    }

    /// An npm package's newest version for its spec, installed beside the current one and
    /// swapped in once it reads as the same package; the old files go only after that.
    async fn refetch_npm(&self, record: &mut PackageRecord) -> Result<Vec<String>> {
        let pi = self.storage.dirs().pi();
        let name = self.npm_name_of(record).ok_or_else(|| {
            failed(
                ErrorKind::NotFound,
                format!("the npm files of {:?} are missing", record.id),
            )
        })?;
        let (staging, installed) = self.stage_npm(&record.location).await?;
        if installed != name {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(failed(
                ErrorKind::InvalidParams,
                format!("{:?} now installs {installed}, not {name}", record.location),
            ));
        }
        let old_path = PathBuf::from(&record.path);
        let prefix = fetch::pkgs_root(&pi)?.join(fetch::prefix_key(&name));
        let aside = prefix.with_file_name(format!(".previous-{}", fetch::prefix_key(&name)));
        let had = prefix.exists();
        if had {
            let _ = std::fs::remove_dir_all(&aside);
            std::fs::rename(&prefix, &aside)
                .map_err(|e| failed(ErrorKind::IoError, format!("{}: {e}", prefix.display())))?;
        }
        let restore = |error: Error| {
            let _ = std::fs::remove_dir_all(&prefix);
            if had {
                let _ = std::fs::rename(&aside, &prefix);
            }
            error
        };
        std::fs::rename(&staging, &prefix).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            restore(failed(
                ErrorKind::IoError,
                format!("{}: {e}", prefix.display()),
            ))
        })?;
        let path = npm_package_dir(&prefix, &name);
        let previous = std::mem::replace(&mut record.path, path.display().to_string());
        match self.manifest(record).await {
            Ok(manifest) if manifest.id == record.id => {}
            other => {
                record.path = previous;
                let reason = match other {
                    Ok(m) => format!("the new version is {:?}, not {:?}", m.id, record.id),
                    Err(reason) => reason,
                };
                return Err(restore(failed(ErrorKind::InvalidParams, reason)));
            }
        }
        let (version, integrity) = fetch::npm_lock_entry(&prefix, &name);
        record.version = version;
        record.integrity = integrity;
        if had {
            let _ = std::fs::remove_dir_all(&aside);
        } else if fetch::shared_prefix_name(&pi, &old_path).is_some() {
            // Installed before ADR-0102: it moved to a prefix of its own.
            let _ = self.uninstall_shared(&name).await;
        }
        Ok(scripts_note(&path))
    }

    /// Removes an npm record's files: its prefix, or its entry in the shared prefix.
    async fn remove_npm(&self, record: &PackageRecord) -> Result<()> {
        let pi = self.storage.dirs().pi();
        let path = Path::new(&record.path);
        if let Some(prefix) = fetch::prefix_of(&pi, path) {
            return fetch::remove_prefix(&pi, &prefix);
        }
        let name = fetch::shared_prefix_name(&pi, path).ok_or_else(|| {
            failed(
                ErrorKind::NotFound,
                format!("{} is not inside PiArc's npm directory", path.display()),
            )
        })?;
        self.uninstall_shared(&name).await
    }

    async fn uninstall_shared(&self, name: &str) -> Result<()> {
        let root = fetch::npm_root(&self.storage.dirs().pi())?;
        let prefix = root.clone().into_os_string();
        let name = OsString::from(name);
        self.run_npm(
            &root,
            Self::npm_args(
                &["uninstall"],
                &[&name, &OsString::from("--prefix"), &prefix],
            ),
        )
        .await
    }

    async fn manifest(
        &self,
        record: &PackageRecord,
    ) -> std::result::Result<config::Manifest, String> {
        let path = PathBuf::from(&record.path);
        let data = config::data_dir(&self.data(), &record.id);
        tokio::task::spawn_blocking(move || config::read(&path, &data))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// `plugins/extensions`: the confirmed Pi extension entries in effect for `workspace`.
///
/// # Errors
///
/// The settings or the trust lookup failed.
pub(crate) async fn extensions(
    trust: &TrustService,
    workspace: &Path,
) -> Result<PluginsExtensions> {
    let settings = trust.permission_settings(workspace).await?;
    let extensions = settings
        .packages()
        .active
        .iter()
        .flat_map(|a| {
            a.extensions().into_iter().map(|p| PluginExtension {
                package: a.id().to_owned(),
                path: p.display().to_string(),
            })
        })
        .collect();
    Ok(PluginsExtensions { extensions })
}

/// `<prefix>/node_modules/<name>` (a scoped name is two directories).
fn npm_package_dir(prefix: &Path, name: &str) -> PathBuf {
    name.split('/')
        .fold(prefix.join("node_modules"), |dir, part| dir.join(part))
}

/// The note about install scripts a package declares.
fn scripts_note(dir: &Path) -> Vec<String> {
    let scripts = fetch::declared_scripts(dir);
    if scripts.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "declares install scripts ({}); PiArc never runs them, so parts that need them may not work",
            scripts.join(", ")
        )]
    }
}

/// The workspace of a scope: required and absolute for the project scope.
fn scope_workspace(scope: PackageScope, workspace: Option<&str>) -> Result<Option<PathBuf>> {
    match (scope, workspace) {
        (_, Some(w)) => {
            let path = Path::new(w);
            if !path.is_absolute() {
                return Err(failed(
                    ErrorKind::InvalidParams,
                    "the workspace must be an absolute path",
                ));
            }
            Ok(Some(piarc_git::canonical(path)?))
        }
        (PackageScope::Project, None) => Err(failed(
            ErrorKind::InvalidParams,
            "the project scope needs a workspace",
        )),
        (PackageScope::User, None) => Ok(None),
    }
}

#[cfg(test)]
mod tests;
