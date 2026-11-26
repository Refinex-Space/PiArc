//! Branches, remotes and recent checkouts for the Git panel's branch popup and base inference.

use std::collections::HashSet;

use piarc_protocol::git::{GitBranches, GitLocalBranch, GitRemoteBranch};

use crate::exec::ExecOptions;
use crate::git::GitError;
use crate::repo::Reader;

/// How many recent checkouts the popup lists.
const RECENT: usize = 5;

/// The refs of a repository, for lookups.
#[derive(Debug, Default, Clone)]
pub struct RefNames {
    names: HashSet<String>,
    /// The branch `refs/remotes/origin/HEAD` points at (`main`).
    pub origin_head: Option<String>,
    /// The configured remotes.
    pub remotes: Vec<String>,
}

impl RefNames {
    /// Whether the full ref name exists.
    #[must_use]
    pub fn has(&self, name: &str) -> bool {
        self.names.contains(name)
    }
}

const FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00\
%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:unix)%00%(symref)%00%(worktreepath)";

/// One line of [`FORMAT`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct RefLine {
    name: String,
    oid: String,
    upstream: String,
    track: String,
    head: bool,
    time: u64,
    symref: String,
    worktree: String,
}

fn parse_refs(out: &[u8]) -> Vec<RefLine> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            (f.len() >= 8).then(|| RefLine {
                name: f[0].to_owned(),
                oid: f[1].to_owned(),
                upstream: f[2].to_owned(),
                track: f[3].to_owned(),
                head: f[4] == "*",
                time: f[5].parse().unwrap_or(0),
                symref: f[6].to_owned(),
                worktree: f[7].to_owned(),
            })
        })
        .collect()
}

async fn ref_lines(reader: &Reader) -> Result<Vec<RefLine>, GitError> {
    let out = reader
        .ok(&["for-each-ref", FORMAT, "refs/heads", "refs/remotes"])
        .await?;
    Ok(parse_refs(&out))
}

/// The configured remotes' names.
///
/// # Errors
///
/// The reader's errors.
pub async fn remotes(reader: &Reader) -> Result<Vec<String>, GitError> {
    let out = reader.ok(&["remote"]).await?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Every branch ref, `origin/HEAD`'s target and the remotes.
///
/// # Errors
///
/// The reader's errors.
pub async fn ref_names(reader: &Reader) -> Result<RefNames, GitError> {
    let lines = ref_lines(reader).await?;
    let origin_head = lines
        .iter()
        .find(|l| l.name == "refs/remotes/origin/HEAD")
        .and_then(|l| l.symref.strip_prefix("refs/remotes/origin/"))
        .map(str::to_owned);
    Ok(RefNames {
        names: lines.into_iter().map(|l| l.name).collect(),
        origin_head,
        remotes: remotes(reader).await?,
    })
}

/// "ahead 2, behind 1" / "gone" / "" as (ahead, behind, gone).
fn parse_track(track: &str) -> (Option<u64>, Option<u64>, bool) {
    if track == "gone" {
        return (None, None, true);
    }
    let mut ahead = None;
    let mut behind = None;
    for part in track.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().ok();
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().ok();
        }
    }
    (ahead, behind, false)
}

/// The branch a reflog subject "checkout: moving from A to B" moved to.
fn checkout_target(subject: &str) -> Option<&str> {
    subject
        .strip_prefix("checkout: moving from ")
        .and_then(|rest| rest.rsplit_once(" to "))
        .map(|(_, to)| to.trim())
}

/// Local and remote branches, recent checkouts and remotes.
///
/// # Errors
///
/// The reader's errors.
pub async fn branches(reader: &Reader) -> Result<GitBranches, GitError> {
    let lines = ref_lines(reader).await?;
    let root = reader.repo.root.to_string_lossy().into_owned();
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in lines {
        if let Some(name) = line.name.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(&line.track);
            let worktree = Some(line.worktree.clone())
                .filter(|w| !w.is_empty() && !line.head && !same_path(w, &root));
            local.push(GitLocalBranch {
                name: name.to_owned(),
                oid: line.oid,
                upstream: Some(line.upstream).filter(|u| !u.is_empty()),
                ahead: ahead.filter(|&n| n > 0),
                behind: behind.filter(|&n| n > 0),
                gone: gone.then_some(true),
                current: line.head.then_some(true),
                worktree,
                time: line.time,
            });
        } else if let Some(rest) = line.name.strip_prefix("refs/remotes/") {
            if !line.symref.is_empty() {
                continue;
            }
            if let Some((remote_name, name)) = rest.split_once('/') {
                remote.push(GitRemoteBranch {
                    remote: remote_name.to_owned(),
                    name: name.to_owned(),
                    oid: line.oid,
                    time: line.time,
                });
            }
        }
    }
    let known: HashSet<&str> = local
        .iter()
        .filter(|b| b.current.is_none())
        .map(|b| b.name.as_str())
        .collect();
    let mut recent: Vec<String> = Vec::new();
    let log = reader
        .run(
            &[
                "log",
                "-g",
                "--no-show-signature",
                "--format=%gs",
                "--grep-reflog=checkout: moving from",
                "--max-count=200",
                "HEAD",
            ],
            ExecOptions::default(),
        )
        .await?;
    if log.success() {
        for subject in String::from_utf8_lossy(&log.stdout).lines() {
            if let Some(target) = checkout_target(subject)
                && known.contains(target)
                && !recent.iter().any(|r| r == target)
            {
                recent.push(target.to_owned());
                if recent.len() == RECENT {
                    break;
                }
            }
        }
    }
    Ok(GitBranches {
        local,
        remote,
        recent,
        remotes: remotes(reader).await?,
    })
}

fn same_path(a: &str, b: &str) -> bool {
    let tidy = |p: &str| {
        let path = std::path::PathBuf::from(p);
        crate::canonical(&path).unwrap_or(path)
    };
    tidy(a) == tidy(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_lines_and_tracking() {
        let out = b"refs/heads/main\0aaa\0origin/main\0ahead 2, behind 1\0*\x00100\0\0/repo\n\
refs/remotes/origin/HEAD\0aaa\0\0\0 \x00100\0refs/remotes/origin/main\0\n";
        let lines = parse_refs(out);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].head);
        assert_eq!(parse_track(&lines[0].track), (Some(2), Some(1), false));
        assert_eq!(lines[1].symref, "refs/remotes/origin/main");
        assert_eq!(parse_track("gone"), (None, None, true));
        assert_eq!(parse_track(""), (None, None, false));
    }

    #[test]
    fn checkout_targets() {
        assert_eq!(
            checkout_target("checkout: moving from main to feature/x"),
            Some("feature/x")
        );
        assert_eq!(checkout_target("commit: x"), None);
    }
}
