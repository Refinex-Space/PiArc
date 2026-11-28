//! Workspace, home, data and command environment fixtures isolated to one scenario run.

use std::collections::BTreeMap;
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
/// PiArc set in the real application, here added to the isolated tool environment.
pub const INTERNAL_PROBES: [(&str, &str); 4] = [
    ("ELECTRON_RUN_AS_NODE", "1"),
    ("NODE_OPTIONS", "--no-deprecation"),
    ("PI_CODING_AGENT_DIR", "/l2/pi"),
    ("PIARC_L2_INTERNAL", "1"),
];

/// The command environment of a run's Core: the login shell (on Unix `/bin/bash` with a home
/// directory of the run, whose `.bash_profile` puts `<home>/bin` with the program
/// `l2-login-tool` on `PATH` and sets `LC_TIME`). Only OS tool paths come from the test
/// process; all private variables here are synthetic, even when an isolation assertion fails.
pub(super) fn command_env(home: &Path) -> Result<piarc_core::tool_io::CommandEnv, String> {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
    let mut base: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
        .filter(|(key, _)| {
            [
                "PATH",
                "SystemRoot",
                "WINDIR",
                "COMSPEC",
                "PATHEXT",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "TEMP",
                "TMP",
                "TMPDIR",
                "LOCALAPPDATA",
            ]
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
        })
        .collect();
    base.extend(
        INTERNAL_PROBES
            .iter()
            .map(|(k, v)| (std::ffi::OsString::from(k), std::ffi::OsString::from(v))),
    );
    base.push(("L2_USER_VAR".into(), "synthetic-exported-secret".into()));
    base.push(("LC_NUMERIC".into(), "C".into()));
    base.push(("HOME".into(), home.as_os_str().to_owned()));
    if cfg!(windows) {
        base.push(("USERPROFILE".into(), home.as_os_str().to_owned()));
    }
    if cfg!(unix) {
        let tool = bin.join("l2-login-tool");
        std::fs::write(&tool, "#!/bin/sh\necho 'login PATH works'\n")
            .map_err(|e| format!("{}: {e}", tool.display()))?;
        make_executable(&tool)?;
        let quoted = bin.display().to_string().replace('\'', r"'\''");
        std::fs::write(
            home.join(".bash_profile"),
            format!("export PATH='{quoted}':\"$PATH\"\nexport LC_TIME=C\nexport L2_LOGIN_PROFILE=synthetic-profile-secret\n"),
        )
        .map_err(|e| format!("{}: {e}", home.display()))?;
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
    mcp_urls: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (path, content) in &spec.workspace.run_files {
        write_file(root, path, &fill_paths(spec, content, workspace, mcp_urls))?;
    }
    if spec.workspace.git {
        // Byte-exact checkouts whatever the machine's git says: Git for Windows sets
        // `core.autocrlf=true` system-wide, which would give worktrees CRLF files (W3).
        for args in [
            &["init", "--quiet", "--template="][..],
            &["config", "core.autocrlf", "false"][..],
        ] {
            let result = Command::new("git")
                .args(args)
                .current_dir(workspace)
                .output()
                .map_err(|e| format!("git {}: {e}", args[0]))?;
            if !result.status.success() {
                return Err(format!(
                    "git {} failed: {}",
                    args[0],
                    String::from_utf8_lossy(&result.stderr)
                ));
            }
        }
    }
    for (path, content) in &spec.workspace.files {
        write_file(
            workspace,
            path,
            &fill_paths(spec, content, workspace, mcp_urls),
        )?;
    }
    if spec.workspace.git_commit {
        commit_all(workspace, &spec.workspace.git_branches)?;
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

/// `{{mcp_echo}}` in a file's text: the absolute path of the stdio MCP fixture server
/// (`packages/testkit/src/mcp-echo-server.ts`, T36), escaped for a JSON string, so scenarios
/// can configure it in `.mcp.json` (`"command": "node", "args": ["{{mcp_echo}}", "alpha"]`).
pub const MCP_ECHO_PLACEHOLDER: &str = "{{mcp_echo}}";

/// A path for a JSON string in a fixture file: no `\\?\` prefix (Node rejects it on Windows)
/// and backslashes escaped.
fn json_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let quoted = serde_json::to_string(plain).unwrap_or_default();
    quoted.trim_matches('"').to_owned()
}

fn fill_paths(
    spec: &ScenarioSpec,
    content: &str,
    workspace: &Path,
    mcp_urls: &BTreeMap<String, String>,
) -> String {
    let mut content = content.to_owned();
    // `{{mcp_http:<name>}}`: the URL of the scenario's HTTP MCP fixture server `name` (T36).
    for (name, url) in mcp_urls {
        content = content.replace(&format!("{{{{mcp_http:{name}}}}}"), url);
    }
    // `{{workspace}}`: the workspace's absolute path, escaped for a JSON string (T45: a Pi
    // settings file naming a package inside the workspace).
    if content.contains(super::runner::WORKSPACE_PLACEHOLDER) {
        content = content.replace(super::runner::WORKSPACE_PLACEHOLDER, &json_path(workspace));
    }
    if !content.contains(MCP_ECHO_PLACEHOLDER) {
        return content;
    }
    let echo = spec
        .fixture(".")
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("testkit")
        .join("src")
        .join("mcp-echo-server.ts");
    let echo = canonical(&echo);
    content.replace(MCP_ECHO_PLACEHOLDER, &json_path(&echo))
}

/// The spelling of an existing `path` as Core reports it: links resolved, without the verbatim
/// `\\?\` prefix `canonicalize` adds on Windows (Node cannot run such a path either). A path
/// that cannot be resolved is returned as it is.
pub(crate) fn canonical(path: &Path) -> PathBuf {
    let Ok(real) = std::fs::canonicalize(path) else {
        return path.to_path_buf();
    };
    match real.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        Some(plain) if plain.as_bytes().get(1) == Some(&b':') => PathBuf::from(plain),
        _ => real,
    }
}

/// Commits the workspace's files with a fixed identity, then creates `branches` there (T35).
fn commit_all(workspace: &Path, branches: &[String]) -> Result<(), String> {
    let git = |args: &[&str]| -> Result<(), String> {
        let result = Command::new("git")
            .args([
                "-c",
                "user.name=PiArc L2",
                "-c",
                "user.email=l2@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(workspace)
            .output()
            .map_err(|e| format!("git {args:?}: {e}"))?;
        if result.status.success() {
            Ok(())
        } else {
            Err(format!(
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&result.stderr)
            ))
        }
    };
    git(&["add", "--all"])?;
    git(&["commit", "--quiet", "--allow-empty", "-m", "initial"])?;
    for branch in branches {
        git(&["branch", branch])?;
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

/// Every entry of Claude Code's configuration below a run's root (inside any `.claude`
/// directory, or named `.claude.json`): the relative path and its content (file bytes, a
/// link's target, or nothing for a directory). Links are not followed. T24-A08 compares the
/// snapshot before Core starts with the one after it stopped: PiArc never writes there.
pub(super) fn claude_snapshot(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(
        root: &Path,
        dir: &Path,
        inside: bool,
        out: &mut std::collections::BTreeMap<String, Vec<u8>>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let claude = inside || name == ".claude" || name == ".claude.json";
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            let key = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if meta.is_dir() {
                if claude {
                    out.insert(key + "/", Vec::new());
                }
                walk(root, &path, claude, out);
            } else if claude {
                let content = if meta.is_symlink() {
                    std::fs::read_link(&path)
                        .map(|t| t.to_string_lossy().into_owned().into_bytes())
                        .unwrap_or_default()
                } else {
                    std::fs::read(&path).unwrap_or_default()
                };
                out.insert(key, content);
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(root, root, false, &mut out);
    out
}

/// What differs between two [`claude_snapshot`]s, one line per path.
pub(super) fn claude_changes(
    before: &std::collections::BTreeMap<String, Vec<u8>>,
    after: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Vec<String> {
    let mut changes = Vec::new();
    for (path, content) in after {
        match before.get(path) {
            None => changes.push(format!("added {path}")),
            Some(old) if old != content => changes.push(format!("modified {path}")),
            Some(_) => {}
        }
    }
    for path in before.keys().filter(|p| !after.contains_key(*p)) {
        changes.push(format!("removed {path}"));
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_claude_snapshot_sees_additions_edits_and_removals_only_in_claude_paths() {
        let root =
            std::env::temp_dir().join(format!("piarc l2 snapshot 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let write = |name: &str, text: &str| {
            let path = resolve(&root, name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            std::fs::write(path, text).expect("write");
        };
        write("work space/.claude/settings.json", "{}");
        write("home 家/.claude/rules/a.md", "a");
        write("home 家/.claude.json", "{}");
        write("work space/.piarc/settings.json", "{}");
        let before = claude_snapshot(&root);
        assert_eq!(
            before.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "home 家/.claude.json",
                "home 家/.claude/",
                "home 家/.claude/rules/",
                "home 家/.claude/rules/a.md",
                "work space/.claude/",
                "work space/.claude/settings.json"
            ]
        );
        assert!(claude_changes(&before, &claude_snapshot(&root)).is_empty());
        write("work space/.piarc/settings.local.json", "{}");
        write("work space/.claude/settings.json", "{\"x\":1}");
        write("work space/.claude/settings.local.json", "{}");
        std::fs::remove_file(resolve(&root, "home 家/.claude/rules/a.md")).expect("remove");
        assert_eq!(
            claude_changes(&before, &claude_snapshot(&root)),
            [
                "modified work space/.claude/settings.json",
                "added work space/.claude/settings.local.json",
                "removed home 家/.claude/rules/a.md"
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
