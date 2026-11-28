//! The environment shell commands run with (architecture sections 5.4 and 6.11).
//!
//! - **The user's login shell is the base.** An application started from the Dock (or
//!   Launchpad, Spotlight) gets launchd's minimal environment: the `PATH` lines of
//!   `.zprofile`, `.zshrc` and the like are missing, so `node`, `cargo` or `brew` would not be
//!   found. [`login_shell_env`] runs the user's `$SHELL` once as an interactive login shell
//!   (`-i -l -c`, the files a terminal reads), prints its environment between two markers and
//!   returns it; Core caches the answer. It runs the user's configuration files, so it has a
//!   timeout, and any failure leaves the caller with its own environment (and a warning to log).
//!   The shell runs in a session of its own with no controlling terminal and EOF on its stdin,
//!   as VS Code and Zed start it: when PiArc itself was started from a terminal, an interactive
//!   zsh in a background group of that terminal's session is stopped by `SIGTTIN` and the
//!   probe used to wait for its whole timeout.
//!   Windows reads `PATH` from the registry for every process; there the process environment is
//!   the base.
//! - **PiArc's own variables are removed** ([`strip_internal`]): Electron's, Node's and the
//!   ones PiArc and Pi use to talk to their own processes ([`INTERNAL_PREFIXES`],
//!   [`INTERNAL_NAMES`]), and the shell bookkeeping of the login shell ([`SHELL_STATE`]).
//! - **No credentials are added.** Provider keys live in Core's vault and reach the Agent Host
//!   over AHP only. Executable children receive only the explicit OS and toolchain fields
//!   in [`command_environment`]; unrelated user variables stay out.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::command::{CommandRunner, CommandSpec, OutputChunk, Stream};
use crate::tree::DetachedTreeSpawner;

/// Name prefixes of variables that belong to PiArc's processes, never to the user's commands.
pub const INTERNAL_PREFIXES: &[&str] = &["ELECTRON_", "PIARC_", "PI_"];

/// Single variables of Node and Electron that change how a command's own Node programs run.
pub const INTERNAL_NAMES: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "NODE_UNIQUE_ID",
    "ORIGINAL_XDG_CURRENT_DESKTOP",
    "CHROME_CRASHPAD_PIPE_NAME",
];

/// What the login shell sets for itself; the command's own shell sets them again.
pub const SHELL_STATE: &[&str] = &["_", "SHLVL", "PWD", "OLDPWD"];

/// How long the login shell may take to print its environment.
pub const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(10);

/// Shells known to accept `-i -l -c <command>`.
const LOGIN_SHELLS: &[&str] = &["bash", "zsh", "sh", "dash", "ksh", "fish"];

/// Whether `name` is one of PiArc's internal variables (case-insensitive on Windows).
#[must_use]
pub fn is_internal(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    let upper;
    let name = if cfg!(windows) {
        upper = name.to_ascii_uppercase();
        upper.as_str()
    } else {
        name.as_ref()
    };
    INTERNAL_PREFIXES.iter().any(|p| name.starts_with(p))
        || INTERNAL_NAMES.contains(&name)
        || SHELL_STATE.contains(&name)
}

/// `env` without PiArc's internal variables.
#[must_use]
pub fn strip_internal(env: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
    env.into_iter()
        .filter(|(name, _)| !is_internal(name))
        .collect()
}

/// Variables inherited by model-invoked commands (ADR-0035). Keep this a positive list:
/// variable names and secret formats are open-ended, including credentials inside URLs.
#[must_use]
pub fn command_environment(env: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "SHELL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_CTYPE",
        "LC_COLLATE",
        "LC_TIME",
        "LC_NUMERIC",
        "LC_MONETARY",
        "LC_MESSAGES",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "JAVA_HOME",
        "GOPATH",
        "GOROOT",
        "SDKROOT",
        "DEVELOPER_DIR",
    ];
    env.iter()
        .filter(|(name, _)| {
            name.to_str().is_some_and(|k| {
                ALLOWED.iter().any(|allowed| {
                    if cfg!(windows) {
                        k.eq_ignore_ascii_case(allowed)
                    } else {
                        k == *allowed
                    }
                })
            })
        })
        .cloned()
        .collect()
}

