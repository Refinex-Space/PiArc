//! The login shell's environment when PiArc has a controlling terminal (macOS).
//!
//! PiArc started from a terminal (`npm run start`, a `.app` binary run from a shell) keeps that
//! terminal as its controlling terminal. An interactive zsh started in a background process
//! group of that session tries to take the terminal over and is stopped by `SIGTTIN`, so the
//! login environment used to wait for its whole timeout (10 s) on every Core. The probe must
//! leave the terminal's session, as VS Code and Zed do.
//!
//! The test runs itself again under `script`, which gives the child a pseudo-terminal as its
//! controlling terminal, with `/bin/zsh` and a temporary home (no user configuration).
#![cfg(target_os = "macos")]

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CHILD: &str = "PIARC_LOGIN_ENV_TTY_CHILD";
const OK: &str = "LOGIN_ENV_OK";

/// The child half: reads the login environment from inside a terminal session.
#[tokio::test]
#[ignore = "run by `login_env_does_not_wait_for_a_controlling_terminal` under `script`"]
async fn child_reads_the_login_env_inside_a_terminal_session() {
    let home = PathBuf::from(std::env::var_os(CHILD).expect("the parent sets the home"));
    let base: Vec<(OsString, OsString)> = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), home.clone().into_os_string()),
        ("SHELL".into(), "/bin/zsh".into()),
    ];
    let started = Instant::now();
    let env = piarc_exec::env::login_shell_env(&base, &home)
        .await
        .expect("login env");
    let took = started.elapsed();
    assert!(env.iter().any(|(k, _)| k == "PATH"), "no PATH in {env:?}");
    assert!(took < Duration::from_secs(5), "took {took:?}");
    println!("{OK} {}ms", took.as_millis());
}

#[test]
fn login_env_does_not_wait_for_a_controlling_terminal() {
    let home = std::env::temp_dir().join(format!("piarc-login-tty {}", std::process::id()));
    std::fs::create_dir_all(&home).expect("home");
    let test = std::env::current_exe().expect("test binary");
    // `script -q /dev/null cmd…`: cmd runs in a new session whose controlling terminal is a
    // pseudo-terminal, in the terminal's foreground process group.
    let mut child = Command::new("/usr/bin/script")
        .arg("-q")
        .arg("/dev/null")
        .arg(&test)
        .args([
            "child_reads_the_login_env_inside_a_terminal_session",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env(CHILD, &home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("script");
    let deadline = Instant::now() + Duration::from_secs(60);
    while child.try_wait().expect("wait").is_none() {
        assert!(Instant::now() < deadline, "the child did not finish");
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = child.wait_with_output().expect("output");
    let text = String::from_utf8_lossy(&out.stdout);
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        text.contains(OK),
        "{text}{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
