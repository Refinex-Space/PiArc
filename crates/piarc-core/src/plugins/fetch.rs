//! Getting a package onto disk (T40, ADR-0058, ADR-0102): npm through the bundled npm with
//! lifecycle scripts off, git through `piarc-git` pinned to a commit, directories used in place.
//! Every npm package gets a prefix of its own, `<data>/pi/npm/pkgs/<key>/`
//! (`node_modules/<name>` inside): an install never changes another package's files, the
//! installed name is the prefix's only dependency, and uninstalling removes the prefix. Packages
//! installed before ADR-0102 stay in the shared prefix `<data>/pi/npm/`. git clones live at
//! `<data>/pi/git/<host>/<path>`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_ports::{ProcessSpawner, SpawnSpec};
use piarc_protocol::ErrorKind;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::error::{Error, Result};

/// How long one npm command may run before it is killed.
pub(crate) const NPM_TIMEOUT: Duration = Duration::from_secs(600);

/// The arguments every npm install and uninstall carries: lifecycle scripts never run (the
/// package's own and its dependencies'), no audit or funding requests, and Pi's peers are not
/// resolved (the extension runs inside the Agent Host's Pi).
pub const NPM_SAFE_ARGS: &[&str] = &[
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--legacy-peer-deps",
];

/// Lifecycle scripts that npm would run on install.
const INSTALL_SCRIPTS: &[&str] = &["preinstall", "install", "postinstall", "prepare"];

pub(crate) fn failed(kind: ErrorKind, message: impl Into<String>) -> Error {
    Error::Feature {
        kind,
        retryable: false,
        message: message.into(),
        details: None,
    }
}

/// The bundled npm next to the bundled `node`: `npm-cli.js`, run as `node npm-cli.js`.
pub(crate) fn npm_cli(node: &Path) -> Option<PathBuf> {
    let bin = node.parent()?;
    let candidates = [
        // macOS and Linux distributions: bin/npm → ../lib/node_modules/npm/bin/npm-cli.js.
        bin.join("..")
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        // Windows distributions: node_modules\npm next to node.exe.
        bin.join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
        // Node cannot run a verbatim `\\?\C:\…` script path: it lstat-s `C:` (W3).
        .map(piarc_git::strip_verbatim)
}

/// A clone's `.npmrc`, renamed while the bundled npm runs in the clone so that none of the
/// package's npm settings apply, and put back afterwards (the checkout stays as fetched).
pub(crate) struct HiddenNpmrc {
    moved: Option<(PathBuf, PathBuf)>,
}

impl HiddenNpmrc {
    /// Renames `<dir>/.npmrc` aside when there is one.
    pub(crate) fn set_aside(dir: &Path) -> Result<Self> {
        let file = dir.join(".npmrc");
        if std::fs::symlink_metadata(&file).is_err() {
            return Ok(Self { moved: None });
        }
        let aside = dir.join(".npmrc.piarc-set-aside");
        std::fs::rename(&file, &aside)
            .map_err(|e| failed(ErrorKind::IoError, format!("{}: {e}", file.display())))?;
        Ok(Self {
            moved: Some((aside, file)),
        })
    }

    /// Puts the file back.
    pub(crate) fn restore(self) -> Result<()> {
        if let Some((aside, file)) = self.moved {
            std::fs::rename(&aside, &file)
                .map_err(|e| failed(ErrorKind::IoError, format!("{}: {e}", file.display())))?;
        }
        Ok(())
    }
}

/// What one command printed.
pub(crate) struct Captured {
    pub code: Option<i32>,
    pub stderr: String,
}

/// Runs `node npm-cli.js <args>` in `cwd` with `env` (the command environment with the bundled
/// Node's directory first on `PATH`).
pub(crate) async fn npm(
    spawner: &Arc<dyn ProcessSpawner>,
    node: &Path,
    cwd: &Path,
    env: Vec<(OsString, OsString)>,
    args: &[OsString],
) -> Result<Captured> {
    let cli = npm_cli(node).ok_or_else(|| {
        failed(
            ErrorKind::NotFound,
            format!("the bundled npm was not found next to {}", node.display()),
        )
    })?;
    let mut all = vec![cli.into_os_string()];
    all.extend(args.iter().cloned());
    let spec = SpawnSpec {
        program: node.to_owned(),
        args: all,
        cwd: cwd.to_owned(),
        env,
    };
    let mut process = spawner
        .spawn(spec)
        .map_err(|e| failed(ErrorKind::IoError, format!("cannot start npm: {e}")))?;
    drop(process.stdin);
    let stdout = tokio::spawn(drain(process.stdout, 0));
    let stderr = tokio::spawn(drain(process.stderr, 8 * 1024));
    let status = match tokio::time::timeout(NPM_TIMEOUT, process.control.wait()).await {
        Ok(status) => {
            status.map_err(|e| failed(ErrorKind::IoError, format!("npm did not complete: {e}")))?
        }
        Err(_) => {
            let _ = process.control.kill();
            let _ = process.control.wait().await;
            return Err(failed(ErrorKind::Timeout, "npm timed out"));
        }
    };
    let _ = stdout.await;
    let stderr = stderr.await.unwrap_or_default();
    Ok(Captured {
        code: status.code,
        stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
    })
}

async fn drain(mut pipe: std::pin::Pin<Box<dyn AsyncRead + Send>>, keep: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    while let Ok(n) = pipe.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        let room = keep.saturating_sub(kept.len()).min(n);
        kept.extend_from_slice(&buffer[..room]);
    }
    kept
}

