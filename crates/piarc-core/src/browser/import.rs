//! Chrome sign-in import on Core's side (ADR-0090; design addendum B5.1–B5.4). The main
//! process asks the user (profile, sites, then its native confirmation) and calls here:
//!
//! - [`ChromeImports::profiles`] and [`ChromeImports::sites`] read Chrome's folder and a copy
//!   of a profile's cookies database: names and counts only, no value and no key.
//! - [`ChromeImports::import`] runs after the user confirmed: it reads the key once (the
//!   keychain prompt on macOS), decrypts the chosen sites' cookies, registers every value
//!   with the log redactor, writes the record (`browser_imports`, before the main process
//!   writes the cookies, so a site never holds imported cookies without being marked
//!   sensitive) and one `kind: "browserImport"` audit row with sites and counts. The values go
//!   back to the main process as JSON text in a zeroizing buffer and nowhere else.
//! - [`ChromeImports::forget`] removes a site's record (the main process removed its cookies
//!   from the partition first) and audits it.
//!
//! Imported sites are sensitive for the agent's site cards ([`imported_sites`],
//! `tool_io::policy::site`): every session asks, "always" is never offered, rules and modes
//! do not allow them.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_browser_import::{Importer, KeySource, SystemKey};
use piarc_store::BrowserImport;
use serde::Serialize;
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Error, Result};
use crate::storage::{Storage, now_ms};

/// The audit kind of imports and removals.
pub const AUDIT_KIND: &str = "browserImport";

/// Where Chrome's data and key come from.
#[derive(Clone, Default)]
pub struct ChromeConfig {
    /// Chrome's user data folder; the platform's place under `CoreConfig.home` when absent.
    pub root: Option<PathBuf>,
    /// The key's source; the system (keychain, DPAPI) when absent. Development builds' L4
    /// pass a fixed key.
    pub keys: Option<Arc<dyn KeySource>>,
}

impl ChromeConfig {
    /// Development builds' tests (`createForTests`): Chrome's folder at `root` (a fixture) or
    /// none, and the fixed test key ([`piarc_browser_import::test_key`]) instead of the
    /// keychain or DPAPI, so a test never reads the machine's Chrome or keychain.
    #[must_use]
    pub fn for_tests(root: Option<PathBuf>) -> Self {
        Self {
            root,
            keys: Some(Arc::new(piarc_browser_import::FixedKey(
                piarc_browser_import::test_key(),
            ))),
        }
    }
}

impl std::fmt::Debug for ChromeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChromeConfig")
            .field("root", &self.root)
            .field("fixed_key", &self.keys.is_some())
            .finish()
    }
}

/// The key a workspace's records are stored under: the resolved path as Core shows it, so a
/// session's workspace and the settings window's spelling of it (a link, `/var` for
/// `/private/var`, a verbatim Windows path) name the same records.
#[must_use]
pub fn workspace_key(workspace: &Path) -> String {
    let resolved = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    piarc_fs::display(&resolved)
}

/// The sites of `workspace` with imported sign-ins.
///
/// # Errors
///
/// Storage errors.
pub async fn imported_sites(storage: &Storage, workspace: &Path) -> Result<Vec<String>> {
    let key = workspace_key(workspace);
    let rows = storage.run(move |s| s.browser_imports(&key)).await??;
    Ok(rows.into_iter().map(|r| r.site).collect())
}

/// Whether `host` (a site card's host; a local one may carry `:port`) gets cookies of one of
/// `sites`.
#[must_use]
pub fn is_imported(host: &str, local: bool, sites: &[String]) -> bool {
    let name = if local {
        host.rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
            .map_or(host, |(name, _)| name)
    } else {
        host
    };
    sites
        .iter()
        .any(|site| piarc_browser_import::covered(name, site))
}

fn feature(error: &piarc_browser_import::Error) -> Error {
    Error::feature(&error.to_error_object())
}

/// A writer whose buffer is cleared before it grows and when dropped.
struct ZeroizingWriter(Zeroizing<Vec<u8>>);

