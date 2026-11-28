//! The system credential store (macOS Keychain, Windows Credential Manager).

use std::fmt;

/// Where one secret lives in the system credential store: a service name and an account name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SecretName {
    /// The service, prefixed with the application identifier in production.
    pub service: String,
    /// The account within the service.
    pub account: String,
}

/// Why the system credential store could not complete an operation. None of the variants
/// carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretStoreError {
    /// The user or the operating system refused access to the item (for example the user
    /// denied the Keychain prompt).
    AccessDenied(String),
    /// The store is locked or cannot be reached right now (for example the login keychain is
    /// locked, or there is no logon session).
    Unavailable(String),
    /// Any other failure reported by the platform.
    Failed(String),
}

impl SecretStoreError {
    /// The platform's description of the failure.
    #[must_use]
    pub fn reason(&self) -> &str {
        match self {
            Self::AccessDenied(reason) | Self::Unavailable(reason) | Self::Failed(reason) => reason,
        }
    }
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AccessDenied(reason) => {
                write!(f, "access to the credential store was denied: {reason}")
            }
            Self::Unavailable(reason) => write!(f, "the credential store is unavailable: {reason}"),
            Self::Failed(reason) => write!(f, "the credential store failed: {reason}"),
        }
    }
}

impl std::error::Error for SecretStoreError {}

/// The system credential store, reduced to what the credential vault needs: one secret per
/// name. Calls block (they may show a system prompt); async callers run them on a blocking
/// thread. `piarc-secrets` implements it over `keyring-core`; tests use in-memory doubles.
pub trait SecretStore: Send + Sync {
    /// The secret stored under `name`, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// [`SecretStoreError`] when the store cannot be read.
    fn read(&self, name: &SecretName) -> Result<Option<Vec<u8>>, SecretStoreError>;

    /// Stores `secret` under `name`, replacing any previous secret.
    ///
    /// # Errors
    ///
    /// [`SecretStoreError`] when the store cannot be written.
    fn write(&self, name: &SecretName, secret: &[u8]) -> Result<(), SecretStoreError>;

    /// Removes the secret stored under `name`; returns whether there was one.
    ///
    /// # Errors
    ///
    /// [`SecretStoreError`] when the store cannot be written.
    fn delete(&self, name: &SecretName) -> Result<bool, SecretStoreError>;
}
