//! What the npm registry answers, read leniently (ADR-0102): search pages, a version's document
//! (`/<name>/latest`, `/<name>/<version>`) and the package document (README). Every string
//! is cleaned (control characters out, length bounded) before it is stored or shown; an entry
//! that is not a usable package is skipped, not an error. Also the checks of names and
//! versions Core accepts from the settings window, and the URLs it builds from them.

use piarc_store::MarketListing;
use piarc_store::market::kind;
use serde_json::Value;

/// Longest description kept.
pub(crate) const DESCRIPTION_BYTES: usize = 1024;
/// Most keywords kept, and the longest one.
pub(crate) const KEYWORDS: usize = 32;
pub(crate) const KEYWORD_CHARS: usize = 64;
/// Longest README handed to the settings window.
pub(crate) const README_BYTES: usize = 256 * 1024;

/// `text` without control characters (line breaks kept when `lines`), at most `max` bytes on a
/// character boundary.
pub(crate) fn clean(text: &str, max: usize, lines: bool) -> String {
    let mut out = String::with_capacity(text.len().min(max));
    for c in text.chars() {
        let keep = !c.is_control() || (lines && (c == '\n' || c == '\t'));
        if !keep {
            continue;
        }
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|s| clean(s, 512, false))
        .filter(|s| !s.is_empty())
}

/// Only `https:` links are kept.
fn https(value: Option<&Value>) -> Option<String> {
    let url = value?.as_str()?.trim();
    let url = url.strip_prefix("git+").unwrap_or(url);
    (url.starts_with("https://") && url.len() <= 2048 && !url.chars().any(char::is_control))
        .then(|| url.trim_end_matches(".git").to_owned())
}

/// The kinds the keywords name (the same words pi.dev's catalog used).
pub(crate) fn keyword_kinds(keywords: &[String]) -> i64 {
    let has = |words: &[&str]| {
        keywords
            .iter()
            .any(|k| words.iter().any(|w| k.eq_ignore_ascii_case(w)))
    };
    let mut bits = 0;
    if has(&["extension", "pi-extension", "extensions"]) {
        bits |= kind::EXTENSION;
    }
    if has(&["skill", "pi-skill", "skills"]) {
        bits |= kind::SKILL;
    }
    if has(&["prompt", "pi-prompt", "prompts"]) {
        bits |= kind::PROMPT;
    }
    if has(&["theme", "pi-theme", "themes"]) {
        bits |= kind::THEME;
    }
    bits
}

fn ms(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_str)
        .and_then(chrono_ms)
        .unwrap_or(0)
}

/// Unix ms of an RFC 3339 time (`2026-11-01T00:00:00.000Z`), without a date library.
fn chrono_ms(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-').map(str::parse::<i64>);
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let (h, min) = (
        t.next()?.parse::<i64>().ok()?,
        t.next()?.parse::<i64>().ok()?,
    );
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    // Days since 1970-01-01 (civil-from-days inverse, Howard Hinnant's algorithm).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    #[expect(clippy::cast_possible_truncation, reason = "milliseconds of a minute")]
    let millis = (sec * 1000.0) as i64;
    Some(((days * 24 + h) * 60 + min) * 60_000 + millis)
}

/// One search result as a listing, or `None` when it is not a usable package.
pub(crate) fn listing(object: &Value) -> Option<MarketListing> {
    let package = object.get("package")?;
    let name = package.get("name")?.as_str()?;
    let version = package.get("version")?.as_str()?;
    if !valid_name(name) || !valid_version(version) {
        return None;
    }
    let keywords: Vec<String> = package
        .get("keywords")
        .and_then(Value::as_array)
        .map(|k| {
            k.iter()
                .filter_map(Value::as_str)
                .map(|s| clean(s, KEYWORD_CHARS, false))
                .filter(|s| !s.is_empty())
                .take(KEYWORDS)
                .collect()
        })
        .unwrap_or_default();
    let links = package.get("links").unwrap_or(&Value::Null);
    let publisher = package
        .get("publisher")
        .and_then(|p| text(p, "username"))
        .or_else(|| {
            package
                .get("maintainers")
                .and_then(Value::as_array)
                .and_then(|m| m.first())
                .and_then(|m| text(m, "username"))
        })
        .unwrap_or_default();
    let downloads = object
        .get("downloads")
        .and_then(|d| d.get("monthly"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let insecure = object
        .get("flags")
        .and_then(|f| f.get("insecure"))
        .is_some_and(|v| v.as_i64().is_some_and(|n| n != 0) || v.as_bool() == Some(true));
    let updated = ms(object.get("updated")).max(ms(package.get("date")));
    Some(MarketListing {
        kw_kinds: keyword_kinds(&keywords),
        name: name.to_owned(),
        version: version.to_owned(),
        description: package
            .get("description")
            .and_then(Value::as_str)
            .map(|s| clean(s, DESCRIPTION_BYTES, false))
            .unwrap_or_default(),
        keywords,
        publisher,
        license: text(package, "license"),
        updated_ms: updated,
        downloads_monthly: downloads,
        insecure,
        npm_url: https(links.get("npm")),
        repo_url: https(links.get("repository")),
        homepage_url: https(links.get("homepage")),
    })
}

/// A search page: its listings (unusable ones skipped) and the total it reports.
pub(crate) fn search_page(body: &[u8]) -> Option<(Vec<MarketListing>, u64)> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let objects = value.get("objects")?.as_array()?;
    let total = value.get("total").and_then(Value::as_u64).unwrap_or(0);
    Some((objects.iter().filter_map(listing).collect(), total))
}

/// What a version's document says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct VersionInfo {
    pub version: String,
    /// The `pi` manifest's kinds; `None` without a `pi` field (conventional directories).
    pub kinds: Option<i64>,
    pub deprecated: Option<String>,
    pub integrity: Option<String>,
    pub install_scripts: Vec<String>,
    pub dependencies: Vec<String>,
    /// `name@spec` of dependencies that are not registry versions.
    pub foreign: Vec<String>,
}

