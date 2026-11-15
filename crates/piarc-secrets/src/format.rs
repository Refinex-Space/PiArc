//! The vault file format, version 1.
//!
//! ```text
//! offset  size  field
//!      0     8  magic "PIARCVLT"
//!      8     2  format version, little endian (1)
//!     10    16  master key id (see `MasterKey::id`)
//!     26    12  AES-GCM nonce, random for every write
//!     38     n  ciphertext of the plaintext document
//!   38+n    16  AES-GCM authentication tag
//! ```
//!
//! The 38-byte header is the AEAD associated data: changing any header byte, nonce,
//! ciphertext or tag byte makes decryption fail. A changed version field is reported as an
//! unknown version, because the version decides how the rest is read; a changed magic is
//! reported as an integrity failure.

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::master_key::{KEY_ID_LEN, MasterKey};
use crate::random;

/// First bytes of every vault file.
pub const MAGIC: [u8; 8] = *b"PIARCVLT";
/// The format version this build writes and reads.
pub const FORMAT_VERSION: u16 = 1;

const VERSION_AT: usize = MAGIC.len();
const KEY_ID_AT: usize = VERSION_AT + 2;
const NONCE_AT: usize = KEY_ID_AT + KEY_ID_LEN;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Length of the header (associated data).
pub const HEADER_LEN: usize = NONCE_AT + NONCE_LEN;

fn cipher(key: &MasterKey) -> Aes256Gcm {
    // A 32-byte key always has the right length for AES-256.
    Aes256Gcm::new(key.bytes().into())
}

/// Encrypts `plaintext` into a complete vault file under `key` with a fresh random nonce.
///
/// # Errors
///
/// [`Error::Random`] when no nonce can be drawn.
pub fn seal(key: &MasterKey, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    random::fill(&mut nonce)?;
    let mut file = Vec::with_capacity(HEADER_LEN + plaintext.len() + TAG_LEN);
    file.extend_from_slice(&MAGIC);
    file.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    file.extend_from_slice(key.id());
    file.extend_from_slice(&nonce);
    file.extend_from_slice(plaintext);
    let (header, body) = file.split_at_mut(HEADER_LEN);
    let tag = cipher(key)
        .encrypt_inout_detached(&Nonce::from(nonce), header, body.into())
        .map_err(|_| Error::Integrity {
            reason: "the plaintext is too long to encrypt",
            key_id_matches: None,
        })?;
    file.extend_from_slice(&tag);
    Ok(file)
}

/// Authenticates and decrypts a vault file under `key`. Nothing is returned unless the whole
/// file authenticates.
///
/// # Errors
///
/// [`Error::Integrity`] for a truncated or modified file, or one sealed under another key;
/// [`Error::UnsupportedVersion`] for a version other than [`FORMAT_VERSION`].
pub fn open(key: &MasterKey, file: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let integrity = |reason, key_id_matches| Error::Integrity {
        reason,
        key_id_matches,
    };
    if file.len() < KEY_ID_AT || file[..MAGIC.len()] != MAGIC {
        return Err(integrity("the file is not a PiArc credential vault", None));
    }
    let version = u16::from_le_bytes([file[VERSION_AT], file[VERSION_AT + 1]]);
    if version != FORMAT_VERSION {
        return Err(Error::UnsupportedVersion { version });
    }
    if file.len() < HEADER_LEN + TAG_LEN {
        return Err(integrity("the file is truncated", None));
    }
    let key_id_matches = file[KEY_ID_AT..NONCE_AT] == key.id()[..];
    let (header, rest) = file.split_at(HEADER_LEN);
    let (ciphertext, tag) = rest.split_at(rest.len() - TAG_LEN);
    let nonce: [u8; NONCE_LEN] = header[NONCE_AT..]
        .try_into()
        .map_err(|_| integrity("the nonce is malformed", Some(key_id_matches)))?;
    let tag: [u8; TAG_LEN] = tag
        .try_into()
        .map_err(|_| integrity("the tag is malformed", Some(key_id_matches)))?;
    let mut plaintext = Zeroizing::new(ciphertext.to_vec());
    cipher(key)
        .decrypt_inout_detached(
            &Nonce::from(nonce),
            header,
            plaintext.as_mut_slice().into(),
            &Tag::from(tag),
        )
        .map_err(|_| {
            integrity(
                if key_id_matches {
                    "authentication failed: the file was modified or damaged"
                } else {
                    "authentication failed: the file was sealed under another master key"
                },
                Some(key_id_matches),
            )
        })?;
    Ok(plaintext)
}
