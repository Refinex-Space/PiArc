//! The import: list profiles and sites, then decrypt the cookies of the sites the user chose
//! into what the browser partition takes (`cookies.set` details).
//!
//! The database copy is opened before the key is asked for, so a database Chrome holds or
//! cannot be read never brings up the keychain prompt; the key is asked for once, and only
//! when some chosen cookie is encrypted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use zeroize::Zeroizing;

use crate::cookies::{CookieDb, RawCookie, SiteCount, unix_seconds, valid_site};
use crate::crypto::{ChromeKey, Skip, open};
use crate::error::{Error, Result};
use crate::keys::KeySource;
use crate::profiles::{self, Profile};

/// Sites one import may take.
pub const MAX_SITES: usize = 50;

/// `SameSite` as Electron's `cookies.set` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SameSite {
    Unspecified,
    NoRestriction,
    Lax,
    Strict,
}

impl SameSite {
    fn of(chrome: i64) -> Self {
        match chrome {
            0 => Self::NoRestriction,
            1 => Self::Lax,
            2 => Self::Strict,
            _ => Self::Unspecified,
        }
    }
}

/// One decrypted cookie in the shape of Electron's `cookies.set` details. `value` is the
/// secret: it goes to the main process and into the partition, nowhere else.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub site: String,
    pub url: String,
    pub name: String,
    pub value: Zeroizing<String>,
    /// For a domain cookie (`.example.com`); absent for a host-only cookie.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix seconds; absent for a session cookie.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<i64>,
    pub same_site: SameSite,
}

impl std::fmt::Debug for Cookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cookie")
            .field("site", &self.site)
            .field("name", &self.name)
            .field("domain", &self.domain)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

/// Cookies skipped for one reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub reason: Skip,
    pub count: u32,
}

/// What one site gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SiteReport {
    pub site: String,
    pub imported: u32,
    pub skipped: Vec<Skipped>,
}

/// The result of one import.
#[derive(Debug, Clone, Serialize)]
pub struct Imported {
    pub cookies: Vec<Cookie>,
    pub sites: Vec<SiteReport>,
}

/// Reads one Chrome data folder.
#[derive(Clone)]
pub struct Importer {
    root: PathBuf,
    scratch: PathBuf,
    keys: Arc<dyn KeySource>,
}

impl std::fmt::Debug for Importer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Importer")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl Importer {
    /// Over Chrome's data folder `root`; database copies go under `scratch`.
    #[must_use]
    pub fn new(root: PathBuf, scratch: PathBuf, keys: Arc<dyn KeySource>) -> Self {
        Self {
            root,
            scratch,
            keys,
        }
    }

    /// The profiles with a cookies database.
    ///
    /// # Errors
    ///
    /// [`Error::NoChrome`].
    pub fn profiles(&self) -> Result<Vec<Profile>> {
        profiles::list(&self.root)
    }

    fn open_db(&self, profile: &str) -> Result<CookieDb> {
        let file = profiles::cookies_file(&self.root, profile)?;
        CookieDb::open(&file, &self.scratch)
    }

    /// The sites of `profile` with their cookies that have not expired by `now` (Unix
    /// seconds). Reads no value and needs no key.
    ///
    /// # Errors
    ///
    /// Profile and database errors.
    pub fn sites(&self, profile: &str, now: i64) -> Result<Vec<SiteCount>> {
        self.open_db(profile)?.sites(now)
    }

    /// Decrypts the cookies of `sites` in `profile`.
    ///
    /// # Errors
    ///
    /// [`Error::Invalid`] for no site, too many or a malformed one; profile, database and
    /// key errors.
    pub fn import(&self, profile: &str, sites: &[String], now: i64) -> Result<Imported> {
        if sites.is_empty() || sites.len() > MAX_SITES {
            return Err(Error::Invalid(format!(
                "choose between 1 and {MAX_SITES} sites"
            )));
        }
        if let Some(bad) = sites.iter().find(|s| !valid_site(s)) {
            return Err(Error::Invalid(format!("{bad:?} is not a site")));
        }
        let mut chosen: Vec<&String> = sites.iter().collect();
        chosen.sort();
        chosen.dedup();
        let db = self.open_db(profile)?;
        let mut rows = Vec::new();
        for site in &chosen {
            rows.push(((*site).clone(), db.rows(site)?));
        }
        let needs_key = rows
            .iter()
            .flat_map(|(_, r)| r)
            .any(|c| c.value.is_empty() && !c.encrypted.is_empty());
        let key = if needs_key {
            Some(self.keys.key(&self.root)?)
        } else {
            None
        };
        let mut cookies = Vec::new();
        let mut reports = Vec::new();
        for (site, site_rows) in rows {
            let mut skipped: BTreeMap<Skip, u32> = BTreeMap::new();
            let mut imported = 0u32;
            for raw in &site_rows {
                match cookie(&site, raw, key.as_ref(), db.version(), now) {
                    Ok(c) => {
                        imported += 1;
                        cookies.push(c);
                    }
                    Err(reason) => *skipped.entry(reason).or_default() += 1,
                }
            }
            reports.push(SiteReport {
                site,
                imported,
                skipped: skipped
                    .into_iter()
                    .map(|(reason, count)| Skipped { reason, count })
                    .collect(),
            });
        }
        Ok(Imported {
            cookies,
            sites: reports,
        })
    }
}

