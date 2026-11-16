//! The keychain half of the S6 first-run checklist (T12, ADR-0018 rule 5): how often macOS
//! asks for keychain access when a newer build of the app reads the master key an older build
//! created. Only the `testing` build of `piarc-napi` exports it (`CoreRuntime.keychainProbe`),
//! driven by `scripts/dev/s6-probe.mjs` against an installed app.
//!
//! The probe uses the real system credential store and the real vault code, but its own item
//! ([`PROBE_MASTER_KEY_LABEL`], under the `piarc-test.` prefix of test items) and a vault file
//! in a directory the caller chooses, so the app's real master key is never touched. The name
//! is fixed rather than random: build A writes it, build B must find the same item.

use std::path::{Path, PathBuf};

use piarc_ports::SecretStore;
use piarc_secrets::{OpenOutcome, SystemSecretStore, Vault, VaultConfig, master_key_name};
use serde::Serialize;
use serde_json::json;

/// Application label of the probe's master key: service
/// `piarc-test.s6-keychain.credential-vault`, account `master-key`.
pub const PROBE_MASTER_KEY_LABEL: &str = "piarc-test.s6-keychain";

/// The credential the probe stores in its vault (keys must use a vault prefix: `provider/`).
const PROBE_KEY: &str = "provider/piarc-s6-probe";

/// What to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainProbeAction {
    /// Open (creating the master key and vault when missing) and store the probe credential.
    Write,
    /// Open the existing vault and read the probe credential.
    Read,
    /// Delete the probe's master key and vault file.
    Delete,
}

impl KeychainProbeAction {
    /// Parses `write`, `read` or `delete`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "write" => Some(Self::Write),
            "read" => Some(Self::Read),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// The outcome, as the checklist records it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainProbeReport {
    /// `write`, `read` or `delete`.
    pub action: &'static str,
    /// Whether the action succeeded.
    pub ok: bool,
    /// How the vault was opened: `created`, `createdWithNewKey`, `opened`.
    pub opened: Option<&'static str>,
    /// Whether the probe credential was found (`read`).
    pub found: Option<bool>,
    /// Structured error (kind and message) when `ok` is false.
    pub error: Option<serde_json::Value>,
    /// The vault file.
    pub vault: PathBuf,
    /// The keychain service of the master key.
    pub service: String,
}

/// Runs `action` against the vault in `dir`. Blocking: the keychain may show an
/// authorization dialog and wait for the user.
#[must_use]
pub fn run(action: KeychainProbeAction, dir: &Path) -> KeychainProbeReport {
    let master_key = master_key_name(PROBE_MASTER_KEY_LABEL);
    let config = VaultConfig {
        path: dir.join("secrets.vault"),
        master_key: master_key.clone(),
    };
    let mut report = KeychainProbeReport {
        action: match action {
            KeychainProbeAction::Write => "write",
            KeychainProbeAction::Read => "read",
            KeychainProbeAction::Delete => "delete",
        },
        ok: false,
        opened: None,
        found: None,
        error: None,
        vault: config.path.clone(),
        service: master_key.service.clone(),
    };
    let fail = |report: &mut KeychainProbeReport, kind: String, message: String| {
        report.error = Some(json!({ "kind": kind, "message": message }));
    };
    let store = match SystemSecretStore::new() {
        Ok(store) => store,
        Err(error) => {
            fail(
                &mut report,
                "credentialStoreUnavailable".into(),
                error.to_string(),
            );
            return report;
        }
    };
    if action == KeychainProbeAction::Delete {
        match store.delete(&master_key) {
            Ok(_) => {
                let _ = std::fs::remove_file(&config.path);
                report.ok = true;
            }
            Err(error) => fail(&mut report, "credentialStore".into(), error.to_string()),
        }
        return report;
    }
    let (mut vault, outcome) = match Vault::open(&config, &store) {
        Ok(opened) => opened,
        Err(error) => {
            fail(
                &mut report,
                format!("{:?}", error.kind()),
                error.to_string(),
            );
            return report;
        }
    };
    report.opened = Some(match outcome {
        OpenOutcome::Created { new_key: true } => "createdWithNewKey",
        OpenOutcome::Created { new_key: false } => "created",
        OpenOutcome::Opened => "opened",
    });
    match action {
        KeychainProbeAction::Write => {
            match vault.set(PROBE_KEY, &json!({ "type": "api_key", "key": "s6-probe" })) {
                Ok(_) => report.ok = true,
                Err(error) => fail(
                    &mut report,
                    format!("{:?}", error.kind()),
                    error.to_string(),
                ),
            }
        }
        KeychainProbeAction::Read | KeychainProbeAction::Delete => {
            report.found = Some(vault.get(PROBE_KEY).is_some());
            report.ok = true;
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_parse() {
        assert_eq!(
            KeychainProbeAction::parse("write"),
            Some(KeychainProbeAction::Write)
        );
        assert_eq!(
            KeychainProbeAction::parse("read"),
            Some(KeychainProbeAction::Read)
        );
        assert_eq!(
            KeychainProbeAction::parse("delete"),
            Some(KeychainProbeAction::Delete)
        );
        assert_eq!(KeychainProbeAction::parse("other"), None);
    }

    #[test]
    fn the_probe_credential_key_is_one_the_vault_accepts() {
        piarc_secrets::validate_key(PROBE_KEY).expect("the vault accepts the probe's key");
    }

    #[test]
    fn the_probe_item_is_a_test_item() {
        let name = master_key_name(PROBE_MASTER_KEY_LABEL);
        assert!(name.service.starts_with("piarc-test."), "{}", name.service);
        assert_ne!(name, crate::identity::master_key_name());
    }
}
