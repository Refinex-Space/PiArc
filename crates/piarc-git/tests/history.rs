//! G3 against real git: history pages with parents and references, filters, commit details,
//! tags, cherry-picks and reverts (with conflicts), resets, stashes, remote branch deletion and
//! restore, and file bytes for image diffs.

mod support;

use std::path::Path;

use piarc_git::remote::RemoteOutcome;
use piarc_git::stash::{self, ApplyOutcome};
use piarc_git::{Cancel, Reader, Writer, history, log};
use piarc_protocol::git::{GitLogRevs, GitRefKind, GitResetMode, GitTextSource};
use support::{git, home, reader, repository, temp_dir, writer};

async fn pair(home: &Path, repo: &Path) -> (Reader, Writer) {
    (reader(home, repo).await, writer(home, repo).await)
}

fn commit_file(repo: &Path, name: &str, text: &str, message: &str) -> String {
    std::fs::write(repo.join(name), text).expect("write");
    git(repo, &["add", "--", name]);
    git(repo, &["commit", "-q", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

/// main: initial → fix → merge of feature/x (one commit), tagged v1.0.
struct Branched {
    home: std::path::PathBuf,
    repo: std::path::PathBuf,
    base: String,
    side: String,
    merge: String,
}

fn branched(name: &str) -> Branched {
    let root = temp_dir(name);
    let home = home(&root);
    let repo = repository(&root, "repo 仓库");
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["switch", "-q", "-c", "feature/x"]);
    let side = commit_file(&repo, "b.txt", "b\n", "feat: 侧边分支");
    git(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "c.txt", "c\n", "fix: main work");
    git(
        &repo,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Merge feature/x",
            "feature/x",
        ],
    );
    git(&repo, &["tag", "v1.0"]);
    let merge = git(&repo, &["rev-parse", "HEAD"]);

    Branched {
        home,
        repo,
        base,
        side,
        merge,
    }
}

#[tokio::test]
async fn pages_carry_parents_and_references() {
    let Branched {
        home,
        repo,
        base,
        merge,
        ..
    } = branched("history-log");
    let reader = reader(&home, &repo).await;
    let page = history::log(&reader, &GitLogRevs::Head, 0, 200, None, None)
        .await
        .expect("log");
    assert!(!page.more);
    assert_eq!(page.commits.len(), 4);
    assert_eq!(page.commits[0].sha, merge);
    assert_eq!(page.commits[0].parents.len(), 2);
    assert!(
        page.commits[0]
            .refs
            .iter()
            .any(|r| r.kind == GitRefKind::Local && r.name == "main" && r.current == Some(true))
    );
    assert!(
        page.commits[0]
            .refs
            .iter()
            .any(|r| r.kind == GitRefKind::Tag && r.name == "v1.0")
    );
    assert_eq!(
        page.commits.last().map(|c| c.sha.as_str()),
        Some(base.as_str())
    );

    // Paging: two at a time, the second page continues where the first stopped.
    let first = history::log(&reader, &GitLogRevs::Head, 0, 2, None, None)
        .await
        .expect("first");
    assert!(first.more);
    let second = history::log(&reader, &GitLogRevs::Head, 2, 2, None, None)
        .await
        .expect("second");
    assert!(!second.more);
    let ids: Vec<&str> = first
        .commits
        .iter()
        .chain(&second.commits)
        .map(|c| c.sha.as_str())
        .collect();
    let all: Vec<&str> = page.commits.iter().map(|c| c.sha.as_str()).collect();
    assert_eq!(ids, all);
}

#[tokio::test]
async fn filters_branches_and_details() {
    let Branched {
        home,
        repo,
        base,
        side,
        ..
    } = branched("history-filter");
    let reader = reader(&home, &repo).await;
    // Message text in any case, and an id prefix.
    let found = history::log(&reader, &GitLogRevs::Head, 0, 200, Some("侧边"), None)
        .await
        .expect("text");
    assert_eq!(found.commits.len(), 1);
    assert_eq!(found.commits[0].sha, side);
    let found = history::log(&reader, &GitLogRevs::Head, 0, 200, Some("MAIN WORK"), None)
        .await
        .expect("case");
    assert_eq!(found.commits.len(), 1);
    let found = history::log(&reader, &GitLogRevs::Head, 0, 200, Some(&base[..8]), None)
        .await
        .expect("prefix");
    assert_eq!(found.commits[0].sha, base);
    // A pattern is literal: regex syntax matches nothing.
    let found = history::log(&reader, &GitLogRevs::Head, 0, 200, Some("fix.*"), None)
        .await
        .expect("literal");
    assert!(found.commits.is_empty());

    // One branch's history.
    let branch = history::log(
        &reader,
        &GitLogRevs::Ref {
            name: "feature/x".into(),
        },
        0,
        200,
        None,
        None,
    )
    .await
    .expect("branch");
    assert_eq!(branch.commits.len(), 2);

    let detail = history::commit_detail(&reader, &side)
        .await
        .expect("detail")
        .expect("found");
    assert_eq!(detail.message, "feat: 侧边分支");
    assert!(detail.in_head);
    assert!(!detail.pushed);
    assert_eq!(detail.parents, std::slice::from_ref(&base));
    assert!(
        history::commit_detail(&reader, &"f".repeat(40))
            .await
            .expect("missing")
            .is_none()
    );
}

#[tokio::test]
async fn picks_reverts_tags_and_resets() {
    let root = temp_dir("history-ops");
    let home = home(&root);
    let repo = repository(&root, "repo");
    git(&repo, &["switch", "-q", "-c", "other"]);
    let clean = commit_file(&repo, "new.txt", "new\n", "add new");
    let clash = commit_file(&repo, "a.txt", "other side\n", "change a");
    git(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "a.txt", "main side\n", "change a on main");
    let (reader, writer) = pair(&home, &repo).await;

    assert!(matches!(
        history::pick(&reader, &writer, &clean, false)
            .await
            .expect("pick"),
        RemoteOutcome::Done(_)
    ));
    assert!(repo.join("new.txt").exists());
    // Picking it again changes nothing: refused, and no pick is left in progress.
    assert!(matches!(
        history::pick(&reader, &writer, &clean, false)
            .await
            .expect("again"),
        RemoteOutcome::Failed(_)
    ));
    assert!(!repo.join(".git/CHERRY_PICK_HEAD").exists());

    match history::pick(&reader, &writer, &clash, false)
        .await
        .expect("clash")
    {
        RemoteOutcome::Conflict(paths) => assert_eq!(paths, ["a.txt"]),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert!(repo.join(".git/CHERRY_PICK_HEAD").exists());
    git(&repo, &["cherry-pick", "--abort"]);

    // HEAD is the picked commit that added `new.txt`: reverting it removes the file.
    let head = git(&repo, &["rev-parse", "HEAD"]);
    assert!(matches!(
        history::pick(&reader, &writer, &head, true)
            .await
            .expect("revert"),
        RemoteOutcome::Done(_)
    ));
    assert!(!repo.join("new.txt").exists());

    history::create_tag(&writer, "v1", &head, None)
        .await
        .expect("tag");
    history::create_tag(&writer, "v2", &head, Some("第二版\n"))
        .await
        .expect("annotated");
    assert_eq!(git(&repo, &["cat-file", "-t", "v2"]), "tag");
    assert!(
        history::create_tag(&writer, "v1", &head, None)
            .await
            .is_err()
    );

    // A hard reset to the commit before the revert; soft keeps the revert staged.
    let reverted = git(&repo, &["rev-parse", "HEAD"]);
    let (leaving, pushed) = history::leaving(&reader, &head).await.expect("leaving");
    assert_eq!((leaving, pushed), (1, 0));
    history::reset(&writer, &head, GitResetMode::Soft)
        .await
        .expect("soft");
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "new.txt");
    git(&repo, &["reset", "-q", "--hard", &reverted]);
    std::fs::write(repo.join("new.txt"), "untracked in the way\n").expect("untracked");
    // `keep` refuses to lose the untracked file the reset would overwrite.
    assert!(
        history::reset(&writer, &head, GitResetMode::Keep)
            .await
            .is_err()
    );
    std::fs::write(repo.join("a.txt"), "local edit\n").expect("edit");
    history::reset(&writer, &head, GitResetMode::Hard)
        .await
        .expect("hard");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).expect("a"),
        "main side\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).expect("new"),
        "new\n"
    );
}