fn cookie(
    site: &str,
    raw: &RawCookie,
    key: Option<&ChromeKey>,
    version: i64,
    now: i64,
) -> std::result::Result<Cookie, Skip> {
    if raw.partitioned {
        return Err(Skip::Partitioned);
    }
    if raw.expired(now) {
        return Err(Skip::Expired);
    }
    let value = if raw.value.is_empty() && !raw.encrypted.is_empty() {
        let key = key.ok_or(Skip::Undecryptable)?;
        open(key, &raw.encrypted, &raw.host_key, version)?
    } else {
        raw.value.clone()
    };
    let host = raw.host_key.trim_start_matches('.');
    if host.is_empty() {
        return Err(Skip::Invalid);
    }
    let path = if raw.path.starts_with('/') {
        raw.path.clone()
    } else {
        "/".to_owned()
    };
    let scheme = if raw.secure { "https" } else { "http" };
    Ok(Cookie {
        site: site.to_owned(),
        url: format!("{scheme}://{host}{path}"),
        name: raw.name.clone(),
        value,
        domain: raw.host_key.starts_with('.').then(|| raw.host_key.clone()),
        path,
        secure: raw.secure,
        http_only: raw.http_only,
        expiration_date: (raw.persistent && raw.expires_utc != 0)
            .then(|| unix_seconds(raw.expires_utc)),
        same_site: SameSite::of(raw.same_site),
    })
}

/// The site list's chosen sites that a `host` would send cookies to, or that are under it:
/// `host` itself, its parent domains and its subdomains. The site information menu uses it
/// to narrow the list to the page's site.
#[must_use]
pub fn related(host: &str, sites: &[SiteCount]) -> Vec<String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    sites
        .iter()
        .filter(|s| {
            s.site == host
                || host.ends_with(&format!(".{}", s.site))
                || s.site.ends_with(&format!(".{host}"))
        })
        .map(|s| s.site.clone())
        .collect()
}

/// Whether `host` gets cookies of an imported `site` (the site or one of its subdomains):
/// such hosts are sensitive for the agent (B5.4).
#[must_use]
pub fn covered(host: &str, site: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let site = site.trim_start_matches('.').to_ascii_lowercase();
    let site = site.trim_start_matches('[').trim_end_matches(']');
    !site.is_empty() && (host == site || host.ends_with(&format!(".{site}")))
}

