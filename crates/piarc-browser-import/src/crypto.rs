//! Chrome's cookie encryption (`os_crypt`), the parts PiArc reads:
//!
//! - **macOS `v10`**: AES-128-CBC with PKCS#7 padding, IV of 16 spaces; the key is
//!   PBKDF2-HMAC-SHA1 of the keychain's "Chrome Safe Storage" password, salt `saltysalt`, 1003
//!   iterations ([`mac_key`]).
//! - **Windows `v10`**: AES-256-GCM, 12-byte nonce after the prefix, 16-byte tag at the end;
//!   the key is DPAPI-protected in `Local State` (`crate::keys`).
//! - **Windows `v20`** (App-Bound encryption): the key is bound to Chrome's own service; PiArc
//!   reports each such cookie as [`Skip::AppBound`].
//! - From cookie database version 24 the plaintext starts with SHA-256 of the cookie's
//!   `host_key`; it is checked and removed ([`DOMAIN_HASH_VERSION`]).
//!
//! Keys and plaintexts live in [`Zeroizing`] buffers. [`seal`] is the inverse of [`open`], for
//! fixtures: tests encrypt with the same scheme and a test key, then import.

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::aes::Aes128;
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

/// The cookie database version from which values carry the domain hash.
pub const DOMAIN_HASH_VERSION: i64 = 24;
/// PBKDF2 salt of macOS Chrome's key.
pub const MAC_SALT: &[u8] = b"saltysalt";
/// PBKDF2 iterations of macOS Chrome's key.
pub const MAC_ITERATIONS: u32 = 1003;
const MAC_IV: [u8; 16] = [b' '; 16];
const V10: &[u8] = b"v10";
const V20: &[u8] = b"v20";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HASH_LEN: usize = 32;

/// Chrome's cookie key, by scheme. `Debug` never shows the bytes.
#[derive(Clone)]
pub enum ChromeKey {
    /// macOS: AES-128-CBC.
    Cbc(Zeroizing<[u8; 16]>),
    /// Windows: AES-256-GCM.
    Gcm(Zeroizing<[u8; 32]>),
}

impl std::fmt::Debug for ChromeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Cbc(_) => "ChromeKey::Cbc(..)",
            Self::Gcm(_) => "ChromeKey::Gcm(..)",
        })
    }
}

/// Why one cookie was not imported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Skip {
    /// Its expiry is past.
    Expired,
    /// `v20`: App-Bound encryption (Windows), which PiArc cannot decrypt.
    AppBound,
    /// The key does not open it, or the domain hash does not match.
    Undecryptable,
    /// A prefix PiArc does not know (`v11` of Linux, no prefix).
    UnknownFormat,
    /// A partitioned (CHIPS) cookie: the browser cannot take it as a plain cookie.
    Partitioned,
    /// The plaintext is not text.
    Invalid,
}

/// The macOS key from the keychain password.
#[must_use]
pub fn mac_key(password: &[u8]) -> ChromeKey {
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, MAC_SALT, MAC_ITERATIONS, key.as_mut_slice());
    ChromeKey::Cbc(key)
}

/// The plaintext of one `encrypted_value`.
///
/// # Errors
///
/// The [`Skip`] reason when the value cannot be had.
pub fn open(
    key: &ChromeKey,
    encrypted: &[u8],
    host_key: &str,
    db_version: i64,
) -> Result<Zeroizing<String>, Skip> {
    if encrypted.starts_with(V20) {
        return Err(Skip::AppBound);
    }
    let Some(body) = encrypted.strip_prefix(V10) else {
        return Err(Skip::UnknownFormat);
    };
    let mut plain = match key {
        ChromeKey::Cbc(key) => open_cbc(key, body)?,
        ChromeKey::Gcm(key) => open_gcm(key, body)?,
    };
    if db_version >= DOMAIN_HASH_VERSION {
        let hash = Sha256::digest(host_key.as_bytes());
        if plain.len() < HASH_LEN || plain[..HASH_LEN] != hash[..] {
            return Err(Skip::Undecryptable);
        }
        plain.copy_within(HASH_LEN.., 0);
        let len = plain.len() - HASH_LEN;
        plain[len..].zeroize();
        plain.truncate(len);
    }
    let bytes = std::mem::take(&mut *plain);
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Zeroizing::new(text)),
        Err(error) => {
            error.into_bytes().zeroize();
            Err(Skip::Invalid)
        }
    }
}

