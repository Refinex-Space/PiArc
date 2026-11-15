//! The application identifier: the single definition that names PiArc to the operating
//! system (macOS bundle id, Windows AppUserModelID) and prefixes its credential store items.
//!
//! The product owner has not chosen it yet (requirement D2 in `docs/product/REQUIREMENTS.md`
//! section 7: it must match a domain the project owns, so it cannot be picked on their
//! behalf). Until then [`APP_IDENTIFIER`] is a placeholder that is visibly not a reverse-DNS
//! name. Changing it later moves the master key to another service name, so builds that
//! stored credentials under the placeholder need a migration (`docs/plan/PLAN.md`).

use piarc_ports::SecretName;

/// The application identifier (placeholder until D2 is decided).
pub const APP_IDENTIFIER: &str = "PiArc.pending-D2";

/// Where the credential vault's master key lives in the system credential store:
/// service `<APP_IDENTIFIER>.credential-vault`, account `master-key`.
#[must_use]
pub fn master_key_name() -> SecretName {
    piarc_secrets::master_key_name(APP_IDENTIFIER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_credential_service_is_prefixed_with_the_application_identifier() {
        let name = master_key_name();
        assert!(name.service.starts_with(APP_IDENTIFIER));
        assert_eq!(name.service, format!("{APP_IDENTIFIER}.credential-vault"));
        assert!(!name.service.starts_with(piarc_secrets::TEST_SERVICE_PREFIX));
    }
}
