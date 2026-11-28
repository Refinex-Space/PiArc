//! The pure parts of the update flow (ADR-0111): version order, the artefacts of this
//! platform in a verified manifest, the release notes file and Velopack's release feed.

use std::collections::BTreeMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::release::{ManifestFile, ReleaseManifest};

/// Name of the release notes file (ADR-0111 rule 2).
pub const NOTES_FILE: &str = "piarc-release-notes.json";
/// `format` of the release notes this build understands.
pub const NOTES_FORMAT: &str = "piarc-release-notes/1";
/// Name of the signed manifest and its signature (ADR-0024).
pub const MANIFEST_FILE: &str = "piarc-release-manifest.json";
pub const SIGNATURE_FILE: &str = "piarc-release-manifest.json.minisig";

/// The operating systems with published artefacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Macos,
    Windows,
}

/// This build's platform, or `None` when no artefact is published for it.
#[must_use]
pub fn this_platform() -> Option<(Os, &'static str)> {
    let os = if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(target_os = "windows") {
        Os::Windows
    } else {
        return None;
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return None,
    };
    Some((os, arch))
}

/// A parsed `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

fn parse_version(text: &str) -> Option<Version> {
    let text = text.split('+').next()?;
    let (core, pre) = text
        .split_once('-')
        .map_or((text, None), |(c, p)| (c, Some(p)));
    let mut parts = core.split('.');
    let mut numbers = [0_u64; 3];
    for slot in &mut numbers {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        None => Vec::new(),
        Some("") => return None,
        Some(p) => p.split('.').map(str::to_owned).collect(),
    };
    Some(Version { core: numbers, pre })
}

fn compare_pre(a: &[String], b: &[String]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (x, y) in a.iter().zip(b) {
        let order = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    a.len().cmp(&b.len())
}

/// Whether `candidate` is a newer SemVer than `current`; an unparsable version is never newer.
#[must_use]
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(candidate), parse_version(current)) else {
        return false;
    };
    a.core
        .cmp(&b.core)
        .then_with(|| compare_pre(&a.pre, &b.pre))
        .is_gt()
}

/// Whether `version` is valid SemVer without a prerelease part (only those are offered).
#[must_use]
pub fn is_release(version: &str) -> bool {
    parse_version(version).is_some_and(|v| v.pre.is_empty())
}

/// `PiArc-<version>-macos-<arch>.zip`.
#[must_use]
pub fn mac_archive(version: &str, arch: &str) -> String {
    format!("PiArc-{version}-macos-{arch}.zip")
}

/// `releases.win-<arch>.json`.
#[must_use]
pub fn windows_feed(arch: &str) -> String {
    format!("releases.win-{arch}.json")
}

/// The release notes file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    pub format: String,
    pub version: String,
    pub date: String,
    pub security: bool,
    pub notes: BTreeMap<String, String>,
}

/// Why a downloaded piece does not fit the release.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FeedError {
    #[error("{0} is not listed in the manifest")]
    NotListed(String),
    #[error("{name} does not match the manifest ({what})")]
    Mismatch { name: String, what: &'static str },
    #[error("{name} is malformed: {reason}")]
    Malformed { name: String, reason: String },
}

/// Checks bytes read into memory against their manifest entry.
///
/// # Errors
///
/// [`FeedError::NotListed`] or [`FeedError::Mismatch`].
pub fn verify_bytes(manifest: &ReleaseManifest, name: &str, bytes: &[u8]) -> Result<(), FeedError> {
    let entry = manifest
        .file(name)
        .ok_or_else(|| FeedError::NotListed(name.to_owned()))?;
    if entry.size != bytes.len() as u64 {
        return Err(FeedError::Mismatch {
            name: name.to_owned(),
            what: "size",
        });
    }
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if !hex.eq_ignore_ascii_case(&entry.sha256) {
        return Err(FeedError::Mismatch {
            name: name.to_owned(),
            what: "SHA-256",
        });
    }
    Ok(())
}

