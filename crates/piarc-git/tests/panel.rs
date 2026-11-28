//! Git panel read-only queries against real git (ADR-0084, ADR-0085): scopes and diffs,
//! status, base inference, branches, commits, file texts, and the guarantee that no query runs
//! a program the repository or the user's configuration names. Paths contain spaces and
//! Chinese.

mod support;

use std::path::Path;

use piarc_git::{Cancel, ExecOptions, Git, GitError, diff, log, refs, status};
use piarc_protocol::git::{GitFileStatus, GitRepoState, GitScope, GitTextSource};
use support::{git, home, reader, repository, temp_dir};

async fn changes(home: &Path, repo: &Path, scope: GitScope) -> piarc_protocol::git::GitChanges {
    let reader = reader(home, repo).await;
    let range = diff::resolve_range(&reader, &scope, None)
        .await
        .expect("range");
    diff::changes(&reader, range, false).await.expect("changes")
}

#[tokio::test]
async fn uncommitted_scope_lists_every_kind_of_change() {
    let root = temp_dir("kinds");
    let home = home(&root);
    let repo = repository(&root, "repo 仓库");
    std::fs::write(repo.join("gone.txt"), "bye\n").expect("gone");
    std::fs::write(
        repo.join("old name.rs"),
        "fn a() {}\nfn b() {}\nfn c() {}\n",
    )
    .expect("old");
    std::fs::write(repo.join("img.bin"), [0_u8, 1, 2, 3]).expect("bin");
    std::fs::write(repo.join("run.sh"), "echo hi\n").expect("run");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "more"]);

    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nfour").expect("modify");
    std::fs::remove_file(repo.join("gone.txt")).expect("delete");
    git(&repo, &["mv", "old name.rs", "新 名字.rs"]);
    std::fs::write(repo.join("img.bin"), [9_u8, 0, 9]).expect("bin change");
    std::fs::write(repo.join("staged.md"), "# hi\n").expect("staged");
    git(&repo, &["add", "staged.md"]);
    std::fs::create_dir_all(repo.join("目录 dir")).expect("dir");
    std::fs::write(repo.join("目录 dir/未跟踪 file.txt"), "a\nb\n").expect("untracked");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.join("run.sh"), std::fs::Permissions::from_mode(0o755))
            .expect("chmod");
    }

    let view = changes(&home, &repo, GitScope::Uncommitted).await;
    assert_eq!(view.scope, GitScope::Uncommitted);
    let by_path = |p: &str| {
        view.files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} missing from {:?}", view.files))
    };
    let a = by_path("a.txt");
    assert_eq!(a.status, GitFileStatus::Modified);
    assert_eq!((a.added, a.removed), (Some(2), Some(1)));
    let hunks = &a.diff.as_ref().expect("diff").hunks;
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].lines.last().and_then(|l| l.no_newline), Some(true));
    assert_eq!(by_path("gone.txt").status, GitFileStatus::Deleted);
    let renamed = by_path("新 名字.rs");
    assert_eq!(renamed.status, GitFileStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("old name.rs"));
    let binary = by_path("img.bin");
    assert_eq!(binary.binary, Some(true));
    assert!(binary.diff.is_none());
    assert_eq!(by_path("staged.md").status, GitFileStatus::Added);
    let untracked = by_path("目录 dir/未跟踪 file.txt");
    assert_eq!(untracked.status, GitFileStatus::Untracked);
    assert_eq!(untracked.added, Some(2));
    assert_eq!(untracked.diff.as_ref().map(|d| d.hunks.len()), Some(1));
    #[cfg(unix)]
    {
        let mode = by_path("run.sh");
        assert_eq!(mode.new_mode.as_deref(), Some("100755"));
        assert_eq!(mode.diff.as_ref().map(|d| d.hunks.len()), Some(0));
    }
    assert!(view.withheld.is_none());
}

#[tokio::test]
async fn crlf_files_with_autocrlf_show_only_real_changes() {
    let root = temp_dir("crlf");
    let home = home(&root);
    let repo = repository(&root, "repo");
    git(&repo, &["config", "core.autocrlf", "true"]);
    std::fs::write(repo.join("win.txt"), "l1\r\nl2\r\nl3\r\n").expect("win");
    git(&repo, &["add", "win.txt"]);
    git(&repo, &["commit", "-q", "-m", "crlf"]);
    std::fs::write(repo.join("win.txt"), "l1\r\nL2\r\nl3\r\n").expect("edit");
    let view = changes(&home, &repo, GitScope::Uncommitted).await;
    let file = view
        .files
        .iter()
        .find(|f| f.path == "win.txt")
        .expect("win");
    assert_eq!((file.added, file.removed), (Some(1), Some(1)));
    let lines = &file.diff.as_ref().expect("diff").hunks[0].lines;
    assert!(lines.iter().all(|l| !l.text.ends_with('\r')));
}