fn open_cbc(key: &[u8; 16], body: &[u8]) -> Result<Zeroizing<Vec<u8>>, Skip> {
    let mut buf = Zeroizing::new(body.to_vec());
    let len = cbc::Decryptor::<Aes128>::new(key.into(), &MAC_IV.into())
        .decrypt_padded::<Pkcs7>(&mut buf)
        .map_err(|_| Skip::Undecryptable)?
        .len();
    buf[len..].zeroize();
    buf.truncate(len);
    Ok(buf)
}

fn open_gcm(key: &[u8; 32], body: &[u8]) -> Result<Zeroizing<Vec<u8>>, Skip> {
    if body.len() < NONCE_LEN + TAG_LEN {
        return Err(Skip::Undecryptable);
    }
    let (nonce, rest) = body.split_at(NONCE_LEN);
    let (ciphertext, tag) = rest.split_at(rest.len() - TAG_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| Skip::Undecryptable)?;
    let tag: [u8; TAG_LEN] = tag.try_into().map_err(|_| Skip::Undecryptable)?;
    let mut buf = Zeroizing::new(ciphertext.to_vec());
    Aes256Gcm::new(key.into())
        .decrypt_inout_detached(
            &Nonce::from(nonce),
            &[],
            buf.as_mut_slice().into(),
            &Tag::from(tag),
        )
        .map_err(|_| Skip::Undecryptable)?;
    Ok(buf)
}

