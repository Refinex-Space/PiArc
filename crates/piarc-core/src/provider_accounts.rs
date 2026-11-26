//! The signed-in accounts of a provider (ADR-0083). Pi keeps one credential per provider, so one
//! account is in use at a time: its token is at `oauth/<provider>`, where Pi reads it. The other
//! accounts' tokens are aside at `account/<provider>/<id>`, a prefix only Core reads. The public
//! details (id, name, whether in use) are in the user's `modelProviders.accounts`.
//!
//! Every function changes the vault first and the settings in memory; the caller persists the
//! settings afterwards. Switching writes `oauth/<provider>`, which reaches the running Agent
//! Hosts as `secrets/changed`: their next request uses the account now in use.
use piarc_protocol::models::LoginProvider;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{Error, Result};
use crate::providers::Settings;
use crate::secrets::SecretsService;

/// An account as the settings record it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub(crate) provider: String,
    pub(crate) id: String,
    /// An email or a user name, as the credential told it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    /// Whether its token is the one at `oauth/<provider>`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) active: bool,
}

/// The id the settings window sees for a sign-in made before accounts were recorded.
pub(crate) const CURRENT: &str = "current";

fn in_use_key(provider: &str) -> String {
    format!("oauth/{provider}")
}

fn aside_key(provider: &str, id: &str) -> String {
    format!("account/{provider}/{id}")
}

fn vault(error: piarc_protocol::ErrorObject) -> Error {
    Error::feature(&error)
}

fn no_account() -> Error {
    Error::InvalidArgument {
        field: "account",
        reason: "no such signed-in account".into(),
    }
}

async fn token(secrets: &SecretsService, key: &str) -> Result<Option<Map<String, Value>>> {
    secrets.value_of(key).await.map_err(vault)
}

async fn store(
    secrets: &SecretsService,
    key: &str,
    value: Option<Map<String, Value>>,
) -> Result<()> {
    secrets.store_value(key, value).await.map_err(vault)
}

/// Moves the account in use aside, if there is one, and records it as not in use (named
/// `label` when its record has no name yet). Answers its id, to put it back with [`put_back`].
pub(crate) async fn set_aside(
    secrets: &SecretsService,
    settings: &mut Settings,
    provider: &str,
    label: Option<&str>,
) -> Result<Option<String>> {
    let Some(value) = token(secrets, &in_use_key(provider)).await? else {
        // A record of an account in use without its token is stale.
        settings
            .accounts
            .retain(|a| !(a.provider == provider && a.active));
        return Ok(None);
    };
    let id = match settings
        .accounts
        .iter_mut()
        .find(|a| a.provider == provider && a.active)
    {
        Some(account) => {
            account.active = false;
            if account.label.is_none() {
                account.label = label.map(str::to_owned);
            }
            account.id.clone()
        }
        None => {
            let id = crate::sessions::new_session_id()?;
            settings.accounts.push(Account {
                provider: provider.to_owned(),
                id: id.clone(),
                label: label.map(str::to_owned),
                active: false,
            });
            id
        }
    };
    store(secrets, &aside_key(provider, &id), Some(value)).await?;
    Ok(Some(id))
}

/// Puts account `id` back in use: its token to `oauth/<provider>`, its aside entry removed.
pub(crate) async fn put_back(
    secrets: &SecretsService,
    settings: &mut Settings,
    provider: &str,
    id: &str,
) -> Result<()> {
    let value = token(secrets, &aside_key(provider, id))
        .await?
        .ok_or_else(no_account)?;
    store(secrets, &in_use_key(provider), Some(value)).await?;
    store(secrets, &aside_key(provider, id), None).await?;
    for account in settings
        .accounts
        .iter_mut()
        .filter(|a| a.provider == provider)
    {
        account.active = account.id == id;
    }
    Ok(())
}

/// After a sign-in: the new account is the one in use. An account aside with the same name is
/// the same account signed in again, and goes.
pub(crate) async fn signed_in(
    secrets: &SecretsService,
    settings: &mut Settings,
    provider: &str,
    label: Option<String>,
) -> Result<()> {
    settings
        .accounts
        .retain(|a| !(a.provider == provider && a.active));
    let same: Vec<String> = settings
        .accounts
        .iter()
        .filter(|a| a.provider == provider && label.is_some() && a.label == label)
        .map(|a| a.id.clone())
        .collect();
    for id in &same {
        store(secrets, &aside_key(provider, id), None).await?;
    }
    settings
        .accounts
        .retain(|a| !(a.provider == provider && same.contains(&a.id)));
    settings.accounts.push(Account {
        provider: provider.to_owned(),
        id: crate::sessions::new_session_id()?,
        label,
        active: true,
    });
    Ok(())
}

/// Makes account `id` (aside) the one in use; the one in use, named `in_use` when its record has
/// no name, moves aside.
pub(crate) async fn switch(
    secrets: &SecretsService,
    settings: &mut Settings,
    provider: &str,
    id: &str,
    in_use: Option<&str>,
) -> Result<()> {
    if !settings
        .accounts
        .iter()
        .any(|a| a.provider == provider && a.id == id && !a.active)
    {
        return Err(no_account());
    }
    set_aside(secrets, settings, provider, in_use).await?;
    put_back(secrets, settings, provider, id).await
}

/// Removes account `id`, which is aside: its token and its record.
pub(crate) async fn remove(
    secrets: &SecretsService,
    settings: &mut Settings,
    provider: &str,
    id: &str,
) -> Result<()> {
    if !settings
        .accounts
        .iter()
        .any(|a| a.provider == provider && a.id == id && !a.active)
    {
        return Err(no_account());
    }
    store(secrets, &aside_key(provider, id), None).await?;
    settings
        .accounts
        .retain(|a| !(a.provider == provider && a.id == id));
    Ok(())
}

/// After signing out of the account in use: its record goes (the accounts aside stay).
pub(crate) fn signed_out(settings: &mut Settings, provider: &str) {
    settings
        .accounts
        .retain(|a| !(a.provider == provider && a.active));
}

/// The accounts for the settings window. The account in use takes its name from the credential
/// when its record has none; a sign-in made before accounts were recorded shows as [`CURRENT`];
/// a record of an account in use whose provider is no longer signed in is left out.
pub(crate) fn view(accounts: &[Account], logins: &[LoginProvider]) -> Value {
    let signed_in = |provider: &str| logins.iter().any(|l| l.id == provider && l.signed_in);
    let mut out: Vec<Account> = accounts
        .iter()
        .filter(|a| !a.active || signed_in(&a.provider))
        .cloned()
        .collect();
    for login in logins.iter().filter(|l| l.signed_in) {
        match out.iter_mut().find(|a| a.provider == login.id && a.active) {
            Some(account) => {
                if account.label.is_none() {
                    account.label.clone_from(&login.account);
                }
            }
            None => out.push(Account {
                provider: login.id.clone(),
                id: CURRENT.to_owned(),
                label: login.account.clone(),
                active: true,
            }),
        }
    }
    json!(out)
}

#[cfg(test)]
#[path = "provider_accounts_tests.rs"]
mod tests;
