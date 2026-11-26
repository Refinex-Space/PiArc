//! `git status` for the Git panel (ADR-0084): branch, upstream, the operation in progress and
//! the uncommitted files with their line counts, plus the base branch of the branch scope.

use std::collections::HashMap;
use std::path::Path;

use piarc_protocol::git::{
    GitBase, GitFileStatus, GitRepoState, GitRepository, GitStatus, GitStatusFile,
};

use crate::exec::ExecOptions;
use crate::git::GitError;
use crate::repo::{Reader, Repo};

/// The most status entries the panel lists.
pub const MAX_ENTRIES: usize = 10_000;
/// Untracked files larger than this are not line-counted.
const COUNT_LIMIT: u64 = 1024 * 1024;
/// A NUL byte in this many leading bytes makes a file binary (git's rule).
const BINARY_PROBE: usize = 8000;

/// What `status --porcelain=v2 --branch` says about the branch.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    /// The commit, absent before the first one.
    pub oid: Option<String>,
    /// The branch, absent when detached.
    pub head: Option<String>,
    /// `HEAD` is detached.
    pub detached: bool,
    /// The upstream.
    pub upstream: Option<String>,
    /// Ahead of the upstream.
    pub ahead: u64,
    /// Behind it.
    pub behind: u64,
}

/// Parses `status --porcelain=v2 -z --branch` output.
#[must_use]
pub fn parse_porcelain(out: &[u8]) -> (BranchInfo, Vec<GitStatusFile>) {
    let text = String::from_utf8_lossy(out);
    let mut fields = text.split('\0').peekable();
    let mut branch = BranchInfo::default();
    let mut files = Vec::new();
    while let Some(entry) = fields.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            parse_header(header, &mut branch);
            continue;
        }
        let mut kind = entry.splitn(2, ' ');
        match (kind.next(), kind.next()) {
            (Some("1"), Some(rest)) => {
                if let Some(file) = ordinary(rest, 7, None) {
                    files.push(file);
                }
            }
            (Some("2"), Some(rest)) => {
                let old = fields.next().map(str::to_owned);
                if let Some(file) = ordinary(rest, 8, old) {
                    files.push(file);
                }
            }
            (Some("u"), Some(rest)) => {
                let parts: Vec<&str> = rest.splitn(10, ' ').collect();
                if parts.len() == 10 {
                    files.push(GitStatusFile {
                        path: parts[9].to_owned(),
                        old_path: None,
                        staged: None,
                        unstaged: Some(GitFileStatus::Conflicted),
                        conflict: Some(parts[0].to_owned()),
                        submodule: None,
                        added: None,
                        removed: None,
                    });
                }
            }
            (Some("?"), Some(path)) => files.push(GitStatusFile {
                path: path.to_owned(),
                old_path: None,
                staged: None,
                unstaged: Some(GitFileStatus::Untracked),
                conflict: None,
                submodule: None,
                added: None,
                removed: None,
            }),
            _ => {}
        }
    }
    (branch, files)
}

fn parse_header(header: &str, branch: &mut BranchInfo) {
    let Some((key, value)) = header.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" if value != "(initial)" => branch.oid = Some(value.to_owned()),
        "branch.head" if value == "(detached)" => branch.detached = true,
        "branch.head" => branch.head = Some(value.to_owned()),
        "branch.upstream" => branch.upstream = Some(value.to_owned()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    branch.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    branch.behind = n.parse().unwrap_or(0);
                }
            }
        }
        _ => {}
    }
}

/// An ordinary (`1`, `skip` = 7) or renamed (`2`, `skip` = 8) entry after its type letter.
fn ordinary(rest: &str, skip: usize, old_path: Option<String>) -> Option<GitStatusFile> {
    let parts: Vec<&str> = rest.splitn(skip + 1, ' ').collect();
    if parts.len() != skip + 1 {
        return None;
    }
    let xy = parts[0].as_bytes();
    let (x, y) = (*xy.first()?, *xy.get(1)?);
    let submodule = parts[1].starts_with('S');
    Some(GitStatusFile {
        path: parts[skip].to_owned(),
        old_path,
        staged: letter(x),
        unstaged: letter(y),
        conflict: None,
        submodule: submodule.then_some(true),
        added: None,
        removed: None,
    })
}

fn letter(code: u8) -> Option<GitFileStatus> {
    Some(match code {
        b'M' => GitFileStatus::Modified,
        b'T' => GitFileStatus::TypeChanged,
        b'A' => GitFileStatus::Added,
        b'D' => GitFileStatus::Deleted,
        b'R' => GitFileStatus::Renamed,
        b'C' => GitFileStatus::Copied,
        b'U' => GitFileStatus::Conflicted,
        _ => return None,
    })
}

