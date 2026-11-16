//! Release manifest verification (ADR-0018 rule 4, ADR-0024): the last line of defence of an
//! update without platform code signing.
//!
//! A release publishes `piarc-release-manifest.json` (format [`MANIFEST_FORMAT`]: product,
//! version and every artefact's file name, size and SHA-256) and its minisign signature
//! `piarc-release-manifest.json.minisig` (prehashed Ed25519; written by
//! `scripts/release/release-manifest.mjs`). Before an update is offered or applied:
//!
//! 1. [`verify_manifest`] checks the signature against the trusted keys ([`TrustedKeys`]:
//!    the keys built into the app, [`BUILTIN_RELEASE_KEYS`]) and only then parses the manifest;
//! 2. [`verify_file`] checks each downloaded artefact's size and SHA-256 against its entry.
//!
//! Every failure is a [`ReleaseError`] whose kind is `releaseIntegrity` (or `ioError` when a
//! file cannot be read) with `details.reason`; callers refuse the update on any error. The
//! update flow itself (checking, prompting, Velopack) is T50's.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The `format` member of a manifest this build understands.
pub const MANIFEST_FORMAT: &str = "piarc-release-manifest/1";

/// Base64 minisign public keys whose signatures the app accepts. Empty until T50 generates the
/// release key in the protected release environment: with no key every manifest is refused
/// (fail closed). The test keys in `scripts/release/test-keys/` must never be listed here.
pub const BUILTIN_RELEASE_KEYS: &[&str] = &[];

/// One artefact of a release.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    /// File name, without directories.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

/// A verified release manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    /// [`MANIFEST_FORMAT`].
    pub format: String,
    /// `PiArc`.
    pub product: String,
    /// SemVer of the release.
    pub version: String,
    /// ISO 8601 time the manifest was generated.
    pub created_at: String,
    /// The artefacts.
    pub files: Vec<ManifestFile>,
}

impl ReleaseManifest {
    /// The entry of `name`.
    #[must_use]
    pub fn file(&self, name: &str) -> Option<&ManifestFile> {
        self.files.iter().find(|f| f.name == name)
    }
}

/// Why a manifest or artefact was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReleaseError {
    /// The app trusts no release key yet, so nothing can verify.
    #[error("no trusted release key is configured")]
    NoTrustedKey,
    /// A trusted key is not a valid minisign public key.
    #[error("trusted release key {index} is not a minisign public key")]
    InvalidTrustedKey {
        /// Position in the key list.
        index: usize,
    },
    /// The signature file is not a minisign signature, or uses the legacy (not prehashed)
    /// algorithm.
    #[error("the manifest signature is malformed: {reason}")]
    MalformedSignature {
        /// What is wrong.
        reason: String,
    },
    /// The signature names a key the app does not trust.
    #[error("the manifest is signed with a key the app does not trust")]
    UnknownKey,
    /// The signature does not match the manifest (or its trusted comment was changed).
    #[error("the manifest signature does not match its content")]
    BadSignature,
    /// The signed manifest cannot be understood.
    #[error("the manifest is malformed: {reason}")]
    MalformedManifest {
        /// What is wrong.
        reason: String,
    },
    /// The artefact is not listed in the manifest.
    #[error("{name} is not listed in the manifest")]
    NotListed {
        /// The file name.
        name: String,
    },
    /// The artefact's size differs from the manifest.
    #[error("{name} has {actual} bytes, the manifest says {expected}")]
    SizeMismatch {
        /// The file name.
        name: String,
        /// Size in the manifest.
        expected: u64,
        /// Size on disk.
        actual: u64,
    },
    /// The artefact's SHA-256 differs from the manifest.
    #[error("{name} has SHA-256 {actual}, the manifest says {expected}")]
    HashMismatch {
        /// The file name.
        name: String,
        /// Hash in the manifest.
        expected: String,
        /// Hash of the file.
        actual: String,
    },
    /// The artefact cannot be read.
    #[error("cannot read {path}: {reason}")]
    Io {
        /// The file.
        path: PathBuf,
        /// The operating system's error.
        reason: String,
    },
}

impl ReleaseError {
    /// `releaseIntegrity`, or `ioError` when a file could not be read.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Io { .. } => ErrorKind::IoError,
            _ => ErrorKind::ReleaseIntegrity,
        }
    }

    /// Never retryable: the same input fails the same way.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The `details.reason` of the error object.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NoTrustedKey | Self::InvalidTrustedKey { .. } => "noTrustedKey",
            Self::MalformedSignature { .. } => "malformedSignature",
            Self::UnknownKey => "unknownKey",
            Self::BadSignature => "badSignature",
            Self::MalformedManifest { .. } => "malformedManifest",
            Self::NotListed { .. } => "notListed",
            Self::SizeMismatch { .. } => "sizeMismatch",
            Self::HashMismatch { .. } => "hashMismatch",
            Self::Io { .. } => "io",
        }
    }

    /// The structured error object (`details`: `{ reason, file? }`).
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let file = match self {
            Self::NotListed { name }
            | Self::SizeMismatch { name, .. }
            | Self::HashMismatch { name, .. } => Some(name.clone()),
            Self::Io { path, .. } => Some(path.display().to_string()),
            _ => None,
        };
        let mut details = serde_json::json!({ "reason": self.reason() });
        if let Some(file) = file {
            details["file"] = serde_json::Value::String(file);
        }
        let kind = self.kind();
        ErrorObject {
            code: kind.code(),
            message: self.to_string(),
            data: ErrorData {
                kind,
                retryable: self.retryable(),
                details: Some(details),
            },
        }
    }
}

