//! Shell integration: PiArc's terminals start zsh, bash (Git Bash on Windows) and PowerShell
//! so that they report prompts, commands and exit codes with OSC 133 and the working directory
//! with OSC 7 — without changing any of the user's startup files.
//!
//! The scripts live in `crates/piarc-term/shell-integration/` (written for PiArc; Ghostty's
//! and VS Code's integrations use the same OSC sequences and the same ZDOTDIR and prompt
//! wrapping ideas) and are copied into a directory of PiArc's data directory by [`install`]:
//!
//! - **zsh**: `ZDOTDIR` points at PiArc's `zsh/` directory, whose `.zshenv` puts the user's
//!   `ZDOTDIR` back, sources their `.zshenv` and loads `piarc.zsh` (precmd and preexec hooks).
//!   zsh then reads the rest of the user's startup files as usual.
//! - **bash**: `--rcfile piarc.bash -i`; the script reads the user's files as an interactive
//!   (or, with `PIARC_SHELL_LOGIN`, a login) bash would, then adds `PROMPT_COMMAND` and a
//!   `DEBUG` trap (bash 3.2 has no `PS0`).
//! - **PowerShell**: `-NoExit -Command . piarc.ps1` after the profile; it wraps `prompt` and
//!   the PSReadLine Enter key.
//!
//! Other shells (fish, nu, cmd, …) start unchanged and report no command boundaries.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

const ZSHENV: &str = include_str!("../shell-integration/zsh/.zshenv");
const ZSH: &str = include_str!("../shell-integration/piarc.zsh");
const BASH: &str = include_str!("../shell-integration/piarc.bash");
const POWERSHELL: &str = include_str!("../shell-integration/piarc.ps1");

/// The environment variable that tells the scripts where they are.
pub const DIR_VARIABLE: &str = "PIARC_SHELL_INTEGRATION";

/// Shells with an integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// zsh.
    Zsh,
    /// bash, Git Bash included.
    Bash,
    /// Windows PowerShell or PowerShell 7.
    PowerShell,
}

impl ShellKind {
    /// The kind of the shell at `program` (by its file name), if it has an integration.
    #[must_use]
    pub fn of(program: &str) -> Option<Self> {
        // Both separators: a Windows path is recognized on any platform.
        let name = program.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
        let name = name.strip_suffix(".exe").unwrap_or(&name);
        match name.trim_start_matches('-') {
            "zsh" => Some(Self::Zsh),
            "bash" => Some(Self::Bash),
            "pwsh" | "powershell" => Some(Self::PowerShell),
            _ => None,
        }
    }
}

/// The installed scripts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Integration {
    dir: PathBuf,
}

/// How to start a shell with its integration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The program.
    pub program: String,
    /// Its arguments.
    pub args: Vec<String>,
    /// Variables to add to its environment.
    pub env: Vec<(String, String)>,
}

/// Writes the scripts into `dir` (created if missing); files whose content is already right
/// are left alone, so concurrent PiArc processes do not race on them.
///
/// # Errors
///
/// [`Error::Spawn`] when a script cannot be written.
pub fn install(dir: &Path) -> Result<Integration> {
    let fail = |error: std::io::Error| Error::Spawn {
        reason: format!(
            "cannot write the shell integration to {}: {error}",
            dir.display()
        ),
    };
    fs::create_dir_all(dir.join("zsh")).map_err(fail)?;
    for (name, content) in [
        ("zsh/.zshenv", ZSHENV),
        ("piarc.zsh", ZSH),
        ("piarc.bash", BASH),
        ("piarc.ps1", POWERSHELL),
    ] {
        let path = dir.join(name);
        if fs::read_to_string(&path).is_ok_and(|current| current == content) {
            continue;
        }
        let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));
        fs::write(&temp, content)
            .and_then(|()| fs::rename(&temp, &path))
            .map_err(fail)?;
    }
    Ok(Integration {
        dir: dir.to_owned(),
    })
}

