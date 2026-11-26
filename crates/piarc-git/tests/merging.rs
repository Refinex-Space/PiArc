//! G4 against real git: the three merge modes and a merge conflict, a rebase conflict whose
//! sides are swapped for the user, taking a side (a deletion included), and interactive rebases
//! that reorder, reword, squash, fix up and drop commits.

mod support;

use std::path::Path;

use piarc_git::merge::{self, swapped};
use piarc_git::remote::RemoteOutcome;
use piarc_git::{Reader, Writer, status};
use piarc_protocol::git::{GitMergeMode, GitRebaseAction, GitRebaseStep, GitSide};
use support::{git, home, reader, repository, temp_dir, writer};

async fn pair(home: &Path, repo: &Path) -> (Reader, Writer) {
    (reader(home, repo).await, writer(home, repo).await)
}

fn commit(repo: &Path, name: &str, text: &str, message: &str) -> String {
    std::fs::write(repo.join(name), text).expect("write");
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

/// main and `topic` both change `a.txt` (a conflict) after the initial commit.
fn diverged(repo: &Path) {
    git(repo, &["switch", "-q", "-c", "topic"]);
    commit(repo, "a.txt", "topic line\n", "topic: change a");
    git(repo, &["switch", "-q", "main"]);
    commit(repo, "a.txt", "main line\n", "main: change a");
}

#[tokio::test]
async fn merges_fast_forward_create_a_commit_or_squash() {
    let root = temp_dir("merge-modes");
    let home = home(&root);
    let repo = repository(&root, "repo 仓库");
    git(&repo, &["switch", "-q", "-c", "topic"]);
    let tip = commit(&repo, "b.txt", "b\n", "topic: add b");
    git(&repo, &["switch", "-q", "main"]);
    let (reader, writer) = pair(&home, &repo).await;

    git(&repo, &["switch", "-q", "-c", "ff"]);
    let done = merge::merge(&reader, &writer, "topic", GitMergeMode::Ff)
        .await
        .expect("ff");
    assert!(matches!(done, RemoteOutcome::Done(_)), "{done:?}");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), tip);

    git(&repo, &["switch", "-q", "-c", "no-ff", "main"]);
    merge::merge(&reader, &writer, "topic", GitMergeMode::NoFf)
        .await
        .expect("no-ff");
    assert_eq!(
        git(&repo, &["rev-list", "--count", "--merges", "HEAD"]),
        "1"
    );

    git(&repo, &["switch", "-q", "-c", "squash", "main"]);
    merge::merge(&reader, &writer, "topic", GitMergeMode::Squash)
        .await
        .expect("squash");
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "b.txt");
    assert_eq!(
        git(&repo, &["rev-parse", "HEAD"]),
        git(&repo, &["rev-parse", "main"])
    );
}

#[tokio::test]
async fn a_merge_conflict_is_resolved_by_taking_a_side() {
    let root = temp_dir("merge-conflict");
    let home = home(&root);
    let repo = repository(&root, "repo");
    diverged(&repo);
    let (reader, writer) = pair(&home, &repo).await;
    match merge::merge(&reader, &writer, "topic", GitMergeMode::Ff)
        .await
        .expect("merge")
    {
        RemoteOutcome::Conflict(paths) => assert_eq!(paths, ["a.txt"]),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert!(!swapped(&status::repo_state(&reader.repo)));
    let sides = merge::conflict_sides(&reader, "a.txt", "main".into(), "topic".into())
        .await
        .expect("sides");
    assert_eq!(sides.base.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(sides.yours.as_deref(), Some("main line\n"));
    assert_eq!(sides.theirs.as_deref(), Some("topic line\n"));
    assert!(
        sides
            .result
            .as_deref()
            .is_some_and(|r| r.contains("<<<<<<<"))
    );
    merge::take_side(&reader, &writer, "a.txt", GitSide::Theirs)
        .await
        .expect("take");
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).expect("a"),
        "topic line\n"
    );
    assert!(
        piarc_git::branches::conflicted(&reader)
            .await
            .expect("conflicts")
            .is_empty()
    );
}

