//! The libghostty-vt artefact lock (`ghostty-vt.lock.json`) and the two checks every artefact
//! passes before it is linked: its SHA-256 against the locked digest, and its detached minisign
//! signature against the locked public key (ADR-0017).
//!
//! `build.rs` uses this module to verify downloaded or cached artefacts; `src/lib.rs` includes
//! it under `cfg(test)` so the checks are unit-tested with a real signed file.

use std::fmt;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The parsed lock file.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lock {
    /// Free-form explanation kept in the file for reviewers.
    #[serde(rename = "$comment")]
    #[allow(
        dead_code,
        reason = "declared so deny_unknown_fields accepts it; only people read it"
    )]
    pub comment: Vec<String>,
    /// libghostty-vt version, for example `1.0.1`.
    pub version: String,
    /// Release directory; each artefact is `<baseUrl><file>`, its signature `<file>.minisig`.
    pub base_url: String,
    /// The release signing key in minisign's base64 form.
    pub minisign_public_key: String,
    /// One entry per downloadable archive.
    pub artifacts: Vec<Artifact>,
}

/// One prebuilt archive and how to link it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    /// File name in the release directory.
    pub file: String,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
    /// Rust target triples served by this archive.
    pub targets: Vec<String>,
    /// How the library is linked.
    pub link: Link,
    /// Directory inside the archive that holds the library to link.
    pub lib_dir: String,
    /// Directory inside the archive that holds `ghostty/vt.h`.
    pub include_dir: String,
    /// The DLL inside the archive, for [`Link::Dll`].
    #[serde(default)]
    pub dll: Option<String>,
}

/// Link mode of an artefact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Link {
    /// Static library (`libghostty-vt.a` from the XCFramework).
    Static,
    /// Import library plus a DLL that ships next to the binary (Windows MSVC).
    Dll,
}

impl Lock {
    /// Parses and sanity-checks the lock file.
    ///
    /// # Errors
    ///
    /// A message when the JSON does not match the schema, the base URL is not HTTPS, a digest is
    /// not 64 hex digits, a DLL artefact names no DLL, or a target appears twice.
    pub fn parse(text: &str) -> Result<Self, String> {
        let lock: Self = serde_json::from_str(text)
            .map_err(|error| format!("ghostty-vt.lock.json is invalid: {error}"))?;
        if !lock.base_url.starts_with("https://") || !lock.base_url.ends_with('/') {
            return Err("ghostty-vt.lock.json: baseUrl must be an https:// URL ending in /".into());
        }
        let mut seen = Vec::new();
        for artifact in &lock.artifacts {
            if artifact.sha256.len() != 64
                || !artifact
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(format!(
                    "ghostty-vt.lock.json: the sha256 of {} must be 64 lowercase hex digits",
                    artifact.file
                ));
            }
            if artifact.link == Link::Dll && artifact.dll.is_none() {
                return Err(format!(
                    "ghostty-vt.lock.json: {} links a DLL but names none",
                    artifact.file
                ));
            }
            for target in &artifact.targets {
                if seen.contains(target) {
                    return Err(format!(
                        "ghostty-vt.lock.json: target {target} appears in two artefacts"
                    ));
                }
                seen.push(target.clone());
            }
        }
        Ok(lock)
    }

    /// The artefact that serves `target`.
    #[must_use]
    pub fn artifact_for(&self, target: &str) -> Option<&Artifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.targets.iter().any(|t| t == target))
    }

    /// Every locked target triple, for error messages.
    #[must_use]
    pub fn targets(&self) -> Vec<&str> {
        self.artifacts
            .iter()
            .flat_map(|artifact| artifact.targets.iter().map(String::as_str))
            .collect()
    }
}

/// Why an artefact was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// The SHA-256 of the file differs from the locked digest.
    Digest {
        /// The locked digest.
        expected: String,
        /// The digest of the file on disk.
        actual: String,
    },
    /// The public key in the lock file cannot be decoded.
    PublicKey(String),
    /// The `.minisig` file cannot be decoded.
    SignatureFormat(String),
    /// The signature does not verify against the file and the locked key.
    Signature(String),
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Digest { expected, actual } => write!(
                f,
                "SHA-256 mismatch: ghostty-vt.lock.json expects {expected}, the file has {actual}"
            ),
            Self::PublicKey(reason) => {
                write!(
                    f,
                    "the minisign public key in ghostty-vt.lock.json is invalid: {reason}"
                )
            }
            Self::SignatureFormat(reason) => {
                write!(f, "the minisign signature file is malformed: {reason}")
            }
            Self::Signature(reason) => {
                write!(f, "minisign signature check failed: {reason}")
            }
        }
    }
}

/// Lowercase hex SHA-256 of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

/// Checks `data` (the content of `artifact.file`) against the locked digest, then against its
/// detached minisign signature `signature` (the text of `<file>.minisig`). Both must pass.
///
/// # Errors
///
/// The first check that fails, see [`VerifyError`].
pub fn verify(
    lock: &Lock,
    artifact: &Artifact,
    data: &[u8],
    signature: &str,
) -> Result<(), VerifyError> {
    let actual = sha256_hex(data);
    if actual != artifact.sha256 {
        return Err(VerifyError::Digest {
            expected: artifact.sha256.clone(),
            actual,
        });
    }
    verify_minisign(&lock.minisign_public_key, data, signature)
}

