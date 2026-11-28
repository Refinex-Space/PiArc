//! The environments of the Git panel's two modes (ADR-0085 rules 1 and 3).
//!
//! Both start from the variables model commands inherit (ADR-0035, `inherited`) and add a few
//! named ones from the user's login shell (`login`); nothing else of the login environment, so
//! provider keys and tokens exported there never reach git, hooks or filters.

use std::ffi::{OsStr, OsString};

/// Added to read-only queries: git finds the user's configuration through them.
const READ_EXTRA: &[&str] = &["XDG_CONFIG_HOME"];

/// Added to the user's write operations: configuration, the SSH and GPG agents, proxies.
const USER_EXTRA: &[&str] = &[
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GNUPGHOME",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
];

/// Added to `gh` (ADR-0085 rule 9): the user's write-mode variables, and GitHub's own only when
/// the login shell has them.
const GH_EXTRA: &[&str] = &[
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "GH_CONFIG_DIR",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

/// Set on every `gh` run: no prompt, no update check, no colors or spinners.
const GH_SET: &[(&str, &str)] = &[
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_SPINNER_DISABLED", "1"),
    ("GH_PAGER", "cat"),
    ("NO_COLOR", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

/// Set on every read-only query.
const READ_SET: &[(&str, &str)] = &[
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_NO_LAZY_FETCH", "1"),
    // An empty allow list permits no transport: a query never reaches the network.
    ("GIT_ALLOW_PROTOCOL", ""),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_PAGER", "cat"),
    ("GIT_LITERAL_PATHSPECS", "1"),
    ("LC_ALL", "C"),
];

/// Set on every write operation.
const USER_SET: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("SSH_ASKPASS_REQUIRE", "never"),
    ("GIT_EDITOR", "true"),
    ("GIT_SEQUENCE_EDITOR", "true"),
    ("GIT_MERGE_AUTOEDIT", "no"),
    ("GIT_PAGER", "cat"),
    ("GIT_LITERAL_PATHSPECS", "1"),
    ("LC_ALL", "C"),
];

/// The environment of read-only queries.
#[must_use]
pub fn readonly_env(
    inherited: &[(OsString, OsString)],
    login: &[(OsString, OsString)],
) -> Vec<(OsString, OsString)> {
    build(inherited, login, READ_EXTRA, READ_SET)
}

/// The environment of the user's write operations.
#[must_use]
pub fn user_env(
    inherited: &[(OsString, OsString)],
    login: &[(OsString, OsString)],
) -> Vec<(OsString, OsString)> {
    build(inherited, login, USER_EXTRA, USER_SET)
}

/// The environment of `gh` (G5).
#[must_use]
pub fn gh_env(
    inherited: &[(OsString, OsString)],
    login: &[(OsString, OsString)],
) -> Vec<(OsString, OsString)> {
    build(inherited, login, GH_EXTRA, GH_SET)
}

fn build(
    inherited: &[(OsString, OsString)],
    login: &[(OsString, OsString)],
    extra: &[&str],
    set: &[(&str, &str)],
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = inherited
        .iter()
        .filter(|(name, _)| !is_git_variable(name))
        .cloned()
        .collect();
    for wanted in extra {
        if env.iter().any(|(name, _)| same_name(name, wanted)) {
            continue;
        }
        if let Some(pair) = login.iter().find(|(name, _)| same_name(name, wanted)) {
            env.push(pair.clone());
        }
    }
    for (name, value) in set {
        env.retain(|(existing, _)| !same_name(existing, name));
        env.push(((*name).into(), (*value).into()));
    }
    env
}

/// `GIT_*`: inherited values would redirect the repository, config or programs git runs.
fn is_git_variable(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        let upper = name.to_ascii_uppercase();
        if cfg!(windows) {
            upper.starts_with("GIT_")
        } else {
            name.starts_with("GIT_")
        }
    })
}

fn same_name(name: &OsStr, wanted: &str) -> bool {
    name.to_str().is_some_and(|name| {
        if cfg!(windows) {
            name.eq_ignore_ascii_case(wanted)
        } else {
            name == wanted
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
        env.iter()
            .find(|(k, _)| same_name(k, name))
            .map(|(_, v)| v.as_os_str())
    }

    #[test]
    fn read_only_takes_config_location_and_drops_git_variables() {
        let inherited = pairs(&[("PATH", "/bin"), ("HOME", "/h"), ("GIT_DIR", "/evil")]);
        let login = pairs(&[
            ("XDG_CONFIG_HOME", "/h/.config"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("OPENAI_API_KEY", "sk-secret"),
        ]);
        let env = readonly_env(&inherited, &login);
        assert_eq!(get(&env, "XDG_CONFIG_HOME"), Some(OsStr::new("/h/.config")));
        assert_eq!(get(&env, "GIT_DIR"), None);
        assert_eq!(get(&env, "SSH_AUTH_SOCK"), None);
        assert_eq!(get(&env, "OPENAI_API_KEY"), None);
        assert_eq!(get(&env, "GIT_ALLOW_PROTOCOL"), Some(OsStr::new("")));
        assert_eq!(get(&env, "GIT_OPTIONAL_LOCKS"), Some(OsStr::new("0")));
    }

    #[test]
    fn user_mode_adds_agents_and_proxies_only() {
        let inherited = pairs(&[("PATH", "/bin"), ("GIT_EDITOR", "vim")]);
        let login = pairs(&[
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("https_proxy", "http://proxy:8080"),
            ("GITHUB_TOKEN", "ghp_secret"),
            ("GIT_SSH_COMMAND", "ssh -i evil"),
        ]);
        let env = user_env(&inherited, &login);
        assert_eq!(get(&env, "SSH_AUTH_SOCK"), Some(OsStr::new("/tmp/agent")));
        assert_eq!(
            get(&env, "https_proxy"),
            Some(OsStr::new("http://proxy:8080"))
        );
        assert_eq!(get(&env, "GITHUB_TOKEN"), None);
        assert_eq!(get(&env, "GIT_SSH_COMMAND"), None);
        assert_eq!(get(&env, "GIT_EDITOR"), Some(OsStr::new("true")));
        assert_eq!(get(&env, "SSH_ASKPASS_REQUIRE"), Some(OsStr::new("never")));
    }
}
