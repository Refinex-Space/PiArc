//! Release manifest verification (T12-A08): the fixtures in `tests/fixtures/release/` are
//! signed by `scripts/release/release-manifest.mjs` with the test key, so these tests also show
//! that the Node signer and the Rust verifier agree on minisign's format.

use std::path::{Path, PathBuf};

use piarc_core::release::{
    MANIFEST_FORMAT, ReleaseError, TrustedKeys, verify_file, verify_manifest,
};
use piarc_protocol::ErrorKind;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("release")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixtures().join(name)).expect("fixture exists")
}

fn text(name: &str) -> String {
    String::from_utf8(read(name)).expect("UTF-8 fixture")
}

/// The base64 key of a `.pub` file in scripts/release/test-keys/.
fn test_key(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("scripts")
        .join("release")
        .join("test-keys")
        .join(name);
    std::fs::read_to_string(path)
        .expect("test key exists")
        .lines()
        .nth(1)
        .expect("key line")
        .to_owned()
}

fn trusted() -> TrustedKeys {
    TrustedKeys::from_base64(&[&test_key("release-manifest.test.pub")]).expect("valid key")
}

const MANIFEST: &str = "piarc-release-manifest.json";
const SIGNATURE: &str = "piarc-release-manifest.json.minisig";

fn assert_refused(error: &ReleaseError, reason: &str) {
    let object = error.to_error_object();
    assert_eq!(object.data.kind, ErrorKind::ReleaseIntegrity, "{error}");
    assert!(!object.data.retryable);
    assert_eq!(
        object.data.details.as_ref().expect("details")["reason"],
        reason
    );
    println!(
        "refused ({reason}): {}",
        serde_json::to_string(&object).expect("serializes")
    );
}

#[test]
fn a_signed_manifest_and_its_files_verify() {
    let manifest = verify_manifest(&read(MANIFEST), &text(SIGNATURE), &trusted())
        .expect("the test key's signature verifies");
    assert_eq!(manifest.format, MANIFEST_FORMAT);
    assert_eq!(manifest.version, "0.1.0");
    assert_eq!(manifest.files.len(), 2);
    for file in &manifest.files {
        verify_file(&manifest, &fixtures().join(&file.name)).expect("file matches");
    }
}

#[test]
fn changed_manifest_content_is_refused() {
    let tampered = text(MANIFEST)
        .replace("\"0.1.0\"", "\"0.1.1\"")
        .into_bytes();
    assert_ne!(tampered, read(MANIFEST));
    let error = verify_manifest(&tampered, &text(SIGNATURE), &trusted()).expect_err("refused");
    assert_eq!(error, ReleaseError::BadSignature);
    assert_refused(&error, "badSignature");

    // A changed trusted comment invalidates the global signature.
    let signature = text(SIGNATURE).replace("file:piarc-release-manifest.json", "file:other.json");
    let error = verify_manifest(&read(MANIFEST), &signature, &trusted()).expect_err("refused");
    assert_refused(&error, "badSignature");
}

#[test]
fn a_file_whose_hash_differs_from_the_manifest_is_refused() {
    let manifest =
        verify_manifest(&read(MANIFEST), &text(SIGNATURE), &trusted()).expect("verifies");
    let dir = std::env::temp_dir().join(format!("piarc release 发布 {}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let name = "PiArc-0.1.0-arm64.dmg";
    // Same size, one byte changed: only the hash can tell.
    let mut bytes = read(name);
    bytes[0] ^= 0x20;
    std::fs::write(dir.join(name), &bytes).expect("written");
    let error = verify_file(&manifest, &dir.join(name)).expect_err("refused");
    assert!(
        matches!(error, ReleaseError::HashMismatch { .. }),
        "{error}"
    );
    assert_refused(&error, "hashMismatch");

    bytes.push(b'\n');
    std::fs::write(dir.join(name), &bytes).expect("written");
    let error = verify_file(&manifest, &dir.join(name)).expect_err("refused");
    assert_refused(&error, "sizeMismatch");

    std::fs::write(dir.join("PiArc-0.2.0-arm64.dmg"), b"x").expect("written");
    let error = verify_file(&manifest, &dir.join("PiArc-0.2.0-arm64.dmg")).expect_err("refused");
    assert_refused(&error, "notListed");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn a_manifest_signed_with_another_key_is_refused() {
    let other = text("piarc-release-manifest.json.other-key.minisig");
    let error = verify_manifest(&read(MANIFEST), &other, &trusted()).expect_err("refused");
    assert_eq!(error, ReleaseError::UnknownKey);
    assert_refused(&error, "unknownKey");
    // Trusting the other key instead accepts it: the refusal is about the key, not the format.
    let keys = TrustedKeys::from_base64(&[&test_key("other.test.pub")]).expect("valid key");
    verify_manifest(&read(MANIFEST), &other, &keys).expect("verifies with its own key");
}

#[test]
fn without_a_trusted_key_or_with_a_broken_signature_nothing_verifies() {
    let none = TrustedKeys::from_base64(&[]).expect("empty list");
    let error = verify_manifest(&read(MANIFEST), &text(SIGNATURE), &none).expect_err("refused");
    assert_refused(&error, "noTrustedKey");
    // The built-in keys decode and do not include the test keys.
    let builtin = TrustedKeys::builtin().expect("built-in keys decode");
    let error = verify_manifest(&read(MANIFEST), &text(SIGNATURE), &builtin).expect_err("refused");
    assert_refused(&error, "unknownKey");

    let error =
        verify_manifest(&read(MANIFEST), "not a signature", &trusted()).expect_err("refused");
    assert_refused(&error, "malformedSignature");
}

#[test]
fn the_built_in_key_is_the_committed_release_public_key() {
    // docs/engineering/release.md section 7: the publish job verifies with this file, the app
    // with the built-in list; they must name the same key.
    let pub_file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/release/piarc-release.pub");
    let text = std::fs::read_to_string(pub_file).expect("scripts/release/piarc-release.pub");
    let key = text.lines().nth(1).expect("a key line").trim();
    assert!(
        piarc_core::release::BUILTIN_RELEASE_KEYS.contains(&key),
        "BUILTIN_RELEASE_KEYS does not list {key}"
    );
}