/// Parses `diff --numstat -z` output into counts by path (binary files have none).
#[must_use]
pub fn parse_numstat(out: &[u8]) -> HashMap<String, Option<(u64, u64)>> {
    let text = String::from_utf8_lossy(out);
    let mut fields = text.split('\0');
    let mut counts = HashMap::new();
    while let Some(entry) = fields.next() {
        if entry.is_empty() {
            continue;
        }
        let mut parts = entry.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // A rename leaves the path empty and gives the old and new paths as the next fields.
        let path = if path.is_empty() {
            let _old = fields.next();
            fields.next().unwrap_or_default().to_owned()
        } else {
            path.to_owned()
        };
        let pair = match (added.parse(), removed.parse()) {
            (Ok(a), Ok(r)) => Some((a, r)),
            _ => None,
        };
        counts.insert(path, pair);
    }
    counts
}

/// Line counts of an untracked file: `None` when binary or too large to count.
#[must_use]
pub fn count_untracked(path: &Path) -> Option<u64> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > COUNT_LIMIT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.iter().take(BINARY_PROBE).any(|&b| b == 0) {
        return None;
    }
    let mut lines = bytecount(&bytes);
    if bytes.last().is_some_and(|&b| b != b'\n') {
        lines += 1;
    }
    Some(lines)
}

fn bytecount(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|&&b| b == b'\n').count() as u64
}

/// What the repository is in the middle of, read from its git directory.
#[must_use]
pub fn repo_state(repo: &Repo) -> GitRepoState {
    let dir = &repo.git_dir;
    let read = |name: &str| {
        std::fs::read_to_string(dir.join(name))
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    };
    let short = |oid: Option<String>| oid.map(|o| o.chars().take(7).collect::<String>());
    for sub in ["rebase-merge", "rebase-apply"] {
        if dir.join(sub).is_dir() {
            let file = |name: &str| read(&format!("{sub}/{name}"));
            let (step, total) = if sub == "rebase-merge" {
                (file("msgnum"), file("end"))
            } else {
                (file("next"), file("last"))
            };
            return GitRepoState::Rebasing {
                branch: file("head-name")
                    .map(|h| h.trim_start_matches("refs/heads/").to_owned()),
                onto: short(file("onto")),
                step: step.and_then(|s| s.parse().ok()),
                total: total.and_then(|s| s.parse().ok()),
            };
        }
    }
    if dir.join("MERGE_HEAD").is_file() {
        return GitRepoState::Merging {
            source: read("MERGE_MSG").and_then(|m| merge_source(&m)),
        };
    }
    if let Some(oid) = read("CHERRY_PICK_HEAD") {
        return GitRepoState::CherryPicking {
            commit: short(Some(oid)),
        };
    }
    if let Some(oid) = read("REVERT_HEAD") {
        return GitRepoState::Reverting {
            commit: short(Some(oid)),
        };
    }
    GitRepoState::Clean
}

/// `origin/main` of "Merge remote-tracking branch 'origin/main'", `x` of "Merge branch 'x'".
fn merge_source(message: &str) -> Option<String> {
    let first = message.lines().next()?;
    let start = first.find('\'')? + 1;
    let end = first[start..].find('\'')? + start;
    Some(first[start..end].to_owned())
}