/// Why the login shell's environment is not available.
#[derive(Debug, thiserror::Error)]
pub enum LoginEnvError {
    /// `SHELL` is unset or names a shell whose options are unknown.
    #[error("no usable login shell (SHELL={0:?})")]
    NoShell(Option<String>),
    /// The shell could not be started.
    #[error("cannot start {shell}: {error}")]
    Start {
        /// The shell.
        shell: String,
        /// What went wrong.
        error: std::io::Error,
    },
    /// The shell did not finish in time.
    #[error("{0} did not print its environment within {LOGIN_ENV_TIMEOUT:?}")]
    TimedOut(String),
    /// The output did not contain the environment.
    #[error("{0} printed no environment (exit status {1:?})")]
    NoOutput(String, Option<i32>),
}

/// The environment of the user's login shell (`SHELL` in `base`), started with `base` from
/// `cwd` (the home directory), in a session of its own (no controlling terminal). See the
/// module documentation.
///
/// # Errors
///
/// [`LoginEnvError`] when there is no known shell, it cannot start, takes longer than
/// [`LOGIN_ENV_TIMEOUT`] or prints no environment.
pub async fn login_shell_env(
    base: &[(OsString, OsString)],
    cwd: &Path,
) -> Result<Vec<(OsString, OsString)>, LoginEnvError> {
    let shell = base
        .iter()
        .find(|(name, _)| name == "SHELL")
        .map(|(_, value)| PathBuf::from(value));
    let known = shell.as_ref().is_some_and(|shell| {
        shell.is_absolute()
            && shell
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| LOGIN_SHELLS.contains(&name))
    });
    let shell = match shell {
        Some(shell) if known => shell,
        other => {
            return Err(LoginEnvError::NoShell(
                other.map(|s| s.display().to_string()),
            ));
        }
    };
    let shown = shell.display().to_string();
    let marker = format!("__PIARC_ENV_{}__", std::process::id());
    // Read the environment with the OS utility even when the profile changes PATH.
    let script = format!("printf '%s' '{marker}'; /usr/bin/env -0; printf '%s' '{marker}'");
    let spec = CommandSpec {
        program: shell,
        args: ["-i", "-l", "-c", script.as_str()]
            .iter()
            .map(OsString::from)
            .collect(),
        cwd: cwd.to_path_buf(),
        env: base.to_vec(),
        launcher: None,
        timeout: Some(LOGIN_ENV_TIMEOUT),
        kill_grace: Duration::from_millis(500),
    };
    let runner = CommandRunner::new(Arc::new(DetachedTreeSpawner));
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
    let collect = async {
        let mut out = Vec::new();
        while let Some(chunk) = rx.recv().await {
            if chunk.stream == Stream::Stdout {
                out.extend(chunk.bytes);
            }
        }
        out
    };
    let (exit, out) = tokio::join!(runner.run(spec, tx, CancellationToken::new()), collect);
    let exit = exit.map_err(|error| LoginEnvError::Start {
        shell: shown.clone(),
        error,
    })?;
    if exit.timed_out {
        return Err(LoginEnvError::TimedOut(shown));
    }
    parse_env_output(&out, marker.as_bytes())
        .ok_or(LoginEnvError::NoOutput(shown, exit.status.code))
}

/// The `NAME=value` entries of `env -0` between the first and the last `marker`.
fn parse_env_output(out: &[u8], marker: &[u8]) -> Option<Vec<(OsString, OsString)>> {
    let start = find(out, marker)? + marker.len();
    let end = start + rfind(&out[start..], marker)?;
    let entries = out[start..end]
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let at = entry.iter().position(|&b| b == b'=')?;
            (at > 0).then(|| (bytes_os(&entry[..at]), bytes_os(&entry[at + 1..])))
        })
        .collect::<Vec<_>>();
    (!entries.is_empty()).then_some(entries)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

#[cfg(unix)]
fn bytes_os(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(bytes.to_vec())
}

