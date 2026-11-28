//! The L2 runner's provider and settings steps: endpoints configured through Core's settings
//! (T21, T29), the vault and settings checks, and the configuration diagnostics (T24).

use super::*;

impl Driver<'_> {
    pub(super) async fn check_config_diagnostics(&self) -> Result<(), String> {
        let Some(expected) = &self.spec.expect.config_diagnostics else {
            return Ok(());
        };
        let report = call(
            |done| {
                self.core
                    .config_diagnostics(Some(self.env.workspace.clone()), done)
            },
            "reading the configuration diagnostics",
        )
        .await?;
        match crate::l2::checks::config_diagnostics_mismatch(expected, &report) {
            Some(mismatch) => Err(mismatch),
            None => Ok(()),
        }
    }

    /// Writes or removes a managed settings file (T47) and waits until Core's managed reports
    /// change: Core reads the files again every 100 ms.
    pub(super) async fn write_managed(
        &self,
        path: &str,
        content: Option<&str>,
    ) -> Result<(), String> {
        let Some((base, _)) = &self.env.managed else {
            return Err("write_managed needs a managed section".into());
        };
        let before = self.managed_reports().await?;
        match content {
            Some(content) => write_file(base, path, content)?,
            None => {
                let file = path.split('/').fold(base.clone(), |p, part| p.join(part));
                std::fs::remove_file(&file).map_err(|e| format!("{}: {e}", file.display()))?;
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if self.managed_reports().await? != before {
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                return Err(format!(
                    "write_managed {path}: Core did not pick the change up in 10 s"
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// The managed documents' reports of the configuration diagnostics.
    async fn managed_reports(&self) -> Result<Vec<Value>, String> {
        let report = call(
            |done| {
                self.core
                    .config_diagnostics(Some(self.env.workspace.clone()), done)
            },
            "reading the configuration diagnostics",
        )
        .await?;
        Ok(report["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["kind"] == "enterprise")
            .cloned()
            .collect())
    }

    /// The workspace's audit rows of `kind`, newest first, as Core's `audit_events` answers
    /// them (the built-in browser's `browser` rows included, design addendum B2.7.2).
    pub(super) async fn audit_rows(&self, kind: &str) -> Result<Vec<Value>, String> {
        let query = json!({ "kind": kind, "workspace": self.env.workspace, "limit": 1000 });
        let rows = call(
            |done| self.core.audit_events(query.to_string(), done),
            "reading the audit",
        )
        .await?;
        Ok(rows["events"].as_array().cloned().unwrap_or_default())
    }

    /// `expect.audit` (T47): every entry matches rows of its kind in the workspace's audit.
    pub(super) async fn check_audit(&self) -> Result<(), String> {
        for (n, expected) in self.spec.expect.audit.iter().enumerate() {
            let rows = self.audit_rows(&expected.kind).await?;
            let matching = rows
                .iter()
                .filter(|row| {
                    crate::l2::matcher::subset_mismatch(&expected.detail, &row["detail"], "detail")
                        .is_none()
                })
                .count();
            let ok = match expected.count {
                Some(count) => matching == count,
                None => matching > 0,
            };
            if !ok {
                let shown: Vec<&Value> = rows.iter().map(|r| &r["detail"]).take(12).collect();
                return Err(format!(
                    "expect/audit/{n}: {} {} row(s) match {}, expected {}; rows: {}",
                    matching,
                    expected.kind,
                    expected.detail,
                    expected
                        .count
                        .map_or_else(|| "at least 1".to_owned(), |c| c.to_string()),
                    serde_json::to_string(&shown).unwrap_or_default()
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn configure_providers(&self) -> Result<(), String> {
        let mut configs: Vec<_> = self
            .spec
            .cloud_providers
            .iter()
            .map(|id| (json!({"kind":"cloud","id":id}), true))
            .collect();
        for (name, spec) in &self.spec.providers {
            let Some(setup) = spec.configure_as else {
                continue;
            };
            let mock = &self.env.mocks[name];
            let (base, api) = match spec.wire {
                Wire::Anthropic => (mock.anthropic_base_url(), "anthropic-messages"),
                Wire::Openai => (mock.openai_base_url(), "openai-completions"),
            };
            let kind = match setup {
                EndpointSetup::Local => "local",
                EndpointSetup::Custom => "custom",
            };
            configs.push((json!({"kind":kind,"id":pi_provider(name),"api":api,"baseUrl":base,"models":[MOCK_MODEL]}),setup==EndpointSetup::Custom));
        }
        for (config, keyed) in configs {
            let key = keyed.then(|| json!({"key":L2_CREDENTIAL}).to_string());
            let op = piarc_core::providers::Operation::save(&config.to_string(), key.as_deref())
                .map_err(|e| e.to_string())?;
            call(
                |done| self.core.provider_op(op, done),
                "configuring provider",
            )
            .await?;
        }
        Ok(())
    }

    pub(super) async fn check_provider_settings(&self) -> Result<(), String> {
        if self.spec.expect.configured_providers.is_empty() {
            return Ok(());
        }
        let settings = call(
            |done| {
                self.core
                    .provider_op(piarc_core::providers::Operation::List, done)
            },
            "reading providers",
        )
        .await?;
        let catalog = call(
            |done| self.core.workspace_models(self.env.workspace.clone(), done),
            "checking available models",
        )
        .await?;
        for (id, expected) in &self.spec.expect.configured_providers {
            let actual = settings["providers"]
                .as_array()
                .and_then(|p| p.iter().find(|p| p["id"] == id.as_str()))
                .ok_or_else(|| format!("provider {id} missing"))?;
            if let Some(mismatch) = subset_mismatch(expected, actual, id) {
                return Err(mismatch);
            }
            if !catalog["models"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|m| m["provider"] == id.as_str()))
            {
                return Err(format!("provider {id} has no available model"));
            }
        }
        let scan = crate::plaintext::scan(&[&self.env.data], &[L2_CREDENTIAL.as_bytes()], None);
        if !scan.findings.is_empty() || !scan.unreadable.is_empty() {
            return Err(format!(
                "credential scan findings: {:?}, unreadable: {:?}",
                scan.findings, scan.unreadable
            ));
        }
        Ok(())
    }
}
