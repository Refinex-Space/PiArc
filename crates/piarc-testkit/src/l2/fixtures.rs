//! Workspace, home, data and command environment fixtures isolated to one scenario run.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use super::format::ScenarioSpec;

pub(super) fn resolve(workspace: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|part| *part != ".")
        .fold(workspace.to_path_buf(), |path, part| path.join(part))
}

/// Variables PiArc's processes carry that commands must not see (T17): what Electron, Node and
/// PiArc set in the real application, here added to the test process's environment.
pub const INTERNAL_PROBES: [(&str, &str); 4] = [
    ("ELECTRON_RUN_AS_NODE", "1"),
    ("NODE_OPTIONS", "--no-deprecation"),
    ("PI_CODING_AGENT_DIR", "/l2/pi"),
    ("PIARC_L2_INTERNAL", "1"),
];

/// The command environment of a run's Core: the login shell (on Unix `/bin/bash` with a home
/// directory of the run, whose `.bash_profile` puts `<home>/bin` with the program
/// `l2-login-tool` on `PATH` and sets `L2_LOGIN_PROFILE`) started from the test process's
/// environment plus [`INTERNAL_PROBES`] and `L2_USER_VAR=kept`. Windows has no login shell:
/// the same environment, stripped.
pub(super) fn command_env(home: &Path) -> Result<piarc_core::tool_io::CommandEnv, String> {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
    let mut base: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
        .filter(|(k, _)| k != "HOME" && k != "SHELL" && k != "BASH_ENV")
        .collect();
    base.extend(
        INTERNAL_PROBES
            .iter()
            .map(|(k, v)| (std::ffi::OsString::from(k), std::ffi::OsString::from(v))),
    );
    base.push(("L2_USER_VAR".into(), "kept".into()));
    if cfg!(unix) {
        let tool = bin.join("l2-login-tool");
        std::fs::write(&tool, "#!/bin/sh\necho 'login PATH works'\n")
            .map_err(|e| format!("{}: {e}", tool.display()))?;
        make_executable(&tool)?;
        let quoted = bin.display().to_string().replace('\'', r"'\''");
        std::fs::write(
            home.join(".bash_profile"),
            format!("export PATH='{quoted}':\"$PATH\"\nexport L2_LOGIN_PROFILE=loaded\n"),
        )
        .map_err(|e| format!("{}: {e}", home.display()))?;
        base.push(("HOME".into(), home.as_os_str().to_owned()));
        base.push(("SHELL".into(), "/bin/bash".into()));
    }
    Ok(piarc_core::tool_io::CommandEnv::LoginShell { base })
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(super) fn prepare_workspace(
    spec: &ScenarioSpec,
    root: &Path,
    workspace: &Path,
) -> Result<(), String> {
    for (path, content) in &spec.workspace.run_files {
        write_file(root, path, content)?;
    }
    if spec.workspace.git {
        let result = Command::new("git")
            .args(["init", "--quiet", "--template="])
            .current_dir(workspace)
            .output()
            .map_err(|e| format!("git init: {e}"))?;
        if !result.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&result.stderr)
            ));
        }
    }
    for (path, content) in &spec.workspace.files {
        write_file(workspace, path, content)?;
    }
    for (path, name) in &spec.workspace.fixtures {
        let target = resolve(workspace, path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::copy(spec.fixture(name), &target)
            .map_err(|e| format!("fixture {name} → {}: {e}", target.display()))?;
    }
    for session in spec.sessions().values() {
        if let Some(cwd) = &session.cwd {
            let dir = resolve(workspace, cwd);
            std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
    }
    Ok(())
}

pub(super) fn write_file(workspace: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = resolve(workspace, relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}
