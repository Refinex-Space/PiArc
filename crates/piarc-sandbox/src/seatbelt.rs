//! Seatbelt profiles for sandboxed commands (macOS, architecture section 6.10).
//!
//! The profile text depends only on the shape of the policy (how many writable directories
//! and `denyRead` entries, the protected patterns, the proxy port); every path reaches
//! `sandbox-exec` as a `-D KEY=VALUE` parameter. Paths therefore never need SBPL string
//! escaping, and a snapshot of the text shows every rule change in review.
//!
//! Model, after the base policy (`seatbelt/base.sbpl`, from Codex: deny by default, then the
//! process, sysctl, IPC and terminal operations ordinary programs need):
//!
//! - reads: everything except the `denyRead` paths;
//! - writes: the writable directories, plus `/dev/null`, `/dev/stdout`, `/dev/stderr`,
//!   `/dev/tty` and `/dev/fd/N`;
//! - protected paths: no write at any depth below a writable directory; a `.git`,
//!   `.git/modules` or `.git/worktrees` directory cannot be renamed or removed either, since
//!   renaming it would move protected files out from under their patterns;
//! - `denyRead` paths, and their ancestors inside writable directories, cannot be renamed or
//!   removed, for the same reason;
//! - network: only outgoing connections to the proxy on `localhost:<port>`; no binding, no
//!   Unix sockets, no other address.
//!
//! Seatbelt evaluates the rules in order and the last match wins, so the denies come after
//! the allows. On the default case-insensitive APFS volume Seatbelt matches paths without
//! regard to case (`.CLAUDE` hits the `.claude` rule; measured in T11).

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::policy::ResolvedPolicy;

/// The only `sandbox-exec` PiArc runs: never looked up on `PATH`.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

const BASE_POLICY: &str = include_str!("seatbelt/base.sbpl");

/// A generated profile and the parameters it reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatbeltProfile {
    /// SBPL text.
    pub text: String,
    /// `-D` parameters, in order.
    pub params: Vec<(String, String)>,
}

impl SeatbeltProfile {
    /// The profile for `policy` with network access only to the proxy on `proxy_port`.
    ///
    /// # Errors
    ///
    /// A path is not UTF-8 (APFS only stores UTF-8 names, so this means a broken policy).
    pub fn build(policy: &ResolvedPolicy, proxy_port: u16) -> Result<Self> {
        let mut builder = Builder::default();
        builder.text.push_str(BASE_POLICY);
        builder.section("PiArc: reads");
        builder.line("(allow file-read*)");
        let deny_read: Vec<String> = policy
            .deny_read
            .iter()
            .enumerate()
            .map(|(i, path)| builder.param(&format!("DENY_READ_{i}"), path))
            .collect::<Result<_>>()?;
        builder.rule("deny file-read*", deny_read.iter().map(|k| subpath(k)));

        builder.section("PiArc: writes");
        let mut writable = Vec::new();
        for (i, dir) in policy.writable.iter().enumerate() {
            let key = builder.param(&format!("WRITABLE_{i}"), dir)?;
            let pattern = builder.raw_param(&format!("WRITABLE_{i}_RE"), regex_escape(utf8(dir)?));
            writable.push((key, pattern));
        }
        builder.rule(
            "allow file-write*",
            writable.iter().map(|(k, _)| subpath(k)),
        );
        builder.line(
            "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/stdout\") \
             (literal \"/dev/stderr\") (literal \"/dev/tty\") (regex #\"^/dev/fd/[0-9]+$\"))",
        );

        builder.section("PiArc: protected paths");
        let protected = alternation(policy.protected.iter().map(|p| glob_regex(p)));
        if let Some(protected) = &protected {
            let below = format!("/(.*/)?({protected})(/.*)?$");
            builder.rule(
                "deny file-write*",
                writable.iter().map(|(_, re)| anchored_regex(re, &below)),
            );
        }
        let anchors = alternation(policy.protected.iter().flat_map(|p| literal_prefixes(p)));
        if let Some(anchors) = &anchors {
            let at = format!("/(.*/)?({anchors})$");
            builder.rule(
                "deny file-write-unlink",
                writable.iter().map(|(_, re)| anchored_regex(re, &at)),
            );
        }
        let kept: Vec<String> = keep_in_place(policy)
            .iter()
            .enumerate()
            .map(|(i, path)| builder.param(&format!("KEEP_{i}"), path))
            .collect::<Result<_>>()?;
        builder.rule(
            "deny file-write-unlink",
            deny_read
                .iter()
                .map(|k| subpath(k))
                .chain(kept.iter().map(|k| literal(k))),
        );

        builder.section("PiArc: network (the proxy only)");
        builder.line(&format!(
            "(allow network-outbound (remote ip \"localhost:{proxy_port}\"))"
        ));
        builder.section("PiArc: no writes through read-only descriptors");
        // F_MAKECOMPRESSED = 80, F_TRANSFEREXTENTS = 110 (as in Codex's generator).
        builder.line("(deny system-fcntl (fcntl-command 80 110))");
        Ok(Self {
            text: builder.text,
            params: builder.params,
        })
    }

