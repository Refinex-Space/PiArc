//! In-memory [`SecretStore`] doubles for tests: a store that keeps secrets in a map, and can
//! be told to fail every call with a given error (denied, locked, unavailable).

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_ports::{SecretName, SecretStore, SecretStoreError};
use zeroize::Zeroizing;

/// A credential store in memory. Secrets are zeroed when removed or when the store drops.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    items: HashMap<SecretName, Zeroizing<Vec<u8>>>,
    failure: Option<SecretStoreError>,
    writes: usize,
}

impl MemorySecretStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every later call fails with `error` until [`MemorySecretStore::recover`].
    pub fn fail_with(&self, error: SecretStoreError) {
        self.lock().failure = Some(error);
    }

    /// Calls succeed again.
    pub fn recover(&self) {
        self.lock().failure = None;
    }

    /// Whether a secret is stored under `name`.
    #[must_use]
    pub fn contains(&self, name: &SecretName) -> bool {
        self.lock().items.contains_key(name)
    }

    /// Removes the secret under `name` without going through the trait (simulates the user
    /// deleting the item).
    pub fn remove(&self, name: &SecretName) {
        self.lock().items.remove(name);
    }

    /// How many successful writes the store received.
    #[must_use]
    pub fn writes(&self) -> usize {
        self.lock().writes
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn check(state: &State) -> Result<(), SecretStoreError> {
        state.failure.clone().map_or(Ok(()), Err)
    }
}

impl SecretStore for MemorySecretStore {
    fn read(&self, name: &SecretName) -> Result<Option<Vec<u8>>, SecretStoreError> {
        let state = self.lock();
        Self::check(&state)?;
        Ok(state.items.get(name).map(|s| s.to_vec()))
    }

    fn write(&self, name: &SecretName, secret: &[u8]) -> Result<(), SecretStoreError> {
        let mut state = self.lock();
        Self::check(&state)?;
        state
            .items
            .insert(name.clone(), Zeroizing::new(secret.to_vec()));
        state.writes += 1;
        Ok(())
    }

    fn delete(&self, name: &SecretName) -> Result<bool, SecretStoreError> {
        let mut state = self.lock();
        Self::check(&state)?;
        Ok(state.items.remove(name).is_some())
    }
}
