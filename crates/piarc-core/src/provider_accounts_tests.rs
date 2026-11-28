//! ADR-0083: several accounts of one provider, one in use at a time.
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::secrets::{MemorySecretStore, SecretsConfig, test_master_key_name};

const P: &str = "openai-codex";

struct Fixture {
    dir: std::path::PathBuf,
    secrets: SecretsService,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc-accounts-{}",
            crate::sessions::new_session_id().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let config = SecretsConfig::with_master_key(&dir, test_master_key_name("accounts"));
        let secrets = SecretsService::new(config, Arc::new(MemorySecretStore::new()));
        Self { dir, secrets }
    }

    /// A sign-in as Pi's login writes it.
    async fn sign_in(&self, settings: &mut Settings, who: &str) {
        let token = json!({"type": "oauth", "access": format!("a-{who}"), "refresh": format!("r-{who}"), "expires": 1});
        self.secrets
            .store_value(&in_use_key(P), token.as_object().cloned())
            .await
            .unwrap();
        signed_in(
            &self.secrets,
            settings,
            P,
            Some(format!("{who}@example.com")),
        )
        .await
        .unwrap();
    }

    async fn refresh_of(&self, key: &str) -> Option<String> {
        self.secrets
            .value_of(key)
            .await
            .unwrap()
            .and_then(|v| v.get("refresh").and_then(Value::as_str).map(str::to_owned))
    }

    fn id_of(settings: &Settings, who: &str) -> String {
        let label = format!("{who}@example.com");
        settings
            .accounts
            .iter()
            .find(|a| a.label.as_deref() == Some(label.as_str()))
            .map(|a| a.id.clone())
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn a_second_account_switching_and_removing() {
    let f = Fixture::new();
    let mut settings = Settings::default();
    f.sign_in(&mut settings, "ann").await;

    // Adding a second account: the one in use moves aside first, then the sign-in runs.
    let aside = set_aside(&f.secrets, &mut settings, P, None)
        .await
        .unwrap()
        .unwrap();
    f.sign_in(&mut settings, "bob").await;
    assert_eq!(f.refresh_of(&in_use_key(P)).await.as_deref(), Some("r-bob"));
    assert_eq!(
        f.refresh_of(&aside_key(P, &aside)).await.as_deref(),
        Some("r-ann")
    );
    let ann = Fixture::id_of(&settings, "ann");
    assert_eq!(ann, aside);
    assert_eq!(settings.accounts.iter().filter(|a| a.active).count(), 1);

    // Switching back to ann: bob goes aside.
    switch(&f.secrets, &mut settings, P, &ann, None)
        .await
        .unwrap();
    assert_eq!(f.refresh_of(&in_use_key(P)).await.as_deref(), Some("r-ann"));
    assert_eq!(f.refresh_of(&aside_key(P, &ann)).await, None);
    let bob = Fixture::id_of(&settings, "bob");
    assert_eq!(
        f.refresh_of(&aside_key(P, &bob)).await.as_deref(),
        Some("r-bob")
    );
    assert!(settings.accounts.iter().any(|a| a.id == ann && a.active));

    // The account in use cannot be switched to or removed as an aside one.
    assert!(
        switch(&f.secrets, &mut settings, P, &ann, None)
            .await
            .is_err()
    );
    assert!(remove(&f.secrets, &mut settings, P, &ann).await.is_err());

    remove(&f.secrets, &mut settings, P, &bob).await.unwrap();
    assert_eq!(f.refresh_of(&aside_key(P, &bob)).await, None);
    assert_eq!(settings.accounts.len(), 1);
}

#[tokio::test]
async fn a_failed_sign_in_puts_the_account_back_and_the_same_account_is_not_kept_twice() {
    let f = Fixture::new();
    let mut settings = Settings::default();
    f.sign_in(&mut settings, "ann").await;
    let aside = set_aside(&f.secrets, &mut settings, P, None)
        .await
        .unwrap()
        .unwrap();
    // The sign-in failed: ann is back in use.
    put_back(&f.secrets, &mut settings, P, &aside)
        .await
        .unwrap();
    assert_eq!(f.refresh_of(&in_use_key(P)).await.as_deref(), Some("r-ann"));
    assert_eq!(f.refresh_of(&aside_key(P, &aside)).await, None);
    assert!(settings.accounts.iter().all(|a| a.active));

    // Signing in as ann again replaces the record aside rather than adding one.
    let aside = set_aside(&f.secrets, &mut settings, P, None)
        .await
        .unwrap()
        .unwrap();
    f.sign_in(&mut settings, "ann").await;
    assert_eq!(settings.accounts.len(), 1);
    assert_eq!(f.refresh_of(&aside_key(P, &aside)).await, None);
}

#[tokio::test]
async fn nothing_in_use_sets_nothing_aside() {
    let f = Fixture::new();
    let mut settings = Settings::default();
    settings.accounts.push(Account {
        provider: P.into(),
        id: "stale".into(),
        label: None,
        active: true,
    });
    assert_eq!(
        set_aside(&f.secrets, &mut settings, P, None).await.unwrap(),
        None
    );
    assert!(settings.accounts.is_empty());
}

#[test]
fn the_view_names_the_account_in_use_and_shows_an_older_sign_in() {
    let login = |id: &str, signed_in: bool, account: Option<&str>| LoginProvider {
        id: id.into(),
        name: id.into(),
        label: id.into(),
        subscription: true,
        signed_in,
        account: account.map(str::to_owned),
    };
    let records = vec![
        Account {
            provider: P.into(),
            id: "a1".into(),
            label: None,
            active: true,
        },
        Account {
            provider: P.into(),
            id: "a2".into(),
            label: Some("bob@example.com".into()),
            active: false,
        },
        // In use, but the provider is no longer signed in.
        Account {
            provider: "xai".into(),
            id: "x1".into(),
            label: None,
            active: true,
        },
    ];
    let logins = vec![
        login(P, true, Some("ann@example.com")),
        login("xai", false, None),
        login("github-copilot", true, Some("octo")),
    ];
    let view = view(&records, &logins);
    assert_eq!(
        view,
        json!([
            {"provider": P, "id": "a1", "label": "ann@example.com", "active": true},
            {"provider": P, "id": "a2", "label": "bob@example.com"},
            {"provider": "github-copilot", "id": CURRENT, "label": "octo", "active": true},
        ])
    );
}
