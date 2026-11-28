//! The application identifier: the single definition that names PiArc to the operating
//! system (macOS bundle id, Windows AppUserModelID) and prefixes its credential store items.
//!
//! Decided by the product owner as requirement D2 (`docs/product/REQUIREMENTS.md` section 7):
//! the product domain `piarc.cn`, reversed. Once released it must not change: the operating
//! systems treat a new identifier as another application, so the master key, Keychain grants
//! and notification settings would be lost.

use piarc_ports::SecretName;

/// The application identifier: macOS bundle id and Windows AppUserModelID (D2).
pub const APP_IDENTIFIER: &str = "cn.piarc.desktop";

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
        assert_eq!(name.service, "cn.piarc.desktop.credential-vault");
        assert!(!name.service.starts_with(piarc_secrets::TEST_SERVICE_PREFIX));
    }
}
