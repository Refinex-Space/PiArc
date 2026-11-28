/// The process's environment (macOS `ps -E`, Linux `/proc/<pid>/environ`) holds no credential.
pub fn check_process_environment(what: &str, pid: u32, needles: &[String]) {
    let environment = if cfg!(target_os = "macos") {
        let out = std::process::Command::new("/bin/ps")
            .args(["-E", "-ww", "-o", "command=", "-p", &pid.to_string()])
            .output()
            .expect("ps runs");
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else if cfg!(target_os = "linux") {
        std::fs::read_to_string(format!("/proc/{pid}/environ")).unwrap_or_default()
    } else {
        // Windows: the process's environment block, read from its PEB (process-env.ps1).
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("agent_host")
            .join("process-env.ps1");
        let out = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .args(["-ProcessId", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("powershell runs");
        assert!(
            out.status.success(),
            "{what}: reading the environment of pid {pid} failed"
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    assert!(
        environment.contains("PATH="),
        "{what}: the environment of pid {pid} is visible to the check"
    );
    for needle in needles {
        assert!(
            !environment.contains(needle.as_str()),
            "{what}: a credential is in its environment"
        );
    }
    println!("{what} (pid {pid}) environment holds no credential");
}
