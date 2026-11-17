//! Where a bash command ended up: the working directory the next command starts in
//! (architecture section 6.11, "`cd` 在工作区内跨命令保留").
//!
//! The command text is not touched. bash reads the file named by `BASH_ENV` before it runs a
//! `-c` command; [`CwdProbe::prepare`] writes such a file that
//!
//! 1. installs an `EXIT` trap writing `pwd -P` to a second file, and
//! 2. unsets `BASH_ENV` (or puts back the user's own value after sourcing that file), so the
//!    command and the scripts it runs neither see it nor run the trap themselves.
//!
//! Exit status, output and error messages stay those of the command; `$?` survives an `EXIT`
//! trap. When there is no answer, the command replaced the shell (`exec`), installed its own
//! `EXIT` trap, or was killed: the previous directory stays. On Windows Git Bash prints
//! `/c/…` paths; [`crate::msys_to_windows`] turns them into Windows paths.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

/// The two files of one command.
#[derive(Debug)]
pub struct CwdProbe {
    init: PathBuf,
    answer: PathBuf,
}

impl CwdProbe {
    /// Writes the init file for request `id` into `dir` and returns the probe and the
    /// variable to add to the command's environment. `user_bash_env` is the `BASH_ENV` the
    /// environment already had.
    ///
    /// # Errors
    ///
    /// The directory or the init file cannot be written.
    pub fn prepare(
        dir: &Path,
        id: &str,
        user_bash_env: Option<&str>,
    ) -> io::Result<(Self, (OsString, OsString))> {
        std::fs::create_dir_all(dir)?;
        let stem: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let init = dir.join(format!("{stem}.bash-env"));
        let answer = dir.join(format!("{stem}.cwd"));
        let _ = std::fs::remove_file(&answer);
        let save = format!("builtin pwd -P >| {}", quote(&bash_path(&answer)));
        let mut script = format!("trap {} EXIT\n", quote(&save));
        match user_bash_env {
            Some(user) => {
                script.push_str(&format!("export BASH_ENV={}\n", quote(user)));
                script.push_str("[ -r \"$BASH_ENV\" ] && builtin . \"$BASH_ENV\"\n");
            }
            None => script.push_str("unset BASH_ENV\n"),
        }
        std::fs::write(&init, script)?;
        let variable = (OsString::from("BASH_ENV"), OsString::from(bash_path(&init)));
        Ok((Self { init, answer }, variable))
    }

    /// The directory the shell ended in, as the shell printed it; removes both files.
    #[must_use]
    pub fn finish(self) -> Option<String> {
        let answer = std::fs::read_to_string(&self.answer).ok();
        let _ = std::fs::remove_file(&self.init);
        let _ = std::fs::remove_file(&self.answer);
        answer
            .map(|text| text.trim_end_matches(['\n', '\r']).to_owned())
            .filter(|text| !text.is_empty())
    }
}

/// `path` as bash reads it: forward slashes on Windows (Git Bash opens `C:/…` paths), without
/// the `\\?\` prefix.
fn bash_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.trim_start_matches(r"\\?\").replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// `text` as one single-quoted shell word.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[cfg(unix)]
    #[test]
    fn reports_the_final_directory_and_keeps_the_exit_code() {
        let dir = std::env::temp_dir().join(format!("piarc-exec-cwd 目录 {}", std::process::id()));
        let target = dir.join("it's here");
        std::fs::create_dir_all(&target).expect("dirs");
        let run = |command: &str, user: Option<&str>| {
            let (probe, (name, value)) = CwdProbe::prepare(&dir, "req-1", user).expect("probe");
            let out = std::process::Command::new("/bin/bash")
                .args(["-c", command])
                .current_dir(&dir)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env(name, value)
                .output()
                .expect("bash runs");
            (probe.finish(), out)
        };
        let canonical = std::fs::canonicalize(&target).expect("canonical");
        let (cwd, out) = run("cd \"it's here\" && echo \"[$BASH_ENV]\"; exit 3", None);
        assert_eq!(cwd.as_deref(), canonical.to_str());
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "[]\n");
        // A child bash does not run the trap.
        let (cwd, _) = run("bash -c 'cd /'", None);
        assert_eq!(
            cwd.as_deref(),
            std::fs::canonicalize(&dir).expect("dir").to_str()
        );
        // `exec` replaces the shell: no answer.
        let (cwd, _) = run("exec true", None);
        assert_eq!(cwd, None);
        // The user's own BASH_ENV still runs and stays visible.
        let user = dir.join("user-env.sh");
        std::fs::write(&user, "USER_ENV_RAN=yes\n").expect("user env");
        let user = user.to_str().expect("utf-8").to_owned();
        let (_, out) = run("echo \"$USER_ENV_RAN $BASH_ENV\"", Some(&user));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("yes {user}\n")
        );
        assert!(std::fs::read_dir(&dir).expect("list").all(|e| {
            !e.expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with("req-1")
        }));
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
