//! Which shells run commands, and how they are invoked (architecture sections 6.2.2 and 15.2).
//!
//! - **bash** runs the `Bash` tool. Unix: `/bin/bash`, else `bash` on `PATH`. Windows: Git
//!   Bash, looked up in this order: the path in the user's settings (`shell.gitBashPath`), the
//!   usual installation directories (`%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`,
//!   `%LOCALAPPDATA%\Programs\Git`), then the installation the `git.exe` on `PATH` belongs to
//!   (`<git>\cmd\git.exe` or `<git>\bin\git.exe` → `<git>\bin\bash.exe`). `bash.exe` elsewhere on
//!   `PATH` is not used: `System32\bash.exe` is the WSL launcher. Without Git Bash, Windows
//!   sessions get no `Bash` tool and the user is told to install Git for Windows.
//! - **PowerShell** runs the `PowerShell` tool, on Windows only: PowerShell 7 (`pwsh.exe` on
//!   `PATH`, then `%ProgramFiles%\PowerShell\7\pwsh.exe`), else Windows PowerShell 5.1
//!   (`powershell.exe` on `PATH`, then under `%SystemRoot%\System32\WindowsPowerShell\v1.0`).
//!
//! [`powershell_args`] follows Pi's PowerShell backend (`@earendil-works/pi-coding-agent`
//! 1.5.2, `dist/core/tools/powershell.js`, MIT, Copyright (c) Mario Zechner): UTF-8 console
//! output first, and for Windows PowerShell 5.1 an exit code that ignores error records made
//! from a native command's redirected stderr.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The shells of a session's command tools.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shells {
    /// bash (Git Bash on Windows), when found.
    pub bash: Option<PathBuf>,
    /// PowerShell, on Windows when found.
    pub powershell: Option<PathBuf>,
    /// Where bash was looked for, in order (for the message when it is missing).
    pub bash_searched: Vec<PathBuf>,
}

/// What shell detection looks at; [`Probe::system`] is the real one, tests describe a machine.
pub struct Probe<'a> {
    /// Whether to look the Windows way.
    pub windows: bool,
    /// The environment (`PATH`, `ProgramFiles`, ...).
    pub env: &'a [(OsString, OsString)],
    /// Whether a file exists.
    pub exists: &'a dyn Fn(&Path) -> bool,
}

impl<'a> Probe<'a> {
    /// This machine, with environment `env`.
    #[must_use]
    pub fn system(env: &'a [(OsString, OsString)]) -> Self {
        Self {
            windows: cfg!(windows),
            env,
            exists: &|path: &Path| path.is_file(),
        }
    }

    fn var(&self, name: &str) -> Option<&OsStr> {
        self.env
            .iter()
            .find(|(k, _)| {
                if self.windows {
                    k.to_string_lossy().eq_ignore_ascii_case(name)
                } else {
                    k == name
                }
            })
            .map(|(_, v)| v.as_os_str())
    }

    fn on_path(&self, file: &str) -> Option<PathBuf> {
        std::env::split_paths(self.var("PATH")?)
            .map(|dir| dir.join(file))
            .find(|candidate| (self.exists)(candidate))
    }
}