#[tokio::test]
async fn reset_counts_pushed_commits() {
    let root = temp_dir("history-pushed");
    let home = home(&root);
    let remote = root.join("remote.git");
    git(
        &root,
        &["init", "-q", "--bare", remote.to_str().expect("utf-8")],
    );
    let repo = repository(&root, "repo");
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().expect("utf-8")],
    );
    commit_file(&repo, "b.txt", "b\n", "pushed one");
    git(&repo, &["push", "-q", "-u", "origin", "main"]);
    commit_file(&repo, "c.txt", "c\n", "local one");
    let reader = reader(&home, &repo).await;
    assert_eq!(
        history::leaving(&reader, &base).await.expect("leaving"),
        (2, 1)
    );
    let detail = history::commit_detail(&reader, &base)
        .await
        .expect("detail")
        .expect("found");
    assert!(detail.pushed);
}

#[tokio::test]
async fn stashes_push_apply_pop_branch_and_drop() {
    let root = temp_dir("history-stash");
    let home = home(&root);
    let repo = repository(&root, "repo");
    let (reader, writer) = pair(&home, &repo).await;
    assert!(
        !stash::push(&writer, None, false)
            .await
            .expect("nothing to stash")
    );
    std::fs::write(repo.join("a.txt"), "stashed edit\n").expect("edit");
    std::fs::write(repo.join("untracked.txt"), "u\n").expect("untracked");
    assert!(
        stash::push(&writer, Some("半成品"), true)
            .await
            .expect("push")
    );
    assert!(!repo.join("untracked.txt").exists());
    let list = stash::list(&reader).await.expect("list");
    assert_eq!(list.entries.len(), 1);
    assert_eq!(list.entries[0].message, "半成品");
    assert_eq!(list.entries[0].branch.as_deref(), Some("main"));
    assert_eq!(
        stash::oid_at(&reader, 0).await.expect("oid").as_deref(),
        Some(list.entries[0].oid.as_str())
    );
    assert!(stash::oid_at(&reader, 1).await.expect("none").is_none());

    assert_eq!(
        stash::apply(&reader, &writer, 0, false)
            .await
            .expect("apply"),
        ApplyOutcome::Done
    );
    assert_eq!(stash::list(&reader).await.expect("kept").entries.len(), 1);
    // Applying again over the same change conflicts with the local edit: refused.
    assert!(matches!(
        stash::apply(&reader, &writer, 0, true)
            .await
            .expect("refused"),
        ApplyOutcome::Failed(_)
    ));
    git(&repo, &["reset", "-q", "--hard"]);
    git(&repo, &["clean", "-q", "-fd"]);
    commit_file(&repo, "a.txt", "committed meanwhile\n", "clash");
    match stash::apply(&reader, &writer, 0, true)
        .await
        .expect("conflict")
    {
        ApplyOutcome::Conflict(paths) => assert_eq!(paths, ["a.txt"]),
        other => panic!("expected a conflict, got {other:?}"),
    }
    // The pop stopped: git kept the stash.
    assert_eq!(stash::list(&reader).await.expect("kept").entries.len(), 1);
    git(&repo, &["reset", "-q", "--hard"]);
    git(&repo, &["clean", "-q", "-fd"]);

    assert!(matches!(
        stash::branch(&reader, &writer, 0, "from-stash")
            .await
            .expect("branch"),
        RemoteOutcome::Done(_)
    ));
    assert_eq!(git(&repo, &["branch", "--show-current"]), "from-stash");
    assert!(
        stash::list(&reader)
            .await
            .expect("dropped")
            .entries
            .is_empty()
    );

    std::fs::write(repo.join("a.txt"), "again\n").expect("edit");
    stash::push(&writer, None, false).await.expect("push");
    stash::drop(&writer, 0).await.expect("drop");
    assert!(
        stash::list(&reader)
            .await
            .expect("empty")
            .entries
            .is_empty()
    );
}

