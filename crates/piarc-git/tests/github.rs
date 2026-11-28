//! G5's `gh` calls against a fake `gh` (a shell script that records its arguments and stdin):
//! the arguments built for viewing, creating and merging pull requests, the body sent through
//! stdin, and the outcomes "no pull request" and "not signed in".
#![cfg(unix)]

mod support;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_git::gh::{self, GhOutcome, GhRepo};
use piarc_git::{Cancel, Git};
use piarc_protocol::git::{GitMergeMethod, GitPrState};
use support::{TokioSpawner, temp_dir};

const FAKE: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$FAKE_LOG"
cat > "$FAKE_LOG.stdin"
case "$FAKE_MODE" in
  nopr) echo "no pull requests found for branch \"x\"" >&2; exit 1 ;;
  auth) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
esac
case "$1 $2" in
  "pr view") echo '{"number":7,"title":"Add login","state":"OPEN","isDraft":false,"url":"https://github.com/octo/app/pull/7","baseRefName":"main","headRefName":"feature/x","reviewDecision":"APPROVED","mergeable":"MERGEABLE","statusCheckRollup":[]}' ;;
  "pr create") echo "Creating pull request"; echo "https://github.com/octo/app/pull/8" ;;
  "pr merge") exit 0 ;;
esac
"#;

struct Fake {
    dir: PathBuf,
    log: PathBuf,
}

impl Fake {
    fn new(name: &str) -> Self {
        let dir = temp_dir(name);
        let program = dir.join("gh");
        std::fs::write(&program, FAKE).expect("script");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("mode");
        Self {
            log: dir.join("log 日志"),
            dir,
        }
    }

    fn gh(&self, mode: &str) -> Git {
        let env: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("FAKE_LOG".into(), self.log.clone().into()),
            ("FAKE_MODE".into(), mode.into()),
        ];
        Git::other(Arc::new(TokioSpawner), self.dir.join("gh"), env)
    }

    fn args(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .expect("log")
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn stdin(&self) -> String {
        let mut path = self.log.clone().into_os_string();
        path.push(".stdin");
        std::fs::read_to_string(Path::new(&path)).expect("stdin")
    }
}

fn repo() -> GhRepo {
    gh::repo_of("git@github.com:octo/app.git").expect("repo")
}

#[tokio::test]
async fn pull_requests_are_viewed_created_and_merged_with_fixed_arguments() {
    let fake = Fake::new("gh-calls");
    let cwd = fake.dir.clone();
    let viewed = gh::pr_view(&fake.gh(""), &cwd, &repo(), "feature/x", Cancel::new())
        .await
        .expect("view");
    let GhOutcome::Done(Some(pr)) = viewed else {
        panic!("expected a pull request, got {viewed:?}");
    };
    assert_eq!((pr.number, pr.state), (7, GitPrState::Open));
    assert_eq!(pr.review_decision.as_deref(), Some("APPROVED"));
    assert_eq!(
        fake.args(),
        [
            "pr",
            "view",
            "--repo=github.com/octo/app",
            "--json=number,title,state,isDraft,url,baseRefName,headRefName,reviewDecision,mergeable,statusCheckRollup",
            "--",
            "feature/x",
        ]
    );

    // A title that looks like a flag stays the title's value; the body goes through stdin.
    let created = gh::pr_create(
        &fake.gh(""),
        &cwd,
        &repo(),
        "main",
        "feature/x",
        "--web 登录",
        "## Summary\n- 登录表单\n",
        true,
        Cancel::new(),
    )
    .await
    .expect("create");
    assert_eq!(
        created,
        GhOutcome::Done("https://github.com/octo/app/pull/8".into())
    );
    assert_eq!(
        fake.args(),
        [
            "pr",
            "create",
            "--repo=github.com/octo/app",
            "--base=main",
            "--head=feature/x",
            "--title=--web 登录",
            "--body-file=-",
            "--draft",
        ]
    );
    assert_eq!(fake.stdin(), "## Summary\n- 登录表单\n");

    let merged = gh::pr_merge(
        &fake.gh(""),
        &cwd,
        &repo(),
        7,
        GitMergeMethod::Squash,
        Cancel::new(),
    )
    .await
    .expect("merge");
    assert_eq!(merged, GhOutcome::Done(()));
    assert_eq!(
        fake.args(),
        [
            "pr",
            "merge",
            "--repo=github.com/octo/app",
            "--squash",
            "--",
            "7"
        ]
    );
}

#[tokio::test]
async fn no_pull_request_and_no_sign_in_are_told_apart() {
    let fake = Fake::new("gh-outcomes");
    let cwd = fake.dir.clone();
    let none = gh::pr_view(&fake.gh("nopr"), &cwd, &repo(), "x", Cancel::new())
        .await
        .expect("view");
    assert_eq!(none, GhOutcome::Done(None));
    let auth = gh::pr_view(&fake.gh("auth"), &cwd, &repo(), "x", Cancel::new())
        .await
        .expect("view");
    assert!(matches!(auth, GhOutcome::Auth(_)), "{auth:?}");
}