/// Finds the shells; `git_bash` is the path from the user's settings (Windows only).
#[must_use]
pub fn detect(probe: &Probe<'_>, git_bash: Option<&Path>) -> Shells {
    if !probe.windows {
        let fixed = PathBuf::from("/bin/bash");
        let bash = if (probe.exists)(&fixed) {
            Some(fixed.clone())
        } else {
            probe.on_path("bash")
        };
        return Shells {
            bash,
            powershell: None,
            bash_searched: vec![fixed],
        };
    }
    let mut searched = Vec::new();
    if let Some(explicit) = git_bash {
        searched.push(explicit.to_path_buf());
    }
    for (var, rest) in [
        ("ProgramFiles", &["Git"][..]),
        ("ProgramFiles(x86)", &["Git"][..]),
        ("LOCALAPPDATA", &["Programs", "Git"][..]),
    ] {
        if let Some(base) = probe.var(var) {
            let root = rest
                .iter()
                .fold(PathBuf::from(base), |p, part| p.join(part));
            searched.push(root.join("bin").join("bash.exe"));
        }
    }
    if let Some(git) = probe.on_path("git.exe") {
        // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe.
        for root in git.ancestors().skip(2).take(2) {
            searched.push(root.join("bin").join("bash.exe"));
        }
    }
    let bash = searched.iter().find(|p| (probe.exists)(p)).cloned();
    let powershell = probe
        .on_path("pwsh.exe")
        .or_else(|| {
            let pwsh = PathBuf::from(probe.var("ProgramFiles")?)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            (probe.exists)(&pwsh).then_some(pwsh)
        })
        .or_else(|| probe.on_path("powershell.exe"))
        .or_else(|| {
            let ps = PathBuf::from(probe.var("SystemRoot")?)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            (probe.exists)(&ps).then_some(ps)
        });
    Shells {
        bash,
        powershell,
        bash_searched: searched,
    }
}

/// The variable that carries a command to Git Bash on Windows (see [`bash_invocation`]).
pub const COMMAND_VARIABLE: &str = "PIARC_COMMAND";

/// How bash runs `command`: its arguments, and the variables to add to its environment.
///
/// Unix passes the command as `-c`'s argument. Git Bash's runtime parses its Windows command
/// line itself and cut a 12,000-character argument with quotes short (CI), so on Windows the
/// command travels in [`COMMAND_VARIABLE`], which the shell unsets before running it: the
/// command and its children do not see it. Output, exit codes and runtime errors are those of
/// `-c`; a syntax error reads `eval: line N` and may exit 1 instead of 2.
#[must_use]
pub fn bash_invocation(command: &str) -> (Vec<OsString>, Vec<(OsString, OsString)>) {
    if cfg!(windows) {
        carried_invocation(command)
    } else {
        (
            vec![OsString::from("-c"), OsString::from(command)],
            Vec::new(),
        )
    }
}

/// The Windows form of [`bash_invocation`], whatever the platform (tested with Unix bash).
fn carried_invocation(command: &str) -> (Vec<OsString>, Vec<(OsString, OsString)>) {
    let run = format!("eval \"unset {COMMAND_VARIABLE}; ${COMMAND_VARIABLE}\"");
    (
        vec![OsString::from("-c"), OsString::from(run)],
        vec![(OsString::from(COMMAND_VARIABLE), OsString::from(command))],
    )
}

/// Sets the console output to UTF-8 before the command (Pi's prefix).
const UTF8_OUTPUT_PREFIX: &str =
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/// Windows PowerShell 5.1 turns redirected native stderr into error records and sets `$?` to
/// false although the native command exited 0; PowerShell 7 does not. The lone `;` keeps an
/// unfinished last statement a parse error instead of joining it to the suffix (Pi's suffix).
const WINDOWS_POWERSHELL_EXIT_SUFFIX: &str = "\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and (\"$($Error[0].FullyQualifiedErrorId)\" -like \"NativeCommandError*\")) { exit 0 }\nexit 1";

/// The arguments that run `command` with the PowerShell at `shell`.
#[must_use]
pub fn powershell_args(shell: &Path, command: &str) -> Vec<OsString> {
    let windows_powershell = shell
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe"));
    // A final backtick would continue the command's last line into the suffix.
    let suffix = if windows_powershell && !command.ends_with('`') {
        WINDOWS_POWERSHELL_EXIT_SUFFIX
    } else {
        ""
    };
    [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
    ]
    .iter()
    .map(OsString::from)
    .chain(std::iter::once(OsString::from(format!(
        "{UTF8_OUTPUT_PREFIX}{command}{suffix}"
    ))))
    .collect()
}