#[tokio::test]
async fn branch_scope_compares_with_the_inferred_base() {
    let root = temp_dir("base");
    let home = home(&root);
    let remote = root.join("remote.git");
    git(
        &root,
        &["init", "-q", "--bare", remote.to_str().expect("utf8")],
    );
    let repo = repository(&root, "clone 克隆");
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().expect("utf8")],
    );
    git(&repo, &["push", "-q", "origin", "main"]);
    git(&repo, &["remote", "set-head", "origin", "main"]);
    git(&repo, &["switch", "-q", "-c", "feature/登录"]);
    std::fs::write(repo.join("b.txt"), "b\n").expect("b");
    git(&repo, &["add", "b.txt"]);
    git(&repo, &["commit", "-q", "-m", "feat: b"]);
    std::fs::write(repo.join("c.txt"), "c\n").expect("c");

    let view = changes(&home, &repo, GitScope::Branch { base: None }).await;
    let base = view.base.as_ref().expect("base");
    assert_eq!(base.name, "main");
    assert_eq!(base.reference, "refs/remotes/origin/main");
    let paths: Vec<&str> = view.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["b.txt", "c.txt"]);

    let reader = reader(&home, &repo).await;
    let listed = log::commits(&reader, Some(base.clone()))
        .await
        .expect("commits");
    assert_eq!(listed.total, 1);
    assert_eq!(listed.commits[0].subject, "feat: b");

    let commit = listed.commits[0].sha.clone();
    let one = changes(&home, &repo, GitScope::Commit { sha: commit }).await;
    let paths: Vec<&str> = one.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["b.txt"]);

    // An explicit base wins; one without common history answers as uncommitted.
    git(&repo, &["switch", "-q", "--orphan", "lonely"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "root"]);
    let lonely = changes(
        &home,
        &repo,
        GitScope::Branch {
            base: Some("main".into()),
        },
    )
    .await;
    assert_eq!(lonely.scope, GitScope::Uncommitted);
}

#[tokio::test]
async fn status_reports_branch_upstream_counts_and_merge_state() {
    let root = temp_dir("status");
    let home = home(&root);
    let remote = root.join("remote.git");
    git(
        &root,
        &["init", "-q", "--bare", remote.to_str().expect("utf8")],
    );
    let repo = repository(&root, "repo 仓库");
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().expect("utf8")],
    );
    git(&repo, &["push", "-q", "-u", "origin", "main"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("a");
    git(&repo, &["commit", "-q", "-am", "local"]);
    std::fs::write(repo.join("new.txt"), "x\ny\n").expect("new");

    let reader = reader(&home, &repo).await;
    let answer = status::status(&reader, None, None).await.expect("status");
    let repository = answer.repository.expect("repository");
    assert_eq!(repository.branch.as_deref(), Some("main"));
    assert_eq!(repository.upstream.as_deref(), Some("origin/main"));
    assert_eq!((repository.ahead, repository.behind), (1, 0));
    assert_eq!(repository.remotes, ["origin"]);
    assert_eq!(repository.state, GitRepoState::Clean);
    let new = answer
        .files
        .iter()
        .find(|f| f.path == "new.txt")
        .expect("new");
    assert_eq!(new.added, Some(2));

    // A conflicted merge lists the file first and reports the state.
    git(&repo, &["switch", "-q", "-c", "other", "HEAD~1"]);
    std::fs::write(repo.join("a.txt"), "other\n").expect("other");
    git(&repo, &["commit", "-q", "-am", "other"]);
    let merge = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "merge",
            "main",
        ])
        .current_dir(&repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("merge");
    assert!(!merge.status.success());
    let answer = status::status(&reader, None, None).await.expect("status");
    assert_eq!(answer.files[0].path, "a.txt");
    assert_eq!(answer.files[0].conflict.as_deref(), Some("UU"));
    assert!(matches!(
        answer.repository.expect("repo").state,
        GitRepoState::Merging { .. }
    ));
}

