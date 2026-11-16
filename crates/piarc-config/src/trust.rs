//! The one trust query every consumer of project-level executable configuration goes
//! through (hooks, MCP servers, permission allow rules, plugins, Pi extensions): see this
//! crate's `CLAUDE.md`.
//!
//! The decision itself lives in Core (the store, keyed by the repository's main checkout);
//! Core implements [`TrustLookup`]. This module turns every failure into "not trusted".

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

/// Whether a project's executable configuration may be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrustState {
    /// The user trusted the project (its main checkout).
    Trusted,
    /// Not trusted: no decision, denied, revoked, or the answer could not be determined.
    Untrusted,
}

impl TrustState {
    /// `true` for [`TrustState::Trusted`].
    #[must_use]
    pub fn is_trusted(self) -> bool {
        self == Self::Trusted
    }
}

/// Answers whether the project containing a directory is trusted. Implemented by Core.
pub trait TrustLookup: Send + Sync {
    /// `Ok(true)` only for a recorded "trusted" decision of the directory's main checkout.
    ///
    /// # Errors
    ///
    /// Any failure; the caller treats it as not trusted.
    fn lookup(&self, dir: &Path) -> Result<bool, String>;
}

/// The trust query. Errors and panics of `lookup` are [`TrustState::Untrusted`]; `on_error`
/// receives the reason so the caller can log it.
pub fn project_trust(
    lookup: &dyn TrustLookup,
    dir: &Path,
    on_error: &mut dyn FnMut(&str),
) -> TrustState {
    match catch_unwind(AssertUnwindSafe(|| lookup.lookup(dir))) {
        Ok(Ok(true)) => TrustState::Trusted,
        Ok(Ok(false)) => TrustState::Untrusted,
        Ok(Err(reason)) => {
            on_error(&reason);
            TrustState::Untrusted
        }
        Err(_) => {
            on_error("the trust lookup panicked");
            TrustState::Untrusted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Result<bool, String>);

    impl TrustLookup for Fixed {
        fn lookup(&self, _dir: &Path) -> Result<bool, String> {
            self.0.clone()
        }
    }

    struct Panics;

    impl TrustLookup for Panics {
        fn lookup(&self, _dir: &Path) -> Result<bool, String> {
            panic!("broken lookup")
        }
    }

    #[test]
    fn only_a_positive_answer_trusts() {
        let mut errors = Vec::new();
        let mut log = |e: &str| errors.push(e.to_owned());
        let dir = Path::new("/w");
        assert_eq!(
            project_trust(&Fixed(Ok(true)), dir, &mut log),
            TrustState::Trusted
        );
        assert_eq!(
            project_trust(&Fixed(Ok(false)), dir, &mut log),
            TrustState::Untrusted
        );
        assert_eq!(
            project_trust(&Fixed(Err("store closed".into())), dir, &mut log),
            TrustState::Untrusted
        );
        assert_eq!(project_trust(&Panics, dir, &mut log), TrustState::Untrusted);
        assert_eq!(errors, ["store closed", "the trust lookup panicked"]);
    }
}
