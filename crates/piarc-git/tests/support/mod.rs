//! Shared fixtures of the Git panel tests: a tokio spawner (feature crates cannot depend on
//! `piarc-exec`), throwaway repositories whose paths contain spaces and Chinese, a temporary
//! home for the user's global configuration, and the panel's read and write runners.

#![allow(dead_code, reason = "each test file uses a different part of the fixtures")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use piarc_git::{Git, Reader, Writer, canonical};
use piarc_ports::{
    BoxFuture, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};

pub struct TokioSpawner;

struct Child(tokio::process::Child);

impl ProcessControl for Child {
    fn pid(&self) -> Option<u32> {
        self.0.id()
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.0.start_kill()
    }

    fn wait(&mut self) -> BoxFuture<'_, std::io::Result<ExitStatus>> {
        Box::pin(async move {
            let status = self.0.wait().await?;
            #[cfg(unix)]
            let signal = std::os::unix::process::ExitStatusExt::signal(&status);
            #[cfg(not(unix))]
            let signal = None;
            Ok(ExitStatus {
                code: status.code(),
                signal,
            })
        })
    }
}

impl ProcessSpawner for TokioSpawner {
    fn spawn(&self, spec: SpawnSpec) -> std::io::Result<SpawnedProcess> {
        let mut child = tokio::process::Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(std::io::Error::other("missing pipe"));
        };
        Ok(SpawnedProcess {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            control: Box::new(Child(child)),
        })
    }
}

/// A fresh directory under the system temporary directory.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "piarc-git-panel {name} 工作 {}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    canonical(&dir).expect("canonical")
}

/// The variables a test's git sees as "inherited": the machine's PATH and temp dirs, and
/// `HOME` pointing at `home` (its `.gitconfig` is the user's global configuration).
pub fn inherited(home: &Path) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
        .into_iter()
        .filter_map(|k| std::env::var_os(k).map(|v| (k.into(), v)))
        .collect();
    env.push(("HOME".into(), home.into()));
    env.push(("USERPROFILE".into(), home.into()));
    env
}

fn program() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH");
    piarc_git::git::find_program(&path, None).expect("git on PATH")
}

/// The panel's read-only runner for a test home.
pub fn read_git(home: &Path) -> Git {
    Git::new(
        Arc::new(TokioSpawner),
        program(),
        piarc_git::env::readonly_env(&inherited(home), &[]),
    )
}

/// The panel's user-mode runner for a test home.
pub fn user_git(home: &Path) -> Git {
    Git::new(
        Arc::new(TokioSpawner),
        program(),
        piarc_git::env::user_env(&inherited(home), &[]),
    )
}

pub async fn reader(home: &Path, repo: &Path) -> Reader {
    Reader::open(read_git(home), repo)
        .await
        .expect("open")
        .expect("a repository")
}

pub async fn writer(home: &Path, repo: &Path) -> Writer {
    let reader = reader(home, repo).await;
    Writer::new(user_git(home), reader.repo)
}

/// Runs the system git in `dir` with a fixed identity and no machine configuration.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=PiArc Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "core.quotePath=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A home whose `.gitconfig` sets the test identity.
pub fn home(root: &Path) -> PathBuf {
    let home = root.join("home 主目录");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = PiArc Test\n\temail = test@example.invalid\n\
[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n\
[protocol \"file\"]\n\tallow = always\n",
    )
    .expect("gitconfig");
    home
}

/// An initialized repository at `root/<name>` with one commit of `a.txt`.
pub fn repository(root: &Path, name: &str) -> PathBuf {
    let repo = root.join(name);
    std::fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").expect("a");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "initial"]);
    repo
}