#[cfg(not(unix))]
fn bytes_os(bytes: &[u8]) -> OsString {
    OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn strips_piarc_electron_and_node_variables() {
        let env = os(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/u"),
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("ELECTRON_NO_ATTACH_CONSOLE", "1"),
            ("NODE_OPTIONS", "--require x"),
            ("NODE_CHANNEL_FD", "3"),
            ("PI_CODING_AGENT_DIR", "/data/pi"),
            ("PI_PACKAGE_DIR", "/bundle"),
            ("PIARC_REQUIRE_KEYCHAIN", "1"),
            ("SHLVL", "2"),
            ("_", "/usr/bin/env"),
            ("PWD", "/home/u"),
            ("NODE_ENV", "development"),
            ("PIP_INDEX_URL", "https://example.test/simple"),
        ]);
        let kept: Vec<String> = strip_internal(env)
            .into_iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept, ["PATH", "HOME", "NODE_ENV", "PIP_INDEX_URL"]);
    }

    #[test]
    fn command_fields_use_the_platforms_environment_name_rules() {
        let base = os(&[
            ("Path", "fixture-path"),
            ("LC_NUMERIC", "C"),
            ("BASH_ENV", "custom-startup"),
            ("PIP_INDEX_URL", "https://fixture.invalid/simple"),
            ("CUSTOM_CREDENTIAL", "fixture-secret"),
        ]);
        let inherited = command_environment(&base);
        let mut expected = Vec::new();
        if cfg!(windows) {
            expected.push(("Path", "fixture-path"));
        }
        expected.push(("LC_NUMERIC", "C"));
        assert_eq!(inherited, os(&expected));
    }

    #[test]
    fn parses_env_between_markers() {
        let out = b"motd noise\n__M__PATH=/a:/b\0MULTI=one\ntwo\0EMPTY=\0EQ=a=b\0__M__trailing";
        let env = parse_env_output(out, b"__M__").expect("parsed");
        assert_eq!(
            env,
            os(&[
                ("PATH", "/a:/b"),
                ("MULTI", "one\ntwo"),
                ("EMPTY", ""),
                ("EQ", "a=b")
            ])
        );
        assert!(parse_env_output(b"no markers", b"__M__").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_the_login_shells_path() {
        // A home directory whose login file adds a directory to PATH, as `.bash_profile`
        // would for a toolchain.
        let home = std::env::temp_dir().join(format!("piarc-exec-login {}", std::process::id()));
        std::fs::create_dir_all(&home).expect("home");
        std::fs::write(
            home.join(".bash_profile"),
            "echo profile noise\nexport PATH=\"/opt/piarc-test/bin:$PATH\"\nexport FROM_PROFILE=yes\n",
        )
        .expect("profile");
        let base = os(&[
            ("PATH", "/usr/bin:/bin"),
            ("HOME", home.to_str().expect("utf-8")),
            ("SHELL", "/bin/bash"),
            ("ELECTRON_RUN_AS_NODE", "1"),
        ]);
        let env = login_shell_env(&base, &home).await.expect("login env");
        let get = |name: &str| {
            env.iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.to_string_lossy().into_owned())
        };
        // `/etc/profile` may rebuild PATH (macOS runs `path_helper`); the profile's entry is
        // what an application started from the Dock would otherwise miss.
        let path = get("PATH").expect("PATH");
        assert!(path.starts_with("/opt/piarc-test/bin:"), "{path}");
        assert!(path.split(':').any(|dir| dir == "/usr/bin"), "{path}");
        assert_eq!(get("FROM_PROFILE").as_deref(), Some("yes"));
        let stripped = strip_internal(env);
        assert!(!stripped.iter().any(|(k, _)| k == "ELECTRON_RUN_AS_NODE"));
        std::fs::remove_dir_all(&home).expect("cleanup");
    }

    #[tokio::test]
    async fn an_unknown_shell_is_reported() {
        let error = login_shell_env(&os(&[("SHELL", "/bin/tcsh")]), &std::env::temp_dir())
            .await
            .expect_err("tcsh is not supported");
        assert!(matches!(error, LoginEnvError::NoShell(Some(_))), "{error}");
        let error = login_shell_env(&[], &std::env::temp_dir())
            .await
            .expect_err("no SHELL");
        assert!(matches!(error, LoginEnvError::NoShell(None)), "{error}");
    }
}
