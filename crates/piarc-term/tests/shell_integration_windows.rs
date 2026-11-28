//! OSC 133 command boundaries and exit codes from real Windows shells with PiArc's integration
//! (T33-A02): Git Bash and Windows PowerShell in a ConPTY. The macOS shells are in
//! `shell_integration.rs`. Git Bash runs in a fresh HOME with empty startup files.
#![cfg(windows)]

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_term::commands::{CommandInfo, CommandState};
use piarc_term::shell;
use piarc_term::{Event, Program, Session, SessionConfig};

const WAIT: Duration = Duration::from_secs(30);

struct Shell {
    session: Session,
    events: Receiver<Event>,
    home: PathBuf,
}

impl Drop for Shell {
    fn drop(&mut self) {
        self.session.close();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

/// Git for Windows' bash (`<git>\bin\bash.exe`), found next to `git` on PATH.
fn git_bash() -> String {
    let output = std::process::Command::new("git")
        .arg("--exec-path")
        .output()
        .expect("git is on PATH");
    // <git>\mingw64\libexec\git-core
    let exec_path = PathBuf::from(String::from_utf8(output.stdout).expect("UTF-8").trim());
    let bash = exec_path
        .ancestors()
        .nth(3)
        .expect("the Git installation")
        .join("bin")
        .join("bash.exe");
    assert!(bash.is_file(), "{} is missing", bash.display());
    bash.to_string_lossy().into_owned()
}

fn start(program: &str, tag: &str) -> Shell {
    let home = std::env::temp_dir().join(format!("piarc-sh-{tag}-{} 中", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join("work dir")).expect("home");
    for rc in [".bashrc", ".bash_profile"] {
        std::fs::write(home.join(rc), "").expect("rc");
    }
    let integration = shell::install(&home.join(".integration")).expect("install");
    let launch = integration
        .launch(program, false, None)
        .expect("a shell with integration");
    let mut env = vec![
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
    ];
    env.extend(launch.env);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let session = Session::spawn(
        SessionConfig {
            cols: 120,
            rows: 30,
            program: Program::Command {
                program: launch.program,
                args: launch.args,
            },
            cwd: Some(home.join("work dir")),
            env,
            ..SessionConfig::default()
        },
        Arc::new(move |event| {
            let _ = tx.lock().expect("lock").send(event);
        }),
    )
    .expect("spawn");
    Shell {
        session,
        events: rx,
        home,
    }
}

/// Waits for the first prompt (its working directory report).
fn wait_for_prompt(shell: &Shell) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match shell.events.recv_timeout(left) {
            Ok(Event::Pwd(path)) => return path,
            Ok(_) => {}
            Err(_) => panic!(
                "no prompt; screen:\n{}",
                shell.session.viewport_text().unwrap_or_default()
            ),
        }
    }
}

/// Types `line` (Enter is a carriage return under ConPTY) and returns the finished command.
fn run(shell: &Shell, line: &str) -> CommandInfo {
    let before = shell.session.info().last_command;
    shell
        .session
        .write(format!("{line}\r").into_bytes())
        .expect("type");
    shell
        .session
        .wait_command(before, WAIT)
        .unwrap_or_else(|error| {
            panic!(
                "{line}: {error}; screen:\n{}",
                shell.session.viewport_text().unwrap_or_default()
            )
        })
}

#[test]
fn git_bash_reports_commands_and_exit_codes() {
    let shell = start(&git_bash(), "gitbash");
    let pwd = wait_for_prompt(&shell);
    assert!(pwd.ends_with("/work dir"), "working directory {pwd}");
    let ok = run(&shell, "echo hello");
    assert_eq!(ok.command, "echo hello");
    assert_eq!((ok.state, ok.exit_code), (CommandState::Finished, Some(0)));
    assert_eq!(ok.output, "hello");
    assert_eq!(run(&shell, "false").exit_code, Some(1));
    let seven = run(&shell, "sh -c 'echo out; exit 7'");
    assert_eq!((seven.exit_code, seven.output.as_str()), (Some(7), "out"));
}

#[test]
fn powershell_reports_commands_and_exit_codes() {
    let shell = start("powershell.exe", "powershell");
    let pwd = wait_for_prompt(&shell);
    assert!(pwd.ends_with("/work dir"), "working directory {pwd}");
    let ok = run(&shell, "Write-Output hello");
    assert_eq!(ok.command, "Write-Output hello");
    assert_eq!((ok.state, ok.exit_code), (CommandState::Finished, Some(0)));
    assert_eq!(ok.output, "hello");
    let native = run(&shell, "cmd /c exit 7");
    assert_eq!(native.exit_code, Some(7), "a native command's exit code");
    let failed = run(&shell, "Get-Item does-not-exist -ErrorAction Stop");
    assert_eq!(failed.exit_code, Some(1), "a failed cmdlet");
}
