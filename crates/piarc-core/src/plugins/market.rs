//! Installing a Pi package the market lists (ADR-0102): a structured request (an npm name and an
//! exact version), never a spec from the page. npm runs against the market's registry only
//! (`npm_config_registry`, the user's `.npmrc` out of the way), with `--save-exact`, the safe
//! arguments and the user's proxy; the result must be exactly what the catalog described or it
//! is removed again: the requested name and version, the registry's integrity value, every
//! locked package a tarball of that registry with an integrity value, and a Pi package whose id
//! is its npm name.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use piarc_protocol::ErrorKind;
use piarc_protocol::plugins::{
    PackageInstallRequest, PackageInstallResult, PackageScope, PackageSourceKind,
};
use serde_json::{Value, json};

use super::{Fetched, PluginManager, fetch, npm_package_dir, scope_workspace, scripts_note};
use crate::error::Result;
use fetch::failed;

/// What the market asks to install.
#[derive(Debug, Clone)]
pub(crate) struct MarketSpec {
    pub name: String,
    pub version: String,
    /// `dist.integrity` of that version on the registry (`sha512-…`).
    pub integrity: String,
    /// The registry's base URL (no trailing slash).
    pub registry: String,
    /// A CA npm must also trust (development builds' local registry only).
    pub ca_file: Option<PathBuf>,
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// Why the staged install is not what the catalog described, if it is not.
fn check_staged(prefix: &Path, spec: &MarketSpec) -> Option<String> {
    if fetch::prefix_dependency(prefix).as_deref() != Some(spec.name.as_str()) {
        return Some(format!("npm did not install exactly {}", spec.name));
    }
    let manifest = read_json(&npm_package_dir(prefix, &spec.name).join("package.json"))?;
    let field = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    if field("name") != spec.name || field("version") != spec.version {
        return Some(format!(
            "npm installed {}@{}, not {}@{}",
            field("name"),
            field("version"),
            spec.name,
            spec.version
        ));
    }
    let lock = read_json(&prefix.join("package-lock.json"))
        .ok_or("npm wrote no lock file")
        .ok()?;
    let packages = lock.get("packages").and_then(Value::as_object);
    let Some(packages) = packages else {
        return Some("npm's lock file lists no packages".into());
    };
    let own = packages.get(&format!("node_modules/{}", spec.name));
    let integrity = own.and_then(|e| e.get("integrity")).and_then(Value::as_str);
    if integrity != Some(spec.integrity.as_str()) {
        return Some(format!(
            "the integrity of {} differs from the registry's",
            spec.name
        ));
    }
    let registry = format!("{}/", spec.registry);
    for (path, entry) in packages {
        if path.is_empty() || entry.get("inBundle").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let resolved = entry
            .get("resolved")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let has_integrity = entry
            .get("integrity")
            .and_then(Value::as_str)
            .is_some_and(|i| !i.is_empty());
        if !resolved.starts_with(&registry) || !has_integrity {
            return Some(format!(
                "{path} does not come from the registry ({})",
                crate::market::npm::clean(resolved, 200, false)
            ));
        }
    }
    None
}

impl PluginManager {
    /// Installs `spec` (off) and declares it in `scope`.
    ///
    /// # Errors
    ///
    /// The name is installed already, npm failed, the result is not what the catalog
    /// described (nothing stays), or the settings cannot be written.
    pub(crate) async fn install_market(
        &self,
        spec: MarketSpec,
        scope: PackageScope,
        workspace: Option<&str>,
    ) -> Result<PackageInstallResult> {
        let _npm = self.npm_lock.lock().await;
        let root = scope_workspace(scope, workspace)?;
        let request = PackageInstallRequest {
            kind: PackageSourceKind::Npm,
            // Updates install the newest version of this name.
            location: spec.name.clone(),
            scope,
            workspace: workspace.map(str::to_owned),
        };
        let fetched = self.fetch_market(&spec).await;
        let host = crate::market::net::host_of(&spec.registry);
        let origin = json!({ "origin": "market", "registry": host, "requested": spec.version });
        self.finish_install(&request, root, fetched, Some(origin))
            .await
    }

