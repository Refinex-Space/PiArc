//! The vault's file format and open/create rules (T08-A01 to A04), against the in-memory
//! credential store double. Atomic-write failures (A05) are unit tests in `src/vault.rs`.

use std::path::{Path, PathBuf};

use piarc_ports::{SecretName, SecretStoreError};
use piarc_protocol::ErrorKind;
use piarc_secrets::format::{HEADER_LEN, MAGIC};
use piarc_secrets::{Error, MemorySecretStore, OpenOutcome, Vault, VaultConfig, master_key_name};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// A random-looking credential value whose bytes must never appear in a file.
const SECRET: &str = "piarc-test-secret-6f1c9a04d2b8e7350a1d";

struct Dir(PathBuf);

impl Dir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc secrets {label} 中文 {}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("after 1970")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }

    fn config(&self) -> VaultConfig {
        VaultConfig {
            path: self.0.join("secrets.vault"),
            master_key: master_key_name("piarc-test.vault-tests"),
        }
    }

    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn credential(access: &str) -> Value {
    json!({ "type": "oauth", "access": access, "refresh": SECRET, "expires": 1_763_200_000_000_u64 })
}

fn hash(path: &Path) -> Vec<u8> {
    Sha256::digest(std::fs::read(path).expect("file")).to_vec()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn open(config: &VaultConfig, store: &MemorySecretStore) -> Result<(Vault, OpenOutcome), Error> {
    Vault::open(config, store)
}

#[test]
fn round_trips_entries_through_the_encrypted_file() {
    let dir = Dir::new("roundtrip");
    let config = dir.config();
    let store = MemorySecretStore::new();
    let (mut vault, outcome) = open(&config, &store).expect("created");
    assert_eq!(outcome, OpenOutcome::Created { new_key: true });
    let r1 = vault.set("oauth/example", &credential("a1")).expect("set");
    let r2 = vault
        .set(
            "provider/openai",
            &json!({ "type": "api_key", "key": SECRET }),
        )
        .expect("set");
    let r3 = vault.set("oauth/example", &credential("a2")).expect("set");
    assert!(r1 < r2 && r2 < r3, "revisions grow: {r1} {r2} {r3}");
    assert_eq!(
        vault.delete("provider/openai").expect("delete"),
        Some(r3 + 1)
    );
    assert_eq!(vault.delete("provider/openai").expect("delete"), None);
    drop(vault);

    let file = std::fs::read(&config.path).expect("vault file");
    assert!(file.starts_with(&MAGIC));
    assert!(!contains(&file, SECRET.as_bytes()), "no plaintext on disk");
    assert!(!contains(&file, b"oauth/example"), "keys are encrypted too");

    let (reopened, outcome) = open(&config, &store).expect("reopened");
    assert_eq!(outcome, OpenOutcome::Opened);
    let entries: Vec<(String, u64, Value)> = reopened
        .entries()
        .map(|e| {
            (
                e.key.to_owned(),
                e.revision,
                serde_json::from_str(e.value).expect("json"),
            )
        })
        .collect();
    assert_eq!(
        entries,
        vec![("oauth/example".to_owned(), r3, credential("a2"))]
    );
    // A recreated key never reuses a revision.
    drop(reopened);
    let (mut vault, _) = open(&config, &store).expect("reopened");
    assert!(
        vault
            .set("provider/openai", &json!({ "type": "api_key" }))
            .expect("set")
            > r3 + 1
    );
}

#[test]
fn every_write_uses_a_new_nonce() {
    let dir = Dir::new("nonce");
    let config = dir.config();
    let store = MemorySecretStore::new();
    let (mut vault, _) = open(&config, &store).expect("created");
    let mut nonces = Vec::new();
    for _ in 0..3 {
        vault
            .set("oauth/example", &credential("same"))
            .expect("set");
        let file = std::fs::read(&config.path).expect("file");
        nonces.push(file[HEADER_LEN - 12..HEADER_LEN].to_vec());
    }
    nonces.sort();
    nonces.dedup();
    assert_eq!(nonces.len(), 3);
}

/// T08-A01: flipping any single byte of the header, nonce, ciphertext or tag makes opening
/// fail with an integrity error, and nothing is returned. The version field (bytes 8–9)
/// decides how the file is read, so a changed version is reported as an unknown version.
#[test]
fn any_modified_byte_fails_with_an_integrity_error() {
    let dir = Dir::new("tamper");
    let config = dir.config();
    let store = MemorySecretStore::new();
    let (mut vault, _) = open(&config, &store).expect("created");
    vault.set("oauth/example", &credential("a1")).expect("set");
    drop(vault);
    let original = std::fs::read(&config.path).expect("file");
    let (mut integrity, mut version) = (0, 0);
    for index in 0..original.len() {
        let mut tampered = original.clone();
        tampered[index] ^= 0x01;
        std::fs::write(&config.path, &tampered).expect("write");
        let error = open(&config, &store).expect_err("tampered vault must not open");
        match (index, &error) {
            (8 | 9, Error::UnsupportedVersion { .. }) => version += 1,
            (_, Error::Integrity { .. }) if !(8..10).contains(&index) => {
                assert_eq!(error.kind(), ErrorKind::VaultIntegrity);
                assert!(!error.retryable());
                integrity += 1;
            }
            _ => panic!("byte {index}: unexpected error {error:?}"),
        }
        assert!(!error.to_string().contains(SECRET));
    }
    assert_eq!(version, 2);
    assert_eq!(integrity, original.len() - 2);
    eprintln!(
        "T08-A01: {} bytes flipped one at a time ({HEADER_LEN}-byte header incl. 12-byte nonce, {} bytes ciphertext, 16-byte tag): {integrity} integrity errors, {version} version errors, 0 opened",
        original.len(),
        original.len() - HEADER_LEN - 16
    );

    // Truncation and another master key fail the same way.
    std::fs::write(&config.path, &original[..original.len() - 1]).expect("write");
    assert!(matches!(
        open(&config, &store),
        Err(Error::Integrity { .. })
    ));
    std::fs::write(&config.path, &original).expect("write");
    let other = MemorySecretStore::new();
    let other_config = VaultConfig {
        master_key: config.master_key.clone(),
        ..config.clone()
    };
    // `other` has no key: the vault exists, so the key is reported missing...
    assert!(matches!(
        open(&other_config, &other),
        Err(Error::MasterKeyMissing { .. })
    ));
    // ...and with a different key the header's key id does not match.
    let third = Dir::new("other key");
    let (_, _) = open(&third.config(), &other).expect("creates a key in `other`");
    let error = open(&other_config, &other).expect_err("sealed under another key");
    assert!(matches!(
        error,
        Error::Integrity {
            key_id_matches: Some(false),
            ..
        }
    ));
    assert_eq!(
        error.to_error_object().data.details,
        Some(json!({ "keyIdMatches": false }))
    );
}

/// T08-A02.
#[test]
fn an_unknown_format_version_is_a_version_error() {
    let dir = Dir::new("version");
    let config = dir.config();
    let store = MemorySecretStore::new();
    drop(open(&config, &store).expect("created"));
    let mut file = std::fs::read(&config.path).expect("file");
    file[8..10].copy_from_slice(&2u16.to_le_bytes());
    std::fs::write(&config.path, &file).expect("write");
    let error = open(&config, &store).expect_err("version 2 is unknown");
    assert!(matches!(error, Error::UnsupportedVersion { version: 2 }));
    let object = error.to_error_object();
    assert_eq!(object.data.kind, ErrorKind::VaultVersion);
    assert_eq!(object.data.details, Some(json!({ "version": 2 })));
    assert!(!object.data.retryable);
}

/// T08-A03.
#[test]
fn first_run_creates_the_key_and_a_missing_key_is_reported_without_touching_the_vault() {
    let dir = Dir::new("first run");
    let config = dir.config();
    let store = MemorySecretStore::new();
    let (vault, outcome) = open(&config, &store).expect("first run");
    assert_eq!(outcome, OpenOutcome::Created { new_key: true });
    assert_eq!(vault.entries().count(), 0);
    assert!(store.contains(&config.master_key));
    assert_eq!(store.writes(), 1);
    assert_eq!(dir.files(), vec!["secrets.vault".to_owned()]);
    drop(vault);

    let (mut vault, outcome) = open(&config, &store).expect("second run");
    assert_eq!(outcome, OpenOutcome::Opened);
    vault.set("oauth/example", &credential("a1")).expect("set");
    drop(vault);
    let before = hash(&config.path);

    store.remove(&config.master_key);
    let error = open(&config, &store).expect_err("the key is gone");
    assert!(matches!(error, Error::MasterKeyMissing { .. }));
    let object = error.to_error_object();
    assert_eq!(object.data.kind, ErrorKind::MasterKeyMissing);
    assert!(!object.data.retryable);
    assert!(!store.contains(&config.master_key), "no new key created");
    assert_eq!(store.writes(), 1, "nothing written to the store");
    assert_eq!(hash(&config.path), before, "vault file unchanged");
    assert_eq!(dir.files(), vec!["secrets.vault".to_owned()]);

    // An existing key without a vault file gets a new empty vault under that key.
    let fresh = Dir::new("key only");
    let config = VaultConfig {
        path: fresh.0.join("secrets.vault"),
        ..config
    };
    let other = MemorySecretStore::new();
    drop(open(&config, &other).expect("creates key"));
    std::fs::remove_file(&config.path).expect("remove vault");
    let (_, outcome) = open(&config, &other).expect("recreates the vault");
    assert_eq!(outcome, OpenOutcome::Created { new_key: false });
    assert_eq!(other.writes(), 1);
}

/// T08-A04: a denied, locked or unavailable store yields a retryable structured error and
/// leaves no plaintext (and on first run, no file at all) in the data directory.
#[test]
fn an_unusable_credential_store_is_a_retryable_error_without_plaintext() {
    let failures = [
        (
            SecretStoreError::AccessDenied("user denied".into()),
            "accessDenied",
        ),
        (
            SecretStoreError::Unavailable("keychain locked".into()),
            "unavailable",
        ),
        (
            SecretStoreError::Failed("platform failure".into()),
            "failed",
        ),
    ];
    for (failure, reason) in failures {
        // First run: nothing exists yet.
        let dir = Dir::new(&format!("store {reason}"));
        let config = dir.config();
        let store = MemorySecretStore::new();
        store.fail_with(failure.clone());
        let error = open(&config, &store).expect_err("store refuses");
        let object = error.to_error_object();
        assert_eq!(object.data.kind, ErrorKind::CredentialStoreUnavailable);
        assert!(object.data.retryable);
        assert_eq!(object.data.details, Some(json!({ "reason": reason })));
        assert!(dir.files().is_empty(), "no file written: {:?}", dir.files());

        // Existing vault: still only the encrypted file.
        store.recover();
        let (mut vault, _) = open(&config, &store).expect("created");
        vault.set("oauth/example", &credential("a1")).expect("set");
        drop(vault);
        let before = hash(&config.path);
        store.fail_with(failure.clone());
        let error = open(&config, &store).expect_err("store refuses");
        assert!(error.retryable());
        assert_eq!(dir.files(), vec!["secrets.vault".to_owned()]);
        assert_eq!(hash(&config.path), before);
        for name in dir.files() {
            let bytes = std::fs::read(dir.0.join(name)).expect("file");
            assert!(!contains(&bytes, SECRET.as_bytes()));
        }
        store.recover();
        assert!(
            open(&config, &store).is_ok(),
            "works again once access is granted"
        );
    }
}

#[test]
fn rejects_unknown_key_prefixes_and_non_object_values() {
    let dir = Dir::new("validation");
    let store = MemorySecretStore::new();
    let (mut vault, _) = open(&dir.config(), &store).expect("created");
    for key in ["", "provider/", "aws/x", "oauth/a\nb"] {
        assert!(
            matches!(
                vault.set(key, &credential("x")),
                Err(Error::InvalidKey { .. })
            ),
            "{key:?}"
        );
    }
    let error = vault
        .set("provider/x", &json!(SECRET))
        .expect_err("a bare string is not a credential");
    assert!(!error.to_string().contains(SECRET));
    assert_eq!(error.kind(), ErrorKind::InvalidParams);
    assert!(vault.set("mcp/my server", &json!({ "token": "t" })).is_ok());
}

#[test]
fn names_test_items_under_the_test_prefix() {
    let a = piarc_secrets::test_master_key_name("unit");
    let b = piarc_secrets::test_master_key_name("unit");
    assert!(a.service.starts_with(piarc_secrets::TEST_SERVICE_PREFIX));
    assert!(a.service.ends_with(piarc_secrets::SERVICE_SUFFIX));
    assert_ne!(a, b);
    assert_eq!(
        master_key_name("app.example"),
        SecretName {
            service: "app.example.credential-vault".into(),
            account: "master-key".into()
        }
    );
}
