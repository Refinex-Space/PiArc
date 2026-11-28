//! Scenario format for T29's provider sign-in: the mock authorization server, the flow of the
//! test OAuth provider every Agent Host registers, and the sign-in actions. The schema is in
//! `tests/scenarios/schema.json`.

use serde::Deserialize;

/// How the test provider signs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFlow {
    /// The authorization page redirects to the Agent Host's loopback server.
    AuthorizationCode,
    /// A code entered elsewhere, then polling.
    DeviceCode,
}

/// The scenario's mock authorization server and test provider (`piarc-test-oauth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthSpec {
    pub flow: OAuthFlow,
}

/// The user's decision at the authorization server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInBehavior {
    Approve,
    Deny,
    Expire,
}

/// How a sign-in ends (`core/login`'s last state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

impl SignInOutcome {
    #[must_use]
    pub fn state(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Signs in to the test provider: the runner plays the browser (follows the authorization
/// page's redirect) and checks the outcome and whether the provider is signed in afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignInAction {
    pub behavior: SignInBehavior,
    /// Cancel at the first step instead of finishing.
    #[serde(default)]
    pub cancel: bool,
    pub outcome: SignInOutcome,
    /// Text the final message must contain.
    #[serde(default)]
    pub message: Option<String>,
}
