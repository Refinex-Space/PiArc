//! Commit message generation (ADR-0086): Core reads the staged changes with the read-only
//! runner, leaves out the content of files that must not reach a model provider, cuts and
//! redacts the diff, and asks the session's Agent Host through the session actor (which starts
//! a reclaimed Agent Host again).

use std::collections::HashMap;
use std::path::PathBuf;

use piarc_git::diff::{self, ParsedFile};
use piarc_git::{ExecOptions, GitError, Reader, commit, status};
use piarc_protocol::git::{GitCommitMessage, GitFailure, GitFailureKind, GitLanguage};
use piarc_protocol::session::{CommitMessageAnswer, CommitMessageFile, CommitMessageParams, SessionId};
use serde_json::Value;

use crate::Result;
use crate::git::write::Context;
use crate::git::{clean, failure_of, reply, reply_failure};
use crate::sessions::Op;

/// The most diff bytes of one file sent.
pub(crate) const FILE_BUDGET: usize = 8 * 1024;
/// The most diff bytes sent in all.
pub(crate) const TOTAL_BUDGET: usize = 32 * 1024;
/// The most bytes of a generated message kept.
const MESSAGE_LIMIT: usize = 4 * 1024;

/// Generates a commit message from the staged changes (and, for `amend`, the last commit).
pub(crate) async fn generate(
    context: &Context<'_>,
    language: GitLanguage,
    instructions: &str,
    amend: bool,
) -> Result<Value> {
    let assembled = match assemble(context, language, instructions, amend).await {
        Ok(Ok(assembled)) => assembled,
        Ok(Err(failure)) => return reply_failure(failure),
        Err(error) => return reply_failure(failure_of(&error)),
    };
    let (params, withheld) = assembled;
    let op = Op::CommitMessage(Box::new(params));
    let asked = context.hub.op(context.session.to_owned(), op);
    let answer = tokio::select! {
        answer = asked => answer,
        () = context.cancel.cancelled() => {
            return reply_failure(GitFailure::of(GitFailureKind::Cancelled));
        }
    };
    let value = match answer {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            let kind = if message.contains("No model") || message.contains("no model channel") {
                GitFailureKind::NoModel
            } else {
                GitFailureKind::Failed
            };
            return reply_failure(GitFailure::new(kind, clean(&message)));
        }
    };
    let Ok(answer) = serde_json::from_value::<CommitMessageAnswer>(value) else {
        return reply_failure(GitFailure::new(GitFailureKind::Failed, "unreadable answer"));
    };
    reply(&GitCommitMessage {
        text: tidy(&answer.text),
        model: format!("{}/{}", answer.model.provider, answer.model.id),
        fallback: answer.fallback,
        withheld,
    })
}

/// The message without control characters (line breaks kept), cut to the limit.
fn tidy(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let trimmed = kept.trim();
    if trimmed.len() <= MESSAGE_LIMIT {
        return trimmed.to_owned();
    }
    let mut cut = MESSAGE_LIMIT;
    while !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    trimmed[..cut].trim_end().to_owned()
}

type Assembled = (CommitMessageParams, Vec<String>);