fn non_empty(manifest: &Value, key: &str) -> bool {
    match manifest.get(key) {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    }
}

/// A dependency spec that names a registry version or range (not git, a URL, a path, an alias).
pub(crate) fn registry_spec(spec: &str) -> bool {
    let spec = spec.trim();
    !(spec.contains(':')
        || spec.contains('/')
        || spec.contains('\\')
        || spec.starts_with('.')
        || spec.starts_with("~/"))
}

pub(crate) fn version_info(doc: &Value) -> Option<VersionInfo> {
    let version = doc.get("version")?.as_str()?;
    if !valid_version(version) {
        return None;
    }
    let kinds = doc.get("pi").filter(|p| p.is_object()).map(|pi| {
        let mut bits = 0;
        for (key, bit) in [
            ("extensions", kind::EXTENSION),
            ("skills", kind::SKILL),
            ("prompts", kind::PROMPT),
            ("themes", kind::THEME),
        ] {
            if non_empty(pi, key) {
                bits |= bit;
            }
        }
        bits
    });
    let scripts = doc.get("scripts").and_then(Value::as_object);
    let install_scripts = ["preinstall", "install", "postinstall", "prepare"]
        .into_iter()
        .filter(|s| scripts.is_some_and(|m| m.contains_key(*s)))
        .map(str::to_owned)
        .collect();
    let mut dependencies = Vec::new();
    let mut foreign = Vec::new();
    for key in ["dependencies", "optionalDependencies"] {
        for (name, spec) in doc
            .get(key)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let name = clean(name, 214, false);
            let spec = spec.as_str().unwrap_or_default();
            if !registry_spec(spec) {
                foreign.push(format!("{name}@{}", clean(spec, 200, false)));
            }
            dependencies.push(name);
        }
    }
    dependencies.sort();
    dependencies.dedup();
    let deprecated = match doc.get("deprecated") {
        Some(Value::String(s)) if !s.is_empty() => Some(clean(s, 512, false)),
        _ => None,
    };
    Some(VersionInfo {
        version: version.to_owned(),
        kinds,
        deprecated,
        integrity: doc
            .get("dist")
            .and_then(|d| d.get("integrity"))
            .and_then(Value::as_str)
            .filter(|i| i.starts_with("sha512-"))
            .map(str::to_owned),
        install_scripts,
        dependencies,
        foreign,
    })
}

/// The README of a package document, cleaned and bounded: `(text, truncated)`.
pub(crate) fn readme(doc: &Value) -> Option<(String, bool)> {
    let text = doc.get("readme")?.as_str()?;
    if text.trim().is_empty() {
        return None;
    }
    let kept = clean(text, README_BYTES, true);
    let truncated = kept.len() < text.len();
    Some((kept, truncated))
}

/// npm's package name rules for new packages: at most 214 characters, lowercase, URL-safe,
/// not starting with `.` or `_`, optionally `@scope/name`.
#[must_use]
pub fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    let part_ok = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.starts_with('_')
            && part
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-._~".contains(c))
    };
    match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, rest)| part_ok(scope) && part_ok(rest)),
        None => part_ok(name),
    }
}

/// An exact semantic version (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build`), no range or tag.
#[must_use]
pub fn valid_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 256 {
        return false;
    }
    let (core, rest) = match version.find(['-', '+']) {
        Some(i) => version.split_at(i),
        None => (version, ""),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    let numbers_ok = numbers.len() == 3
        && numbers.iter().all(|n| {
            !n.is_empty()
                && n.chars().all(|c| c.is_ascii_digit())
                && (n.len() == 1 || !n.starts_with('0'))
        });
    let rest_ok = rest
        .chars()
        .skip(1)
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
        && rest.len() != 1;
    numbers_ok && rest_ok
}

/// The path of package `name` on the registry (`@scope%2fname` for a scoped one).
#[must_use]
pub(crate) fn package_path(name: &str) -> String {
    name.replacen('/', "%2f", 1)
}

