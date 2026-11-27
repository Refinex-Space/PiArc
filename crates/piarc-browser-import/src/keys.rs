//! Where Chrome's cookie key comes from. [`SystemKey`] asks the system once per import, after
//! the user confirmed it in PiArc: macOS reads the login keychain's "Chrome Safe Storage"
//! password (the system shows its own prompt; PiArc's dialog recommends "Allow", not "Always
//! Allow") and derives the AES-128 key; Windows decrypts `Local State`'s
//! `os_crypt.encrypted_key` with DPAPI (the current user's key, no prompt). Tests and the
//! development builds' L4 use [`FixedKey`].

use std::path::Path;

use base64::Engine;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::crypto::{ChromeKey, mac_key};
use crate::error::{Error, KeyProblem, Result};

/// The keychain item of Chrome's password (macOS).
pub const KEYCHAIN_SERVICE: &str = "Chrome Safe Storage";
/// The keychain account of Chrome's password (macOS).
pub const KEYCHAIN_ACCOUNT: &str = "Chrome";
/// The password behind [`test_key`]: fixtures encrypt with it.
pub const TEST_PASSWORD: &[u8] = b"piarc-test-chrome";
/// The prefix of a DPAPI-protected key in `Local State`.
const DPAPI_PREFIX: &[u8] = b"DPAPI";

/// A source of the key for the Chrome data folder `root`.
pub trait KeySource: Send + Sync {
    /// The key; called once per import, after the user's confirmation.
    ///
    /// # Errors
    ///
    /// [`Error::Key`] when the system store refuses or has no key; [`Error::Unsupported`].
    fn key(&self, root: &Path) -> Result<ChromeKey>;
}

/// A key given up front (tests, development builds' L4).
#[derive(Debug, Clone)]
pub struct FixedKey(pub ChromeKey);

impl KeySource for FixedKey {
    fn key(&self, _root: &Path) -> Result<ChromeKey> {
        Ok(self.0.clone())
    }
}

/// This platform's scheme keyed from [`TEST_PASSWORD`]: the macOS derivation, or on Windows
/// SHA-256 of the password as the AES-256 key.
#[must_use]
pub fn test_key() -> ChromeKey {
    if cfg!(windows) {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(TEST_PASSWORD);
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&digest);
        ChromeKey::Gcm(key)
    } else {
        mac_key(TEST_PASSWORD)
    }
}

/// The system's key: the keychain (macOS) or DPAPI (Windows).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemKey;

impl KeySource for SystemKey {
    #[cfg(target_os = "macos")]
    fn key(&self, _root: &Path) -> Result<ChromeKey> {
        let password =
            security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
                .map_err(|error| keychain_error(error.code()))?;
        let password = Zeroizing::new(password);
        Ok(mac_key(&password))
    }

    #[cfg(windows)]
    fn key(&self, root: &Path) -> Result<ChromeKey> {
        let protected = protected_key(root)?;
        let key = crate::dpapi::unprotect(&protected).map_err(|code| {
            Error::key(
                KeyProblem::Unavailable,
                format!("Windows could not decrypt Chrome's key (DPAPI error {code})"),
            )
        })?;
        gcm_key(&key)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn key(&self, _root: &Path) -> Result<ChromeKey> {
        Err(Error::Unsupported)
    }
}

/// The error for a keychain status code (`OSStatus`).
#[cfg_attr(
    all(not(target_os = "macos"), not(test)),
    expect(dead_code, reason = "the keychain is read on macOS only")
)]
pub(crate) fn keychain_error(code: i32) -> Error {
    match code {
        // errSecItemNotFound
        -25_300 => Error::key(
            KeyProblem::Missing,
            "The keychain has no \"Chrome Safe Storage\" item; open Chrome once and try again",
        ),
        // errSecUserCanceled, errSecAuthFailed
        -128 | -25_293 => Error::key(
            KeyProblem::Denied,
            "Access to \"Chrome Safe Storage\" in the keychain was not allowed",
        ),
        _ => Error::key(
            KeyProblem::Unavailable,
            format!("The keychain could not be read (status {code})"),
        ),
    }
}

