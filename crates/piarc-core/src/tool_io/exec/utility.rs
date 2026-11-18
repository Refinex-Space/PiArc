//! Resolve the four M1 filesystem utilities without running anything from the workspace.
//! These checks are for automatic approval only. Prompted commands retain the user's shell.
use super::*;

impl Exec {
    pub(in crate::tool_io) async fn simple_utility(
        &self,
        scope: &piarc_fs::Scope,
        command: &str,
    ) -> Option<PathBuf> {
        let name = command.split_ascii_whitespace().next()?;
        let shell = self.shells().bash.as_deref()?;
        let env = self.base_env().await;
        let expected = installed_utility(shell, name)?;
        if !safe_search(&env, scope, name, &expected) {
            return None;
        }
        #[cfg(windows)]
        {
            // The Git Bash launcher can prepend its own directories to the Windows PATH.
            // Check its actual resolution against the installed coreutils in a clean cwd.
            let known = self
                .git_utilities
                .get_or_init(|| self.probe_git_utilities(shell, &env))
                .await;
            if !known.iter().any(|s| s == name) {
                return None;
            }
        }
        Some(expected)
    }

    #[cfg(windows)]
    async fn probe_git_utilities(&self, shell: &Path, env: &[(OsString, OsString)]) -> Vec<String> {
        let Some(dir) =
            installed_utility(shell, "touch").and_then(|p| p.parent().map(Path::to_owned))
        else {
            return Vec::new();
        };
        // All names are constants; the native directory is passed as an argument to bash.
        let script = r#"for n in mkdir touch mv cp; do
            f=$(builtin type -P "$n")
            [[ -n "$f" && "$f" -ef "$1/$n.exe" ]] && builtin printf '%s\n' "$n"
        done
        exit 0"#;
        let args = vec![
            "-c".into(),
            script.into(),
            "piarc".into(),
            piarc_fs::display(&dir).replace('\\', "/").into(),
        ];
        let spec = CommandSpec {
            program: shell.to_owned(),
            args,
            cwd: dir,
            env: env.to_vec(),
            launcher: None,
            timeout: Some(Duration::from_secs(2)),
            kill_grace: Duration::from_millis(100),
        };
        let (tx, mut rx) = mpsc::channel::<OutputChunk>(8);
        let read = async {
            let mut bytes = Vec::new();
            while let Some(chunk) = rx.recv().await {
                if chunk.stream == Stream::Stdout && bytes.len() + chunk.bytes.len() <= 256 {
                    bytes.extend(chunk.bytes);
                }
            }
            bytes
        };
        let (result, bytes) =
            tokio::join!(self.runner.run(spec, tx, CancellationToken::new()), read);
        if result.is_ok_and(|r| r.status.success() && !r.timed_out && !r.killed) {
            String::from_utf8_lossy(&bytes)
                .lines()
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        }
    }
}

#[cfg(not(windows))]
fn installed_utility(shell: &Path, name: &str) -> Option<PathBuf> {
    if shell != Path::new("/bin/bash") || !matches!(name, "mkdir" | "touch" | "mv" | "cp") {
        return None;
    }
    ["/bin", "/usr/bin"]
        .iter()
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())?
        .canonicalize()
        .ok()
}

#[cfg(windows)]
fn installed_utility(shell: &Path, name: &str) -> Option<PathBuf> {
    if !matches!(name, "mkdir" | "touch" | "mv" | "cp") {
        return None;
    }
    let actual = shell.canonicalize().ok()?;
    for base in ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
    {
        let git = PathBuf::from(base).join("Git");
        let expected = git.join("bin/bash.exe");
        let program = git.join("usr/bin").join(format!("{name}.exe"));
        if piarc_git::strip_verbatim(actual.clone()) == expected
            && program.is_file()
            && piarc_git::strip_verbatim(program.canonicalize().ok()?) == program
        {
            return Some(program);
        }
    }
    None
}

fn safe_search(
    env: &[(OsString, OsString)],
    scope: &piarc_fs::Scope,
    name: &str,
    expected: &Path,
) -> bool {
    if env.iter().any(|(key, v)| {
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
    }) {
        return false;
    }
    let Some((_, path)) = env.iter().find(|(k, _)| {
        if cfg!(windows) {
            k.eq_ignore_ascii_case("PATH")
        } else {
            k == "PATH"
        }
    }) else {
        return false;
    };
    let mut first = None;
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute()
            || dir
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            return false;
        }
        let Some(raw) = dir.to_str() else {
            return false;
        };
        let Ok(physical) = scope.locate(raw) else {
            return false;
        };
        if physical.starts_with(scope.root()) || dir.starts_with(scope.root()) {
            return false;
        }
        let candidate = physical.join(&filename);
        if first.is_none() && candidate.exists() {
            let Some(found) = candidate.canonicalize().ok() else {
                return false;
            };
            first = Some(piarc_git::strip_verbatim(found));
        }
    }
    match first {
        Some(found) => found == piarc_git::strip_verbatim(expected.to_owned()),
        None => cfg!(windows), // Git's own PATH addition is checked by the shell probe.
    }
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
        let expected = installed_utility(Path::new("/bin/bash"), "touch").expect("system touch");
        let check = |dirs: Vec<&Path>| {
            safe_search(
                &[("PATH".into(), std::env::join_paths(dirs).expect("path"))],
                &scope,
                "touch",
                &expected,
            )
        };
        assert!(check(vec![Path::new("/usr/bin"), Path::new("/bin")]));
        assert!(!check(vec![&ws, Path::new("/usr/bin")]));
        assert!(!check(vec![Path::new(""), Path::new("/usr/bin")]));
        let bin = root.join("custom");
        std::fs::create_dir_all(&bin).expect("bin");
        std::fs::write(bin.join("touch"), "fixture").expect("file");
        assert!(!check(vec![&bin, Path::new("/usr/bin")]));
        std::fs::remove_dir_all(root).expect("clean");
    }
}