/// Parses the (already verified) release notes and checks they belong to `version`.
///
/// # Errors
///
/// [`FeedError::Malformed`].
pub fn parse_notes(bytes: &[u8], version: &str) -> Result<ReleaseNotes, FeedError> {
    let malformed = |reason: String| FeedError::Malformed {
        name: NOTES_FILE.to_owned(),
        reason,
    };
    let notes: ReleaseNotes =
        serde_json::from_slice(bytes).map_err(|e| malformed(e.to_string()))?;
    if notes.format != NOTES_FORMAT {
        return Err(malformed(format!("format {:?}", notes.format)));
    }
    if notes.version != version {
        return Err(malformed(format!(
            "version {} in a {version} release",
            notes.version
        )));
    }
    if !notes.notes.contains_key("en") {
        return Err(malformed("no English notes".into()));
    }
    Ok(notes)
}

#[derive(Deserialize)]
struct VelopackFeed {
    #[serde(rename = "Assets")]
    assets: Vec<VelopackAsset>,
}

#[derive(Deserialize)]
struct VelopackAsset {
    #[serde(rename = "Version")]
    version: String,
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "FileName")]
    file_name: String,
}

/// The Full package of `version` in a (verified) `releases.win-<arch>.json`.
///
/// # Errors
///
/// [`FeedError::Malformed`] when the feed does not parse or has no such package, or names a
/// path instead of a file.
pub fn velopack_full_package(bytes: &[u8], feed: &str, version: &str) -> Result<String, FeedError> {
    let malformed = |reason: String| FeedError::Malformed {
        name: feed.to_owned(),
        reason,
    };
    let parsed: VelopackFeed =
        serde_json::from_slice(bytes).map_err(|e| malformed(e.to_string()))?;
    let asset = parsed
        .assets
        .into_iter()
        .find(|a| a.kind.eq_ignore_ascii_case("full") && a.version == version)
        .ok_or_else(|| malformed(format!("no Full package of {version}")))?;
    if asset.file_name.is_empty()
        || asset.file_name.contains(['/', '\\'])
        || asset.file_name == ".."
    {
        return Err(malformed(format!("file name {:?}", asset.file_name)));
    }
    Ok(asset.file_name)
}