/// The id of the empty tree in this repository's hash.
///
/// # Errors
///
/// The reader's errors.
pub async fn empty_tree(reader: &Reader) -> Result<String, GitError> {
    let out = reader
        .run(&["hash-object", "-t", "tree", "--stdin"], ExecOptions::default())
        .await?;
    if !out.success() {
        return Err(crate::repo::failed(&["hash-object"], &out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// `status`: branch, upstream, state, remotes, counts and files. `writable` and `protected`
/// are left false for Core to set; `preferred` and `session_base` steer the base branch.
///
/// # Errors
///
/// The reader's errors.
pub async fn status(
    reader: &Reader,
    preferred: Option<&str>,
    session_base: Option<&str>,
) -> Result<GitStatus, GitError> {
    let out = reader
        .ok(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
        ])
        .await?;
    let (branch, mut files) = parse_porcelain(&out);
    let truncated = files.len() > MAX_ENTRIES;
    files.truncate(MAX_ENTRIES);
    let against = match &branch.oid {
        Some(_) => "HEAD".to_owned(),
        None => empty_tree(reader).await?,
    };
    let numstat = reader
        .ok(&["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", &against])
        .await?;
    let counts = parse_numstat(&numstat);
    let (mut added, mut removed) = (0, 0);
    for file in &mut files {
        let pair = if file.unstaged == Some(GitFileStatus::Untracked) {
            count_untracked(&reader.repo.root.join(&file.path)).map(|n| (n, 0))
        } else {
            counts.get(&file.path).copied().flatten()
        };
        if let Some((a, r)) = pair {
            file.added = Some(a);
            file.removed = Some(r);
            added += a;
            removed += r;
        }
    }
    files.sort_by(|a, b| {
        let conflict = |f: &GitStatusFile| u8::from(f.conflict.is_none());
        conflict(a)
            .cmp(&conflict(b))
            .then_with(|| a.path.cmp(&b.path))
    });
    let refs = crate::refs::ref_names(reader).await?;
    let base = match branch.oid {
        Some(_) => infer_base(reader, &refs, preferred, session_base, branch.head.as_deref()).await?,
        None => None,
    };
    let remotes = crate::refs::remotes(reader).await?;
    Ok(GitStatus {
        repository: Some(GitRepository {
            root: reader.repo.root.to_string_lossy().into_owned(),
            branch: branch.head,
            head: branch.oid,
            detached: branch.detached.then_some(true),
            upstream: branch.upstream,
            ahead: branch.ahead,
            behind: branch.behind,
            state: repo_state(&reader.repo),
            remotes,
            base,
            writable: false,
            protected: false,
            added,
            removed,
        }),
        files,
        truncated: truncated.then_some(true),
        fingerprint: reader.repo.fingerprint(),
    })
}

/// The base branch of the branch scope (ADR-0084 rule 2) with its merge base.
///
/// # Errors
///
/// The reader's errors.
pub async fn infer_base(
    reader: &Reader,
    refs: &crate::refs::RefNames,
    preferred: Option<&str>,
    session_base: Option<&str>,
    current: Option<&str>,
) -> Result<Option<GitBase>, GitError> {
    let mut candidates: Vec<String> = Vec::new();
    candidates.extend(preferred.map(str::to_owned));
    candidates.extend(session_base.map(str::to_owned));
    candidates.extend(refs.origin_head.clone());
    for name in ["main", "master"] {
        if refs.has(&format!("refs/remotes/origin/{name}")) {
            candidates.push(name.to_owned());
        }
    }
    for name in ["main", "master"] {
        if refs.has(&format!("refs/heads/{name}")) {
            candidates.push(name.to_owned());
        }
    }
    candidates.extend(current.map(str::to_owned));
    for name in candidates {
        let reference = [format!("refs/remotes/origin/{name}"), format!("refs/heads/{name}")]
            .into_iter()
            .chain(name.starts_with("refs/").then(|| name.clone()))
            .chain(
                name.split_once('/')
                    .filter(|(remote, _)| refs.remotes.iter().any(|r| r == remote))
                    .map(|_| format!("refs/remotes/{name}")),
            )
            .find(|r| refs.has(r));
        let Some(reference) = reference else {
            continue;
        };
        let out = reader
            .run(
                &["merge-base", "--end-of-options", &reference, "HEAD"],
                ExecOptions::default(),
            )
            .await?;
        let merge_base = out
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
            .filter(|s| !s.is_empty());
        return Ok(Some(GitBase {
            name,
            reference,
            merge_base,
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_v2_entries_and_branch_headers() {
        let out = b"# branch.oid 1111111111111111111111111111111111111111\0\
# branch.head feature/x\0\
# branch.upstream origin/feature/x\0\
# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa aaa src/a.rs\0\
1 A. N... 000000 100644 100644 000 bbb new file.md\0\
2 R. N... 100644 100644 100644 ccc ccc R100 to.rs\0from.rs\0\
u UU N... 100644 100644 100644 100644 d1 d2 d3 conflict.txt\0\
? untracked/\xe4\xb8\xad.txt\0\
1 .M S.M. 160000 160000 160000 eee eee vendor/lib\0";
        let (branch, files) = parse_porcelain(out);
        assert_eq!(branch.head.as_deref(), Some("feature/x"));
        assert_eq!(branch.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((branch.ahead, branch.behind), (2, 1));
        assert!(!branch.detached);
        assert_eq!(files.len(), 6);
        assert_eq!(files[0].unstaged, Some(GitFileStatus::Modified));
        assert_eq!(files[0].staged, None);
        assert_eq!(files[1].path, "new file.md");
        assert_eq!(files[1].staged, Some(GitFileStatus::Added));
        assert_eq!(files[2].path, "to.rs");
        assert_eq!(files[2].old_path.as_deref(), Some("from.rs"));
        assert_eq!(files[3].conflict.as_deref(), Some("UU"));
        assert_eq!(files[4].path, "untracked/中.txt");
        assert_eq!(files[4].unstaged, Some(GitFileStatus::Untracked));
        assert_eq!(files[5].submodule, Some(true));
    }

    #[test]
    fn detached_and_initial_heads() {
        let (branch, _) = parse_porcelain(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(branch.oid.is_none());
        assert!(branch.detached);
        assert!(branch.head.is_none());
    }

    #[test]
    fn numstat_with_renames_and_binary() {
        let out = b"3\t1\ta.txt\0-\t-\timg.png\0\x30\t0\t\0old.rs\0new.rs\0";
        let counts = parse_numstat(out);
        assert_eq!(counts["a.txt"], Some((3, 1)));
        assert_eq!(counts["img.png"], None);
        assert_eq!(counts["new.rs"], Some((0, 0)));
    }

    #[test]
    fn merge_sources() {
        assert_eq!(
            merge_source("Merge remote-tracking branch 'origin/main' into x\n").as_deref(),
            Some("origin/main")
        );
        assert_eq!(merge_source("Merge branch 'y'").as_deref(), Some("y"));
        assert_eq!(merge_source("custom"), None);
    }
}