#[tokio::test]
async fn empty_repository_compares_with_the_empty_tree() {
    let root = temp_dir("empty");
    let home = home(&root);
    let repo = root.join("空 empty");
    std::fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("first.txt"), "1\n").expect("first");
    git(&repo, &["add", "first.txt"]);
    std::fs::write(repo.join("loose.txt"), "2\n").expect("loose");
    let view = changes(&home, &repo, GitScope::Branch { base: None }).await;
    assert_eq!(view.scope, GitScope::Uncommitted);
    let paths: Vec<&str> = view.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["first.txt", "loose.txt"]);
    let reader = reader(&home, &repo).await;
    let answer = status::status(&reader, None, None).await.expect("status");
    let repository = answer.repository.expect("repo");
    assert!(repository.head.is_none());
    assert!(repository.base.is_none());
}

#[tokio::test]
async fn branches_texts_and_recent_checkouts() {
    let root = temp_dir("branches");
    let home = home(&root);
    let repo = repository(&root, "repo");
    git(&repo, &["switch", "-q", "-c", "feature/a"]);
    git(&repo, &["switch", "-q", "-c", "fix/b"]);
    git(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("a.txt"), "changed\n").expect("a");
    git(&repo, &["add", "a.txt"]);
    std::fs::write(repo.join("a.txt"), "changed again\n").expect("a2");

    let reader = reader(&home, &repo).await;
    let listed = refs::branches(&reader).await.expect("branches");
    let names: Vec<&str> = listed.local.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["feature/a", "fix/b", "main"]);
    assert_eq!(listed.local[2].current, Some(true));
    assert_eq!(listed.recent, ["fix/b", "feature/a"]);

    let text = |source| {
        let reader = &reader;
        async move {
            log::file_text(reader, &source, "a.txt")
                .await
                .expect("text")
                .text
        }
    };
    let head = text(GitTextSource::Commit { rev: "HEAD".into() }).await;
    assert_eq!(head.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(
        text(GitTextSource::Index).await.as_deref(),
        Some("changed\n")
    );
    assert_eq!(
        text(GitTextSource::Worktree).await.as_deref(),
        Some("changed again\n")
    );
}

