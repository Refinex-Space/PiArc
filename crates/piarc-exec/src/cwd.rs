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
//! `EXIT` trap, or was killed: the previous directory stays. On Windows the trap asks Git Bash
//! for the Windows form (`pwd -W`, `C:/…`), so mounted directories such as `/tmp` (the user's
//! `%TEMP%`) resolve too; [`crate::msys_to_windows`] turns the answer into a Windows path.

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
        let save = format!("{PWD} >| {}", quote(&bash_path(&answer)));
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

    /// Bind one verified program to its physical executable in this command's bash process.
    /// A changed lookup fails closed before the command runs. Its text and exit trap stay intact.
    ///
    /// # Errors
    ///
    /// The name is not a plain command name, or the startup file cannot be updated.
    pub fn pin_program(&self, name: &str, path: &Path) -> io::Result<()> {
        use std::io::Write;
        let plain = !name.is_empty()
            && !name.starts_with('-')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'));
        if !plain {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let program = quote(&bash_path(path));
        let mut file = std::fs::OpenOptions::new().append(true).open(&self.init)?;
        let refused = "{ builtin printf '%s\\n' 'Command resolution changed. Request a new approval.' >&2; exit 126; }";
        writeln!(
            file,
            "[[ $(builtin type -t {name}) == file && $(builtin type -P {name}) -ef {program} ]] || {refused}"
        )?;
        writeln!(file, "builtin hash -p {program} {name} || {refused}")
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

/// How the trap prints the directory. Git Bash's `pwd -P` answers in its own namespace, where
/// mounted directories have POSIX names (`/tmp` is `%TEMP%`, `/usr` is Git's own) that no
/// drive-letter conversion can map back; `pwd -W` prints the Windows path (`C:/…`). A bash
/// without `-W` falls back to `pwd -P`.
const PWD: &str = if cfg!(windows) {
    "{ builtin pwd -W 2>/dev/null || builtin pwd -P; }"
} else {
    "builtin pwd -P"
};

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

    #[cfg(unix)]
    #[test]
    fn pinned_programs_refuse_a_different_resolution() {
        let dir = std::env::temp_dir().join(format!("piarc-exec-pin {}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).expect("dirs");
        let run = |path: &str, pins: &[(&str, &Path)]| {
            let (probe, (name, value)) = CwdProbe::prepare(&dir, "req-pin", None).expect("probe");
            for (n, p) in pins {
                probe.pin_program(n, p).expect("pin");
            }
            let out = std::process::Command::new("/bin/bash")
                .args(["-c", "ls -d . && cat /dev/null && echo done"])
                .current_dir(&dir)
                .env_clear()
                .env("PATH", path)
                .env(name, value)
                .output()
                .expect("bash runs");
            let _ = probe.finish();
            out
        };
        let ls = Path::new("/bin/ls");
        let cat = Path::new("/bin/cat");
        let ok = run("/usr/bin:/bin", &[("ls", ls), ("cat", cat)]);
        assert!(ok.status.success(), "{ok:?}");
        // A workspace program shadowing the verified one stops the command before it runs.
        let fake = bin.join("cat");
        std::fs::write(&fake, "#!/bin/sh\necho fake\n").expect("fake");
        std::process::Command::new("chmod")
            .args(["+x"])
            .arg(&fake)
            .status()
            .expect("chmod");
        let path = format!("{}:/usr/bin:/bin", bin.display());
        let refused = run(&path, &[("ls", ls), ("cat", cat)]);
        assert_eq!(refused.status.code(), Some(126));
        assert!(!String::from_utf8_lossy(&refused.stdout).contains("done"));
        for bad in ["", "-x", "a b", "a;b", "$(x)"] {
            let (probe, _) = CwdProbe::prepare(&dir, "req-bad", None).expect("probe");
            assert!(probe.pin_program(bad, ls).is_err(), "{bad:?}");
            let _ = probe.finish();
        }
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

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

    /// Git Bash mounts directories under POSIX names (`/usr` is Git's own, `/tmp` is the user's
    /// `%TEMP%`). The answer must still name the Windows directory (W1: a workspace under
    /// `%TEMP%` lost its `cd`).
    #[cfg(windows)]
    #[test]
    fn a_mounted_directory_is_answered_as_a_windows_path() {
        let env: Vec<_> = std::env::vars_os().collect();
        let bash = crate::shells::detect(&crate::shells::Probe::system(&env), None)
            .bash
            .expect("Git for Windows is installed");
        let dir = std::env::temp_dir().join(format!("piarc-exec-cwd 目录 {}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        for (command, marker) in [("cd /usr/bin", "bash.exe"), ("cd /tmp", "")] {
            let (probe, (name, value)) = CwdProbe::prepare(&dir, "req-mount", None).expect("probe");
            let out = std::process::Command::new(&bash)
                .args(["-c", command])
                .current_dir(&dir)
                .env(name, value)
                .output()
                .expect("bash runs");
            assert!(out.status.success(), "{out:?}");
            let answer = probe.finish().expect("an answer");
            let windows = crate::msys_to_windows(&answer)
                .unwrap_or_else(|| panic!("{command}: `{answer}` is not a Windows path"));
            let found = Path::new(&windows);
            assert!(found.is_dir(), "{command}: {windows}");
            assert!(
                marker.is_empty() || found.join(marker).is_file(),
                "{windows}"
            );
        }
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
