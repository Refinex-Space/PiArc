//! T35: PiArc's worktrees against real git: creation on a new branch from a chosen base,
//! `.worktreeinclude` copies, the `.gitignore` line, uncommitted changes, removal that keeps the
//! branch and refuses changes without force, restoring a removed worktree, and a subagent's
//! untouched branch. Paths contain spaces and Chinese.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use piarc_git::worktree::{self, WorktreeError};
use piarc_git::{Git, canonical};
use piarc_ports::{
    BoxFuture, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};

/// tokio's process, direct child only: the production spawner is `piarc-exec`'s.
struct TokioSpawner;

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

const NULL_CONFIG: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

fn test_env() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> =
        ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME"]
            .into_iter()
            .filter_map(|k| std::env::var_os(k).map(|v| (k.into(), v)))
            .collect();
    env.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
    env.push(("GIT_CONFIG_GLOBAL".into(), NULL_CONFIG.into()));
    env
}

fn runner() -> Git {
    let path = std::env::var_os("PATH").expect("PATH");
    let program = piarc_git::git::find_program(&path, None).expect("git on PATH");
    Git::new(Arc::new(TokioSpawner), program, test_env())
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piarc-git {name} 工作 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    canonical(&dir).expect("canonical")
}

fn git(dir: &Path, args: &[&str]) -> String {
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
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", NULL_CONFIG)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A repository with a `main` and a `release 版本` branch, ignored `.env` and `secrets/`, and a
/// `.worktreeinclude` listing `.env`, `secrets/` and `README.md` (tracked, so not copied).
fn repository(root: &Path) -> PathBuf {
    let repo = root.join("repo 仓库");
    std::fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("README.md"), "# 仓库\r\n").expect("readme");
    std::fs::write(repo.join(".gitignore"), ".env\nsecrets/\nbuild/\n").expect("ignore");
    std::fs::write(
        repo.join(".worktreeinclude"),
        ".env\nsecrets/\nREADME.md\nnotes.txt\n",
    )
    .expect("include");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "initial"]);
    git(&repo, &["branch", "release-1"]);
    std::fs::write(repo.join("later.txt"), "later\n").expect("later");
    git(&repo, &["add", "later.txt"]);
    git(&repo, &["commit", "-q", "-m", "later"]);
    std::fs::write(repo.join(".env"), "KEY=1\n").expect(".env");
    std::fs::create_dir_all(repo.join("secrets").join("深")).expect("secrets");
    std::fs::write(repo.join("secrets").join("深").join("a 文件.txt"), "s\n").expect("secret");
    std::fs::create_dir_all(repo.join("build")).expect("build");
    std::fs::write(repo.join("build").join("out.bin"), "x").expect("build file");
    // Listed but not ignored: stays out.
    std::fs::write(repo.join("notes.txt"), "n\n").expect("notes");
    repo
}

