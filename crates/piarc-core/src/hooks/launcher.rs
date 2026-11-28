//! Which program runs a hook command (Claude Code's `shell` field and exec form):
//!
//! - exec form (`args` set): `command` starts directly with `args`, no shell.
//! - `shell: "bash"` (the default): `/bin/sh -c` on macOS; Git Bash on Windows, or PowerShell
//!   when Git Bash is missing.
//! - `shell: "powershell"`: PowerShell (Windows; macOS has none in PiArc's shell detection).
//!
//! Every hook gets the command environment of the session's tools (ADR-0035) plus
//! `CLAUDE_PROJECT_DIR`, the workspace root, which Claude Code's hooks use to find their
//! scripts, and the variables the user listed in their own settings' `hookAllowedEnvVars`,
//! taken from the login shell's environment (I93, ADR-0055).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use piarc_hooks::{Command, Error, Launcher, Shell};
use piarc_ports::SpawnSpec;

/// The environment and shells hooks start with.
#[derive(Debug, Clone, Default)]
pub(crate) struct Launch {
    /// Variables commands inherit (ADR-0035).
    pub env: Vec<(OsString, OsString)>,
    /// Git Bash on Windows, `/bin/bash` elsewhere.
    pub bash: Option<PathBuf>,
    /// PowerShell, when found.
    pub powershell: Option<PathBuf>,
    /// The login shell's environment without PiArc's internal variables: where `http` header
    /// variables and `hookAllowedEnvVars` take their values.
    pub expansion: Vec<(OsString, OsString)>,
}

pub(crate) struct CoreLauncher {
    pub launch: Launch,
    pub project_dir: PathBuf,
    /// `hookAllowedEnvVars` of the user's settings.
    pub extra: Vec<String>,
}

impl Launcher for CoreLauncher {
    fn spec(&self, handler: &Command, cwd: &Path) -> Result<SpawnSpec, Error> {
        let mut env = self.launch.env.clone();
        for name in &self.extra {
            if let Some((key, value)) = self
                .launch
                .expansion
                .iter()
                .find(|(k, _)| k == name.as_str())
            {
                env.retain(|(k, _)| k != key);
                env.push((key.clone(), value.clone()));
            }
        }
        env.retain(|(k, _)| k != "CLAUDE_PROJECT_DIR");
        env.push((
            "CLAUDE_PROJECT_DIR".into(),
            self.project_dir.clone().into_os_string(),
        ));
        let spec = |program: PathBuf, args: Vec<OsString>| SpawnSpec {
            program,
            args,
            cwd: cwd.to_owned(),
            env: env.clone(),
        };
        if let Some(args) = &handler.args {
            return Ok(spec(
                PathBuf::from(&handler.command),
                args.iter().map(OsString::from).collect(),
            ));
        }
        let wants = handler
            .shell
            .unwrap_or(if cfg!(windows) && self.launch.bash.is_none() {
                Shell::PowerShell
            } else {
                Shell::Bash
            });
        match wants {
            Shell::Bash if !cfg!(windows) => Ok(spec(
                PathBuf::from("/bin/sh"),
                vec!["-c".into(), handler.command.clone().into()],
            )),
            Shell::Bash => {
                let bash = self.launch.bash.clone().ok_or_else(|| {
                    Error::CannotStart(
                        "Git Bash was not found; set \"shell\": \"powershell\" or install Git for Windows"
                            .to_owned(),
                    )
                })?;
                let (args, carried) = piarc_exec::shells::bash_invocation(&handler.command);
                let mut spawn = spec(bash, args);
                spawn.env.extend(carried);
                Ok(spawn)
            }
            Shell::PowerShell => {
                let shell = self
                    .launch
                    .powershell
                    .clone()
                    .ok_or_else(|| Error::CannotStart("PowerShell was not found".to_owned()))?;
                let args = piarc_exec::shells::powershell_args(&shell, &handler.command);
                Ok(spec(shell, args))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn handler(command: &str, shell: Option<Shell>, args: Option<Vec<String>>) -> Command {
        Command {
            command: command.into(),
            args,
            shell,
        }
    }

    #[test]
    fn exec_form_skips_the_shell_and_every_hook_gets_the_project_dir() {
        let launcher = CoreLauncher {
            launch: Launch {
                env: vec![
                    ("PATH".into(), "/usr/bin".into()),
                    ("CLAUDE_PROJECT_DIR".into(), "stale".into()),
                ],
                bash: None,
                powershell: None,
                expansion: vec![
                    ("WEBHOOK_TOKEN".into(), "t-1".into()),
                    ("AWS_SECRET".into(), "never".into()),
                ],
            },
            project_dir: PathBuf::from("/work/项目"),
            extra: vec!["WEBHOOK_TOKEN".into(), "NOT_SET".into()],
        };
        let exec = launcher
            .spec(
                &handler("node", None, Some(vec!["fmt.js".into()])),
                Path::new("/work"),
            )
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(exec.program, PathBuf::from("node"));
        assert_eq!(exec.args, [OsString::from("fmt.js")]);
        assert!(
            exec.env
                .contains(&("CLAUDE_PROJECT_DIR".into(), "/work/项目".into()))
        );
        assert_eq!(
            exec.env
                .iter()
                .filter(|(k, _)| k == "CLAUDE_PROJECT_DIR")
                .count(),
            1
        );
        assert!(exec.env.contains(&("WEBHOOK_TOKEN".into(), "t-1".into())));
        assert!(
            !exec
                .env
                .iter()
                .any(|(k, _)| k == "AWS_SECRET" || k == "NOT_SET")
        );
        let _ = Arc::new(launcher);
    }

    #[cfg(unix)]
    #[test]
    fn the_default_shell_is_sh_and_powershell_must_exist() {
        let launcher = CoreLauncher {
            launch: Launch::default(),
            project_dir: PathBuf::from("/work"),
            extra: Vec::new(),
        };
        let shell = launcher
            .spec(&handler("echo hi", None, None), Path::new("/work"))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(shell.program, PathBuf::from("/bin/sh"));
        assert_eq!(
            shell.args,
            [OsString::from("-c"), OsString::from("echo hi")]
        );
        let missing = launcher.spec(
            &handler("x", Some(Shell::PowerShell), None),
            Path::new("/w"),
        );
        assert_eq!(
            missing.err().map(|e| e.to_string()).as_deref(),
            Some("PowerShell was not found")
        );
    }
}
