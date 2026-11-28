//! Git panel write operations against real git (ADR-0085): staging files and hunks with the
//! stale guard, commits that run the user's hooks, the three checkouts, deleting and restoring
//! branches, pushes that are rejected or leased, and pulls that stop on conflicts.

mod support;

use std::path::Path;

use piarc_git::branches::{self, CheckoutOutcome, DeleteOutcome};
use piarc_git::commit::{self, CommitOutcome};
use piarc_git::index::{self, HunkAction, HunkOutcome};
use piarc_git::remote::{self, PushSpec, RemoteOutcome, Sequencer};
use piarc_git::{Cancel, Reader, Writer};
use piarc_protocol::git::{GitCheckoutMode, GitHunkRef, GitPullMode, GitStage};
use support::{git, home, reader, repository, temp_dir, writer};

async fn pair(home: &Path, repo: &Path) -> (Reader, Writer) {
    (reader(home, repo).await, writer(home, repo).await)
}

fn hunk_ref(
    stages: &piarc_protocol::git::GitFileStages,
    stage: GitStage,
    index: usize,
) -> GitHunkRef {
    let hashes = match stage {
        GitStage::Staged => &stages.staged_hashes,
        GitStage::Unstaged => &stages.hunk_hashes,
    };
    GitHunkRef {
        path: stages.path.clone(),
        stage,
        index: index as u64,
        hash: hashes[index].clone(),
        worktree_hash: stages.worktree_hash.clone(),
        index_oid: stages.index_oid.clone(),
    }
}

#[tokio::test]
async fn hunks_stage_unstage_and_roll_back_only_when_fresh() {
    let root = temp_dir("hunks");
    let home = home(&root);
    let repo = repository(&root, "repo 仓库");
    let lines: Vec<String> = (1..=30).map(|n| format!("line {n}")).collect();
    std::fs::write(repo.join("a.txt"), lines.join("\n") + "\n").expect("a");
    git(&repo, &["commit", "-q", "-am", "thirty"]);
    let mut edited = lines.clone();
    edited[1] = "LINE 2".into();
    edited[25] = "LINE 26".into();
    std::fs::write(repo.join("a.txt"), edited.join("\n") + "\n").expect("edit");

    let (reader, writer) = pair(&home, &repo).await;
    let stages = index::file_stages(&reader, "a.txt").await.expect("stages");
    assert!(stages.hunk_actions);
    assert_eq!(stages.hunk_hashes.len(), 2);
    let first = hunk_ref(&stages, GitStage::Unstaged, 0);
    let applied = index::apply_hunk(&reader, &writer, &first, HunkAction::Stage)
        .await
        .expect("stage");
    assert_eq!(applied, HunkOutcome::Applied);
    let cached = git(&repo, &["diff", "--cached"]);
    assert!(
        cached.contains("+LINE 2") && !cached.contains("LINE 26"),
        "{cached}"
    );

    // Shown before the file changed: refused, nothing moves.
    let stale = index::file_stages(&reader, "a.txt").await.expect("stages");
    edited[14] = "LINE 15".into();
    std::fs::write(repo.join("a.txt"), edited.join("\n") + "\n").expect("touch");
    let again = hunk_ref(&stale, GitStage::Unstaged, 0);
    let refused = index::apply_hunk(&reader, &writer, &again, HunkAction::Stage)
        .await
        .expect("stale");
    assert_eq!(refused, HunkOutcome::Stale);
    assert_eq!(git(&repo, &["diff", "--cached"]), cached);

    let fresh = index::file_stages(&reader, "a.txt").await.expect("stages");
    let staged = hunk_ref(&fresh, GitStage::Staged, 0);
    let back = index::apply_hunk(&reader, &writer, &staged, HunkAction::Unstage)
        .await
        .expect("unstage");
    assert_eq!(back, HunkOutcome::Applied);
    assert!(git(&repo, &["diff", "--cached"]).is_empty());

    let fresh = index::file_stages(&reader, "a.txt").await.expect("stages");
    let last = fresh.hunk_hashes.len() - 1;
    let undo = hunk_ref(&fresh, GitStage::Unstaged, last);
    let rolled = index::apply_hunk(&reader, &writer, &undo, HunkAction::Rollback)
        .await
        .expect("rollback");
    assert_eq!(rolled, HunkOutcome::Applied);
    let text = std::fs::read_to_string(repo.join("a.txt")).expect("read");
    assert!(
        text.contains("LINE 2\n") && text.contains("LINE 15"),
        "{text}"
    );
    assert!(
        !text.contains("LINE 26") && text.contains("line 26"),
        "{text}"
    );
}