/// A path Git Bash printed (`/c/Users/me`, `C:/Users/me`, `//server/share/dir`) as a Windows
/// path; `None` for paths inside Git's own tree (`/tmp`, `/usr/bin`), which are never inside
/// a workspace.
#[must_use]
pub fn msys_to_windows(path: &str) -> Option<String> {
    let path = path.trim_end_matches(['\r', '\n']);
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(path.replace('/', "\\"));
    }
    if let Some(unc) = path.strip_prefix("//") {
        return Some(format!(r"\\{}", unc.replace('/', "\\")));
    }
    let rest = path.strip_prefix('/')?;
    let (drive, tail) = rest.split_once('/').unwrap_or((rest, ""));
    let mut letters = drive.chars();
    match (letters.next(), letters.next()) {
        (Some(letter), None) if letter.is_ascii_alphabetic() => Some(format!(
            "{}:\\{}",
            letter.to_ascii_uppercase(),
            tail.replace('/', "\\")
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn machine(files: &[PathBuf]) -> impl Fn(&Path) -> bool + use<> {
        let files: HashSet<PathBuf> = files.iter().cloned().collect();
        move |p: &Path| files.contains(p)
    }

    #[test]
    fn unix_uses_bin_bash_and_no_powershell() {
        let vars = env(&[("PATH", "/usr/local/bin")]);
        let exists = machine(&[PathBuf::from("/bin/bash")]);
        let shells = detect(
            &Probe {
                windows: false,
                env: &vars,
                exists: &exists,
            },
            None,
        );
        assert_eq!(shells.bash, Some(PathBuf::from("/bin/bash")));
        assert_eq!(shells.powershell, None);
        let exists = machine(&[PathBuf::from("/usr/local/bin/bash")]);
        let shells = detect(
            &Probe {
                windows: false,
                env: &vars,
                exists: &exists,
            },
            None,
        );
        assert_eq!(shells.bash, Some(PathBuf::from("/usr/local/bin/bash")));
    }

    fn pf() -> PathBuf {
        PathBuf::from("PF")
    }

    #[test]
    fn windows_prefers_the_setting_then_known_places_then_git_on_path() {
        let vars = env(&[
            ("PATH", "G/cmd"),
            ("ProgramFiles", "PF"),
            ("SystemRoot", "W"),
        ]);
        let explicit = PathBuf::from("D").join("tools").join("bash.exe");
        let installed = pf().join("Git").join("bin").join("bash.exe");
        let from_git = PathBuf::from("G").join("bin").join("bash.exe");
        let git = PathBuf::from("G/cmd").join("git.exe");
        let probe = |files: &[PathBuf], explicit_path: Option<&Path>| {
            let exists = machine(files);
            detect(
                &Probe {
                    windows: true,
                    env: &vars,
                    exists: &exists,
                },
                explicit_path,
            )
        };
        let all = [
            explicit.clone(),
            installed.clone(),
            from_git.clone(),
            git.clone(),
        ];
        assert_eq!(probe(&all, Some(&explicit)).bash, Some(explicit.clone()));
        assert_eq!(probe(&all, None).bash, Some(installed.clone()));
        assert_eq!(
            probe(&[from_git.clone(), git.clone()], None).bash,
            Some(from_git.clone())
        );
        let missing = probe(&[git], Some(&explicit));
        assert_eq!(missing.bash, None);
        assert_eq!(missing.bash_searched[0], explicit);
        assert!(missing.bash_searched.contains(&installed));
        assert!(missing.bash_searched.contains(&from_git));
    }

    #[test]
    fn windows_prefers_powershell_7() {
        let vars = env(&[("PATH", "P"), ("ProgramFiles", "PF"), ("SystemRoot", "W")]);
        let pwsh7 = pf().join("PowerShell").join("7").join("pwsh.exe");
        let legacy = PathBuf::from("W")
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let find = |files: &[PathBuf]| {
            let exists = machine(files);
            detect(
                &Probe {
                    windows: true,
                    env: &vars,
                    exists: &exists,
                },
                None,
            )
            .powershell
        };
        let on_path = PathBuf::from("P").join("pwsh.exe");
        assert_eq!(find(&[on_path.clone(), legacy.clone()]), Some(on_path));
        assert_eq!(find(&[pwsh7.clone(), legacy.clone()]), Some(pwsh7));
        assert_eq!(find(std::slice::from_ref(&legacy)), Some(legacy));
        assert_eq!(find(&[]), None);
    }

    #[test]
    fn powershell_args_set_utf8_and_fix_5_1_exit_codes() {
        let args = powershell_args(Path::new("pwsh.exe"), "Get-ChildItem");
        let last = args.last().expect("command").to_string_lossy().into_owned();
        assert_eq!(args[0], "-NoLogo");
        assert!(last.starts_with("try { [Console]::OutputEncoding"));
        assert!(last.ends_with("\nGet-ChildItem"));
        let legacy = powershell_args(Path::new("POWERSHELL.EXE"), "git push 2>&1");
        let last = legacy
            .last()
            .expect("command")
            .to_string_lossy()
            .into_owned();
        assert!(last.contains("NativeCommandError"));
        let backtick = powershell_args(Path::new("powershell.exe"), "echo `");
        assert!(
            backtick
                .last()
                .expect("command")
                .to_string_lossy()
                .ends_with('`')
        );
    }

    #[test]
    fn converts_git_bash_paths() {
        assert_eq!(
            msys_to_windows("/c/Users/me").as_deref(),
            Some(r"C:\Users\me")
        );
        assert_eq!(msys_to_windows("/d").as_deref(), Some(r"D:\"));
        assert_eq!(
            msys_to_windows("/c/工作 区/src\n").as_deref(),
            Some(r"C:\工作 区\src")
        );
        assert_eq!(
            msys_to_windows("C:/Users/me").as_deref(),
            Some(r"C:\Users\me")
        );
        assert_eq!(
            msys_to_windows("//server/share/dir").as_deref(),
            Some(r"\\server\share\dir")
        );
        assert_eq!(msys_to_windows("/tmp"), None);
        assert_eq!(msys_to_windows("/usr/bin"), None);
        assert_eq!(msys_to_windows("relative"), None);
    }

    /// The Windows form run by Unix bash: the whole command, and the output, exit code and
    /// runtime errors of plain `-c`; no trace of the carrying variable for the command or its
    /// children. (A syntax error reads `eval: line N` and may exit 1 instead of 2.)
    #[cfg(unix)]
    #[test]
    fn a_command_carried_in_the_environment_runs_as_with_dash_c() {
        let run = |args: Vec<OsString>, carried: Vec<(OsString, OsString)>| {
            std::process::Command::new("/bin/bash")
                .args(args)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .envs(carried)
                .output()
                .expect("bash runs")
        };
        let carried = |command: &str| {
            let (args, env) = carried_invocation(command);
            run(args, env)
        };
        let direct = |command: &str| run(vec!["-c".into(), command.into()], Vec::new());
        let long = "it's [x] (y) {z} \"q\" $HOME ".repeat(800);
        let printed = carried(&format!("printf '%s' {}", shell_quote(&long)));
        assert_eq!(String::from_utf8_lossy(&printed.stdout), long);
        let hidden = carried(&format!(
            "echo \"[${{{COMMAND_VARIABLE}:-}}]\"; env | grep -c {COMMAND_VARIABLE}"
        ));
        assert_eq!(String::from_utf8_lossy(&hidden.stdout), "[]\n0\n");
        for command in ["true\nexit 7", "echo a\nno_such_command_for_piarc\necho b"] {
            let (via, plain) = (carried(command), direct(command));
            assert_eq!(via.status.code(), plain.status.code(), "{command}");
            assert_eq!(via.stdout, plain.stdout, "{command}");
            assert_eq!(via.stderr, plain.stderr, "{command}");
        }
    }

    /// `text` as one single-quoted shell word.
    #[cfg(unix)]
    fn shell_quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}
