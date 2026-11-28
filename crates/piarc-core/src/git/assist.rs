//! PR descriptions and reviews (ADR-0087): Core picks the diff (the branch's commits against its
//! base for a description, a scope for a review), leaves out the content of sensitive files and
//! cuts and redacts the rest as for commit messages (ADR-0086 rule 2), asks the session's Agent
//! Host through the session actor, and keeps only review findings that name a file it sent and a
//! line that file has.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use piarc_git::diff::{self, ParsedFile};
use piarc_git::{ExecOptions, GitError, Reader, refs, status};
use piarc_protocol::git::{
    GitFailure, GitFailureKind, GitFinding, GitLanguage, GitPrDraft, GitReview, GitScope,
};
use piarc_protocol::session::{
    CommitMessageFile, GitAssistAnswer, GitAssistParams, GitAssistTask, SessionId,
};
use serde_json::Value;

use super::message::{Budget, describe};
use crate::Result;
use crate::git::write::Context;
use crate::git::{clean, failure_of, reply, reply_failure};
use crate::sessions::Op;

/// What a description sends: the branch's commits.
const DESCRIPTION_BUDGET: Budget = Budget {
    file: 8 * 1024,
    total: 32 * 1024,
};
/// What a review sends.
const REVIEW_BUDGET: Budget = Budget {
    file: 16 * 1024,
    total: 64 * 1024,
};
/// The most commit subjects sent.
const MAX_SUBJECTS: usize = 50;
/// The most bytes of a PR body kept.
const BODY_LIMIT: usize = 16 * 1024;

/// The diff sent, and which files had their content in it.
struct Material {
    files: Vec<CommitMessageFile>,
    diff: String,
    withheld: Vec<String>,
    sent: HashSet<String>,
}

/// `git diff <from> [<to>]` (the working tree without `to`) described within `budget`.
async fn material(
    context: &Context<'_>,
    from: &str,
    to: Option<&str>,
    budget: Budget,
) -> std::result::Result<Material, GitError> {
    let reader = &context.reader;
    let args = |extra: &[&'static str]| {
        let mut args = vec!["diff", "--no-ext-diff", "--find-renames"];
        args.extend_from_slice(extra);
        args.extend(["--end-of-options", from]);
        args.extend(to);
        args.push("--");
        args.into_iter().map(str::to_owned).collect::<Vec<String>>()
    };
    let raw = reader.ok(&args(&["--raw", "-z"])).await?;
    let counts = status::parse_numstat(&reader.ok(&args(&["--numstat", "-z"])).await?);
    let patch = reader
        .run(
            &args(&[
                "--no-color",
                "--no-textconv",
                "-U3",
                "--src-prefix=a/",
                "--dst-prefix=b/",
            ]),
            ExecOptions {
                stdout_limit: Some(4 * 1024 * 1024),
                ..ExecOptions::default()
            },
        )
        .await?;
    let sections: HashMap<String, ParsedFile> = diff::parse_patch(&patch.stdout)
        .into_iter()
        .filter_map(|f| f.path().map(str::to_owned).map(|p| (p, f)))
        .collect();
    let entries = diff::parse_raw(&raw);
    let paths: Vec<PathBuf> = entries
        .iter()
        .map(|e| reader.repo.root.join(&e.path))
        .collect();
    let denied = context.hub.read_denied(context.session, &paths).await;
    let (files, text, withheld) = describe(&entries, &counts, &sections, &denied, budget);
    let sent = files
        .iter()
        .filter(|f| f.withheld.is_none())
        .map(|f| f.path.clone())
        .collect();
    Ok(Material {
        files,
        diff: piarc_telemetry::redact::redact(&text).text.into_owned(),
        withheld,
        sent,
    })
}

/// The base of the current branch: its name and merge base, inferred unless named.
async fn base_of(
    reader: &Reader,
    base: Option<&str>,
) -> std::result::Result<Option<(String, String)>, GitError> {
    let names = refs::ref_names(reader).await?;
    let current = piarc_git::worktree::head_branch(&reader.repo.root);
    let session_base = crate::sessions::session_base(reader).await;
    let found = status::infer_base(
        reader,
        &names,
        base,
        session_base.as_deref(),
        current.as_deref(),
    )
    .await?;
    Ok(found.and_then(|b| b.merge_base.map(|mb| (b.name, mb))))
}

/// Asks the session's Agent Host; a reply value or a failure.
async fn ask(
    context: &Context<'_>,
    params: GitAssistParams,
) -> std::result::Result<GitAssistAnswer, GitFailure> {
    let asked = context
        .hub
        .op(context.session.to_owned(), Op::GitAssist(Box::new(params)));
    let answer = tokio::select! {
        answer = asked => answer,
        () = context.cancel.cancelled() => return Err(GitFailure::of(GitFailureKind::Cancelled)),
    };
    let value = answer.map_err(|error| {
        let message = error.to_string();
        let kind = if message.contains("No model") || message.contains("no model channel") {
            GitFailureKind::NoModel
        } else {
            GitFailureKind::Failed
        };
        GitFailure::new(kind, clean(&message))
    })?;
    serde_json::from_value::<GitAssistAnswer>(value)
        .map_err(|_| GitFailure::new(GitFailureKind::Failed, "unreadable answer"))
}

fn params(
    context: &Context<'_>,
    task: GitAssistTask,
    language: GitLanguage,
    instructions: &str,
    base: Option<String>,
    commits: Vec<String>,
    material: &Material,
) -> GitAssistParams {
    GitAssistParams {
        session_id: SessionId(context.session.to_owned()),
        task,
        language,
        instructions: instructions.to_owned(),
        branch: piarc_git::worktree::head_branch(&context.reader.repo.root),
        base,
        commits,
        files: material.files.clone(),
        diff: material.diff.clone(),
    }
}