    /// `sandbox-exec` arguments before the command: `-p <profile> -DKEY=VALUE… --`.
    #[must_use]
    pub fn args(&self) -> Vec<OsString> {
        let mut args = vec![OsString::from("-p"), OsString::from(&self.text)];
        args.extend(
            self.params
                .iter()
                .map(|(key, value)| OsString::from(format!("-D{key}={value}"))),
        );
        args.push(OsString::from("--"));
        args
    }
}

#[derive(Default)]
struct Builder {
    text: String,
    params: Vec<(String, String)>,
}

impl Builder {
    fn section(&mut self, title: &str) {
        let _ = write!(self.text, "\n; {title}\n");
    }

    fn line(&mut self, line: &str) {
        self.text.push_str(line);
        self.text.push('\n');
    }

    /// `(<action> filter…)` on one line per filter; nothing when there are no filters.
    fn rule(&mut self, action: &str, filters: impl Iterator<Item = String>) {
        let filters: Vec<String> = filters.collect();
        if filters.is_empty() {
            return;
        }
        let _ = write!(self.text, "({action}");
        for filter in filters {
            let _ = write!(self.text, "\n  {filter}");
        }
        self.text.push_str(")\n");
    }

    fn param(&mut self, key: &str, path: &Path) -> Result<String> {
        let value = utf8(path)?.to_owned();
        Ok(self.raw_param(key, value))
    }

    fn raw_param(&mut self, key: &str, value: String) -> String {
        self.params.push((key.to_owned(), value));
        key.to_owned()
    }
}

fn utf8(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| Error::NotUtf8 {
        path: path.to_path_buf(),
    })
}

fn subpath(key: &str) -> String {
    format!("(subpath (param {}))", sbpl_string(key))
}

fn literal(key: &str) -> String {
    format!("(literal (param {}))", sbpl_string(key))
}

/// `(regex "^" + <escaped directory parameter> + tail)`.
fn anchored_regex(key: &str, tail: &str) -> String {
    format!(
        "(regex (string-append \"^\" (param {}) {}))",
        sbpl_string(key),
        sbpl_string(tail)
    )
}

