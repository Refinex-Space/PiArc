//! T08-A11: the real system credential store (macOS login keychain, Windows Credential
//! Manager) creates, reads and deletes the master key under a test-only service name, and
//! nothing is left behind.
//!
//! Only items under `piarc-test.` service names are created, and each test removes them.
//! When the store is unavailable (no logon session, locked keychain on a headless runner) the
//! test prints `T08-A11 NOT RUN` with the reason instead of passing silently; with
//! `PIARC_REQUIRE_KEYCHAIN=1` it fails instead. Item existence is checked without reading
//! the secret: `security find-generic-password` without `-g`/`-w` on macOS.

use std::sync::mpsc;
use std::time::Duration;

use piarc_ports::{SecretName, SecretStore, SecretStoreError};
use piarc_secrets::{
    Error, MasterKey, OpenOutcome, SystemSecretStore, Vault, VaultConfig, test_master_key_name,
};
use serde_json::json;

/// A keychain call that waits for a prompt nobody answers must not hang the test run.
const STORE_TIMEOUT: Duration = Duration::from_secs(30);

fn required() -> bool {
    std::env::var_os("PIARC_REQUIRE_KEYCHAIN").is_some_and(|v| v == "1")
}

/// Runs `f` on a thread with a timeout.
fn bounded<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(STORE_TIMEOUT).ok()
}

/// Whether the platform store can be used here; prints why not.
fn usable_store(probe: &SecretName) -> Option<SystemSecretStore> {
    let not_run = |reason: String| {
        assert!(
            !required(),
            "T08-A11 required but the store is unusable: {reason}"
        );
        eprintln!("T08-A11 NOT RUN: the system credential store is unusable here: {reason}");
        None
    };
    let probe = probe.clone();
    match bounded(move || {
        let store = SystemSecretStore::new()?;
        store.read(&probe).map(|_| store)
    }) {
        None => not_run(format!(
            "no answer within {STORE_TIMEOUT:?} (waiting for a prompt?)"
        )),
        Some(Err(e @ (SecretStoreError::Unavailable(_) | SecretStoreError::AccessDenied(_)))) => {
            not_run(e.to_string())
        }
        Some(Err(e)) => panic!("the system credential store failed: {e}"),
        Some(Ok(store)) => Some(store),
    }
}

/// Whether an item exists, asked independently of keyring-core. `None` where no such tool
/// is used (Windows: keyring-core's own read is the check).
fn item_exists_per_os(name: &SecretName) -> Option<bool> {
    if cfg!(target_os = "macos") {
        let status = std::process::Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                &name.service,
                "-a",
                &name.account,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("security runs");
        Some(status.success())
    } else {
        None
    }
}

#[test]
fn creates_reads_and_deletes_the_master_key_in_the_system_store() {
    let name = test_master_key_name("a11");
    let Some(store) = usable_store(&name) else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("piarc keychain a11 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let config = VaultConfig {
        path: dir.join("secrets.vault"),
        master_key: name.clone(),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Create: first run generates the key into the store and an empty vault.
        let (mut vault, outcome) = Vault::open(&config, &store).expect("first run");
        assert_eq!(outcome, OpenOutcome::Created { new_key: true });
        vault
            .set(
                "provider/example",
                &json!({ "type": "api_key", "key": "piarc-test-value" }),
            )
            .expect("set");
        drop(vault);
        assert!(item_exists_per_os(&name).unwrap_or(true));

        // Read: the key comes back and decrypts the vault.
        let key = MasterKey::load(&store, &name)
            .expect("read")
            .expect("the key exists");
        assert_eq!(key.bytes().len(), 32);
        let (vault, outcome) = Vault::open(&config, &store).expect("reopened");
        assert_eq!(outcome, OpenOutcome::Opened);
        assert!(vault.get("provider/example").is_some());
        drop(vault);

        // Delete: the item is gone, and the vault reports the missing key.
        assert!(store.delete(&name).expect("delete"));
        assert!(store.read(&name).expect("read after delete").is_none());
        assert!(!item_exists_per_os(&name).unwrap_or(false));
        assert!(matches!(
            Vault::open(&config, &store),
            Err(Error::MasterKeyMissing { .. })
        ));
        assert!(
            !store.delete(&name).expect("second delete"),
            "nothing left to delete"
        );
    }));
    // Clean up even when an assertion failed.
    let _ = store.delete(&name);
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
    assert_ne!(item_exists_per_os(&name), Some(true), "no item left behind");
    eprintln!(
        "T08-A11: created, read and deleted the master key under service {:?} account {:?}; \
         item present after create, absent after delete (checked with {})",
        name.service,
        name.account,
        if cfg!(target_os = "macos") {
            "security find-generic-password"
        } else {
            "keyring-core"
        }
    );
}