    async fn fetch_market(&self, spec: &MarketSpec) -> Result<Fetched> {
        if self.npm_installed(&spec.name).await?
            || self.records().await?.iter().any(|r| r.id == spec.name)
        {
            return Err(failed(
                ErrorKind::InvalidParams,
                format!("{} is installed already: update or uninstall it", spec.name),
            ));
        }
        let pi = self.storage.dirs().pi();
        let staging = fetch::staging_prefix(&pi)?;
        let installed = self.npm_market(&staging, spec).await;
        let problem = match installed {
            Ok(()) => check_staged(&staging, spec),
            Err(error) => Some(error.to_string()),
        };
        if let Some(problem) = problem {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(failed(ErrorKind::InvalidParams, problem));
        }
        let prefix = fetch::pkgs_root(&pi)?.join(fetch::prefix_key(&spec.name));
        if prefix.exists() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(failed(
                ErrorKind::InvalidParams,
                format!("{} is installed already", spec.name),
            ));
        }
        std::fs::rename(&staging, &prefix).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            failed(ErrorKind::IoError, format!("{}: {e}", prefix.display()))
        })?;
        let path = npm_package_dir(&prefix, &spec.name);
        Ok(Fetched {
            notes: scripts_note(&path),
            path,
            commit: None,
            version: Some(spec.version.clone()),
            integrity: Some(spec.integrity.clone()),
            prefix: Some(prefix),
            expect: Some(spec.name.clone()),
        })
    }

    /// `npm install <name>@<version>` in `prefix` against the market's registry only.
    async fn npm_market(&self, prefix: &Path, spec: &MarketSpec) -> Result<()> {
        // npm refuses one file as both its user and its global configuration.
        let npm_dir = self.storage.dirs().pi().join("npm");
        let (user, global) = (
            npm_dir.join("market.npmrc"),
            npm_dir.join("market-global.npmrc"),
        );
        for file in [&user, &global] {
            std::fs::write(file, "")
                .map_err(|e| failed(ErrorKind::IoError, format!("{}: {e}", file.display())))?;
        }
        let mut extra: Vec<(OsString, OsString)> = vec![
            (
                "npm_config_registry".into(),
                format!("{}/", spec.registry).into(),
            ),
            ("npm_config_userconfig".into(), user.into()),
            ("npm_config_globalconfig".into(), global.into()),
        ];
        if let Some(ca) = &spec.ca_file {
            extra.push(("NODE_EXTRA_CA_CERTS".into(), ca.clone().into()));
        }
        let target = OsString::from(format!("{}@{}", spec.name, spec.version));
        let prefix_arg = prefix.as_os_str().to_owned();
        self.run_npm_with(
            prefix,
            Self::npm_args(
                &["install"],
                &[
                    &target,
                    &OsString::from("--save-exact"),
                    &OsString::from("--prefix"),
                    &prefix_arg,
                ],
            ),
            extra,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{MarketSpec, check_staged};

    fn staged(lock: &serde_json::Value, version: &str) -> (std::path::PathBuf, MarketSpec) {
        let dir = std::env::temp_dir().join(format!(
            "piarc market staged 测试 {}",
            crate::sessions::new_session_id().expect("id")
        ));
        let package = dir.join("node_modules").join("pi-x");
        std::fs::create_dir_all(&package).expect("dir");
        std::fs::write(
            dir.join("package.json"),
            json!({ "dependencies": { "pi-x": "1.0.0" } }).to_string(),
        )
        .expect("stub");
        std::fs::write(
            package.join("package.json"),
            json!({ "name": "pi-x", "version": version }).to_string(),
        )
        .expect("manifest");
        std::fs::write(dir.join("package-lock.json"), lock.to_string()).expect("lock");
        let spec = MarketSpec {
            name: "pi-x".into(),
            version: "1.0.0".into(),
            integrity: "sha512-good".into(),
            registry: "https://registry.npmjs.org".into(),
            ca_file: None,
        };
        (dir, spec)
    }

    fn lock(own: &str, dep_resolved: &str) -> serde_json::Value {
        json!({ "packages": {
            "": { "dependencies": { "pi-x": "1.0.0" } },
            "node_modules/pi-x": {
                "resolved": "https://registry.npmjs.org/pi-x/-/pi-x-1.0.0.tgz",
                "integrity": own
            },
            "node_modules/dep": { "resolved": dep_resolved, "integrity": "sha512-d" },
            "node_modules/pi-x/node_modules/bundled": { "inBundle": true }
        }})
    }

    #[test]
    fn the_staged_install_must_be_what_the_catalog_described() {
        let good = "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz";
        let (dir, spec) = staged(&lock("sha512-good", good), "1.0.0");
        assert_eq!(check_staged(&dir, &spec), None);
        for (lock, version, why) in [
            (lock("sha512-other", good), "1.0.0", "integrity"),
            (
                lock("sha512-good", "git+ssh://git@github.com/e/dep.git"),
                "1.0.0",
                "registry",
            ),
            (
                lock(
                    "sha512-good",
                    "https://registry.npmjs.org.evil.test/dep.tgz",
                ),
                "1.0.0",
                "registry",
            ),
            (lock("sha512-good", good), "1.0.1", "1.0.1"),
        ] {
            let (dir, spec) = staged(&lock, version);
            let problem = check_staged(&dir, &spec).expect("refused");
            assert!(problem.contains(why), "{why}: {problem}");
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