/// A PR's title and body from the branch's commits against its base.
pub(crate) async fn describe_pr(
    context: &Context<'_>,
    language: GitLanguage,
    instructions: &str,
    base: Option<&str>,
) -> Result<Value> {
    let found = match base_of(&context.reader, base).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            return reply_failure(GitFailure::new(
                GitFailureKind::Invalid,
                "the branch has no base to compare with",
            ));
        }
        Err(error) => return reply_failure(failure_of(&error)),
    };
    let (name, merge_base) = found;
    let range = format!("{merge_base}..HEAD");
    let max = format!("--max-count={MAX_SUBJECTS}");
    let subjects = match context
        .reader
        .ok(&[
            "log",
            "--no-show-signature",
            "--reverse",
            &max,
            "--format=%s",
            "--end-of-options",
            &range,
        ])
        .await
    {
        Ok(out) => String::from_utf8_lossy(&out)
            .lines()
            .map(|l| l.chars().take(200).collect())
            .collect(),
        Err(error) => return reply_failure(failure_of(&error)),
    };
    let material = match material(context, &merge_base, Some("HEAD"), DESCRIPTION_BUDGET).await {
        Ok(material) => material,
        Err(error) => return reply_failure(failure_of(&error)),
    };
    let request = params(
        context,
        GitAssistTask::PrDescription,
        language,
        instructions,
        Some(name),
        subjects,
        &material,
    );
    let answer = match ask(context, request).await {
        Ok(answer) => answer,
        Err(failure) => return reply_failure(failure),
    };
    let body = answer.body.unwrap_or_default();
    let mut cut = body.len().min(BODY_LIMIT);
    while !body.is_char_boundary(cut) {
        cut -= 1;
    }
    reply(&GitPrDraft {
        title: clean(&answer.title.unwrap_or_default()),
        body: body[..cut].to_owned(),
        model: format!("{}/{}", answer.model.provider, answer.model.id),
        fallback: answer.fallback,
        withheld: material.withheld,
    })
}

/// How many lines `path` has in the working tree (0 when it is not there).
fn lines_in(context: &Context<'_>, path: &str) -> u64 {
    piarc_git::index::worktree_bytes(&context.reader.repo.root, path).map_or(0, |bytes| {
        let breaks = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
        breaks + u64::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'))
    })
}

/// Where a review's diff starts, the base's name, and the scope as answered.
async fn review_range(
    context: &Context<'_>,
    scope: &GitScope,
) -> std::result::Result<(String, Option<String>, GitScope), GitFailure> {
    match scope {
        GitScope::Branch { base } => match base_of(&context.reader, base.as_deref()).await {
            Ok(Some((name, merge_base))) => Ok((
                merge_base,
                Some(name.clone()),
                GitScope::Branch { base: Some(name) },
            )),
            Ok(None) => Err(GitFailure::new(
                GitFailureKind::Invalid,
                "the branch has no base to compare with",
            )),
            Err(error) => Err(failure_of(&error)),
        },
        GitScope::Uncommitted => match context.reader.repo_head().await {
            Ok(Some(_)) => Ok(("HEAD".to_owned(), None, GitScope::Uncommitted)),
            Ok(None) => status::empty_tree(&context.reader)
                .await
                .map(|tree| (tree, None, GitScope::Uncommitted))
                .map_err(|error| failure_of(&error)),
            Err(error) => Err(failure_of(&error)),
        },
        GitScope::Commit { .. } => Err(GitFailure::new(
            GitFailureKind::Invalid,
            "a review covers all changes or the uncommitted ones",
        )),
    }
}

/// Review findings on a scope's diff: all changes against the base, or the uncommitted ones.
pub(crate) async fn review(
    context: &Context<'_>,
    scope: GitScope,
    language: GitLanguage,
) -> Result<Value> {
    let (from, base, answered) = match review_range(context, &scope).await {
        Ok(range) => range,
        Err(failure) => return reply_failure(failure),
    };
    let material = match material(context, &from, None, REVIEW_BUDGET).await {
        Ok(material) => material,
        Err(error) => return reply_failure(failure_of(&error)),
    };
    if material.sent.is_empty() {
        return reply_failure(GitFailure::new(
            GitFailureKind::Invalid,
            "there is nothing to review",
        ));
    }
    let request = params(
        context,
        GitAssistTask::Review,
        language,
        "",
        base,
        Vec::new(),
        &material,
    );
    let answer = match ask(context, request).await {
        Ok(answer) => answer,
        Err(failure) => return reply_failure(failure),
    };
    let total = answer.findings.len() as u64;
    let findings: Vec<GitFinding> = answer
        .findings
        .into_iter()
        .filter(|f| {
            material.sent.contains(&f.path) && f.line >= 1 && f.line <= lines_in(context, &f.path)
        })
        .map(|f| GitFinding {
            path: f.path,
            line: f.line,
            severity: f.severity,
            title: clean(&f.title),
            body: clean(&f.body),
        })
        .collect();
    let dropped = total - findings.len() as u64;
    context
        .audit(
            "review",
            serde_json::json!({
                "model": format!("{}/{}", answer.model.provider, answer.model.id),
                "sent": material.sent.len(),
                "withheld": material.withheld.len(),
                "findings": findings.len(),
                "dropped": dropped,
            }),
        )
        .await;
    reply(&GitReview {
        scope: answered,
        summary: clean(&answer.summary.unwrap_or_default()),
        findings,
        dropped,
        model: format!("{}/{}", answer.model.provider, answer.model.id),
        fallback: answer.fallback,
        withheld: material.withheld,
    })
}