#[tokio::test]
async fn a_rebase_conflict_swaps_the_sides_and_a_deletion_is_taken() {
    let root = temp_dir("rebase-conflict");
    let home = home(&root);
    let repo = repository(&root, "repo");
    diverged(&repo);
    git(&repo, &["switch", "-q", "topic"]);
    let (reader, writer) = pair(&home, &repo).await;
    match merge::rebase(&reader, &writer, "main")
        .await
        .expect("rebase")
    {
        RemoteOutcome::Conflict(paths) => assert_eq!(paths, ["a.txt"]),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert!(swapped(&status::repo_state(&reader.repo)));
    // Yours is the commit being replayed (topic's), not git's "ours" (main's).
    let sides = merge::conflict_sides(&reader, "a.txt", "topic".into(), "main".into())
        .await
        .expect("sides");
    assert_eq!(sides.yours.as_deref(), Some("topic line\n"));
    assert_eq!(sides.theirs.as_deref(), Some("main line\n"));
    merge::take_side(&reader, &writer, "a.txt", GitSide::Yours)
        .await
        .expect("take");
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).expect("a"),
        "topic line\n"
    );
    git(&repo, &["-c", "core.editor=true", "rebase", "--continue"]);

    // Modify against delete: taking the deleting side removes the file.
    git(&repo, &["switch", "-q", "-c", "deleter", "main"]);
    git(&repo, &["rm", "-q", "a.txt"]);
    git(&repo, &["commit", "-q", "-m", "delete a"]);
    git(&repo, &["switch", "-q", "main"]);
    commit(&repo, "a.txt", "main again\n", "main: change a again");
    match merge::merge(&reader, &writer, "deleter", GitMergeMode::Ff)
        .await
        .expect("merge")
    {
        RemoteOutcome::Conflict(paths) => assert_eq!(paths, ["a.txt"]),
        other => panic!("expected a conflict, got {other:?}"),
    }
    let sides = merge::conflict_sides(&reader, "a.txt", "main".into(), "deleter".into())
        .await
        .expect("sides");
    assert!(sides.theirs.is_none());
    merge::take_side(&reader, &writer, "a.txt", GitSide::Theirs)
        .await
        .expect("take the deletion");
    assert!(!repo.join("a.txt").exists());
}

#[tokio::test]
async fn interactive_rebases_reorder_reword_squash_fix_up_and_drop() {
    let root = temp_dir("rebase-interactive");
    let home = home(&root);
    let repo = repository(&root, "repo 仓库");
    let base = git(&repo, &["rev-parse", "HEAD"]);
    let one = commit(&repo, "1.txt", "1\n", "one");
    let two = commit(&repo, "2.txt", "2\n", "two");
    let three = commit(&repo, "3.txt", "3\n", "three");
    let four = commit(&repo, "4.txt", "4\n", "four");
    let (reader, writer) = pair(&home, &repo).await;

    let plan = merge::rebase_plan(&reader, &one)
        .await
        .expect("plan")
        .expect("listed");
    assert_eq!(plan.base.as_deref(), Some(base.as_str()));
    let listed: Vec<&str> = plan.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(listed, ["one", "two", "three", "four"]);
    // A commit HEAD does not contain has no plan.
    assert!(
        merge::rebase_plan(&reader, &"f".repeat(40))
            .await
            .expect("plan")
            .is_none()
    );

    // three first, reworded; one with two squashed in; four dropped.
    let messages = root.join("messages 消息");
    std::fs::create_dir_all(&messages).expect("dir");
    let step = |sha: &str, action, message: Option<&str>| GitRebaseStep {
        sha: sha.into(),
        action,
        message: message.map(str::to_owned),
    };
    let steps = [
        step(&three, GitRebaseAction::Reword, Some("三：改写后的信息")),
        step(&one, GitRebaseAction::Pick, None),
        step(&two, GitRebaseAction::Fixup, None),
        step(&four, GitRebaseAction::Drop, None),
    ];
    for (i, s) in steps.iter().enumerate() {
        if let Some(message) = &s.message {
            std::fs::write(messages.join(format!("m{i}")), message).expect("message");
        }
    }
    let todo = merge::todo(&steps, &|i| {
        merge::shell_word(&messages.join(format!("m{i}")))
    });
    let todo_file = messages.join("todo");
    std::fs::write(&todo_file, todo).expect("todo");
    let done = merge::rebase_interactive(&reader, &writer, Some(&base), &todo_file)
        .await
        .expect("rebase");
    assert!(matches!(done, RemoteOutcome::Done(_)), "{done:?}");
    assert_eq!(
        git(&repo, &["log", "--format=%s", &format!("{base}..HEAD")]),
        "one\n三：改写后的信息"
    );
    assert!(repo.join("2.txt").exists());
    assert!(!repo.join("4.txt").exists());
}

#[tokio::test]
async fn local_changes_are_stashed_around_a_rebase_and_put_back() {
    let root = temp_dir("rebase-dirty");
    let home = home(&root);
    let repo = repository(&root, "repo");
    git(&repo, &["switch", "-q", "-c", "topic"]);
    commit(&repo, "b.txt", "b\n", "topic: add b");
    git(&repo, &["switch", "-q", "main"]);
    commit(&repo, "c.txt", "c\n", "main: add c");
    git(&repo, &["switch", "-q", "topic"]);
    std::fs::write(repo.join("a.txt"), "a local edit\n").expect("edit");
    let (reader, writer) = pair(&home, &repo).await;
    let done = merge::rebase(&reader, &writer, "main")
        .await
        .expect("rebase");
    assert!(matches!(done, RemoteOutcome::Done(_)), "{done:?}");
    assert!(repo.join("c.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).expect("a"),
        "a local edit\n"
    );
}