/// A search query string: `keywords:pi-package` and the words, form-encoded.
pub(crate) fn search_query(words: &[String], size: u64, from: u64) -> String {
    let mut text = String::from("keywords:pi-package");
    for word in words {
        text.push(' ');
        text.push_str(word);
    }
    let encoded: String = text
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' => {
                (b as char).to_string()
            }
            b' ' => "+".to_owned(),
            other => format!("%{other:02X}"),
        })
        .collect();
    format!("text={encoded}&size={size}&from={from}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn names_and_versions_follow_npm() {
        for ok in ["pi-tools", "@scope/pi-tools", "a.b", "x~y", "a1"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "Pi",
            "_x",
            ".x",
            "@scope",
            "@/x",
            "@s/",
            "a/b",
            "../x",
            "a b",
            "a%2fb",
            "https://x",
            "git+ssh://x",
            &"a".repeat(215),
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        for ok in [
            "1.2.3",
            "0.0.1",
            "1.2.3-beta.1",
            "1.2.3+build.5",
            "10.20.30",
        ] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in [
            "", "1.2", "^1.2.3", "latest", ">=1", "01.2.3", "1.2.3-", "1.2.x", "1.2.3 ",
        ] {
            assert!(!valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn search_objects_are_cleaned_and_unusable_ones_skipped() {
        let body = json!({
            "total": 3,
            "objects": [
                { "package": { "name": "pi-a", "version": "1.0.0",
                    "description": "line\u{0}one\u{202e}x\nnext",
                    "keywords": ["pi-package", "Extension", "pi-skill"],
                    "date": "2026-11-01T10:00:00.000Z",
                    "links": { "npm": "https://www.npmjs.com/package/pi-a",
                               "repository": "git+https://github.com/a/pi-a.git",
                               "homepage": "javascript:alert(1)" },
                    "publisher": { "username": "alice" } },
                  "downloads": { "monthly": 42 }, "flags": { "insecure": 1 },
                  "updated": "2026-11-02T00:00:00.000Z" },
                { "package": { "name": "Bad Name", "version": "1.0.0" } },
                { "package": { "name": "pi-b", "version": "^1" } }
            ]
        })
        .to_string();
        let (listings, total) = search_page(body.as_bytes()).expect("page");
        assert_eq!(total, 3);
        assert_eq!(listings.len(), 1);
        let a = &listings[0];
        assert_eq!(
            a.description, "lineone\u{202e}xnext",
            "control characters and line breaks out; bidi marks stay for the window to reveal"
        );
        assert_eq!(a.kw_kinds, kind::EXTENSION | kind::SKILL);
        assert_eq!(a.repo_url.as_deref(), Some("https://github.com/a/pi-a"));
        assert_eq!(a.homepage_url, None);
        assert!(a.insecure);
        assert_eq!(a.downloads_monthly, 42);
        assert_eq!(
            a.updated_ms,
            chrono_ms("2026-11-02T00:00:00.000Z").unwrap_or(0)
        );
        assert_eq!(chrono_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert!(search_page(b"{\"objects\": 3}").is_none());
        assert!(search_page(b"not json").is_none());
    }

    #[test]
    fn version_documents_give_kinds_integrity_and_foreign_dependencies() {
        let info = version_info(&json!({
            "version": "2.0.0",
            "pi": { "extensions": ["./x.ts"], "themes": ["./t.json"], "skills": [] },
            "dist": { "integrity": "sha512-abc" },
            "deprecated": "use pi-c",
            "scripts": { "postinstall": "x", "test": "y" },
            "dependencies": { "a": "^1.0.0", "b": "github:o/b", "c": "file:../c", "d": "latest" },
            "optionalDependencies": { "e": "https://x/e.tgz" }
        }))
        .expect("info");
        assert_eq!(info.kinds, Some(kind::EXTENSION | kind::THEME));
        assert_eq!(info.integrity.as_deref(), Some("sha512-abc"));
        assert_eq!(info.deprecated.as_deref(), Some("use pi-c"));
        assert_eq!(info.install_scripts, ["postinstall"]);
        assert_eq!(info.dependencies, ["a", "b", "c", "d", "e"]);
        assert_eq!(
            info.foreign,
            ["b@github:o/b", "c@file:../c", "e@https://x/e.tgz"]
        );
        let plain = version_info(&json!({ "version": "1.0.0" })).expect("plain");
        assert_eq!(plain.kinds, None, "no pi field: kinds unknown");
        assert!(version_info(&json!({ "version": "latest" })).is_none());
    }

    #[test]
    fn readmes_are_bounded_and_urls_encoded() {
        let long = "a".repeat(README_BYTES + 10);
        let (text, truncated) = readme(&json!({ "readme": long })).expect("readme");
        assert_eq!(text.len(), README_BYTES);
        assert!(truncated);
        assert!(readme(&json!({ "readme": "  " })).is_none());
        assert_eq!(package_path("@s/pi-x"), "@s%2fpi-x");
        assert_eq!(
            search_query(&["mcp".into(), "a&b".into()], 50, 0),
            "text=keywords:pi-package+mcp+a%26b&size=50&from=0"
        );
    }
}