#[tokio::test]
async fn files_stage_and_unstage_including_new_and_deleted() {
    let root = temp_dir("files");
    let home = home(&root);
    let repo = repository(&root, "repo");
    std::fs::write(repo.join("新 文件.txt"), "x\n").expect("new");
    std::fs::remove_file(repo.join("a.txt")).expect("delete");
    let (reader, writer) = pair(&home, &repo).await;
    let paths = vec!["新 文件.txt".to_owned(), "a.txt".to_owned()];
    index::stage(&writer, &paths).await.expect("stage");
    let cached = git(&repo, &["diff", "--cached", "--name-status"]);
    assert!(
        cached.contains("D\ta.txt") && cached.contains("新 文件.txt"),
        "{cached}"
    );
    index::unstage(&writer, &paths, false)
        .await
        .expect("unstage");
    assert!(git(&repo, &["diff", "--cached", "--name-only"]).is_empty());
    assert!(commit::has_staged(&reader).await.is_ok_and(|s| !s));
}

#[cfg(unix)]
#[tokio::test]
async fn commits_run_hooks_and_report_identity() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_dir("commit");
    let home = home(&root);
    let repo = repository(&root, "repo");
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho checked > \"$(git rev-parse --show-toplevel)/hook-ran\"\n",
    )
    .expect("hook");
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    std::fs::write(repo.join("b.txt"), "b\n").expect("b");
    git(&repo, &["add", "b.txt"]);
    let (_, writer) = pair(&home, &repo).await;
    let done = commit::commit(&writer, "feat: b\n\nbody", false, false, Cancel::new())
        .await
        .expect("commit");
    assert!(matches!(&done, CommitOutcome::Committed { subject, .. } if subject == "feat: b"));
    assert!(repo.join("hook-ran").is_file());

    std::fs::write(&hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n").expect("hook");
    std::fs::write(repo.join("c.txt"), "c\n").expect("c");
    git(&repo, &["add", "c.txt"]);
    let refused = commit::commit(&writer, "feat: c", false, false, Cancel::new())
        .await
        .expect("commit");
    assert!(matches!(&refused, CommitOutcome::HookFailed(out) if out.contains("lint failed")));

    // Another git holding the index lock is not a hook failure, even with hooks installed.
    std::fs::write(repo.join(".git/index.lock"), "").expect("lock");
    let locked = commit::commit(&writer, "feat: c", false, false, Cancel::new())
        .await
        .expect("commit");
    assert!(matches!(&locked, CommitOutcome::Locked), "{locked:?}");
    std::fs::remove_file(repo.join(".git/index.lock")).expect("unlock");

    let anonymous = root.join("anonymous");
    std::fs::create_dir_all(&anonymous).expect("home");
    std::fs::write(
        anonymous.join(".gitconfig"),
        "[user]\n\tuseConfigOnly = true\n",
    )
    .expect("cfg");
    std::fs::remove_file(&hook).expect("rm hook");
    let (_, nobody) = pair(&anonymous, &repo).await;
    assert!(!commit::has_identity(&nobody).await.expect("ident"));
}

#[tokio::test]
async fn checkouts_refuse_stash_or_discard_local_changes() {
    let root = temp_dir("checkout");
    let home = home(&root);
    let repo = repository(&root, "repo");
    git(&repo, &["switch", "-q", "-c", "other"]);
    std::fs::write(repo.join("a.txt"), "other\n").expect("other");
    git(&repo, &["commit", "-q", "-am", "other"]);
    git(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("a.txt"), "mine\n").expect("mine");
    let (reader, writer) = pair(&home, &repo).await;

    let refused = branches::checkout(&reader, &writer, "other", GitCheckoutMode::Normal)
        .await
        .expect("checkout");
    assert_eq!(refused, CheckoutOutcome::LocalChanges(vec!["a.txt".into()]));

    let smart = branches::checkout(&reader, &writer, "other", GitCheckoutMode::Smart)
        .await
        .expect("smart");
    let CheckoutOutcome::Conflicts { stash, paths } = smart else {
        panic!("expected conflicts, got {smart:?}");
    };
    assert!(stash.contains("piarc: checkout main → other"), "{stash}");
    assert_eq!(paths, ["a.txt"]);
    assert!(git(&repo, &["stash", "list"]).contains("piarc: checkout"));

    git(&repo, &["reset", "-q", "--hard"]);
    git(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("a.txt"), "thrown away\n").expect("dirty");
    let forced = branches::checkout(&reader, &writer, "other", GitCheckoutMode::Force)
        .await
        .expect("force");
    assert_eq!(forced, CheckoutOutcome::Done);
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).expect("a"),
        "other\n"
    );
}

