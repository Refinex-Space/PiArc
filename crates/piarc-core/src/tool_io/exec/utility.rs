//! Resolve the programs an automatic approval relies on without running anything from the
//! workspace (ADR-0031, T23). A command allowed by the read-only list or by Accept edits runs
//! only when every external program in it resolves outside the directories the session can
//! write; the physical files are then pinned in the command's bash process.
use super::*;

/// The Accept edits file commands: their programs must also be system utilities.
const FILE_UTILITIES: &[&str] = &["mkdir", "touch", "mv", "cp"];

/// What a preflight needs to resolve program names the way the command's bash will.
pub(in crate::tool_io) struct Programs {
    #[cfg(not(windows))]
    env: Vec<(OsString, OsString)>,
    custom: bool,
    shell: Option<PathBuf>,
    #[cfg(windows)]
    git: Vec<(String, PathBuf)>,
}

impl Exec {
    pub(in crate::tool_io) async fn programs(&self) -> Programs {
        let resolved = self.base_env().await;
        let shell = self.shells().bash.clone();
        #[cfg(windows)]
        let git = match &shell {
            Some(shell) => self
                .git_programs
                .get_or_init(|| self.probe_git_programs(shell, &resolved.inherited))
                .await
                .clone(),
            None => Vec::new(),
        };
        Programs {
            #[cfg(not(windows))]
            env: resolved.inherited.clone(),
            custom: resolved.custom_resolution,
            shell,
            #[cfg(windows)]
            git,
        }
    }

    /// Ask Git Bash which listed programs resolve to Git's own executables, from a clean
    /// directory. Git's launcher puts its own directories first on the Windows PATH.
    #[cfg(windows)]
    async fn probe_git_programs(
        &self,
        shell: &Path,
        env: &[(OsString, OsString)],
    ) -> Vec<(String, PathBuf)> {
        let Some(root) = git_root(shell) else {
            return Vec::new();
        };
        // All names are constants; the installation is passed as an argument to bash.
        let script = r#"root=$1; shift
        for n in "$@"; do
            f=$(builtin type -P "$n") || continue
            if [[ "$f" -ef "$root/usr/bin/$n.exe" ]]; then builtin printf 'usr %s\n' "$n"
            elif [[ "$f" -ef "$root/mingw64/bin/$n.exe" ]]; then builtin printf 'mingw64 %s\n' "$n"
            fi
        done
        exit 0"#;
        let mut args: Vec<OsString> = vec![
            "-c".into(),
            script.into(),
            "piarc".into(),
            piarc_fs::display(&root).replace('\\', "/").into(),
        ];
        let names = FILE_UTILITIES
            .iter()
            .chain(piarc_policy::bash::PROGRAMS)
            .chain(piarc_policy::bash::WRAPPED)
            .copied();
        args.extend(names.map(OsString::from));
        let spec = CommandSpec {
            program: shell.to_owned(),
            args,
            cwd: root.clone(),
            env: env.to_vec(),
            launcher: None,
            timeout: Some(Duration::from_secs(5)),
            kill_grace: Duration::from_millis(100),
        };
        let (tx, mut rx) = mpsc::channel::<OutputChunk>(8);
        let read = async {
            let mut bytes = Vec::new();
            while let Some(chunk) = rx.recv().await {
                if chunk.stream == Stream::Stdout && bytes.len() + chunk.bytes.len() <= 16_384 {
                    bytes.extend(chunk.bytes);
                }
            }
            bytes
        };
        let (result, bytes) =
            tokio::join!(self.runner.run(spec, tx, CancellationToken::new()), read);
        if !result.is_ok_and(|r| r.status.success() && !r.timed_out && !r.killed) {
            return Vec::new();
        }
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| {
                let (dir, name) = line.split_once(' ')?;
                let program = root.join(dir).join("bin").join(format!("{name}.exe"));
                let canonical = piarc_git::strip_verbatim(program.canonicalize().ok()?);
                (canonical == program).then(|| (name.to_owned(), program))
            })
            .collect()
    }
}

impl Programs {
    /// The physical program `name` resolves to, `None` when an automatic approval cannot rely
    /// on it: the shell's startup or functions are customized, the PATH reaches into the
    /// workspace, or the program lives where the session can write.
    pub(in crate::tool_io) fn resolve(
        &self,
        scope: &piarc_fs::Scope,
        name: &str,
    ) -> Option<PathBuf> {
        if self.custom {
            return None;
        }
        let shell = self.shell.as_deref()?;
        #[cfg(windows)]
        {
            let _ = (shell, scope);
            self.git
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, p)| p.clone())
        }
        #[cfg(not(windows))]
        {
            if shell != Path::new("/bin/bash") {
                return None;
            }
            if FILE_UTILITIES.contains(&name) {
                let expected = installed_utility(name)?;
                return (first_on_path(&self.env, scope, name).ok()?.as_ref() == Some(&expected))
                    .then_some(expected);
            }
            let found = first_on_path(&self.env, scope, name).ok()??;
            let writable = scope
                .check(&piarc_fs::display(&found), piarc_fs::Access::Read)
                .is_ok();
            (!writable).then_some(found)
        }
    }
}