impl Write for ZeroizingWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.0.len() + data.len() > self.0.capacity() {
            let mut grown = Zeroizing::new(Vec::with_capacity((self.0.len() + data.len()) * 2));
            grown.extend_from_slice(&self.0);
            self.0 = grown;
        }
        self.0.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// JSON text of `value` in a zeroizing buffer.
fn secret_json(value: &impl Serialize) -> Result<Zeroizing<String>> {
    let mut writer = ZeroizingWriter(Zeroizing::new(Vec::with_capacity(4096)));
    serde_json::to_writer(&mut writer, value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the import: {e}"),
    })?;
    let bytes = std::mem::take(&mut *writer.0);
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Zeroizing::new(text)),
        Err(error) => {
            error.into_bytes().zeroize();
            Err(Error::Internal {
                reason: "the import is not text".into(),
            })
        }
    }
}

/// Chrome imports of one Core.
#[derive(Clone)]
pub struct ChromeImports {
    storage: Storage,
    root: Option<PathBuf>,
    keys: Arc<dyn KeySource>,
}

impl std::fmt::Debug for ChromeImports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChromeImports")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl ChromeImports {
    /// Over Core's storage; Chrome's folder from `config` or the platform's place under
    /// `home`.
    #[must_use]
    pub fn new(storage: Storage, config: &ChromeConfig, home: Option<&Path>) -> Self {
        let root = config
            .root
            .clone()
            .or_else(|| home.and_then(|home| piarc_browser_import::root_for(home, None)));
        Self {
            storage,
            root,
            keys: config.keys.clone().unwrap_or_else(|| Arc::new(SystemKey)),
        }
    }

    fn importer(&self) -> Option<Importer> {
        let root = self.root.clone()?;
        let scratch = self.storage.dirs().cache().join("chrome-import");
        Some(Importer::new(root, scratch, self.keys.clone()))
    }

    async fn blocking<R: Send + 'static>(
        &self,
        job: impl FnOnce(Importer) -> piarc_browser_import::Result<R> + Send + 'static,
    ) -> Result<R> {
        let importer = self
            .importer()
            .ok_or_else(|| feature(&piarc_browser_import::Error::Unsupported))?;
        tokio::task::spawn_blocking(move || job(importer))
            .await
            .map_err(|e| Error::Internal {
                reason: format!("the Chrome import task failed: {e}"),
            })?
            .map_err(|e| feature(&e))
    }

    /// `{ chrome, profiles: [{ id, name }] }`; `chrome` is false when Chrome's folder is not
    /// there (no profile then).
    ///
    /// # Errors
    ///
    /// Errors reading the folder.
    pub async fn profiles(&self) -> Result<Value> {
        match self.blocking(|importer| importer.profiles()).await {
            Ok(profiles) => Ok(json!({ "chrome": true, "profiles": profiles })),
            Err(Error::Feature { details, .. })
                if details
                    .as_deref()
                    .is_some_and(|d| d.contains("noChrome") || d.contains("unsupported")) =>
            {
                Ok(json!({ "chrome": false, "profiles": [] }))
            }
            Err(error) => Err(error),
        }
    }

    /// `{ sites: [{ site, count }] }` of `profile`: no value, no key.
    ///
    /// # Errors
    ///
    /// Profile and database errors (`busy` while Chrome holds the database).
    pub async fn sites(&self, profile: String) -> Result<Value> {
        let now = now_ms() / 1000;
        let sites = self
            .blocking(move |importer| importer.sites(&profile, now))
            .await?;
        Ok(json!({ "sites": sites }))
    }

    /// Imports `sites` of `profile` into `workspace`'s records and answers the cookies with
    /// per-site counts as JSON text: `{ cookies: [...], sites: [{ site, imported, skipped }] }`.
    ///
    /// # Errors
    ///
    /// `invalidParams` for a bad request; profile, database and key errors (the keychain
    /// prompt refused is `permissionDenied`, reason `keychainDenied`).
    pub async fn import(
        &self,
        workspace: &Path,
        profile: String,
        sites: Vec<String>,
    ) -> Result<Zeroizing<String>> {
        let now = now_ms();
        let id = profile.clone();
        let (imported, name) = self
            .blocking(move |importer| {
                let name = importer
                    .profiles()
                    .ok()
                    .and_then(|list| list.into_iter().find(|p| p.id == id))
                    .map_or_else(|| id.clone(), |p| p.name);
                importer
                    .import(&id, &sites, now / 1000)
                    .map(|imported| (imported, name))
            })
            .await?;
        for cookie in &imported.cookies {
            piarc_telemetry::remember_secret(&cookie.value);
        }
        let key = workspace_key(workspace);
        let counts: Vec<(String, u32)> = imported
            .sites
            .iter()
            .filter(|s| s.imported > 0)
            .map(|s| (s.site.clone(), s.imported))
            .collect();
        {
            let (key, counts, name) = (key.clone(), counts.clone(), name.clone());
            self.storage
                .run(move |s| {
                    counts.iter().try_for_each(|(site, count)| {
                        s.put_browser_import(&key, site, *count, &name, now)
                    })
                })
                .await??;
        }
        let audited: Vec<Value> = imported
            .sites
            .iter()
            .map(|s| json!({ "site": s.site, "count": s.imported }))
            .collect();
        self.audit(&key, json!({ "action": "import", "sites": audited }))
            .await;
        secret_json(&imported)
    }

    /// `{ imports: [{ site, count, profile, importedAt }] }` of `workspace`.
    ///
    /// # Errors
    ///
    /// Storage errors.
    pub async fn list(&self, workspace: &Path) -> Result<Value> {
        let key = workspace_key(workspace);
        let rows: Vec<BrowserImport> = self.storage.run(move |s| s.browser_imports(&key)).await??;
        Ok(json!({ "imports": rows }))
    }

    /// Forgets `site` of `workspace`; `{ forgot }`.
    ///
    /// # Errors
    ///
    /// Storage errors.
    pub async fn forget(&self, workspace: &Path, site: String) -> Result<Value> {
        let key = workspace_key(workspace);
        let forgot = {
            let (key, site) = (key.clone(), site.clone());
            self.storage
                .run(move |s| s.remove_browser_import(&key, &site))
                .await??
        };
        if forgot {
            self.audit(
                &key,
                json!({ "action": "forget", "sites": [{ "site": site }] }),
            )
            .await;
        }
        Ok(json!({ "forgot": forgot }))
    }

    /// One audit row; a failure to write is logged, not raised: the change already happened.
    async fn audit(&self, workspace: &str, detail: Value) {
        let row = piarc_store::AuditEvent {
            at: now_ms(),
            kind: AUDIT_KIND.into(),
            session_id: None,
            workspace: Some(workspace.to_owned()),
            detail: detail.to_string(),
        };
        if let Err(error) = self
            .storage
            .run(move |s| s.append_audit(&row))
            .await
            .and_then(|r| r.map_err(Error::from))
        {
            tracing::warn!(target: "piarc_core::browser", "cannot record a browser import audit row: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use piarc_browser_import::cookies::chrome_time;
    use piarc_browser_import::cookies::fixture::{Row, write};
    use piarc_browser_import::crypto::seal;
    use piarc_browser_import::{FixedKey, test_key};
    use serde_json::Value;

    use super::{ChromeConfig, ChromeImports, imported_sites, is_imported};
    use crate::dirs::DataDirs;
    use crate::storage::{Storage, now_ms};

    struct Fixture {
        dir: PathBuf,
        imports: ChromeImports,
        storage: Storage,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const VALUE: &str = "imported-session-value-0123456789";

    fn fixture(tag: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!(
            "piarc-core-chrome-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let root = dir.join("Chrome 用户");
        let profile = root.join("Default").join("Network");
        std::fs::create_dir_all(&profile).expect("profile");
        std::fs::write(
            root.join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}"#,
        )
        .expect("local state");
        let key = test_key();
        let expires = chrome_time(now_ms() / 1000 + 86_400);
        let row = |host: &str, name: &str, value: &str| Row {
            host_key: host.into(),
            name: name.into(),
            encrypted: seal(&key, value, host, 24, [1; 12]),
            path: "/".into(),
            expires_utc: expires,
            secure: true,
            persistent: true,
            ..Row::default()
        };
        write(
            &profile.join("Cookies"),
            24,
            &[
                row(".github.com", "_gh_sess", VALUE),
                row("github.com", "user", "short"),
                row(".example.test", "a", "b"),
            ],
            false,
        )
        .expect("db");
        let dirs = DataDirs::new(dir.join("data"), dir.join("cache")).expect("dirs");
        dirs.create_layout().expect("layout");
        let storage = Storage::open(dirs).expect("storage");
        let imports = ChromeImports::new(
            storage.clone(),
            &ChromeConfig {
                root: Some(root),
                keys: Some(Arc::new(FixedKey(key))),
            },
            None,
        );
        Fixture {
            dir,
            imports,
            storage,
        }
    }

    #[tokio::test]
    async fn thr17_import_redacts_values_and_audits_sites_and_counts_only() {
        let f = fixture("import");
        let workspace = f.dir.join("工作区");
        let profiles = f.imports.profiles().await.expect("profiles");
        assert_eq!(profiles["chrome"], true);
        assert_eq!(profiles["profiles"][0]["name"], "Personal");
        let sites = f.imports.sites("Default".into()).await.expect("sites");
        assert_eq!(sites["sites"][1]["site"], "github.com");
        assert_eq!(sites["sites"][1]["count"], 2);
        assert!(!sites.to_string().contains(VALUE));

        let text = f
            .imports
            .import(&workspace, "Default".into(), vec!["github.com".into()])
            .await
            .expect("import");
        let result: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(result["cookies"][0]["value"], VALUE);
        assert_eq!(result["cookies"][0]["domain"], ".github.com");
        assert_eq!(result["sites"][0]["imported"], 2);

        // The value is now hidden in every log line (THR-17).
        let line = format!("cookie {VALUE} seen");
        assert!(
            !piarc_telemetry::redact::redact(&line).text.contains(VALUE),
            "the redactor knows the value"
        );

        let list = f.imports.list(&workspace).await.expect("list");
        assert_eq!(list["imports"][0]["site"], "github.com");
        assert_eq!(list["imports"][0]["count"], 2);
        assert_eq!(list["imports"][0]["profile"], "Personal");
        assert_eq!(
            imported_sites(&f.storage, &workspace).await.expect("sites"),
            ["github.com"]
        );

        let audit = f
            .storage
            .run(|s| s.audit_events(10))
            .await
            .expect("run")
            .expect("audit");
        let row = audit
            .iter()
            .find(|e| e.kind == "browserImport")
            .expect("audit row");
        let detail: Value = serde_json::from_str(&row.detail).expect("detail");
        assert_eq!(
            detail,
            serde_json::json!({ "action": "import", "sites": [{ "site": "github.com", "count": 2 }] })
        );
        assert!(!row.detail.contains(VALUE));

        let forgot = f
            .imports
            .forget(&workspace, "github.com".into())
            .await
            .expect("forget");
        assert_eq!(forgot["forgot"], true);
        assert!(
            imported_sites(&f.storage, &workspace)
                .await
                .expect("sites")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_missing_chrome_folder_lists_nothing() {
        let f = fixture("missing");
        let imports = ChromeImports::new(
            f.storage.clone(),
            &ChromeConfig {
                root: Some(f.dir.join("no chrome")),
                keys: None,
            },
            None,
        );
        let profiles = imports.profiles().await.expect("profiles");
        assert_eq!(profiles["chrome"], false);
        let error = imports
            .sites("Default".into())
            .await
            .expect_err("no profile");
        assert_eq!(
            error.to_error_object().data.kind,
            piarc_protocol::ErrorKind::NotFound
        );
    }

    #[test]
    fn hosts_of_imported_sites() {
        let sites = ["github.com".to_owned(), "localhost".to_owned()];
        assert!(is_imported("github.com", false, &sites));
        assert!(is_imported("api.github.com", false, &sites));
        assert!(!is_imported("github.io", false, &sites));
        assert!(is_imported("localhost:3000", true, &sites));
        assert!(!is_imported("127.0.0.1:3000", true, &sites));
    }
}