#[tokio::test]
async fn deleted_branches_restore_with_their_upstream() {
    let root = temp_dir("delete");
    let home = home(&root);
    let remote_dir = root.join("remote.git");
    git(
        &root,
        &["init", "-q", "--bare", remote_dir.to_str().expect("utf8")],
    );
    let repo = repository(&root, "repo");
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            remote_dir.to_str().expect("utf8"),
        ],
    );
    git(&repo, &["switch", "-q", "-c", "topic"]);
    std::fs::write(repo.join("t.txt"), "t\n").expect("t");
    git(&repo, &["add", "t.txt"]);
    git(&repo, &["commit", "-q", "-m", "topic"]);
    git(&repo, &["push", "-q", "-u", "origin", "topic"]);
    std::fs::write(repo.join("t.txt"), "t2\n").expect("t2");
    git(&repo, &["commit", "-q", "-am", "unpushed"]);
    let tip = git(&repo, &["rev-parse", "topic"]);
    git(&repo, &["switch", "-q", "main"]);
    let (reader, writer) = pair(&home, &repo).await;

    assert_eq!(
        branches::unmerged_count(&reader, "topic")
            .await
            .expect("count"),
        1
    );
    let refused = branches::delete(&reader, &writer, "topic", false)
        .await
        .expect("delete");
    assert_eq!(refused, DeleteOutcome::NotMerged);
    let DeleteOutcome::Deleted(deleted) = branches::delete(&reader, &writer, "topic", true)
        .await
        .expect("force")
    else {
        panic!("not deleted");
    };
    assert_eq!(deleted.oid, tip);
    assert_eq!(deleted.upstream.as_deref(), Some("origin/topic"));
    branches::restore(&writer, "topic", &deleted.oid, deleted.upstream.as_deref())
        .await
        .expect("restore");
    assert_eq!(git(&repo, &["rev-parse", "topic"]), tip);
    assert_eq!(
        git(&repo, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]),
        "origin/topic"
    );
}

#[tokio::test]
async fn pushes_are_rejected_leased_and_pulls_stop_on_conflicts() {
    let root = temp_dir("push");
    let home = home(&root);
    let remote_dir = root.join("remote.git");
    git(
        &root,
        &["init", "-q", "--bare", remote_dir.to_str().expect("utf8")],
    );
    let url = remote_dir.to_str().expect("utf8").to_owned();
    let repo = repository(&root, "mine");
    git(&repo, &["remote", "add", "origin", &url]);
    let (reader, writer) = pair(&home, &repo).await;
    let spec = |lease: Option<String>, set_upstream| PushSpec {
        remote: "origin".into(),
        branch: "main".into(),
        set_upstream,
        lease,
    };
    let first = remote::push(&writer, &spec(None, true), None, Cancel::new())
        .await
        .expect("push");
    assert!(matches!(first, RemoteOutcome::Done(_)), "{first:?}");

    let theirs = root.join("theirs");
    git(
        &root,
        &["clone", "-q", &url, theirs.to_str().expect("utf8")],
    );
    std::fs::write(theirs.join("a.txt"), "theirs\n").expect("theirs");
    git(&theirs, &["commit", "-q", "-am", "theirs"]);
    git(&theirs, &["push", "-q", "origin", "main"]);

    std::fs::write(repo.join("a.txt"), "mine\n").expect("mine");
    git(&repo, &["commit", "-q", "-am", "mine"]);
    let rejected = remote::push(&writer, &spec(None, false), None, Cancel::new())
        .await
        .expect("push");
    assert!(
        matches!(rejected, RemoteOutcome::Rejected(_)),
        "{rejected:?}"
    );

    // The lease names the remote-tracking commit from before their push: refused.
    let stale_lease = git(&repo, &["rev-parse", "origin/main"]);
    let leased = remote::push(
        &writer,
        &spec(Some(stale_lease), false),
        None,
        Cancel::new(),
    )
    .await
    .expect("push");
    assert!(matches!(leased, RemoteOutcome::StaleLease(_)), "{leased:?}");

    let pulled = remote::pull(&reader, &writer, GitPullMode::Merge, None, Cancel::new())
        .await
        .expect("pull");
    assert_eq!(pulled, RemoteOutcome::Conflict(vec!["a.txt".into()]));
    std::fs::write(repo.join("a.txt"), "both\n").expect("resolve");
    index::mark_resolved(&writer, &["a.txt".to_owned()])
        .await
        .expect("resolved");
    let continued = remote::sequence(&reader, &writer, Sequencer::Continue)
        .await
        .expect("continue");
    assert!(matches!(continued, RemoteOutcome::Done(_)), "{continued:?}");
    let pushed = remote::push(&writer, &spec(None, false), None, Cancel::new())
        .await
        .expect("push");
    assert!(matches!(pushed, RemoteOutcome::Done(_)), "{pushed:?}");

    // A lease on the current remote commit replaces it.
    git(&repo, &["commit", "-q", "--amend", "-m", "rewritten"]);
    let current = git(&repo, &["rev-parse", "origin/main"]);
    let forced = remote::push(&writer, &spec(Some(current), false), None, Cancel::new())
        .await
        .expect("force");
    assert!(matches!(forced, RemoteOutcome::Done(_)), "{forced:?}");
    let remote_head = git(&remote_dir, &["rev-parse", "main"]);
    assert_eq!(remote_head, git(&repo, &["rev-parse", "HEAD"]));
}