async fn assemble(
    context: &Context<'_>,
    language: GitLanguage,
    instructions: &str,
    amend: bool,
) -> std::result::Result<std::result::Result<Assembled, GitFailure>, GitError> {
    let reader = &context.reader;
    let head = reader.repo_head().await?;
    if amend && head.is_none() {
        return Ok(Err(GitFailure::new(GitFailureKind::Invalid, "nothing to amend")));
    }
    if !amend && !commit::has_staged(reader).await? {
        return Ok(Err(GitFailure::of(GitFailureKind::NothingToCommit)));
    }
    let base = base_of(reader, head.as_deref(), amend).await?;
    let raw = reader.ok(&cached(&base, &["--raw", "-z"])).await?;
    let counts = status::parse_numstat(&reader.ok(&cached(&base, &["--numstat", "-z"])).await?);
    let patch = reader
        .run(
            &cached(&base, &["--no-color", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/"]),
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
    let paths: Vec<PathBuf> = entries.iter().map(|e| reader.repo.root.join(&e.path)).collect();
    let denied = context.hub.read_denied(context.session, &paths).await;
    let (files, text, withheld) = describe(&entries, &counts, &sections, &denied);
    let subjects = if head.is_some() {
        let out = reader
            .run(&["log", "-10", "--no-show-signature", "--format=%s"], ExecOptions::default())
            .await?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.chars().take(200).collect())
            .collect()
    } else {
        Vec::new()
    };
    let previous = if amend {
        commit::last_commit(reader).await?.message
    } else {
        None
    };
    Ok(Ok((
        CommitMessageParams {
            session_id: SessionId(context.session.to_owned()),
            language,
            instructions: instructions.to_owned(),
            branch: piarc_git::worktree::head_branch(&reader.repo.root),
            recent_subjects: subjects,
            files,
            diff: piarc_telemetry::redact::redact(&text).text.into_owned(),
            amend: previous,
        },
        withheld,
    )))
}

/// What the message describes changes from: `HEAD` (its parent when amending), or the empty
/// tree.
async fn base_of(reader: &Reader, head: Option<&str>, amend: bool) -> std::result::Result<String, GitError> {
    if amend {
        let parent = reader
            .run(&["rev-parse", "--verify", "--quiet", "HEAD^1"], ExecOptions::default())
            .await?;
        if parent.success() {
            return Ok(String::from_utf8_lossy(&parent.stdout).trim().to_owned());
        }
        return status::empty_tree(reader).await;
    }
    match head {
        Some(_) => Ok("HEAD".to_owned()),
        None => status::empty_tree(reader).await,
    }
}

fn cached<'a>(base: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["diff", "--cached", "--no-ext-diff", "--find-renames"];
    args.extend_from_slice(extra);
    args.extend(["--end-of-options", base, "--"]);
    args
}

/// The file list, the diff text within budget, and the files sent by path only.
fn describe(
    entries: &[diff::RawEntry],
    counts: &HashMap<String, Option<(u64, u64)>>,
    sections: &HashMap<String, ParsedFile>,
    denied: &[bool],
) -> (Vec<CommitMessageFile>, String, Vec<String>) {
    let mut files = Vec::new();
    let mut text = String::new();
    let mut withheld = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let pair = counts.get(&entry.path).copied().flatten();
        let section = sections.get(&entry.path);
        let body = section.map(|s| {
            let mut bytes = s.header.clone();
            for hunk in &s.hunks {
                bytes.extend_from_slice(&hunk.raw);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let reason = if pair.is_none() || section.is_some_and(|s| s.binary) {
            Some("binary")
        } else if is_sensitive(&entry.path) {
            Some("sensitive")
        } else if denied.get(i).copied().unwrap_or(true) {
            Some("denied")
        } else if is_lockfile(&entry.path) {
            Some("lockfile")
        } else if body.as_deref().is_some_and(holds_private_key) {
            Some("privateKey")
        } else {
            None
        };
        let mut reason = reason.map(str::to_owned);
        if reason.is_none()
            && let Some(body) = body
        {
            let piece = cut(&body, FILE_BUDGET);
            if text.len() + piece.len() > TOTAL_BUDGET {
                reason = Some("budget".to_owned());
            } else {
                text.push_str(&piece);
                if !piece.ends_with('\n') {
                    text.push('\n');
                }
            }
        }
        if let Some(why) = &reason
            && why != "budget"
            && why != "binary"
        {
            withheld.push(entry.path.clone());
        }
        files.push(CommitMessageFile {
            path: entry.path.clone(),
            status: format!("{:?}", entry.status).to_ascii_lowercase(),
            added: pair.map(|p| p.0),
            removed: pair.map(|p| p.1),
            withheld: reason,
        });
    }
    (files, text, withheld)
}

fn cut(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[… cut]\n", &text[..end])
}

/// File names whose content is a credential or key (ADR-0086 rule 2).
#[must_use]
pub(crate) fn is_sensitive(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    name.starts_with(".env")
        || [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx"]
            .iter()
            .any(|ext| name.ends_with(ext))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
            .iter()
            .any(|key| name.starts_with(key))
        || matches!(
            name.as_str(),
            ".npmrc" | ".pypirc" | ".netrc" | ".git-credentials" | "credentials.json"
        )
}

fn is_lockfile(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "package-lock.json"
            | "npm-shrinkwrap.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lockb"
            | "Cargo.lock"
            | "poetry.lock"
            | "Pipfile.lock"
            | "Gemfile.lock"
            | "composer.lock"
            | "go.sum"
    )
}

fn holds_private_key(text: &str) -> bool {
    text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_names() {
        for path in [".env", "config/.env.local", "certs/server.pem", "id_ed25519", "a/.npmrc"] {
            assert!(is_sensitive(path), "{path}");
        }
        for path in ["src/env.ts", "keys.md", "README.md"] {
            assert!(!is_sensitive(path), "{path}");
        }
    }

    #[test]
    fn messages_lose_control_characters_and_long_tails() {
        assert_eq!(tidy("  feat: x\u{7}\n\nbody\u{1b}  "), "feat: x\n\nbody");
        assert!(tidy(&"字".repeat(3000)).len() <= MESSAGE_LIMIT);
    }

    #[test]
    fn private_keys_are_found_in_diffs() {
        assert!(holds_private_key("+-----BEGIN OPENSSH PRIVATE KEY-----\n+abc"));
        assert!(!holds_private_key("+-----BEGIN CERTIFICATE-----"));
    }
}