/// An SBPL string literal.
fn sbpl_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        if matches!(c, '"' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// `text` with the regular-expression metacharacters escaped.
fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\.^$*+?()[]{}|".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A protected pattern as a regex: `*` is one component, `**` one or more.
fn glob_regex(pattern: &str) -> String {
    pattern
        .split('/')
        .map(|part| match part {
            "**" => ".+".to_owned(),
            "*" => "[^/]+".to_owned(),
            literal => regex_escape(literal),
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The directory prefixes of a pattern before its first wildcard, excluding the whole pattern:
/// renaming one of them would carry protected files to a path no pattern matches.
fn literal_prefixes(pattern: &str) -> Vec<String> {
    let parts: Vec<&str> = pattern.split('/').collect();
    let fixed = parts
        .iter()
        .take(parts.len() - 1)
        .take_while(|part| !part.contains('*'))
        .count();
    (1..=fixed)
        .map(|n| glob_regex(&parts[..n].join("/")))
        .collect()
}

/// `a|b|c` of the distinct items, or `None` when there are none.
fn alternation(items: impl Iterator<Item = String>) -> Option<String> {
    let mut unique: Vec<String> = Vec::new();
    for item in items {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    (!unique.is_empty()).then(|| unique.join("|"))
}

/// The ancestors of `denyRead` paths inside writable directories (the directories themselves
/// excluded): renaming one would carry the unreadable path out from under its rule.
fn keep_in_place(policy: &ResolvedPolicy) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();
    for path in &policy.deny_read {
        for dir in &policy.writable {
            let Ok(relative) = path.strip_prefix(dir) else {
                continue;
            };
            let mut ancestor = dir.clone();
            let components: Vec<_> = relative.components().collect();
            for component in components.iter().take(components.len().saturating_sub(1)) {
                ancestor.push(component);
                if !kept.contains(&ancestor) {
                    kept.push(ancestor.clone());
                }
            }
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PROTECTED_PATHS;

    fn policy() -> ResolvedPolicy {
        ResolvedPolicy {
            writable: vec![
                PathBuf::from("/Users/dev/项目 one"),
                PathBuf::from("/Users/dev/Library/Application Support/PiArc/sessions/s1/tmp"),
                PathBuf::from("/Users/dev/extra [x]"),
            ],
            deny_read: vec![
                PathBuf::from("/Users/dev/.ssh"),
                PathBuf::from("/Users/dev/项目 one/secrets/key.pem"),
            ],
            protected: PROTECTED_PATHS.iter().map(|&p| p.to_owned()).collect(),
        }
    }

    #[test]
    fn profile_snapshot() {
        let profile = SeatbeltProfile::build(&policy(), 50123).expect("builds");
        let generated = profile
            .text
            .strip_prefix(BASE_POLICY)
            .expect("the base policy comes first");
        let params: String = profile
            .params
            .iter()
            .map(|(k, v)| format!("{k}={v}\n"))
            .collect();
        let snapshot = format!("{generated}\n;; params\n{params}");
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/seatbelt-profile.sbpl");
        if std::env::var_os("PIARC_UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(&path, &snapshot).expect("snapshot written");
        }
        let expected = std::fs::read_to_string(&path).expect(
            "snapshot exists (PIARC_UPDATE_SNAPSHOTS=1 cargo test -p piarc-sandbox writes it)",
        );
        assert_eq!(snapshot, expected);
    }

    #[test]
    fn paths_reach_sandbox_exec_as_parameters() {
        let profile = SeatbeltProfile::build(&policy(), 50123).expect("builds");
        assert!(!profile.text.contains("项目"));
        let args = profile.args();
        assert_eq!(args[0], "-p");
        assert_eq!(args.last().expect("args"), "--");
        assert!(args.contains(&OsString::from("-DWRITABLE_0=/Users/dev/项目 one")));
        assert!(args.contains(&OsString::from("-DWRITABLE_2_RE=/Users/dev/extra \\[x\\]")));
    }

    #[test]
    fn strings_and_regexes_are_escaped() {
        assert_eq!(sbpl_string(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(regex_escape("/a.b (c)+[d]"), r"/a\.b \(c\)\+\[d\]");
        assert_eq!(
            glob_regex(".git/modules/**/hooks"),
            r"\.git/modules/.+/hooks"
        );
        assert_eq!(
            glob_regex(".git/worktrees/*/config.worktree"),
            r"\.git/worktrees/[^/]+/config\.worktree"
        );
        assert_eq!(
            literal_prefixes(".git/modules/**/hooks"),
            vec![r"\.git".to_owned(), r"\.git/modules".to_owned()]
        );
        assert!(literal_prefixes(".claude").is_empty());
    }

    #[test]
    fn deny_read_ancestors_inside_writable_directories_are_kept_in_place() {
        assert_eq!(
            keep_in_place(&policy()),
            vec![PathBuf::from("/Users/dev/项目 one/secrets")]
        );
    }
}
