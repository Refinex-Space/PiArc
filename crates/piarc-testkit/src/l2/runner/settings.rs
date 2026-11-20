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