/// The manifest entries this platform downloads, in download order.
///
/// # Errors
///
/// [`FeedError::NotListed`] when an artefact is missing from the manifest.
pub fn platform_files(
    manifest: &ReleaseManifest,
    os: Os,
    arch: &str,
    windows_package: Option<&str>,
) -> Result<Vec<ManifestFile>, FeedError> {
    let names: Vec<String> = match os {
        Os::Macos => vec![mac_archive(&manifest.version, arch)],
        Os::Windows => {
            let mut names = vec![windows_feed(arch)];
            names.extend(windows_package.map(str::to_owned));
            names
        }
    };
    names
        .into_iter()
        .map(|name| {
            manifest
                .file(&name)
                .cloned()
                .ok_or(FeedError::NotListed(name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &[u8])]) -> ReleaseManifest {
        ReleaseManifest {
            format: crate::release::MANIFEST_FORMAT.to_owned(),
            product: "PiArc".to_owned(),
            version: "1.2.0".to_owned(),
            created_at: "2026-11-28T00:00:00Z".to_owned(),
            files: files
                .iter()
                .map(|(name, bytes)| ManifestFile {
                    name: (*name).to_owned(),
                    size: bytes.len() as u64,
                    sha256: Sha256::digest(bytes)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn versions_order_by_semver() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.0.0", "1.0.0-beta.2"));
        assert!(is_newer("1.0.0-beta.10", "1.0.0-beta.2"));
        assert!(is_newer("1.0.0-rc.1", "1.0.0-beta.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0+build.5", "1.0.0"));
        assert!(!is_newer("0.9.0", "1.0.0"));
        assert!(!is_newer("1.0", "0.0.0"));
        assert!(!is_newer("v1.0.0", "0.0.0"));
        assert!(!is_newer("1.0.0-", "0.0.0"));
        assert!(is_release("1.0.0"));
        assert!(!is_release("1.0.0-beta.1"));
    }

    #[test]
    fn bytes_are_checked_against_their_entry() {
        let m = manifest(&[(NOTES_FILE, b"{}")]);
        assert_eq!(verify_bytes(&m, NOTES_FILE, b"{}"), Ok(()));
        assert!(matches!(
            verify_bytes(&m, NOTES_FILE, b"{ }"),
            Err(FeedError::Mismatch { what: "size", .. })
        ));
        assert!(matches!(
            verify_bytes(&m, NOTES_FILE, b"[]"),
            Err(FeedError::Mismatch {
                what: "SHA-256",
                ..
            })
        ));
        assert!(matches!(
            verify_bytes(&m, "other", b"{}"),
            Err(FeedError::NotListed(_))
        ));
    }

    #[test]
    fn notes_must_belong_to_the_release() {
        let good = r#"{"format":"piarc-release-notes/1","version":"1.2.0","date":"2026-12-01","security":true,"notes":{"en":"Fixes","zh-CN":"修复"}}"#.as_bytes();
        let notes = parse_notes(good, "1.2.0").unwrap();
        assert!(notes.security);
        assert_eq!(notes.notes["zh-CN"], "修复");
        assert!(parse_notes(good, "1.3.0").is_err());
        let other = br#"{"format":"piarc-release-notes/2","version":"1.2.0","date":"x","security":false,"notes":{"en":""}}"#;
        assert!(parse_notes(other, "1.2.0").is_err());
        let no_en = br#"{"format":"piarc-release-notes/1","version":"1.2.0","date":"x","security":false,"notes":{"zh-CN":""}}"#;
        assert!(parse_notes(no_en, "1.2.0").is_err());
    }

    #[test]
    fn the_velopack_feed_names_the_full_package() {
        let feed = br#"{"Assets":[
            {"PackageId":"cn.piarc.desktop","Version":"1.1.0","Type":"Full","FileName":"cn.piarc.desktop-1.1.0-win-x64-full.nupkg"},
            {"PackageId":"cn.piarc.desktop","Version":"1.2.0","Type":"Delta","FileName":"cn.piarc.desktop-1.2.0-win-x64-delta.nupkg"},
            {"PackageId":"cn.piarc.desktop","Version":"1.2.0","Type":"Full","FileName":"cn.piarc.desktop-1.2.0-win-x64-full.nupkg"}]}"#;
        assert_eq!(
            velopack_full_package(feed, "releases.win-x64.json", "1.2.0").unwrap(),
            "cn.piarc.desktop-1.2.0-win-x64-full.nupkg"
        );
        assert!(velopack_full_package(feed, "f", "1.3.0").is_err());
        let path = br#"{"Assets":[{"Version":"1.2.0","Type":"Full","FileName":"..\\evil.nupkg"}]}"#;
        assert!(velopack_full_package(path, "f", "1.2.0").is_err());
    }

    #[test]
    fn each_platform_takes_its_own_artefacts() {
        let m = manifest(&[
            ("PiArc-1.2.0-macos-arm64.zip", b"a"),
            ("PiArc-1.2.0-macos-x64.zip", b"b"),
            ("releases.win-x64.json", b"c"),
            ("pkg-full.nupkg", b"d"),
        ]);
        let mac = platform_files(&m, Os::Macos, "arm64", None).unwrap();
        assert_eq!(mac.len(), 1);
        assert_eq!(mac[0].name, "PiArc-1.2.0-macos-arm64.zip");
        let win = platform_files(&m, Os::Windows, "x64", Some("pkg-full.nupkg")).unwrap();
        assert_eq!(
            win.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["releases.win-x64.json", "pkg-full.nupkg"]
        );
        assert!(platform_files(&m, Os::Windows, "arm64", Some("pkg-full.nupkg")).is_err());
    }
}