/// A repository whose configuration (local, included and global) names a marker-writing script
/// for every program-running key, with a signed `HEAD`; returns (home, repo, signed commit,
/// script dir, marker).
#[cfg(unix)]
fn evil_repository() -> (
    std::path::PathBuf,
    std::path::PathBuf,
    String,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_dir("thr15");
    let home = home(&root);
    let repo = repository(&root, "evil 仓库");

    // A commit carrying a signature header makes `log.showSignature` call `gpg.program`.
    let tree = git(&repo, &["write-tree"]);
    let parent = git(&repo, &["rev-parse", "HEAD"]);
    let object = format!(
        "tree {tree}\nparent {parent}\nauthor T <t@e.invalid> 1700000000 +0000\n\
committer T <t@e.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n \
-----END PGP SIGNATURE-----\n\nsigned\n"
    );
    let raw = root.join("commit.txt");
    std::fs::write(&raw, object).expect("commit");
    let signed = git(
        &repo,
        &[
            "hash-object",
            "-t",
            "commit",
            "-w",
            raw.to_str().expect("utf8"),
        ],
    );
    git(&repo, &["update-ref", "HEAD", &signed]);

    // The script lives where a shell does not split its path, so a run would leave the marker.
    let bin = std::env::temp_dir().join(format!("piarc-thr15-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&bin);
    std::fs::create_dir_all(&bin).expect("bin");
    let marker = bin.join("ran.txt");
    let script = bin.join("evil.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"$0 $*\" >> '{}'\ncat\n", marker.display()),
    )
    .expect("script");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let hooks = bin.join("hooks");
    std::fs::create_dir_all(&hooks).expect("hooks");
    for hook in [
        "post-index-change",
        "pre-commit",
        "post-checkout",
        "reference-transaction",
    ] {
        std::fs::copy(&script, hooks.join(hook)).expect("hook");
    }
    let s = script.display().to_string();
    let keys = format!(
        "[core]\n\tfsmonitor = {s}\n\thooksPath = {}\n\tpager = {s}\n\
[filter \"evil\"]\n\tclean = {s}\n\tsmudge = {s}\n\tprocess = {s}\n\trequired = true\n\
[diff \"evil\"]\n\ttextconv = {s}\n\tcommand = {s}\n\
[diff]\n\texternal = {s}\n\
[log]\n\tshowSignature = true\n[gpg]\n\tprogram = {s}\n",
        hooks.display()
    );
    let included = bin.join("included.cfg");
    std::fs::write(&included, &keys).expect("include");
    let config = repo.join(".git/config");
    let mut text = std::fs::read_to_string(&config).expect("config");
    text.push_str(&keys);
    text.push_str(&format!("[include]\n\tpath = {}\n", included.display()));
    std::fs::write(&config, text).expect("config");
    let mut global = std::fs::read_to_string(home.join(".gitconfig")).expect("global");
    global.push_str(&keys.replace("evil\"", "evilglobal\""));
    std::fs::write(home.join(".gitconfig"), global).expect("global");
    std::fs::write(repo.join(".gitattributes"), "* filter=evil diff=evil\n").expect("attrs");
    std::fs::write(repo.join("a.txt"), "edited\n").expect("edit");
    std::fs::write(repo.join("new.txt"), "new\n").expect("new");
    let _ = std::fs::remove_file(&marker);

    (home, repo, signed, bin, marker)
}

/// Every repository and global key that makes git run a program points at a script that
/// leaves a marker; no read-only query may leave one (THR-15).
#[cfg(unix)]
#[tokio::test]
async fn thr15_readonly_git_runs_no_repo_program() {
    let (home, repo, signed, bin, marker) = evil_repository();
    let reader = reader(&home, &repo).await;
    let answer = status::status(&reader, None, None).await.expect("status");
    assert!(answer.files.iter().any(|f| f.path == "a.txt"));
    for scope in [
        GitScope::Uncommitted,
        GitScope::Branch { base: None },
        GitScope::Commit {
            sha: signed.clone(),
        },
    ] {
        let range = diff::resolve_range(&reader, &scope, None)
            .await
            .expect("range");
        diff::changes(&reader, range.clone(), false)
            .await
            .expect("changes");
        diff::single(&reader, &range, "a.txt", None, true)
            .await
            .expect("single");
    }
    let base = answer.repository.and_then(|r| r.base);
    log::commits(&reader, base).await.expect("commits");
    refs::branches(&reader).await.expect("branches");
    for source in [
        GitTextSource::Commit { rev: "HEAD".into() },
        GitTextSource::Index,
        GitTextSource::Worktree,
    ] {
        log::file_text(&reader, &source, "a.txt")
            .await
            .expect("text");
    }
    let ran = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(ran.is_empty(), "a read-only query ran a program:\n{ran}");

    // Control: plain git with the same configuration does run them.
    let _ = std::process::Command::new("git")
        .args(["log", "-p", "-1"])
        .current_dir(&repo)
        .env("HOME", &home)
        .output();
    let control = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(!control.is_empty(), "the fixture's programs never ran");
    let _ = std::fs::remove_dir_all(&bin);
}

#[cfg(unix)]
#[tokio::test]
async fn exec_cuts_output_and_cancels() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    let root = temp_dir("exec");
    let slow = root.join("slow-git.sh");
    std::fs::write(&slow, "#!/bin/sh\nhead -c 4096 /dev/zero\nsleep 30\n").expect("slow");
    std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let git = Git::new(
        Arc::new(support::TokioSpawner),
        slow,
        support::inherited(&root),
    );

    let cancel = Cancel::new();
    let later = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        later.cancel();
    });
    let started = std::time::Instant::now();
    let result = git
        .exec(
            &root,
            &["status"],
            ExecOptions {
                cancel: Some(cancel),
                stdout_limit: Some(100),
                ..ExecOptions::default()
            },
        )
        .await;
    assert!(
        matches!(result, Err(GitError::Cancelled { .. })),
        "{result:?}"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(10));

    let quick = root.join("quick-git.sh");
    std::fs::write(&quick, "#!/bin/sh\nhead -c 4096 /dev/zero\n").expect("quick");
    std::fs::set_permissions(&quick, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let git = Git::new(
        Arc::new(support::TokioSpawner),
        quick,
        support::inherited(&root),
    );
    let out = git
        .exec(
            &root,
            &["status"],
            ExecOptions {
                stdout_limit: Some(100),
                ..ExecOptions::default()
            },
        )
        .await
        .expect("exec");
    assert!(out.truncated);
    assert_eq!(out.stdout.len(), 100);
}
