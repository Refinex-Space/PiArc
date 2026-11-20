//! The tree without a PTY: a process group (Unix) or a process with a child (Windows). The
//! terminal case (jobs in their own process groups, attached to the PTY) is tested end to end
//! in `piarc-core`'s `tests/terminal.rs`.

use std::time::{Duration, Instant};

use super::*;

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits"));
    nix::sys::signal::kill(pid, None).is_ok()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_hangup_ends_the_group_and_a_process_ignoring_it_is_killed() {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    // The leader ignores nothing; its child ignores SIGHUP and SIGTERM and prints its pid.
    let mut leader = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            "sh -c 'trap \"\" HUP TERM; echo $$; exec sleep 300' & wait",
        ])
        .stdout(std::process::Stdio::piped())
        .process_group(0)
        .spawn()
        .expect("spawn");
    let mut out = String::new();
    let mut stdout = leader.stdout.take().expect("stdout");
    let mut byte = [0u8; 1];
    while !out.ends_with('\n') {
        assert_eq!(stdout.read(&mut byte).expect("read"), 1);
        out.push(char::from(byte[0]));
    }
    let stubborn: u32 = out.trim().parse().expect("pid");
    let tree = TerminalTree::attach(leader.id(), None).expect("attach");
    assert!(tree.members().contains(&leader.id()));
    let started = Instant::now();
    let mut hung_up = false;
    tree.end(|| hung_up = true, Duration::from_millis(300))
        .await;
    assert!(hung_up);
    let _ = leader.wait();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(stubborn) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!alive(stubborn), "the process ignoring SIGHUP was killed");
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "it got the grace period"
    );
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn ending_terminates_the_job_with_the_shell_and_its_children() {
    let mut shell = std::process::Command::new("cmd.exe")
        .args(["/C", "ping -n 300 127.0.0.1 > NUL"])
        .spawn()
        .expect("spawn");
    let tree = TerminalTree::attach(shell.id(), None).expect("attach");
    let started = Instant::now();
    tree.end(|| {}, HANGUP_GRACE).await;
    let status = shell.wait().expect("wait");
    assert!(!status.success());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "no grace on Windows"
    );
}
