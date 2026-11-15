//! The vault's master key: 32 random bytes kept in the system credential store.

use piarc_ports::{SecretName, SecretStore};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::random;

/// Length of the master key in bytes (AES-256).
pub const KEY_LEN: usize = 32;
/// Length of the key id written into the vault header.
pub const KEY_ID_LEN: usize = 16;

/// Account of the master key item within its service.
pub const MASTER_KEY_ACCOUNT: &str = "master-key";
/// Suffix of the master key item's service name: `<application identifier>.credential-vault`.
pub const SERVICE_SUFFIX: &str = ".credential-vault";
/// Prefix of the service names tests create items under. Production service names start with
/// the application identifier instead, so tests never touch a real master key.
pub const TEST_SERVICE_PREFIX: &str = "piarc-test.";

/// Where the master key of the application `app_identifier` is stored.
#[must_use]
pub fn master_key_name(app_identifier: &str) -> SecretName {
    SecretName {
        service: format!("{app_identifier}{SERVICE_SUFFIX}"),
        account: MASTER_KEY_ACCOUNT.to_owned(),
    }
}

/// A unique test-only master key name, under [`TEST_SERVICE_PREFIX`].
#[must_use]
pub fn test_master_key_name(label: &str) -> SecretName {
    let mut unique = [0u8; 8];
    // A test name only needs to be unlikely to repeat; fall back to the clock.
    let suffix = match random::fill(&mut unique) {
        Ok(()) => hex(&unique),
        Err(_) => format!("{:?}", std::time::Instant::now()),
    };
    master_key_name(&format!(
        "{TEST_SERVICE_PREFIX}{label}.{}.{suffix}",
        std::process::id()
    ))
}

/// The 32-byte master key and its id. The key bytes are zeroed when it is dropped.
pub struct MasterKey {
    bytes: Zeroizing<[u8; KEY_LEN]>,
    id: [u8; KEY_ID_LEN],
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MasterKey")
            .field("id", &hex(&self.id))
            .finish_non_exhaustive()
    }
}

impl MasterKey {
    fn from_bytes(bytes: Zeroizing<[u8; KEY_LEN]>) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"piarc-credential-vault-key-id\0");
        hasher.update(bytes.as_slice());
        let digest = hasher.finalize();
        let mut id = [0u8; KEY_ID_LEN];
        id.copy_from_slice(&digest[..KEY_ID_LEN]);
        Self { bytes, id }
    }

    /// A new random key.
    ///
    /// # Errors
    ///
    /// [`Error::Random`] when the system random number generator fails.
    pub fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        random::fill(bytes.as_mut_slice())?;
        Ok(Self::from_bytes(bytes))
    }

    /// The key stored under `name`, or `None` when the store has none.
    ///
    /// # Errors
    ///
    /// [`Error::CredentialStore`] when the store refuses or fails; [`Error::Integrity`] when
    /// the stored item is not a 32-byte key.
    pub fn load(store: &dyn SecretStore, name: &SecretName) -> Result<Option<Self>> {
        let Some(secret) = store.read(name)? else {
            return Ok(None);
        };
        let secret = Zeroizing::new(secret);
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        if secret.len() != KEY_LEN {
            return Err(Error::Integrity {
                reason: "the master key item in the system credential store is not a 32-byte key",
                key_id_matches: None,
            });
        }
        bytes.copy_from_slice(&secret);
        Ok(Some(Self::from_bytes(bytes)))
    }

    /// Writes this key under `name`.
    ///
    /// # Errors
    ///
    /// [`Error::CredentialStore`] when the store refuses or fails.
    pub fn save(&self, store: &dyn SecretStore, name: &SecretName) -> Result<()> {
        store.write(name, self.bytes.as_slice())?;
        Ok(())
    }

    /// The key bytes.
    #[must_use]
    pub fn bytes(&self) -> &[u8; KEY_LEN] {
        &self.bytes
    }

    /// The first 16 bytes of SHA-256 over a domain label and the key: identifies which key
    /// sealed a vault without revealing it.
    #[must_use]
    pub fn id(&self) -> &[u8; KEY_ID_LEN] {
        &self.id
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