impl Integration {
    /// Where the scripts are.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// How to start `program` (a shell) with its integration; `login` asks for a login shell.
    /// `zdotdir` is the user's `ZDOTDIR`, if their environment sets one. `None` for shells
    /// without an integration.
    #[must_use]
    pub fn launch(&self, program: &str, login: bool, zdotdir: Option<&str>) -> Option<Launch> {
        let dir = self.dir.to_string_lossy().into_owned();
        let mut env = vec![(DIR_VARIABLE.to_owned(), dir.clone())];
        let args = match ShellKind::of(program)? {
            ShellKind::Zsh => {
                env.push((
                    "ZDOTDIR".into(),
                    self.dir.join("zsh").to_string_lossy().into_owned(),
                ));
                if let Some(zdotdir) = zdotdir {
                    env.push(("PIARC_ZDOTDIR".into(), zdotdir.to_owned()));
                }
                if login { vec!["-l".into()] } else { Vec::new() }
            }
            ShellKind::Bash => {
                if login {
                    env.push(("PIARC_SHELL_LOGIN".into(), "1".into()));
                }
                let rcfile = self.dir.join("piarc.bash").to_string_lossy().into_owned();
                vec!["--rcfile".into(), rcfile, "-i".into()]
            }
            ShellKind::PowerShell => {
                let script = self
                    .dir
                    .join("piarc.ps1")
                    .to_string_lossy()
                    .replace('\'', "''");
                vec![
                    "-NoLogo".into(),
                    "-NoExit".into(),
                    "-Command".into(),
                    format!(". '{script}'"),
                ]
            }
        };
        Some(Launch {
            program: program.to_owned(),
            args,
            env,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shells_are_recognized_by_name() {
        assert_eq!(ShellKind::of("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(ShellKind::of("-zsh"), Some(ShellKind::Zsh));
        assert_eq!(ShellKind::of("/usr/local/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(
            ShellKind::of(r"C:\Program Files\Git\bin\bash.exe"),
            Some(ShellKind::Bash)
        );
        assert_eq!(ShellKind::of("pwsh"), Some(ShellKind::PowerShell));
        assert_eq!(ShellKind::of("PowerShell.EXE"), Some(ShellKind::PowerShell));
        assert_eq!(ShellKind::of("/opt/homebrew/bin/fish"), None);
        assert_eq!(ShellKind::of("cmd.exe"), None);
    }

    #[test]
    fn install_writes_the_scripts_once() {
        let dir = std::env::temp_dir().join(format!("piarc-shell-{} 中", std::process::id()));
        let integration = install(&dir).expect("install");
        assert_eq!(
            fs::read_to_string(dir.join("piarc.bash")).expect("bash"),
            BASH
        );
        let before = fs::metadata(dir.join("piarc.zsh"))
            .and_then(|m| m.modified())
            .expect("mtime");
        install(&dir).expect("again");
        let after = fs::metadata(dir.join("piarc.zsh"))
            .and_then(|m| m.modified())
            .expect("mtime");
        assert_eq!(before, after, "an unchanged script is not rewritten");
        let zsh = integration
            .launch("/bin/zsh", true, Some("/Users/me/.config/zsh"))
            .expect("zsh");
        assert_eq!(zsh.args, ["-l"]);
        assert!(
            zsh.env
                .iter()
                .any(|(k, v)| k == "ZDOTDIR" && v.ends_with("zsh"))
        );
        assert!(
            zsh.env
                .iter()
                .any(|(k, v)| k == "PIARC_ZDOTDIR" && v == "/Users/me/.config/zsh")
        );
        let bash = integration.launch("bash", false, None).expect("bash");
        assert_eq!(bash.args[0], "--rcfile");
        assert!(bash.args[1].ends_with("piarc.bash"));
        let pwsh = integration.launch("pwsh.exe", false, None).expect("pwsh");
        assert!(pwsh.args[3].starts_with(". '") && pwsh.args[3].ends_with("piarc.ps1'"));
        assert!(integration.launch("fish", true, None).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