#[tokio::test]
async fn remote_branches_are_deleted_under_a_lease_and_restored() {
    let root = temp_dir("history-remote");
    let home = home(&root);
    let remote = root.join("remote 远端.git");
    git(
        &root,
        &["init", "-q", "--bare", remote.to_str().expect("utf-8")],
    );
    let repo = repository(&root, "repo");
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().expect("utf-8")],
    );
    git(&repo, &["push", "-q", "origin", "main", "main:topic"]);
    git(&repo, &["fetch", "-q", "origin"]);
    let oid = git(&repo, &["rev-parse", "origin/topic"]);
    let writer = writer(&home, &repo).await;

    // A lease naming another commit refuses.
    let stale = remote::delete(&writer, &"0".repeat(40)).await;
    assert!(matches!(stale, RemoteOutcome::StaleLease(_)), "{stale:?}");
    assert!(remote_has(&remote, "topic"));
    let done = remote::delete(&writer, &oid).await;
    assert!(matches!(done, RemoteOutcome::Done(_)), "{done:?}");
    assert!(!remote_has(&remote, "topic"));

    let restored =
        piarc_git::remote::restore_branch(&writer, "origin", "topic", &oid, Cancel::new())
            .await
            .expect("restore");
    assert!(matches!(restored, RemoteOutcome::Done(_)), "{restored:?}");
    assert!(remote_has(&remote, "topic"));
}