/// The DPAPI-protected key in `<root>/Local State` (`os_crypt.encrypted_key`, base64 of
/// `DPAPI` and the protected bytes), without the prefix.
///
/// # Errors
///
/// [`Error::Key`] with [`KeyProblem::Missing`] or [`KeyProblem::Invalid`].
pub fn protected_key(root: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let missing = || Error::key(KeyProblem::Missing, "Chrome's Local State has no key");
    let text = std::fs::read_to_string(root.join("Local State")).map_err(|_| missing())?;
    let state: Value = serde_json::from_str(&text).map_err(|_| missing())?;
    let encoded = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or_else(missing)?;
    let decoded = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| Error::key(KeyProblem::Invalid, "Chrome's key is not base64"))?,
    );
    let Some(body) = decoded.strip_prefix(DPAPI_PREFIX) else {
        return Err(Error::key(
            KeyProblem::Invalid,
            "Chrome's key is not DPAPI-protected",
        ));
    };
    Ok(Zeroizing::new(body.to_vec()))
}

/// An AES-256-GCM key from the unprotected bytes.
///
/// # Errors
///
/// [`Error::Key`] with [`KeyProblem::Invalid`] unless there are 32 bytes.
#[cfg_attr(
    all(not(windows), not(test)),
    expect(dead_code, reason = "DPAPI keys exist on Windows only")
)]
pub(crate) fn gcm_key(bytes: &[u8]) -> Result<ChromeKey> {
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| Error::key(KeyProblem::Invalid, "Chrome's key has the wrong length"))?;
    Ok(ChromeKey::Gcm(Zeroizing::new(array)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_statuses_map_to_problems() {
        let reason = |code| keychain_error(code).reason();
        assert_eq!(reason(-25_300), "keyMissing");
        assert_eq!(reason(-128), "keychainDenied");
        assert_eq!(reason(-25_293), "keychainDenied");
        assert_eq!(reason(-25_308), "keyUnavailable");
    }

    #[test]
    fn local_state_key_is_read_and_checked() {
        let root = std::env::temp_dir().join(format!("piarc-local-state-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        let write = |encoded: &str| {
            std::fs::write(
                root.join("Local State"),
                serde_json::json!({ "os_crypt": { "encrypted_key": encoded } }).to_string(),
            )
            .expect("local state");
        };
        let engine = base64::engine::general_purpose::STANDARD;
        write(&engine.encode(b"DPAPIprotected bytes"));
        assert_eq!(
            protected_key(&root).expect("key").as_slice(),
            b"protected bytes"
        );
        write(&engine.encode(b"APPB-app-bound"));
        assert_eq!(
            protected_key(&root).expect_err("prefix").reason(),
            "keyInvalid"
        );
        write("%%%");
        assert_eq!(
            protected_key(&root).expect_err("base64").reason(),
            "keyInvalid"
        );
        std::fs::remove_file(root.join("Local State")).expect("remove");
        assert_eq!(
            protected_key(&root).expect_err("missing").reason(),
            "keyMissing"
        );
        std::fs::remove_dir_all(&root).ok();
        assert!(gcm_key(&[0; 31]).is_err());
        assert!(matches!(gcm_key(&[0; 32]), Ok(ChromeKey::Gcm(_))));
    }

    #[test]
    fn the_test_key_follows_the_platform_scheme() {
        let key = FixedKey(test_key()).key(Path::new("/")).expect("key");
        if cfg!(windows) {
            assert!(matches!(key, ChromeKey::Gcm(_)));
        } else {
            assert!(matches!(key, ChromeKey::Cbc(_)));
        }
    }

    /// Windows: a key protected with DPAPI for this user, in Local State's form, decrypts
    /// through [`SystemKey`]; a value sealed under it then opens with AES-256-GCM.
    #[cfg(windows)]
    #[test]
    fn dpapi_protected_local_state_key_opens_v10_values() {
        let root = std::env::temp_dir().join(format!("piarc-dpapi-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        let raw = [42u8; 32];
        let mut stored = DPAPI_PREFIX.to_vec();
        stored.extend_from_slice(&crate::dpapi::protect(&raw).expect("protect"));
        std::fs::write(
            root.join("Local State"),
            serde_json::json!({
                "os_crypt": {
                    "encrypted_key": base64::engine::general_purpose::STANDARD.encode(stored)
                }
            })
            .to_string(),
        )
        .expect("local state");
        let key = SystemKey.key(&root).expect("DPAPI key");
        let sealed = crate::crypto::seal(
            &ChromeKey::Gcm(Zeroizing::new(raw)),
            "windows-value",
            ".win.test",
            24,
            [9; 12],
        );
        assert_eq!(
            crate::crypto::open(&key, &sealed, ".win.test", 24)
                .expect("opens")
                .as_str(),
            "windows-value"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
