//! Credentials the Agent Host reads from and writes to Core's vault (`secrets/*`).
//!
//! Core owns the credential vault (ADR-0018 rule 5, architecture section 5.4) and is its only
//! writer. Credentials reach the Agent Host only over AHP, never through environment
//! variables. Keys are names such as `provider/<id>` (API keys), `oauth/<id>` (OAuth tokens)
//! and `mcp/<server>` (MCP tokens); values are JSON objects.
//!
//! # Reading
//!
//! The Agent Host fetches every credential once at startup with `secrets/getAll` and serves
//! reads from memory. Core then pushes each change as a `secrets/changed` notification
//! (Core → Agent Host) to every Agent Host that called `secrets/getAll` on that connection,
//! the writer included. A notification whose `revision` is not above the receiver's known
//! revision for that key is stale and ignored. `secrets/get` reads one entry.
//!
//! # Writing
//!
//! `secrets/set` and `secrets/delete` change one key. A read-modify-write that must not race
//! with other Agent Hosts (an OAuth refresh) first takes `secrets/lock` on the keys it may
//! write, gets their current entries in the result, and passes the `lockId` to its writes;
//! writes without the lock wait until the lock is released. `secrets/unlock` releases it.
//! Core releases a lock on its own after `expiresInMs` or when the holder's connection ends;
//! a write with a lock that is no longer held fails with `secretLockLost`.
//!
//! # Failures
//!
//! Vault failures map to `masterKeyMissing`, `credentialStoreUnavailable` (retryable),
//! `vaultIntegrity` and `vaultVersion`. The Agent Host reports them as session errors and
//! never falls back to plaintext or environment variables.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::method::{Method, NotificationMethod, request};

/// One stored credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    /// The credential key, such as `oauth/example`.
    pub key: String,
    /// The vault revision of the entry's last write; grows across all keys.
    pub revision: u64,
    /// The credential.
    pub value: Map<String, Value>,
}

/// Parameters of `secrets/getAll`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetAllParams {
    /// Only keys starting with one of these prefixes (for example `provider/` and `oauth/`);
    /// every key when absent. `secrets/changed` is pushed for every key regardless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefixes: Option<Vec<String>>,
}

/// Result of `secrets/getAll`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetAllResult {
    /// Every stored credential, ordered by key.
    pub entries: Vec<SecretEntry>,
}

/// Parameters of `secrets/get`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetParams {
    /// The credential key.
    pub key: String,
}

/// Result of `secrets/get`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsGetResult {
    /// The entry; absent when nothing is stored under the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<SecretEntry>,
}

/// Parameters of `secrets/set`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsSetParams {
    /// The credential key.
    pub key: String,
    /// The new credential.
    pub value: Map<String, Value>,
    /// The lock covering `key`, when the write belongs to a locked read-modify-write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_id: Option<String>,
}

/// Result of `secrets/set`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsSetResult {
    /// The entry's new revision.
    pub revision: u64,
}

/// Parameters of `secrets/delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsDeleteParams {
    /// The credential key.
    pub key: String,
    /// The lock covering `key`, when the delete belongs to a locked read-modify-write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_id: Option<String>,
}

/// Result of `secrets/delete`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsDeleteResult {
    /// The revision of the removal; absent when nothing was stored under the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// Parameters of `secrets/lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsLockParams {
    /// The keys the holder may write, for example `provider/<id>` and `oauth/<id>` of one
    /// model provider. Taken together; the request waits while any of them is locked.
    pub keys: Vec<String>,
}

/// Result of `secrets/lock`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsLockResult {
    /// Passed to `secrets/set`, `secrets/delete` and `secrets/unlock`.
    pub lock_id: String,
    /// The current entries of the locked keys that exist.
    pub entries: Vec<SecretEntry>,
    /// Core releases the lock on its own after this many milliseconds.
    pub expires_in_ms: u64,
}

/// Parameters of `secrets/unlock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsUnlockParams {
    /// The lock to release.
    pub lock_id: String,
}

/// Result of `secrets/unlock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsUnlockResult {
    /// False when the lock was no longer held (expired or already released).
    pub released: bool,
}

/// Parameters of `secrets/changed` (Core → Agent Host): one key changed in the vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsChangedParams {
    /// The credential key.
    pub key: String,
    /// The revision of the change.
    pub revision: u64,
    /// The new credential; absent when the key was deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Map<String, Value>>,
}

request!(
    /// Method marker for `secrets/getAll` (Agent Host → Core).
    SecretsGetAll, "secrets/getAll", SecretsGetAllParams, SecretsGetAllResult
);
request!(
    /// Method marker for `secrets/get` (Agent Host → Core).
    SecretsGet, "secrets/get", SecretsGetParams, SecretsGetResult
);
request!(
    /// Method marker for `secrets/set` (Agent Host → Core).
    SecretsSet, "secrets/set", SecretsSetParams, SecretsSetResult
);
request!(
    /// Method marker for `secrets/delete` (Agent Host → Core).
    SecretsDelete, "secrets/delete", SecretsDeleteParams, SecretsDeleteResult
);
request!(
    /// Method marker for `secrets/lock` (Agent Host → Core).
    SecretsLock, "secrets/lock", SecretsLockParams, SecretsLockResult
);
request!(
    /// Method marker for `secrets/unlock` (Agent Host → Core).
    SecretsUnlock, "secrets/unlock", SecretsUnlockParams, SecretsUnlockResult
);

/// Method marker for `secrets/changed` (Core → Agent Host notification).
#[derive(Debug, Clone, Copy)]
pub struct SecretsChanged;

impl Method for SecretsChanged {
    const NAME: &'static str = "secrets/changed";
    const TYPE_NAME: &'static str = "SecretsChanged";
}

impl NotificationMethod for SecretsChanged {
    type Params = SecretsChangedParams;
}
