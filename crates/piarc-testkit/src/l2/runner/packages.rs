//! T40: installs a scenario's extension packages through Core's public API (`package_install`,
//! `package_set_enabled`), confirming the items the native dialog would list.
use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

use super::{Driver, call};
use crate::l2::package_spec::{PackageScopeSpec, PackageSourceSpec, PackageSpec};

/// Makes `dir` a git repository with one commit of everything in it.
fn commit(dir: &Path) -> Result<(), String> {
    for args in [
        &["init", "--quiet", "--template="][..],
        &["add", "-A"][..],
        &[
            "-c",
            "user.name=PiArc L2",
            "-c",
            "user.email=l2@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "package",
        ][..],
    ] {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .map_err(|e| format!("git: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git {args:?} in {}: {}",
                dir.display(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    Ok(())
}

/// A `file://` URL of `dir`.
fn file_url(dir: &Path) -> String {
    let text = dir.display().to_string().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

impl Driver<'_> {
    pub(super) async fn install_packages(&mut self) -> Result<(), String> {
        let packages: Vec<PackageSpec> = self.spec.packages.clone();
        for package in &packages {
            self.install_package(package).await?;
        }
        Ok(())
    }

    async fn install_package(&mut self, package: &PackageSpec) -> Result<(), String> {
        let root = self
            .env
            .workspace
            .parent()
            .ok_or("the workspace has no parent")?
            .to_owned();
        let dir = root.join(&package.path);
        let (kind, location) = match package.source {
            PackageSourceSpec::Directory => ("directory", dir.display().to_string()),
            PackageSourceSpec::Git => {
                commit(&dir)?;
                ("git", file_url(&dir))
            }
        };
        let scope = match package.scope {
            PackageScopeSpec::User => "user",
            PackageScopeSpec::Project => "project",
        };
        let workspace = self.env.workspace.clone();
        let request = json!({
            "kind": kind,
            "location": location,
            "scope": scope,
            "workspace": workspace.display().to_string(),
        })
        .to_string();
        let installed = call(
            |done| self.core.package_install(&request, done),
            &format!("installing package {}", package.path),
        )
        .await?;
        if !package.enable {
            return Ok(());
        }
        let id = installed["package"]["id"]
            .as_str()
            .ok_or("package_install answered no id")?
            .to_owned();
        let items: Vec<String> = if package.confirm {
            installed["package"]["executables"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["name"].as_str().map(str::to_owned))
                .collect()
        } else {
            Vec::new()
        };
        let ws = workspace.clone();
        call(
            |done| {
                self.core
                    .package_set_enabled(id, true, scope, Some(ws), items, done)
            },
            &format!("turning package {} on", package.path),
        )
        .await
        .map(|_: Value| ())
    }
}

impl Driver<'_> {
    /// `check_commands`: polls Core's command list (prompt lists change after a server's
    /// notification) until it matches, at most 10 s.
    pub(super) async fn check_commands(
        &mut self,
        present: &[String],
        absent: &[String],
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let ws = self.env.workspace.clone();
            let list = call(
                |done| self.core.list_commands(ws, None, done),
                "listing the commands",
            )
            .await?;
            let names: Vec<&str> = list["commands"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["name"].as_str())
                .collect();
            let missing: Vec<&String> = present
                .iter()
                .filter(|n| !names.contains(&n.as_str()))
                .collect();
            let extra: Vec<&String> = absent
                .iter()
                .filter(|n| names.contains(&n.as_str()))
                .collect();
            if missing.is_empty() && extra.is_empty() {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "commands {names:?}: missing {missing:?}, unexpected {extra:?}"
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}