/// The public keys a manifest may be signed with.
#[derive(Debug)]
pub struct TrustedKeys(Vec<minisign_verify::PublicKey>);

impl TrustedKeys {
    /// The keys built into the app ([`BUILTIN_RELEASE_KEYS`]).
    ///
    /// # Errors
    ///
    /// [`ReleaseError::InvalidTrustedKey`] when a built-in key does not decode.
    pub fn builtin() -> Result<Self, ReleaseError> {
        Self::from_base64(BUILTIN_RELEASE_KEYS)
    }

    /// Keys given as base64 minisign public keys (the second line of a `.pub` file).
    ///
    /// # Errors
    ///
    /// [`ReleaseError::InvalidTrustedKey`] for a key that does not decode.
    pub fn from_base64(keys: &[&str]) -> Result<Self, ReleaseError> {
        keys.iter()
            .enumerate()
            .map(|(index, key)| {
                minisign_verify::PublicKey::from_base64(key.trim())
                    .map_err(|_| ReleaseError::InvalidTrustedKey { index })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }
}

/// Verifies `signature` (the `.minisig` text) over the exact manifest bytes with the trusted
/// keys, then parses the manifest. Only prehashed signatures are accepted.
///
/// # Errors
///
/// [`ReleaseError::NoTrustedKey`], [`ReleaseError::MalformedSignature`],
/// [`ReleaseError::UnknownKey`], [`ReleaseError::BadSignature`] before anything is parsed;
/// [`ReleaseError::MalformedManifest`] for a signed manifest of another format or shape.
pub fn verify_manifest(
    manifest: &[u8],
    signature: &str,
    keys: &TrustedKeys,
) -> Result<ReleaseManifest, ReleaseError> {
    if keys.0.is_empty() {
        return Err(ReleaseError::NoTrustedKey);
    }
    let signature = minisign_verify::Signature::decode(signature).map_err(|e| {
        ReleaseError::MalformedSignature {
            reason: e.to_string(),
        }
    })?;
    let mut matched_key = false;
    for key in &keys.0 {
        match key.verify(manifest, &signature, false) {
            Ok(()) => return parse_manifest(manifest),
            Err(minisign_verify::Error::UnexpectedKeyId) => {}
            Err(minisign_verify::Error::UnexpectedAlgorithm) => {
                return Err(ReleaseError::MalformedSignature {
                    reason: "legacy (not prehashed) signatures are not accepted".into(),
                });
            }
            Err(_) => matched_key = true,
        }
    }
    Err(if matched_key {
        ReleaseError::BadSignature
    } else {
        ReleaseError::UnknownKey
    })
}

fn parse_manifest(bytes: &[u8]) -> Result<ReleaseManifest, ReleaseError> {
    let manifest: ReleaseManifest =
        serde_json::from_slice(bytes).map_err(|e| ReleaseError::MalformedManifest {
            reason: e.to_string(),
        })?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(ReleaseError::MalformedManifest {
            reason: format!("format {:?}, expected {MANIFEST_FORMAT:?}", manifest.format),
        });
    }
    for file in &manifest.files {
        let simple_name = !file.name.is_empty()
            && !file.name.contains(['/', '\\'])
            && file.name != "."
            && file.name != "..";
        if !simple_name {
            return Err(ReleaseError::MalformedManifest {
                reason: format!("file name {:?} is not a plain file name", file.name),
            });
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ReleaseError::MalformedManifest {
                reason: format!("{}: SHA-256 is not 64 hex digits", file.name),
            });
        }
    }
    Ok(manifest)
}

/// Checks a downloaded artefact against the entry of its file name: size first, then
/// SHA-256 read in chunks.
///
/// # Errors
///
/// [`ReleaseError::NotListed`], [`ReleaseError::SizeMismatch`],
/// [`ReleaseError::HashMismatch`], [`ReleaseError::Io`].
pub fn verify_file(manifest: &ReleaseManifest, path: &Path) -> Result<(), ReleaseError> {
    let io = |e: std::io::Error| ReleaseError::Io {
        path: path.to_path_buf(),
        reason: e.to_string(),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let entry = manifest
        .file(&name)
        .ok_or_else(|| ReleaseError::NotListed { name: name.clone() })?;
    let actual_size = std::fs::metadata(path).map_err(io)?.len();
    if actual_size != entry.size {
        return Err(ReleaseError::SizeMismatch {
            name,
            expected: entry.size,
            actual: actual_size,
        });
    }
    let mut file = File::open(path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !actual.eq_ignore_ascii_case(&entry.sha256) {
        return Err(ReleaseError::HashMismatch {
            name,
            expected: entry.sha256.clone(),
            actual,
        });
    }
    Ok(())
}
