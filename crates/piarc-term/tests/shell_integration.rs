//! OSC 133 command boundaries and exit codes from real shells with PiArc's integration
//! (T33-A02): zsh and bash on macOS (bash 3.2 there). The Windows shells (Git Bash and
//! PowerShell) are in `shell_integration_windows.rs`. Each test runs in a fresh HOME with
//! empty startup files, so the user's own configuration does not matter.
#![cfg(unix)]

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_term::commands::{CommandChange, CommandState};
use piarc_term::shell;
use piarc_term::{Event, Program, Session, SessionConfig};

const WAIT: Duration = Duration::from_secs(20);

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

fn start(program: &str, login: bool, tag: &str) -> Shell {
    start_with(program, login, tag, &[])
}

/// Starts `program` with integration in a fresh HOME whose startup files are empty except
/// `files` (name, content).
fn start_with(program: &str, login: bool, tag: &str, files: &[(&str, &str)]) -> Shell {
    let home = std::env::temp_dir().join(format!("piarc-sh-{tag}-{} 中", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join("work dir")).expect("home");
    for rc in [".zshrc", ".zshenv", ".bashrc", ".bash_profile"] {
        std::fs::write(home.join(rc), "").expect("rc");
    }
    for (name, content) in files {
        std::fs::write(home.join(name), content).expect("rc content");
    }
    let integration = shell::install(&home.join(".integration")).expect("install");
    let launch = integration
        .launch(program, login, None)
        .expect("a shell with integration");
    let mut env: Vec<(String, String)> = vec![
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("SHELL".into(), program.into()),
    ];
    env.extend(launch.env);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let session = Session::spawn(
        SessionConfig {
            cols: 100,
            rows: 30,
            program: Program::Command {
                program: launch.program,
                args: launch.args,
            },
            cwd: Some(home.join("work dir")),
            env,
            clear_env: true,
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

/// Waits for the first prompt (OSC 133 A shows up as a working directory report first).
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

/// Types `line` and returns the command record once it finished.
fn run(shell: &Shell, line: &str) -> piarc_term::commands::CommandInfo {
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

fn check_commands(program: &str, login: bool, tag: &str) {
    let shell = start(program, login, tag);
    let pwd = wait_for_prompt(&shell);
    assert!(pwd.ends_with("/work dir"), "{tag}: working directory {pwd}");
    let ok = run(&shell, "echo hello");
    assert_eq!(ok.command, "echo hello", "{tag}");
    assert_eq!(
        (ok.state, ok.exit_code),
        (CommandState::Finished, Some(0)),
        "{tag}"
    );
    assert_eq!(ok.output, "hello", "{tag}");
    let failed = run(&shell, "false");
    assert_eq!(failed.exit_code, Some(1), "{tag}");
    assert_eq!(failed.output, "", "{tag}");
    let seven = run(&shell, "sh -c 'echo 中文 out; exit 7'");
    assert_eq!(
        seven.command, "sh -c 'echo 中文 out; exit 7'",
        "{tag}: UTF-8 command line"
    );
    assert_eq!(seven.exit_code, Some(7), "{tag}");
    assert_eq!(seven.output, "中文 out", "{tag}");
    let multi = run(&shell, "printf 'a\\nb\\nc\\n'");
    assert_eq!(multi.output, "a\nb\nc", "{tag}");
    assert_eq!(multi.seq, seven.seq + 1, "{tag}");
    // An empty line runs nothing: no command is recorded.
    shell.session.write(b"\r".to_vec()).expect("enter");
    let after_empty = run(&shell, "cd ..");
    assert_eq!(
        after_empty.seq,
        multi.seq + 1,
        "{tag}: the empty line made no command"
    );
    assert_eq!(after_empty.exit_code, Some(0));
    let last = shell
        .session
        .last_command()
        .expect("read")
        .expect("a command");
    assert_eq!(last.seq, after_empty.seq);
    // Events said the same.
    // Events follow the log: the IO thread reports them right after it updated it.
    let mut started = 0;
    let mut finished = Vec::new();
    let deadline = Instant::now() + WAIT;
    while finished.len() < 5 {
        let left = deadline.saturating_duration_since(Instant::now());
        let Ok(event) = shell.events.recv_timeout(left) else {
            break;
        };
        match event {
            Event::Command(CommandChange::Started { .. }) => started += 1,
            Event::Command(CommandChange::Finished { exit_code, .. }) => finished.push(exit_code),
            _ => {}
        }
    }
    assert_eq!(started, 5, "{tag}");
    assert_eq!(
        finished,
        [Some(0), Some(1), Some(7), Some(0), Some(0)],
        "{tag}"
    );
    // The new directory follows the command's end (OSC 7 in the next prompt).
    let home = std::fs::canonicalize(&shell.home).expect("canonical home");
    let deadline = Instant::now() + WAIT;
    loop {
        let pwd = shell.session.info().pwd;
        if std::fs::canonicalize(&pwd).is_ok_and(|p| p == home) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{tag}: cd .. was not reported: {pwd}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn zsh_reports_commands_and_exit_codes() {
    check_commands("/bin/zsh", true, "zsh-login");
}

#[test]
fn an_interactive_zsh_reports_them_too() {
    check_commands("/bin/zsh", false, "zsh");
}

#[test]
fn bash_reports_commands_and_exit_codes() {
    check_commands("/bin/bash", true, "bash-login");
}

#[test]
fn an_interactive_bash_reports_them_too() {
    check_commands("/bin/bash", false, "bash");
}

#[test]
fn the_users_startup_files_still_apply() {
    let shell = start_with(
        "/bin/zsh",
        true,
        "zshrc",
        &[(".zshrc", "export PIARC_FROM_ZSHRC=yes\n")],
    );
    wait_for_prompt(&shell);
    let info = run(&shell, "echo \"$PIARC_FROM_ZSHRC:$ZDOTDIR\"");
    assert_eq!(
        info.output, "yes:",
        "the user's .zshrc ran and ZDOTDIR is theirs"
    );
    let shell = start_with(
        "/bin/bash",
        true,
        "profile",
        &[(".bash_profile", "export PIARC_FROM_PROFILE=yes\n")],
    );
    wait_for_prompt(&shell);
    let info = run(&shell, "echo \"$PIARC_FROM_PROFILE\"");
    assert_eq!(info.output, "yes", "a login bash read .bash_profile");
    let shell = start_with(
        "/bin/bash",
        false,
        "bashrc",
        &[(".bashrc", "export PIARC_FROM_BASHRC=yes\n")],
    );
    wait_for_prompt(&shell);
    let info = run(&shell, "echo \"$PIARC_FROM_BASHRC\"");
    assert_eq!(info.output, "yes", "an interactive bash read .bashrc");
}
