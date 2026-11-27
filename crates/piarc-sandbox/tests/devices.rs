//! THR-18 (ADR-0096): the Agent Host's profile and the sandboxed commands' profile deny the
//! microphone and the camera on a real `sandbox-exec`. The microphone permission belongs to the
//! app for voice dictation; tccd asks the sandbox of the requesting process about
//! `device-microphone` and `device-camera`, so this test asks the same question with
//! `sandbox_check` (through JavaScript for Automation, which ships with macOS) about a process
//! running under each profile, and about one under a profile without the rules as a control.

#![cfg(target_os = "macos")]

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use piarc_sandbox::seatbelt::{SANDBOX_EXEC, SeatbeltProfile};
use piarc_sandbox::{PROTECTED_PATHS, SandboxPolicy};

const OPERATIONS: [&str; 2] = ["device-microphone", "device-camera"];

/// A process under `sandbox-exec <args>`, once its sandbox is in place.
struct Sandboxed(Child);

impl Sandboxed {
    fn start(args: &[OsString]) -> Self {
        let mut child = Command::new(SANDBOX_EXEC)
            .args(args)
            .args(["/bin/sh", "-c", "echo ready; exec /bin/sleep 30"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("sandbox-exec starts");
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().expect("stdout"))
            .read_line(&mut line)
            .expect("read");
        // sandbox-exec applies the profile before it runs the shell.
        assert_eq!(line.trim(), "ready", "the sandboxed shell did not start");
        Self(child)
    }

    /// `sandbox_check(pid, operation, SANDBOX_FILTER_NONE)` for each operation: 1 is denied.
    fn checks(&self) -> Vec<(String, i32)> {
        let script = "ObjC.bindFunction('sandbox_check', ['int', ['int', 'char *', 'int']]);\n\
             function run(argv) {\n\
               const pid = parseInt(argv[0]);\n\
               return argv.slice(1).map(op => op + ' ' + $.sandbox_check(pid, op, 0)).join('\\n');\n\
             }";
        let out = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", script])
            .arg(self.0.id().to_string())
            .args(OPERATIONS)
            .output()
            .expect("osascript runs");
        assert!(
            out.status.success(),
            "osascript: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|line| {
                let (op, result) = line.rsplit_once(' ').expect("op result");
                (op.to_owned(), result.parse().expect("an integer"))
            })
            .collect()
    }
}

impl Drop for Sandboxed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Dirs {
    root: PathBuf,
}

impl Dirs {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc devices {name} 中文 {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["ws", "data/sessions/s1/tmp"] {
            std::fs::create_dir_all(root.join(dir)).expect("directory");
        }
        Self { root }
    }

    fn ws(&self) -> PathBuf {
        self.root.join("ws")
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn assert_denied(args: &[OsString], profile: &str) {
    let checks = Sandboxed::start(args).checks();
    assert_eq!(checks.len(), OPERATIONS.len(), "{checks:?}");
    for (op, result) in checks {
        assert_eq!(result, 1, "{profile}: {op} is not denied");
    }
}

#[test]
fn thr18_the_agent_hosts_profile_denies_the_microphone_and_the_camera() {
    let dirs = Dirs::new("agent host");
    let launch =
        piarc_sandbox::agent_host_launch(&dirs.ws(), &dirs.root.join("data")).expect("profile");
    assert_denied(&launch.args, "Agent Host");
}

#[test]
fn thr18_the_sandboxed_commands_profile_denies_the_microphone_and_the_camera() {
    let dirs = Dirs::new("bash");
    let mut policy = SandboxPolicy::new(
        dirs.ws(),
        dirs.root.join("data").join("sessions").join("s1").join("tmp"),
    );
    policy.protected = PROTECTED_PATHS.iter().map(|&p| p.to_owned()).collect();
    let profile = SeatbeltProfile::build(&policy.resolve().expect("resolves"), 50_123)
        .expect("profile");
    assert_denied(&profile.args(), "sandboxed commands");
}

/// The probe tells the two apart: without the rules the same operations are allowed.
#[test]
fn the_probe_sees_allowed_devices_under_a_profile_without_the_rules() {
    let args: Vec<OsString> = ["-p", "(version 1)(allow default)", "--"]
        .into_iter()
        .map(OsString::from)
        .collect();
    for (op, result) in Sandboxed::start(&args).checks() {
        assert_eq!(result, 0, "{op} denied without a rule");
    }
}