/// `env` with `dir` first on `PATH` (the bundled Node, ADR-0015 rule 6).
pub(crate) fn with_path_first(
    mut env: Vec<(OsString, OsString)>,
    dir: &Path,
) -> Vec<(OsString, OsString)> {
    let index = env
        .iter()
        .position(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"));
    let rest = index.map(|i| env.remove(i).1);
    let mut parts = vec![dir.to_owned()];
    if let Some(rest) = rest {
        parts.extend(std::env::split_paths(&rest));
    }
    let joined = std::env::join_paths(parts).unwrap_or_default();
    env.push(("PATH".into(), joined));
    env
}

/// The npm prefix of installed npm packages (its real path), created with a minimal
/// `package.json`.
pub(crate) fn npm_root(pi: &Path) -> Result<PathBuf> {
    let root = pi.join("npm");
    std::fs::create_dir_all(&root).map_err(|e| {
        failed(
            ErrorKind::IoError,
            format!("cannot create {}: {e}", root.display()),
        )
    })?;
    let manifest = root.join("package.json");
    if !manifest.exists() {
        std::fs::write(
            &manifest,
            "{\n  \"name\": \"piarc-pi-packages\",\n  \"private\": true\n}\n",
        )
        .map_err(|e| {
            failed(
                ErrorKind::IoError,
                format!("cannot write {}: {e}", manifest.display()),
            )
        })?;
    }
    // npm writes broken lock file paths when `--prefix` goes through a symbolic link (macOS's
    // `/var` → `/private/var`), as Pi notes: always hand it the real path, without Windows'
    // verbatim prefix, which neither Node nor npm takes (W3).
    root.canonicalize()
        .map(piarc_git::strip_verbatim)
        .map_err(|e| {
            failed(
                ErrorKind::IoError,
                format!("cannot open {}: {e}", root.display()),
            )
        })
}

/// The directory of per-package npm prefixes, `<pi>/npm/pkgs` (its real path).
pub(crate) fn pkgs_root(pi: &Path) -> Result<PathBuf> {
    let root = pi.join("npm").join("pkgs");
    std::fs::create_dir_all(&root).map_err(|e| {
        failed(
            ErrorKind::IoError,
            format!("cannot create {}: {e}", root.display()),
        )
    })?;
    real(&root)
}

fn real(path: &Path) -> Result<PathBuf> {
    // npm writes broken lock file paths when `--prefix` goes through a symbolic link: always
    // hand it the real path, without Windows' verbatim prefix (W3).
    path.canonicalize()
        .map(piarc_git::strip_verbatim)
        .map_err(|e| {
            failed(
                ErrorKind::IoError,
                format!("cannot open {}: {e}", path.display()),
            )
        })
}

fn write_stub(prefix: &Path) -> Result<()> {
    std::fs::write(
        prefix.join("package.json"),
        "{\n  \"name\": \"piarc-pi-package\",\n  \"private\": true\n}\n",
    )
    .map_err(|e| {
        failed(
            ErrorKind::IoError,
            format!("cannot write {}: {e}", prefix.display()),
        )
    })
}

/// A new, empty prefix to install one npm spec into: `<pi>/npm/pkgs/.staging-<random>`.
pub(crate) fn staging_prefix(pi: &Path) -> Result<PathBuf> {
    let root = pkgs_root(pi)?;
    let id = crate::sessions::new_session_id().map_err(|e| Error::Internal {
        reason: e.to_string(),
    })?;
    let prefix = root.join(format!(".staging-{id}"));
    std::fs::create_dir_all(&prefix).map_err(|e| {
        failed(
            ErrorKind::IoError,
            format!("cannot create {}: {e}", prefix.display()),
        )
    })?;
    write_stub(&prefix)?;
    real(&prefix)
}

/// The prefix directory name of npm package `name`: its letters, then a short hash of the
/// whole name, so that `a.b` and `a-b`, `@a/b` and `a-b` never share one.
#[must_use]
pub(crate) fn prefix_key(name: &str) -> String {
    use sha2::Digest;
    let readable: String = name
        .trim_start_matches('@')
        .chars()
        .map(|c| match c {
            'a'..='z' | '0'..='9' | '-' | '.' | '_' => c,
            'A'..='Z' => c.to_ascii_lowercase(),
            _ => '+',
        })
        .take(64)
        .collect();
    let digest = sha2::Sha256::digest(name.as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{readable}-{hash}")
}

/// The one package a staging prefix installed: its only dependency.
pub(crate) fn prefix_dependency(prefix: &Path) -> Option<String> {
    let deps = std::fs::read(prefix.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("dependencies").and_then(Value::as_object).cloned())?;
    let mut names = deps.keys();
    let name = names.next()?.clone();
    names.next().is_none().then_some(name)
}

/// The per-package prefix that holds `path` (`<pkgs>/<key>`), if `path` is inside one.
pub(crate) fn prefix_of(pi: &Path, path: &Path) -> Option<PathBuf> {
    let pkgs = pi.join("npm").join("pkgs");
    let pkgs = pkgs
        .canonicalize()
        .map(piarc_git::strip_verbatim)
        .unwrap_or(pkgs);
    let rest = path.strip_prefix(&pkgs).ok()?;
    let first = rest.components().next()?;
    let std::path::Component::Normal(key) = first else {
        return None;
    };
    Some(pkgs.join(key))
}

/// The npm name of a package installed in the shared prefix before ADR-0102:
/// `<pi>/npm/node_modules/<name>` or `.../@scope/<name>`.
pub(crate) fn shared_prefix_name(pi: &Path, path: &Path) -> Option<String> {
    let modules = pi.join("npm").join("node_modules");
    let modules = modules
        .canonicalize()
        .map(piarc_git::strip_verbatim)
        .unwrap_or(modules);
    let rest = path.strip_prefix(&modules).ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    match parts.as_slice() {
        [scope, name] if scope.starts_with('@') => Some(format!("{scope}/{name}")),
        [name] if !name.starts_with('@') => Some(name.clone()),
        _ => None,
    }
}

/// Removes a per-package prefix after checking that it is one (`<pi>/npm/pkgs/<key>`).
pub(crate) fn remove_prefix(pi: &Path, prefix: &Path) -> Result<()> {
    let pkgs = pkgs_root(pi)?;
    let inside = prefix
        .canonicalize()
        .map(piarc_git::strip_verbatim)
        .ok()
        .is_some_and(|p| p.parent() == Some(pkgs.as_path()));
    if !inside {
        return Err(failed(
            ErrorKind::PermissionDenied,
            format!("{} is not a package prefix", prefix.display()),
        ));
    }
    std::fs::remove_dir_all(prefix).map_err(|e| {
        failed(
            ErrorKind::IoError,
            format!("cannot remove {}: {e}", prefix.display()),
        )
    })
}

/// The version and integrity npm recorded for `name` in the prefix's lock file.
pub(crate) fn npm_lock_entry(root: &Path, name: &str) -> (Option<String>, Option<String>) {
    let lock = std::fs::read(root.join("package-lock.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let entry = lock.as_ref().and_then(|l| {
        l.get("packages")
            .and_then(|p| p.get(format!("node_modules/{name}")))
    });
    let text = |key: &str| {
        entry
            .and_then(|e| e.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    (text("version"), text("integrity"))
}

/// The install scripts a package declares (they did not run).
pub(crate) fn declared_scripts(dir: &Path) -> Vec<String> {
    let package = std::fs::read(dir.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let scripts = package
        .as_ref()
        .and_then(|p| p.get("scripts"))
        .and_then(Value::as_object);
    INSTALL_SCRIPTS
        .iter()
        .filter(|s| scripts.is_some_and(|m| m.contains_key(**s)))
        .map(|s| (*s).to_owned())
        .collect()
}

/// Whether a cloned package needs its dependencies installed (`dependencies` not empty).
pub(crate) fn has_dependencies(dir: &Path) -> bool {
    std::fs::read(dir.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| {
            v.get("dependencies")
                .and_then(Value::as_object)
                .map(|m| !m.is_empty())
        })
        .unwrap_or(false)
}

/// Where a git URL is cloned: `<pi>/git/<host>/<path>` (Pi's layout), every component checked.
pub(crate) fn git_dir(pi: &Path, url: &str) -> Result<PathBuf> {
    let rest = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .or_else(|| url.strip_prefix("git@"))
        .ok_or_else(|| {
            failed(
                ErrorKind::InvalidParams,
                format!("{url:?} is not a git URL"),
            )
        })?;
    // `git@host:owner/repo` and `scheme://[user@]host[:port]/path`.
    let rest = rest.replacen(':', "/", usize::from(url.starts_with("git@")));
    let rest = rest
        .rsplit_once('@')
        .map_or(rest.as_str(), |(_, r)| r)
        .to_owned();
    let (host, path) = rest.split_once('/').unwrap_or(("", rest.as_str()));
    let host = if host.is_empty() {
        "local"
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let mut dir = pi.join("git").join(sanitize(host));
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut any = false;
    for part in path.split('/').filter(|p| !p.is_empty()) {
        if part == "." || part == ".." {
            return Err(failed(
                ErrorKind::InvalidParams,
                format!("{url:?} has a relative path"),
            ));
        }
        dir.push(sanitize(part));
        any = true;
    }
    if !any {
        return Err(failed(
            ErrorKind::InvalidParams,
            format!("{url:?} names no repository"),
        ));
    }
    Ok(dir)
}

fn sanitize(part: &str) -> String {
    part.chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Checks a git URL: one of the network or file schemes git clones from, never an option.
pub(crate) fn check_git_url(url: &str) -> Result<()> {
    let ok = ["https://", "http://", "ssh://", "git://", "file://", "git@"]
        .iter()
        .any(|p| url.starts_with(p))
        && !url.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(failed(
            ErrorKind::InvalidParams,
            format!("{url:?} is not a git URL (https, http, ssh, git, file or git@host:path)"),
        ))
    }
}

/// Checks an npm spec: a name, `name@version`, a tarball or directory path, never an option.
pub(crate) fn check_npm_spec(spec: &str) -> Result<()> {
    // Arguments go to npm as they are (no shell): only an option or a control character is
    // refused; a path may contain spaces.
    if spec.trim().is_empty() || spec.starts_with('-') || spec.chars().any(char::is_control) {
        return Err(failed(
            ErrorKind::InvalidParams,
            format!("{spec:?} is not an npm package spec"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{git_dir, prefix_key};

    #[test]
    fn git_urls_map_to_pi_layout_directories() {
        let pi = Path::new("/d/pi");
        assert_eq!(
            git_dir(pi, "https://github.com/acme/tools.git").expect("https"),
            pi.join("git").join("github.com").join("acme").join("tools")
        );
        assert_eq!(
            git_dir(pi, "git@github.com:acme/tools.git").expect("scp"),
            pi.join("git").join("github.com").join("acme").join("tools")
        );
        assert_eq!(
            git_dir(pi, "file:///tmp/仓库/demo.git").expect("file"),
            pi.join("git")
                .join("local")
                .join("tmp")
                .join("仓库")
                .join("demo")
        );
        assert!(git_dir(pi, "https://h/../x").is_err());
        assert!(git_dir(pi, "nope").is_err());
    }

    #[test]
    fn prefix_keys_never_collide_on_similar_names() {
        let keys: std::collections::BTreeSet<String> = ["a.b", "a-b", "@a/b", "a+b", "A-B"]
            .iter()
            .map(|n| prefix_key(n))
            .collect();
        assert_eq!(keys.len(), 5, "{keys:?}");
        assert!(prefix_key("@scope/pi-tools").starts_with("scope+pi-tools-"));
        assert!(!prefix_key("@scope/pi-tools").contains('/'));
    }
}