#[tokio::test]
async fn a_session_worktree_is_created_copied_inspected_and_removed() {
    let root = temp_dir("session");
    let repo = repository(&root);
    let git_runner = runner();

    let created = worktree::create(&git_runner, &repo, "feature-1", Some("release-1"))
        .await
        .expect("created");
    let path = created.worktree.path.clone();
    assert_eq!(
        path,
        repo.join(".piarc").join("worktrees").join("feature-1")
    );
    assert_eq!(created.worktree.branch, "piarc/feature-1");
    assert_eq!(
        created.worktree.base,
        git(&repo, &["rev-parse", "release-1"])
    );
    // `later.txt` came after the base.
    assert!(!path.join("later.txt").exists());
    assert_eq!(
        created.copied,
        vec![".env".to_owned(), "secrets/深/a 文件.txt".to_owned()]
    );
    assert!(path.join("secrets").join("深").join("a 文件.txt").is_file());
    assert!(!path.join("build").exists());
    assert!(!path.join("notes.txt").exists());
    assert!(
        !created.ignored,
        "the repository does not ignore .piarc/worktrees/ yet"
    );
    assert_eq!(
        worktree::head_branch(&path).as_deref(),
        Some("piarc/feature-1")
    );
    assert_eq!(worktree::head_branch(&repo).as_deref(), Some("main"));

    // Copied ignored files are not changes.
    assert!(
        worktree::changes(&git_runner, &path)
            .await
            .expect("status")
            .is_clean()
    );

    // The same name again.
    let again = worktree::create(&git_runner, &repo, "feature-1", None).await;
    assert!(
        matches!(again, Err(WorktreeError::Exists { .. })),
        "{again:?}"
    );
    let unknown = worktree::create(&git_runner, &repo, "x2", Some("no-such-branch")).await;
    assert!(
        matches!(unknown, Err(WorktreeError::UnknownBase { .. })),
        "{unknown:?}"
    );
    let sub = worktree::create(&git_runner, &path.join("secrets"), "x3", None).await;
    assert!(
        matches!(sub, Err(WorktreeError::NotTopLevel { .. })),
        "{sub:?}"
    );

    // The `.gitignore` line makes the next worktree ignored; the main checkout stays clean.
    assert!(worktree::add_ignore_line(&repo).expect("ignore line"));
    git(&repo, &["add", ".gitignore"]);
    git(&repo, &["commit", "-q", "-m", "ignore worktrees"]);
    let second = worktree::create(&git_runner, &repo, "second", None)
        .await
        .expect("second");
    assert!(second.ignored);
    // Only the fixture's untracked `notes.txt`: the worktrees are not listed.
    let main_changes = worktree::changes(&git_runner, &repo).await.expect("status");
    assert_eq!(main_changes.files, ["notes.txt"]);

    let mut branches = worktree::branches(&git_runner, &repo)
        .await
        .expect("branches");
    branches.sort();
    assert_eq!(
        branches,
        ["main", "piarc/feature-1", "piarc/second", "release-1"]
    );

    // Uncommitted changes: listed, and removal without force is refused and keeps everything.
    std::fs::write(path.join("README.md"), "changed\n").expect("edit");
    std::fs::write(path.join("新 文件.txt"), "new\n").expect("new");
    let changes = worktree::changes(&git_runner, &path).await.expect("status");
    assert_eq!(changes.total, 2);
    assert!(
        changes.files.contains(&"README.md".to_owned()),
        "{changes:?}"
    );
    assert!(
        changes.files.contains(&"新 文件.txt".to_owned()),
        "{changes:?}"
    );
    let refused = worktree::remove(&git_runner, &repo, &path, false).await;
    assert!(refused.is_err());
    assert!(path.join("新 文件.txt").is_file());

    // Clean again: removal deletes the directory and keeps the branch.
    std::fs::remove_file(path.join("新 文件.txt")).expect("rm");
    git(&path, &["checkout", "--", "README.md"]);
    worktree::remove(&git_runner, &repo, &path, false)
        .await
        .expect("removed");
    assert!(!path.exists());
    assert!(git(&repo, &["branch", "--list", "piarc/feature-1"]).contains("piarc/feature-1"));

    // Restoring brings it back on the same branch.
    worktree::restore(&git_runner, &repo, &path, "piarc/feature-1")
        .await
        .expect("restore");
    assert_eq!(
        worktree::head_branch(&path).as_deref(),
        Some("piarc/feature-1")
    );

    // Forced removal of a changed worktree (the user chose to discard).
    std::fs::write(path.join("README.md"), "discard me\n").expect("edit");
    worktree::remove(&git_runner, &repo, &path, true)
        .await
        .expect("forced");
    assert!(!path.exists());
    // A directory removed behind git's back is pruned.
    std::fs::remove_dir_all(&second.worktree.path).expect("rm second");
    worktree::remove(&git_runner, &repo, &second.worktree.path, false)
        .await
        .expect("pruned");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn an_untouched_agent_branch_is_deleted_and_a_moved_one_kept() {
    let root = temp_dir("agent");
    let repo = repository(&root);
    let git_runner = runner();
    let created = worktree::create(&git_runner, &repo, "agent-0a1b2c3d", None)
        .await
        .expect("created");
    let base = created.worktree.base.clone();
    assert_eq!(
        worktree::head(&git_runner, &created.worktree.path)
            .await
            .expect("head"),
        base
    );
    worktree::remove(&git_runner, &repo, &created.worktree.path, false)
        .await
        .expect("removed");
    assert!(
        worktree::delete_branch_at(&git_runner, &repo, "piarc/agent-0a1b2c3d", &base)
            .await
            .expect("delete")
    );
    assert!(git(&repo, &["branch", "--list", "piarc/agent-0a1b2c3d"]).is_empty());

    let kept = worktree::create(&git_runner, &repo, "agent-ffff0000", None)
        .await
        .expect("created");
    std::fs::write(kept.worktree.path.join("work.txt"), "w\n").expect("work");
    git(&kept.worktree.path, &["add", "work.txt"]);
    git(&kept.worktree.path, &["commit", "-q", "-m", "work"]);
    let moved = worktree::head(&git_runner, &kept.worktree.path)
        .await
        .expect("head");
    assert_ne!(moved, kept.worktree.base);
    assert!(
        !worktree::delete_branch_at(
            &git_runner,
            &repo,
            "piarc/agent-ffff0000",
            &kept.worktree.base
        )
        .await
        .expect("not deleted")
    );
    assert!(!git(&repo, &["branch", "--list", "piarc/agent-ffff0000"]).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}
