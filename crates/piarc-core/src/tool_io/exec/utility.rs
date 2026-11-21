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
            Some(shell) => {
                probed_once(&self.git_programs, || {
                    self.probe_git_programs(shell, &resolved.inherited)
                })
                .await
            }
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
    /// directory. Git's launcher puts its own directories first on the Windows PATH. `None`
    /// when bash did not answer (failed to start, timed out): the caller asks again later.
    #[cfg(windows)]
    async fn probe_git_programs(
        &self,
        shell: &Path,
        env: &[(OsString, OsString)],
    ) -> Option<Vec<(String, PathBuf)>> {
        let Some(root) = git_root(shell) else {
            return Some(Vec::new());
        };
        // All names are constants; the installation is passed as an argument to bash. Git's
        // native programs live in the MSYS2 environment the build uses: `mingw64`, `ucrt64`
        // (x64 since Git for Windows 2.56) or `clangarm64` (arm64). Only names Git ships are
        // looked up, and through `hash` (no subshell; a fork is slow in MSYS): a name missing
        // from Git cannot resolve to Git's program, and searching a long PATH for it took
        // seconds (W2). `hash` skips builtins, whose programs `type -P` finds instead.
        let script = r#"root=$1; shift
        for n in "$@"; do
            for d in usr mingw64 ucrt64 clangarm64 ""; do
                [[ -n $d && -e "$root/$d/bin/$n.exe" ]] && break
            done
            [[ -n $d ]] || continue
            f=; builtin hash -- "$n" 2>/dev/null && f=${BASH_CMDS[$n]}
            [[ -n $f ]] || f=$(builtin type -P -- "$n") || continue
            for d in usr mingw64 ucrt64 clangarm64; do
                if [[ "$f" -ef "$root/$d/bin/$n.exe" ]]; then builtin printf '%s %s\n' "$d" "$n"; break; fi
            done
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
            // A cold Git Bash under an antivirus scan and a busy machine can take seconds; an
            // unanswered probe is asked again on the next preflight, so this stays short.
            timeout: Some(Duration::from_secs(10)),
            kill_grace: Duration::from_millis(100),
        };
        let (tx, mut rx) = mpsc::channel::<OutputChunk>(8);
        let read = async {
            let mut bytes = Vec::new();
            while let Some(chunk) = rx.recv().await {
                if chunk.stream == piarc_exec::Stream::Stdout
                    && bytes.len() + chunk.bytes.len() <= 16_384
                {
                    bytes.extend(chunk.bytes);
                }
            }
            bytes
        };
        let (result, bytes) =
            tokio::join!(self.runner.run(spec, tx, CancellationToken::new()), read);
        if !result.is_ok_and(|r| r.status.success() && !r.timed_out && !r.killed) {
            return None;
        }
        let found = String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| {
                let (dir, name) = line.split_once(' ')?;
                let program = root.join(dir).join("bin").join(format!("{name}.exe"));
                let canonical = piarc_git::strip_verbatim(program.canonicalize().ok()?);
                (canonical == program).then(|| (name.to_owned(), program))
            })
            .collect();
        Some(found)
    }
}

