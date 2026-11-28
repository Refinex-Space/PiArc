//! [`SecretStore`] over the platform credential store through `keyring-core`: the login
//! keychain on macOS (`apple-native-keyring-store`, `keychain` module), the Credential
//! Manager on Windows (`windows-native-keyring-store`).
//!
//! macOS uses the file-based login keychain, not the data protection keychain: the latter's
//! access groups need a provisioning profile, which ad-hoc signed builds do not have
//! (`docs/research/native-stack.md` section 8.4, ADR-0018).

use std::sync::Arc;

use keyring_core::{CredentialStore, Entry, Error as KeyringError};
use piarc_ports::{SecretName, SecretStore, SecretStoreError};

/// The platform credential store.
pub struct SystemSecretStore {
    inner: Arc<CredentialStore>,
}

impl std::fmt::Debug for SystemSecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemSecretStore").finish_non_exhaustive()
    }
}

impl SystemSecretStore {
    /// Opens the platform store.
    ///
    /// # Errors
    ///
    /// [`SecretStoreError::Unavailable`] on a platform without a supported store, or when the
    /// store cannot be opened.
    pub fn new() -> Result<Self, SecretStoreError> {
        Ok(Self {
            inner: platform_store()?,
        })
    }

    fn entry(&self, name: &SecretName) -> Result<Entry, SecretStoreError> {
        self.inner
            .build(&name.service, &name.account, None)
            .map_err(classify)
    }
}

#[cfg(target_os = "macos")]
fn platform_store() -> Result<Arc<CredentialStore>, SecretStoreError> {
    let store: Arc<CredentialStore> =
        apple_native_keyring_store::keychain::Store::new().map_err(classify)?;
    Ok(store)
}

#[cfg(target_os = "windows")]
fn platform_store() -> Result<Arc<CredentialStore>, SecretStoreError> {
    let store: Arc<CredentialStore> =
        windows_native_keyring_store::Store::new().map_err(classify)?;
    Ok(store)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_store() -> Result<Arc<CredentialStore>, SecretStoreError> {
    Err(SecretStoreError::Unavailable(
        "PiArc supports the system credential store on macOS and Windows only".to_owned(),
    ))
}

impl SecretStore for SystemSecretStore {
    fn read(&self, name: &SecretName) -> Result<Option<Vec<u8>>, SecretStoreError> {
        match self.entry(name)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(classify(error)),
        }
    }

    fn write(&self, name: &SecretName, secret: &[u8]) -> Result<(), SecretStoreError> {
        self.entry(name)?.set_secret(secret).map_err(classify)
    }

    fn delete(&self, name: &SecretName) -> Result<bool, SecretStoreError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(classify(error)),
        }
    }
}

/// Maps a `keyring-core` error. Errors that carry secret bytes (`BadEncoding`,
/// `BadDataFormat`) are reported without them.
fn classify(error: KeyringError) -> SecretStoreError {
    match error {
        KeyringError::NoStorageAccess(platform) => {
            SecretStoreError::Unavailable(platform.to_string())
        }
        KeyringError::PlatformFailure(platform) => classify_platform(platform.as_ref()),
        KeyringError::BadEncoding(_) | KeyringError::BadDataFormat(..) => {
            SecretStoreError::Failed("the stored item has an unexpected format".to_owned())
        }
        other => SecretStoreError::Failed(other.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn classify_platform(
    platform: &(dyn std::error::Error + Send + Sync + 'static),
) -> SecretStoreError {
    // OSStatus values from Security/SecBase.h.
    const USER_CANCELED: i32 = -128;
    const AUTH_FAILED: i32 = -25293;
    const INTERACTION_NOT_ALLOWED: i32 = -25308;
    match platform
        .downcast_ref::<security_framework::base::Error>()
        .map(|e| e.code())
    {
        Some(USER_CANCELED | AUTH_FAILED) => SecretStoreError::AccessDenied(platform.to_string()),
        Some(INTERACTION_NOT_ALLOWED) => SecretStoreError::Unavailable(platform.to_string()),
        _ => SecretStoreError::Failed(platform.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn classify_platform(
    platform: &(dyn std::error::Error + Send + Sync + 'static),
) -> SecretStoreError {
    SecretStoreError::Failed(platform.to_string())
}
