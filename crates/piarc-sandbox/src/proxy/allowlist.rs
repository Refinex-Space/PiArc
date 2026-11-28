//! The domain allowlist of the network proxy.

use std::fmt;

/// Hosts the proxy lets through: exact names (`registry.npmjs.org`) and `*.` wildcards
/// (`*.github.com`: any subdomain at any depth, not `github.com` itself). Matching ignores case
/// and a trailing dot. Empty by default (architecture section 6.10): everything is denied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Allowlist {
    exact: Vec<String>,
    /// Suffixes with their leading dot: `.github.com`.
    suffixes: Vec<String>,
}

/// An allowlist entry that is not a host name or `*.` wildcard.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{entry:?} is not a domain or *.domain pattern")]
pub struct InvalidEntry {
    /// The entry as given.
    pub entry: String,
}

impl Allowlist {
    /// An allowlist of `entries`.
    ///
    /// # Errors
    ///
    /// An entry is empty, a bare `*`, has a wildcard anywhere but a leading `*.`, or contains
    /// characters a host name cannot (`/`, `:`, `@`, whitespace and the like).
    pub fn new<I, S>(entries: I) -> Result<Self, InvalidEntry>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut list = Self::default();
        for entry in entries {
            let entry = entry.as_ref();
            let invalid = || InvalidEntry {
                entry: entry.to_owned(),
            };
            let name = normalize(entry);
            match name.strip_prefix("*.") {
                Some(domain) if valid_name(domain) => list.suffixes.push(format!(".{domain}")),
                Some(_) => return Err(invalid()),
                None if valid_name(&name) => list.exact.push(name),
                None => return Err(invalid()),
            }
        }
        Ok(list)
    }

    /// Whether `host` (a name or an IP literal, without port) may be reached.
    #[must_use]
    pub fn allows(&self, host: &str) -> bool {
        let host = normalize(host);
        self.exact.contains(&host)
            || self
                .suffixes
                .iter()
                .any(|suffix| host.len() > suffix.len() && host.ends_with(suffix.as_str()))
    }
}

impl fmt::Display for Allowlist {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let wildcards = self.suffixes.iter().map(|s| format!("*{s}"));
        let all: Vec<String> = self.exact.iter().cloned().chain(wildcards).collect();
        f.write_str(&all.join(", "))
    }
}

fn normalize(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Letters, digits, `-`, `_` and dots between non-empty labels.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|label| {
            !label.is_empty()
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_entries_match_only_that_host() {
        let list = Allowlist::new(["registry.npmjs.org"]).expect("valid");
        assert!(list.allows("registry.npmjs.org"));
        assert!(list.allows("Registry.NPMJS.org."));
        assert!(!list.allows("npmjs.org"));
        assert!(!list.allows("evil.registry.npmjs.org"));
        assert!(!list.allows("registry.npmjs.org.evil.test"));
    }

    #[test]
    fn wildcards_match_subdomains_but_not_the_domain() {
        let list = Allowlist::new(["*.github.com"]).expect("valid");
        assert!(list.allows("api.github.com"));
        assert!(list.allows("a.b.github.com"));
        assert!(!list.allows("github.com"));
        assert!(!list.allows("evilgithub.com"));
        assert!(!list.allows("github.com.evil.test"));
    }

    #[test]
    fn the_empty_list_denies_everything() {
        assert!(!Allowlist::default().allows("example.com"));
    }

    #[test]
    fn malformed_entries_are_rejected() {
        for entry in [
            "",
            "*",
            "*.",
            "a.*.com",
            "http://a.com",
            "a.com:443",
            "a..com",
            "a b",
        ] {
            assert!(Allowlist::new([entry]).is_err(), "{entry:?}");
        }
    }
}