/// The programs a successful probe found, probed once per Core. A probe without an answer is
/// not kept (W2): one slow first start of Git Bash would otherwise turn off every automatic
/// approval until Core restarts.
#[cfg(windows)]
async fn probed_once<F, Fut>(
    cell: &tokio::sync::OnceCell<Vec<(String, PathBuf)>>,
    probe: F,
) -> Vec<(String, PathBuf)>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<Vec<(String, PathBuf)>>>,
{
    cell.get_or_try_init(|| async { probe().await.ok_or(()) })
        .await
        .map_or_else(|()| Vec::new(), Clone::clone)
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
        let physical = match scope.locate(raw) {
            Ok(physical) => physical,
            // A directory this user cannot search supplies no command, and bash skips it too
            // (W1 met such entries on Windows PATHs); one inside the workspace is still refused.
            Err(piarc_fs::Error::Io { code: "EACCES", .. }) if !dir.starts_with(scope.root()) => {
                continue;
            }
            Err(_) => return Err(()),
        };
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// W2: a probe that got no answer is asked again; an answer is kept for the Core's life.
    #[tokio::test]
    async fn a_probe_without_an_answer_is_tried_again() {
        let cell = tokio::sync::OnceCell::new();
        let ls = || vec![("ls".to_owned(), PathBuf::from("ls.exe"))];
        assert!(probed_once(&cell, || async { None }).await.is_empty());
        assert_eq!(probed_once(&cell, || async { Some(ls()) }).await, ls());
        let kept = probed_once(&cell, || async { unreachable!("kept") }).await;
        assert_eq!(kept, ls());
    }

    /// W2: Git for Windows 2.56 ships its programs in `ucrt64` instead of `mingw64` (arm64
    /// builds use `clangarm64`); `git` resolves to Git's own executable in any of them.
    #[tokio::test]
    async fn git_resolves_in_the_environment_git_ships() {
        let env: Vec<_> = std::env::vars_os().collect();
        let bash = piarc_exec::shells::detect(&piarc_exec::shells::Probe::system(&env), None)
            .bash
            .expect("Git for Windows is installed");
        let Some(root_git) = git_root(&bash) else {
            return;
        };
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique"));
        std::fs::create_dir_all(&root).expect("dir");
        let exec = super::super::Exec::new(
            piarc_exec::ExecLimits::default(),
            super::super::CommandEnv::Fixed(env.clone()),
            root.clone(),
            None,
        );
        let found = exec
            .probe_git_programs(&bash, &env)
            .await
            .expect("answered");
        std::fs::remove_dir_all(&root).expect("clean");
        let git = found.iter().find(|(name, _)| name == "git").map(|(_, p)| p);
        let shipped = ["mingw64", "ucrt64", "clangarm64"]
            .iter()
            .map(|dir| root_git.join(dir).join("bin").join("git.exe"))
            .find(|p| p.is_file());
        assert_eq!(git, shipped.as_ref(), "{found:?}");
        assert!(git.is_some());
    }

    /// W1: an entry the user may not search must not withdraw automatic permission. On
    /// Windows the programs come from asking Git Bash, which skips such an entry.
    #[tokio::test]
    async fn a_path_entry_the_user_cannot_search_is_skipped() {
        let env: Vec<_> = std::env::vars_os().collect();
        let bash = piarc_exec::shells::detect(&piarc_exec::shells::Probe::system(&env), None)
            .bash
            .expect("Git for Windows is installed");
        let Some(root_git) = git_root(&bash) else {
            // Git is not in Program Files: nothing gets automatic permission anyway.
            return;
        };
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique"));
        let locked = root.join("locked");
        let inner = locked.join("inner");
        std::fs::create_dir_all(&inner).expect("dir");
        let user = std::env::var("USERNAME").expect("USERNAME");
        let icacls = |args: &[&str]| {
            let status = std::process::Command::new("icacls")
                .arg(&locked)
                .args(args)
                .stdout(std::process::Stdio::null())
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls {args:?}");
        };
        icacls(&["/deny", &format!("{user}:(OI)(CI)F")]);
        let unreadable = std::fs::canonicalize(&inner).map_err(|e| e.kind());
        let mut path = vec![inner.clone()];
        path.extend(
            env.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("PATH"))
                .flat_map(|(_, v)| std::env::split_paths(v).collect::<Vec<_>>()),
        );
        let mut probe_env: Vec<_> = env
            .iter()
            .filter(|(k, _)| !k.eq_ignore_ascii_case("PATH"))
            .cloned()
            .collect();
        probe_env.push(("PATH".into(), std::env::join_paths(path).expect("path")));
        let exec = super::super::Exec::new(
            piarc_exec::ExecLimits::default(),
            super::super::CommandEnv::Fixed(probe_env.clone()),
            root.clone(),
            None,
        );
        let found = exec
            .probe_git_programs(&bash, &probe_env)
            .await
            .unwrap_or_default();
        icacls(&["/remove:d", &user]);
        std::fs::remove_dir_all(&root).expect("clean");
        assert_eq!(unreadable, Err(std::io::ErrorKind::PermissionDenied));
        let touch = root_git.join("usr").join("bin").join("touch.exe");
        assert!(
            found
                .iter()
                .any(|(name, program)| name == "touch" && *program == touch),
            "touch should still resolve to Git's own program: {found:?}"
        );
    }
}