/// Encrypts `value` the way Chrome does under `key` (the inverse of [`open`]): for fixtures.
/// `nonce` is used by the GCM scheme only.
#[must_use]
pub fn seal(
    key: &ChromeKey,
    value: &str,
    host_key: &str,
    db_version: i64,
    nonce: [u8; NONCE_LEN],
) -> Vec<u8> {
    let mut plain = Vec::new();
    if db_version >= DOMAIN_HASH_VERSION {
        plain.extend_from_slice(&Sha256::digest(host_key.as_bytes()));
    }
    plain.extend_from_slice(value.as_bytes());
    let mut out = V10.to_vec();
    match key {
        ChromeKey::Cbc(key) => {
            let len = plain.len();
            plain.resize(len + 16 - len % 16, 0);
            if let Ok(sealed) = cbc::Encryptor::<Aes128>::new((&**key).into(), &MAC_IV.into())
                .encrypt_padded::<Pkcs7>(&mut plain, len)
            {
                out.extend_from_slice(sealed);
            }
        }
        ChromeKey::Gcm(key) => {
            out.extend_from_slice(&nonce);
            if let Ok(tag) = Aes256Gcm::new((&**key).into()).encrypt_inout_detached(
                &Nonce::from(nonce),
                &[],
                plain.as_mut_slice().into(),
            ) {
                out.extend_from_slice(&plain);
                out.extend_from_slice(&tag);
            }
        }
    }
    plain.zeroize();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gcm_key() -> ChromeKey {
        ChromeKey::Gcm(Zeroizing::new([7u8; 32]))
    }

    #[test]
    fn mac_key_is_pbkdf2_sha1_of_the_password() {
        // RFC 6070 has no 1003-round vector; derive the same key with `pbkdf2` directly and
        // check the parameters Chrome uses (salt, rounds, length).
        let mut expected = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1003, &mut expected);
        let ChromeKey::Cbc(key) = mac_key(b"peanuts") else {
            panic!("macOS keys are CBC keys");
        };
        assert_eq!(*key, expected);
        // Chrome's well-known Linux fallback key (password "peanuts", 1 round) differs:
        // the round count matters.
        let mut one_round = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut one_round);
        assert_ne!(*key, one_round);
    }

    #[test]
    fn v10_cbc_round_trip_before_and_after_the_domain_hash() {
        let key = mac_key(b"test password");
        for version in [23, 24] {
            let sealed = seal(&key, "session=abc;中文", ".example.test", version, [0; 12]);
            assert!(sealed.starts_with(b"v10"));
            let value = open(&key, &sealed, ".example.test", version).expect("opens");
            assert_eq!(value.as_str(), "session=abc;中文");
        }
    }

    #[test]
    fn the_domain_hash_is_stripped_only_from_version_24() {
        let key = mac_key(b"pw");
        let with_hash = seal(&key, "v", "a.test", 24, [0; 12]);
        // Read as an older database, the 32 hash bytes stay in front: not valid text.
        assert_eq!(open(&key, &with_hash, "a.test", 23), Err(Skip::Invalid));
        // The hash binds the value to its host.
        assert_eq!(
            open(&key, &with_hash, "b.test", 24),
            Err(Skip::Undecryptable)
        );
        let without = seal(
            &key,
            "a value longer than thirty-two bytes!!",
            "a.test",
            23,
            [0; 12],
        );
        assert_eq!(open(&key, &without, "a.test", 24), Err(Skip::Undecryptable));
    }

    #[test]
    fn v10_gcm_round_trip_and_tampering() {
        let key = gcm_key();
        let sealed = seal(&key, "token", ".site.test", 24, [3; 12]);
        assert_eq!(
            open(&key, &sealed, ".site.test", 24)
                .expect("opens")
                .as_str(),
            "token"
        );
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(
            open(&key, &tampered, ".site.test", 24),
            Err(Skip::Undecryptable)
        );
        let other = ChromeKey::Gcm(Zeroizing::new([8u8; 32]));
        assert_eq!(
            open(&other, &sealed, ".site.test", 24),
            Err(Skip::Undecryptable)
        );
        assert_eq!(
            open(&key, b"v10short", ".site.test", 24),
            Err(Skip::Undecryptable)
        );
    }

    #[test]
    fn wrong_cbc_key_and_unknown_prefixes_are_skipped() {
        let sealed = seal(&mac_key(b"right"), "x", "h", 24, [0; 12]);
        assert_eq!(open(&mac_key(b"wrong"), &sealed, "h", 24).ok(), None);
        assert_eq!(
            open(&mac_key(b"right"), b"v11abc", "h", 24),
            Err(Skip::UnknownFormat)
        );
        assert_eq!(
            open(&mac_key(b"right"), b"", "h", 24),
            Err(Skip::UnknownFormat)
        );
    }

    #[test]
    fn v20_app_bound_values_are_reported_unsupported() {
        let mut value = b"v20".to_vec();
        value.extend_from_slice(&[0u8; 60]);
        assert_eq!(open(&gcm_key(), &value, "h", 24), Err(Skip::AppBound));
        assert_eq!(open(&mac_key(b"p"), &value, "h", 24), Err(Skip::AppBound));
    }

    #[test]
    fn thr17_keys_do_not_print_their_bytes() {
        assert_eq!(format!("{:?}", mac_key(b"secret")), "ChromeKey::Cbc(..)");
        assert_eq!(format!("{:?}", gcm_key()), "ChromeKey::Gcm(..)");
    }

    #[test]
    fn thr17_plaintext_buffers_are_zeroized() {
        // `Zeroizing` clears on drop; check the type keeps the value until then and that a
        // cleared buffer is empty (the drop path is zeroize's own, tested upstream).
        let key = mac_key(b"pw");
        let sealed = seal(&key, "secret-value", "h", 24, [0; 12]);
        let mut value = open(&key, &sealed, "h", 24).expect("opens");
        assert_eq!(value.as_str(), "secret-value");
        value.zeroize();
        assert!(value.is_empty());
    }
}