/// The importer's root for a user whose home is `home`, or `override_root` when set.
#[must_use]
pub fn root_for(home: &Path, override_root: Option<&Path>) -> Option<PathBuf> {
    override_root
        .map(Path::to_path_buf)
        .or_else(|| profiles::default_root(home))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::cookies::chrome_time;
    use crate::cookies::fixture::{Row, write};
    use crate::crypto::{mac_key, seal};
    use crate::keys::FixedKey;

    const NOW: i64 = 1_800_000_000;

    /// Counts the key reads.
    struct Counting(ChromeKey, Mutex<u32>);

    impl KeySource for Counting {
        fn key(&self, _root: &Path) -> Result<ChromeKey> {
            *self.1.lock().expect("count") += 1;
            Ok(self.0.clone())
        }
    }

    fn root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-import-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(dir.join("Default").join("Network")).expect("profile");
        dir
    }

    fn sealed(key: &ChromeKey, host: &str, name: &str, value: &str, version: i64) -> Row {
        Row {
            host_key: host.into(),
            name: name.into(),
            encrypted: seal(key, value, host, version, [5; 12]),
            path: "/".into(),
            expires_utc: chrome_time(NOW + 86_400),
            secure: true,
            http_only: true,
            same_site: 1,
            persistent: true,
            ..Row::default()
        }
    }

    fn fixture(key: &ChromeKey, version: i64) -> PathBuf {
        let root = root("fixture");
        let mut unknown = sealed(key, ".github.com", "unknown", "x", version);
        unknown.encrypted[2] = b'2'; // "v12": no scheme PiArc knows
        let rows = vec![
            sealed(key, ".github.com", "_gh_sess", "s3cr3t-session", version),
            sealed(key, "github.com", "user_session", "中文值", version),
            unknown,
            Row {
                expires_utc: chrome_time(NOW - 10),
                ..sealed(key, "github.com", "old", "gone", version)
            },
            Row {
                top_frame_site_key: "https://other.test".into(),
                ..sealed(key, ".github.com", "chips", "p", version)
            },
            Row {
                host_key: "plain.test".into(),
                name: "legacy".into(),
                value: "plain-value".into(),
                path: "/app".into(),
                ..Row::default()
            },
        ];
        write(
            &root.join("Default").join("Network").join("Cookies"),
            version,
            &rows,
            false,
        )
        .expect("db");
        root
    }

    fn importer(root: &Path, keys: Arc<dyn KeySource>) -> Importer {
        Importer::new(root.to_path_buf(), root.join("scratch"), keys)
    }

    #[test]
    fn thr17_macos_v10_import_with_domain_hash_keeps_values_out_of_debug() {
        let key = mac_key(b"keychain password");
        for version in [23, 24] {
            let root = fixture(&key, version);
            let counting = Arc::new(Counting(key.clone(), Mutex::new(0)));
            let importer = importer(&root, counting.clone());
            let sites = importer.sites("Default", NOW).expect("sites");
            assert_eq!(
                sites,
                vec![
                    SiteCount {
                        site: "github.com".into(),
                        count: 4
                    },
                    SiteCount {
                        site: "plain.test".into(),
                        count: 1
                    },
                ]
            );
            assert_eq!(
                *counting.1.lock().expect("count"),
                0,
                "listing needs no key"
            );
            let imported = importer
                .import("Default", &["github.com".into()], NOW)
                .expect("import");
            assert_eq!(*counting.1.lock().expect("count"), 1, "one key read");
            let values: Vec<(&str, &str)> = imported
                .cookies
                .iter()
                .map(|c| (c.name.as_str(), c.value.as_str()))
                .collect();
            assert_eq!(
                values,
                [("_gh_sess", "s3cr3t-session"), ("user_session", "中文值")]
            );
            let session = &imported.cookies[0];
            assert_eq!(session.domain.as_deref(), Some(".github.com"));
            assert_eq!(session.url, "https://github.com/");
            assert_eq!(session.same_site, SameSite::Lax);
            assert_eq!(session.expiration_date, Some(NOW + 86_400));
            assert_eq!(imported.cookies[1].domain, None);
            assert_eq!(
                imported.sites,
                vec![SiteReport {
                    site: "github.com".into(),
                    imported: 2,
                    skipped: vec![
                        Skipped {
                            reason: Skip::Expired,
                            count: 1
                        },
                        Skipped {
                            reason: Skip::UnknownFormat,
                            count: 1
                        },
                        Skipped {
                            reason: Skip::Partitioned,
                            count: 1
                        },
                    ],
                }]
            );
            // Values never show in Debug output.
            let debug = format!("{imported:?}");
            assert!(!debug.contains("s3cr3t"), "{debug}");
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn windows_gcm_import_and_app_bound_values() {
        let key = ChromeKey::Gcm(Zeroizing::new([11u8; 32]));
        let root = fixture(&key, 24);
        let importer = importer(&root, Arc::new(FixedKey(key.clone())));
        let mut rows = vec![sealed(&key, ".win.test", "a", "gcm-value", 24)];
        let mut v20 = sealed(&key, ".win.test", "b", "bound", 24);
        v20.encrypted[..3].copy_from_slice(b"v20");
        rows.push(v20);
        write(
            &root.join("Default").join("Network").join("Cookies2"),
            24,
            &rows,
            false,
        )
        .expect("db");
        std::fs::rename(
            root.join("Default").join("Network").join("Cookies2"),
            root.join("Default").join("Network").join("Cookies"),
        )
        .expect("replace");
        let imported = importer
            .import("Default", &["win.test".into()], NOW)
            .expect("import");
        assert_eq!(imported.cookies.len(), 1);
        assert_eq!(imported.cookies[0].value.as_str(), "gcm-value");
        assert_eq!(
            imported.sites[0].skipped,
            vec![Skipped {
                reason: Skip::AppBound,
                count: 1
            }]
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn plain_values_need_no_key_and_a_wrong_key_skips() {
        let key = mac_key(b"right");
        let root = fixture(&key, 24);
        struct Never;
        impl KeySource for Never {
            fn key(&self, _root: &Path) -> Result<ChromeKey> {
                Err(crate::error::Error::key(
                    crate::error::KeyProblem::Denied,
                    "denied",
                ))
            }
        }
        let plain = importer(&root, Arc::new(Never))
            .import("Default", &["plain.test".into()], NOW)
            .expect("plain needs no key");
        assert_eq!(plain.cookies[0].value.as_str(), "plain-value");
        assert_eq!(plain.cookies[0].url, "http://plain.test/app");
        let denied = importer(&root, Arc::new(Never))
            .import("Default", &["github.com".into()], NOW)
            .expect_err("the key is refused");
        assert_eq!(denied.reason(), "keychainDenied");
        let wrong = importer(&root, Arc::new(FixedKey(mac_key(b"wrong"))))
            .import("Default", &["github.com".into()], NOW)
            .expect("import");
        assert!(wrong.cookies.is_empty());
        assert!(
            wrong.sites[0]
                .skipped
                .iter()
                .any(|s| s.reason == Skip::Undecryptable && s.count == 2)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn requests_are_checked() {
        let root = fixture(&mac_key(b"k"), 24);
        let importer = importer(&root, Arc::new(FixedKey(mac_key(b"k"))));
        for sites in [
            vec![],
            vec!["../x".to_owned()],
            vec![".github.com".to_owned()],
            (0..=MAX_SITES).map(|i| format!("s{i}.test")).collect(),
        ] {
            assert_eq!(
                importer
                    .import("Default", &sites, NOW)
                    .expect_err("refused")
                    .reason(),
                "invalid"
            );
        }
        assert_eq!(
            importer
                .import("../Default", &["github.com".into()], NOW)
                .expect_err("bad profile")
                .reason(),
            "invalid"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hosts_covered_by_imported_sites() {
        assert!(covered("github.com", "github.com"));
        assert!(covered("API.GitHub.com.", "github.com"));
        assert!(!covered("notgithub.com", "github.com"));
        assert!(!covered("github.com", "gist.github.com"));
        assert!(covered("[::1]", "[::1]"));
        let sites = [
            SiteCount {
                site: "github.com".into(),
                count: 1,
            },
            SiteCount {
                site: "api.gist.github.com".into(),
                count: 1,
            },
            SiteCount {
                site: "gitlab.com".into(),
                count: 1,
            },
        ];
        assert_eq!(
            related("gist.github.com", &sites),
            ["github.com", "api.gist.github.com"]
        );
    }
}
