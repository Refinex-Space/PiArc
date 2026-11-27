//! What the settings window shows about installed packages.

use std::path::{Path, PathBuf};

use piarc_config::plugins as config;
use piarc_protocol::plugins::{
    PackageComponents, PackageExecutable, PackageInfo, PackageKind, PackageScope, PackageSource,
    PackageSourceKind, PackagesList,
};
use piarc_store::PackageRecord;
use serde_json::Value;

use super::PluginManager;
use crate::error::Result;

/// Declarations and the packages in effect, for one workspace or for the user only.
struct View {
    declarations: Vec<(String, bool, PackageScope)>,
    active: Vec<String>,
    missing: Vec<String>,
}

fn source_kind(name: &str) -> PackageSourceKind {
    match name {
        "git" => PackageSourceKind::Git,
        "npm" => PackageSourceKind::Npm,
        _ => PackageSourceKind::Directory,
    }
}

impl PluginManager {
    async fn view(&self, workspace: Option<&Path>) -> Result<View> {
        match workspace {
            Some(workspace) => {
                let settings = self.trust.permission_settings(workspace).await?;
                Ok(View {
                    declarations: config::listed(&settings),
                    active: settings
                        .packages()
                        .active
                        .iter()
                        .map(|a| a.id().to_owned())
                        .collect(),
                    missing: settings.packages().missing.clone(),
                })
            }
            None => {
                let user = crate::client_settings::read(&self.data()).unwrap_or(Value::Null);
                let declarations: Vec<(String, bool, PackageScope)> = user
                    .get(config::SETTINGS_KEY)
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .map(|(id, on)| (id.clone(), on.as_bool() == Some(true), PackageScope::User))
                    .collect();
                let records = self.records().await?;
                let active = declarations
                    .iter()
                    .filter(|(id, on, _)| *on && records.iter().any(|r| &r.id == id))
                    .map(|(id, _, _)| id.clone())
                    .collect();
                let missing = declarations
                    .iter()
                    .filter(|(id, on, _)| *on && !records.iter().any(|r| &r.id == id))
                    .map(|(id, _, _)| id.clone())
                    .collect();
                Ok(View {
                    declarations,
                    active,
                    missing,
                })
            }
        }
    }

    /// Every installed package as `workspace` (or, without one, the user settings) sees it.
    ///
    /// # Errors
    ///
    /// The settings or the database failed.
    pub async fn list(&self, workspace: Option<&Path>) -> Result<PackagesList> {
        let view = self.view(workspace).await?;
        let records = self.records().await?;
        let mut packages = Vec::with_capacity(records.len());
        for record in &records {
            packages.push(self.describe(record, &view).await);
        }
        Ok(PackagesList {
            packages,
            missing: view.missing,
        })
    }

    /// One package as `workspace` sees it.
    pub(crate) async fn info(
        &self,
        record: &PackageRecord,
        workspace: Option<&Path>,
    ) -> Result<PackageInfo> {
        let view = self.view(workspace).await?;
        Ok(self.describe(record, &view).await)
    }

    async fn describe(&self, record: &PackageRecord, view: &View) -> PackageInfo {
        let declared = view.declarations.iter().find(|(id, _, _)| *id == record.id);
        let mut info = PackageInfo {
            id: record.id.clone(),
            kind: if record.kind == "piPackage" {
                PackageKind::PiPackage
            } else {
                PackageKind::ClaudePlugin
            },
            description: None,
            source: PackageSource {
                kind: source_kind(&record.source_kind),
                location: record.location.clone(),
                commit: record.commit.clone(),
                version: record.version.clone(),
                integrity: record.integrity.clone(),
                npm_name: (record.source_kind == "npm")
                    .then(|| self.npm_name_of(record))
                    .flatten(),
                install_scripts: if record.source_kind == "directory" {
                    Vec::new()
                } else {
                    super::fetch::declared_scripts(std::path::Path::new(&record.path))
                },
            },
            path: record.path.clone(),
            scope: declared.map(|(_, _, scope)| *scope),
            enabled: declared.is_some_and(|(_, on, _)| *on),
            active: view.active.contains(&record.id),
            components: PackageComponents::default(),
            unsupported: Vec::new(),
            executables: Vec::new(),
            issues: Vec::new(),
            installed_at: record.installed_at,
            updated_at: record.updated_at,
        };
        let path = PathBuf::from(&record.path);
        let data = config::data_dir(&self.data(), &record.id);
        let read = tokio::task::spawn_blocking(move || {
            config::read(&path, &data).map(|m| {
                let components = m.components();
                (m, components)
            })
        })
        .await;
        match read {
            Ok(Ok((manifest, components))) => {
                info.description = manifest.description.clone();
                info.components = components;
                info.unsupported = manifest.unsupported.clone();
                info.issues = manifest.issues.clone();
                info.executables = manifest
                    .executables()
                    .into_iter()
                    .map(|e| PackageExecutable {
                        confirmed: record.confirmed.contains(&e.name),
                        kind: e.kind,
                        name: e.name,
                    })
                    .collect();
            }
            Ok(Err(reason)) => info.issues.push(reason),
            Err(error) => info.issues.push(error.to_string()),
        }
        info
    }
}