fn remote_has(remote: &Path, branch: &str) -> bool {
    std::process::Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(remote)
        .status()
        .expect("git")
        .success()
}

mod remote {
    use piarc_git::remote::RemoteOutcome;
    use piarc_git::{Cancel, Writer};

    pub async fn delete(writer: &Writer, expect: &str) -> RemoteOutcome {
        piarc_git::remote::delete_branch(writer, "origin", "topic", Some(expect), Cancel::new())
            .await
            .expect("delete")
    }
}

#[tokio::test]
async fn image_bytes_come_from_every_source() {
    let root = temp_dir("history-blob");
    let home = home(&root);
    let repo = repository(&root, "repo");
    let png = [0x89, b'P', b'N', b'G', 0, 1, 2, 3];
    std::fs::write(repo.join("logo.png"), png).expect("png");
    git(&repo, &["add", "logo.png"]);
    git(&repo, &["commit", "-q", "-m", "logo"]);
    std::fs::write(repo.join("logo.png"), [1, 2, 3]).expect("edit");
    let reader = reader(&home, &repo).await;
    let head = log::file_blob(
        &reader,
        &GitTextSource::Commit { rev: "HEAD".into() },
        "logo.png",
    )
    .await
    .expect("head");
    assert_eq!(head.size, 8);
    assert_eq!(head.data.as_deref(), Some("iVBORwABAgM="));
    let disk = log::file_blob(&reader, &GitTextSource::Worktree, "logo.png")
        .await
        .expect("disk");
    assert_eq!(disk.data.as_deref(), Some("AQID"));
    let missing = log::file_blob(&reader, &GitTextSource::Index, "absent.png")
        .await
        .expect("missing");
    assert_eq!((missing.size, missing.data), (0, None));
}