/// Verifies a minisign signature (`signature` is the full `.minisig` text) of `data` with the
/// base64 public key `public_key`. Only prehashed (`ED`) signatures are accepted: legacy
/// signatures are refused, as minisign itself does by default.
///
/// # Errors
///
/// [`VerifyError::PublicKey`], [`VerifyError::SignatureFormat`] or
/// [`VerifyError::Signature`].
pub fn verify_minisign(public_key: &str, data: &[u8], signature: &str) -> Result<(), VerifyError> {
    let key = minisign_verify::PublicKey::from_base64(public_key)
        .map_err(|error| VerifyError::PublicKey(error.to_string()))?;
    let signature = minisign_verify::Signature::decode(signature)
        .map_err(|error| VerifyError::SignatureFormat(error.to_string()))?;
    key.verify(data, &signature, false)
        .map_err(|error| VerifyError::Signature(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK: &str = include_str!("../ghostty-vt.lock.json");
    // The real SHA256SUMS of the 1.0.1 release and its signature by the release key.
    const SUMS: &str = include_str!("../tests/fixtures/SHA256SUMS");
    const SUMS_SIG: &str = include_str!("../tests/fixtures/SHA256SUMS.minisig");

    fn sums_artifact() -> Artifact {
        Artifact {
            file: "SHA256SUMS".into(),
            sha256: sha256_hex(SUMS.as_bytes()),
            targets: Vec::new(),
            link: Link::Static,
            lib_dir: String::new(),
            include_dir: String::new(),
            dll: None,
        }
    }

    #[test]
    fn the_committed_lock_parses_and_covers_the_four_targets() {
        let lock = Lock::parse(LOCK).expect("the committed lock file is valid");
        for target in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
        ] {
            assert!(
                lock.artifact_for(target).is_some(),
                "{target} is not locked"
            );
        }
    }

    #[test]
    fn locked_digests_match_the_signed_sha256sums() {
        // SHA256SUMS is what the release key signs; every locked digest must appear in it.
        let lock = Lock::parse(LOCK).expect("valid lock");
        verify_minisign(&lock.minisign_public_key, SUMS.as_bytes(), SUMS_SIG)
            .expect("SHA256SUMS carries a valid signature");
        for artifact in &lock.artifacts {
            let line = format!("{}  {}", artifact.sha256, artifact.file);
            assert!(
                SUMS.lines().any(|l| l == line),
                "{line} is not in SHA256SUMS"
            );
        }
    }

    #[test]
    fn a_genuine_file_passes_both_checks() {
        let lock = Lock::parse(LOCK).expect("valid lock");
        assert_eq!(
            verify(&lock, &sums_artifact(), SUMS.as_bytes(), SUMS_SIG),
            Ok(())
        );
    }

    #[test]
    fn a_changed_byte_fails_the_digest_check() {
        let lock = Lock::parse(LOCK).expect("valid lock");
        let mut data = SUMS.as_bytes().to_vec();
        data[0] ^= 1;
        let error = verify(&lock, &sums_artifact(), &data, SUMS_SIG).expect_err("rejected");
        assert!(matches!(error, VerifyError::Digest { .. }), "{error}");
        assert!(error.to_string().contains("SHA-256 mismatch"));
    }

    #[test]
    fn a_matching_digest_with_a_bad_signature_is_rejected() {
        // The digest check passes (the lock was edited along with the file), so only the
        // signature can catch the substitution.
        let lock = Lock::parse(LOCK).expect("valid lock");
        let mut data = SUMS.as_bytes().to_vec();
        data[0] ^= 1;
        let mut artifact = sums_artifact();
        artifact.sha256 = sha256_hex(&data);
        let error = verify(&lock, &artifact, &data, SUMS_SIG).expect_err("rejected");
        assert!(matches!(error, VerifyError::Signature(_)), "{error}");
    }

    #[test]
    fn a_tampered_signature_is_rejected() {
        let lock = Lock::parse(LOCK).expect("valid lock");
        let mut lines: Vec<String> = SUMS_SIG.lines().map(str::to_owned).collect();
        // Line 2 is the base64 signature; swapping two characters keeps it decodable.
        let mut chars: Vec<char> = lines[1].chars().collect();
        chars.swap(20, 21);
        lines[1] = chars.into_iter().collect();
        let tampered = lines.join("\n");
        let error =
            verify(&lock, &sums_artifact(), SUMS.as_bytes(), &tampered).expect_err("rejected");
        assert!(
            matches!(
                error,
                VerifyError::Signature(_) | VerifyError::SignatureFormat(_)
            ),
            "{error}"
        );
    }

    #[test]
    fn a_tampered_trusted_comment_is_rejected() {
        let lock = Lock::parse(LOCK).expect("valid lock");
        let tampered = SUMS_SIG.replace("file:SHA256SUMS", "file:SHA256SUMX");
        let error =
            verify(&lock, &sums_artifact(), SUMS.as_bytes(), &tampered).expect_err("rejected");
        assert!(matches!(error, VerifyError::Signature(_)), "{error}");
    }

    #[test]
    fn another_key_is_rejected() {
        let lock = Lock::parse(LOCK).expect("valid lock");
        // A syntactically valid key with a different key id and key.
        let mut key: Vec<char> = lock.minisign_public_key.chars().collect();
        key[5] = if key[5] == 'A' { 'B' } else { 'A' };
        let key: String = key.into_iter().collect();
        let error = verify_minisign(&key, SUMS.as_bytes(), SUMS_SIG).expect_err("rejected");
        assert!(
            matches!(error, VerifyError::Signature(_) | VerifyError::PublicKey(_)),
            "{error}"
        );
    }

    #[test]
    fn the_lock_rejects_plain_http_and_bad_digests() {
        let http = LOCK.replace("https://release", "http://release");
        assert!(Lock::parse(&http).is_err());
        let short = LOCK.replace(
            "c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b",
            "c0f9",
        );
        assert!(Lock::parse(&short).is_err());
    }
}
