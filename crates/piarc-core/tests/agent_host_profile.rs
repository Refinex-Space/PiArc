//! The Agent Host's finalized Seatbelt profile (T39-A09, architecture section 10.3) on a real
//! `sandbox-exec`: a shell started the way Core starts the Agent Host writes the workspace,
//! Pi's agent directory, the Agent Host's own directory and a session's temporary directory,
//! and nothing else: not the home directory, the rest of PiArc's data directory (the user's
//! settings, the database, the vault, the user's skills) or a protected path of the workspace.
//! Reads stay open. The profile's text is checked by its golden in `piarc-sandbox`.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;

struct Dirs {
    root: PathBuf,
    ws: PathBuf,
    data: PathBuf,
    home: PathBuf,
}

impl Dirs {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc host profile {name} 中文 {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = Self {
            ws: root.join("work space 工作区"),
            data: root.join("data 数据"),
            home: root.join("home"),
            root,
        };
        for dir in [
            dirs.ws.join(".git").join("hooks"),
            dirs.ws.join(".pi"),
            dirs.ws
                .join(".piarc")
                .join("worktrees")
                .join("w1")
                .join(".vscode"),
            dirs.data.join("pi"),
            dirs.data.join("agent-host").join("tmp"),
            dirs.data.join("sessions").join("s1").join("tmp"),
            dirs.data.join("sessions").join("s1").join("blobs"),
            dirs.data.join("skills"),
            dirs.home.clone(),
        ] {
            std::fs::create_dir_all(dir).expect("directory");
        }
        std::fs::write(dirs.data.join("settings.json"), "{}\n").expect("settings");
        std::fs::write(dirs.ws.join(".pi").join("settings.json"), "{}\n").expect("pi settings");
        dirs
    }

    /// Whether the profile lets a shell create `path` (and the parent of a `.lock` directory).
    fn writes(&self, path: &Path) -> bool {
        let launch = piarc_sandbox::agent_host_launch(&self.ws, &self.data).expect("profile");
        let script = if path.extension().is_some_and(|e| e == "lock") {
            "mkdir \"$1\""
        } else {
            "printf x > \"$1\""
        };
        let out = Command::new(&launch.program)
            .args(&launch.args)
            .args(["/bin/sh", "-c", script, "sh"])
            .arg(path)
            .output()
            .expect("sandbox-exec runs");
        out.status.success()
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn the_agent_host_writes_only_its_places() {
    let d = Dirs::new("writes");
    let allowed = [
        d.ws.join("src.txt"),
        d.data.join("pi").join("session.jsonl"),
        d.data.join("agent-host").join("tmp").join("npx.txt"),
        d.data
            .join("sessions")
            .join("s1")
            .join("tmp")
            .join("spill.txt"),
        d.ws.join(".piarc")
            .join("worktrees")
            .join("w1")
            .join("file.txt"),
        // Pi locks its project settings to read them (proper-lockfile's directory).
        d.ws.join(".pi").join("settings.json.lock"),
    ];
    let refused = [
        d.home.join("escape.txt"),
        d.root.join("beside.txt"),
        d.data.join("settings.json"),
        d.data.join("core.sqlite"),
        d.data.join("secrets.vault"),
        d.data.join("skills").join("planted.md"),
        d.data.join("sessions").join("s1").join("blobs").join("x"),
        d.ws.join(".git").join("hooks").join("pre-commit"),
        d.ws.join(".pi").join("settings.json"),
        d.ws.join(".piarc").join("settings.json"),
        d.ws.join(".piarc")
            .join("worktrees")
            .join("w1")
            .join(".vscode")
            .join("tasks.json"),
    ];
    for path in &allowed {
        assert!(d.writes(path), "should write {}", path.display());
    }
    for path in &refused {
        assert!(!d.writes(path), "should not write {}", path.display());
    }
    assert_eq!(
        std::fs::read_to_string(d.data.join("settings.json")).expect("settings"),
        "{}\n",
        "the user's settings are unchanged"
    );
    println!(
        "T39-A09 profile: {} places written, {} refused",
        allowed.len(),
        refused.len()
    );
}

/// THR-03 (R5): the parts of Pi's agent directory that make code run are not the Agent Host's
/// to write. Pi loads every file under `<pi>/extensions` and the `extensions` of
/// `<pi>/settings.json` into the Agent Host; Core reads user skills and commands (with their
/// `allowed-tools` and hooks, which need no trust) from `<pi>/skills` and `<pi>/prompts`, and
/// confirmed packages from `<pi>/npm` and `<pi>/git`. A child of the Agent Host (an MCP server,
/// npx) writing there would run in the Agent Host or in Core on the next session.
#[test]
fn thr03_the_agent_host_cannot_plant_code_in_pis_directory() {
    let d = Dirs::new("pi code");
    let pi = d.data.join("pi");
    for dir in [
        "extensions",
        "skills/planted",
        "prompts",
        "npm",
        "git",
        "sessions/w",
    ] {
        std::fs::create_dir_all(pi.join(dir)).expect("pi directory");
    }
    std::fs::write(pi.join("settings.json"), "{}\n").expect("pi settings");
    let allowed = [
        pi.join("sessions").join("w").join("session.jsonl"),
        // Pi locks its global settings to read them.
        pi.join("settings.json.lock"),
    ];
    let refused = [
        pi.join("extensions").join("planted.js"),
        pi.join("skills").join("planted").join("SKILL.md"),
        pi.join("prompts").join("planted.md"),
        pi.join("npm").join("package.json"),
        pi.join("git").join("planted.js"),
        pi.join("settings.json"),
        pi.join("models.json"),
    ];
    for path in &allowed {
        assert!(d.writes(path), "should write {}", path.display());
    }
    for path in &refused {
        assert!(!d.writes(path), "should not write {}", path.display());
    }
    // Nor can the directories be created when they are missing.
    std::fs::remove_dir_all(pi.join("extensions")).expect("remove");
    assert!(
        !d.writes(&pi.join("extensions").join("x.js")),
        "created <pi>/extensions"
    );
    assert!(
        !pi.join("extensions").exists(),
        "<pi>/extensions was created"
    );
}

#[test]
fn reads_stay_open() {
    let d = Dirs::new("reads");
    std::fs::write(d.home.join("notes.txt"), "readable\n").expect("notes");
    let launch = piarc_sandbox::agent_host_launch(&d.ws, &d.data).expect("profile");
    let out = Command::new(&launch.program)
        .args(&launch.args)
        .args(["/bin/cat"])
        .arg(d.home.join("notes.txt"))
        .output()
        .expect("sandbox-exec runs");
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "readable\n");
}