#[cfg(not(windows))]
fn installed_utility(name: &str) -> Option<PathBuf> {
    ["/bin", "/usr/bin"]
        .iter()
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())?
        .canonicalize()
        .ok()
}

/// The Git installation that owns `shell`, when it is the verified Program Files one.
#[cfg(windows)]
fn git_root(shell: &Path) -> Option<PathBuf> {
    let actual = piarc_git::strip_verbatim(shell.canonicalize().ok()?);
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|base| PathBuf::from(base).join("Git"))
        .find(|git| actual == git.join("bin/bash.exe"))
}

pub(super) fn has_custom_resolution(env: &[(OsString, OsString)]) -> bool {
    env.iter().any(|(key, v)| {
        let key = key.to_string_lossy().to_ascii_uppercase();
        !v.is_empty()
            && (matches!(
                key.as_str(),
                "BASH_ENV"
                    | "ENV"
                    | "BASHOPTS"
                    | "SHELLOPTS"
                    | "PS4"
                    | "POSIXLY_CORRECT"
                    | "SSH_CLIENT"
                    | "SSH2_CLIENT"
                    | "SSH_CONNECTION"
            ) || key.starts_with("BASH_FUNC_")
                || key.starts_with("DYLD_")
                || key.starts_with("LD_")
                || v.to_string_lossy().starts_with("() {"))
    })
}

/// The first executable named `name` on PATH, physical. An error when PATH has a relative or
/// `..` entry, or an entry inside the workspace, before the program is found.
#[cfg(not(windows))]
fn first_on_path(
    env: &[(OsString, OsString)],
    scope: &piarc_fs::Scope,
    name: &str,
) -> Result<Option<PathBuf>, ()> {
    use std::os::unix::fs::PermissionsExt;
    let (_, path) = env.iter().find(|(k, _)| k == "PATH").ok_or(())?;
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute()
            || dir
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            return Err(());
        }
        let raw = dir.to_str().ok_or(())?;
        let physical = scope.locate(raw).map_err(|_| ())?;
        if physical.starts_with(scope.root()) || dir.starts_with(scope.root()) {
            return Err(());
        }
        let candidate = physical.join(name);
        let executable = std::fs::metadata(&candidate)
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
        if executable {
            return candidate.canonicalize().map(Some).map_err(|_| ());
        }
    }
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn workspace_path_entries_and_custom_binaries_do_not_get_automatic_permission() {
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique"));
        let ws = root.join("workspace");
        std::fs::create_dir_all(&ws).expect("dir");
        let scope = piarc_fs::Scope::new(&ws, &ws).expect("scope");
        let programs = |dirs: Vec<&Path>| Programs {
            env: vec![("PATH".into(), std::env::join_paths(dirs).expect("path"))],
            custom: false,
            shell: Some(PathBuf::from("/bin/bash")),
        };
        let system = programs(vec![Path::new("/usr/bin"), Path::new("/bin")]);
        assert_eq!(system.resolve(&scope, "touch"), installed_utility("touch"));
        assert!(system.resolve(&scope, "ls").is_some());
        assert!(system.resolve(&scope, "no-such-program-piarc").is_none());
        assert!(
            programs(vec![&ws, Path::new("/usr/bin")])
                .resolve(&scope, "touch")
                .is_none()
        );
        assert!(
            programs(vec![Path::new(""), Path::new("/usr/bin")])
                .resolve(&scope, "ls")
                .is_none()
        );
        let bin = root.join("custom");
        std::fs::create_dir_all(&bin).expect("bin");
        std::fs::write(bin.join("touch"), "fixture").expect("file");
        std::process::Command::new("chmod")
            .arg("+x")
            .arg(bin.join("touch"))
            .status()
            .expect("chmod");
        assert!(
            programs(vec![&bin, Path::new("/usr/bin")])
                .resolve(&scope, "touch")
                .is_none()
        );
        // A program inside a directory the session can write is not relied on.
        let added = scope.clone().with_added_dir(&bin).expect("added");
        std::fs::write(bin.join("cat"), "fixture").expect("file");
        std::process::Command::new("chmod")
            .arg("+x")
            .arg(bin.join("cat"))
            .status()
            .expect("chmod");
        assert!(
            programs(vec![&bin, Path::new("/bin")])
                .resolve(&added, "cat")
                .is_none()
        );
        assert!(
            programs(vec![&bin, Path::new("/bin")])
                .resolve(&scope, "cat")
                .is_some()
        );
        let custom = Programs {
            custom: true,
            ..programs(vec![Path::new("/bin")])
        };
        assert!(custom.resolve(&scope, "ls").is_none());
        std::fs::remove_dir_all(root).expect("clean");
    }
}
