//! The remotes configured for a working tree, read from git's files without a process (T46:
//! Auto mode trusts the remotes a session had when it was registered).

use std::path::{Path, PathBuf};

/// One configured remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    /// Its name (`origin`).
    pub name: String,
    /// Its first `url`, without user information (`https://token@host/x` → `https://host/x`).
    pub url: String,
}

/// The remotes of the repository holding `dir` (searched upwards), in the order of the
/// configuration file; empty when there is no repository or it cannot be read. Only the
/// repository's own `config` is read: remotes from includes or the global file are left out.
#[must_use]
pub fn remotes(dir: &Path) -> Vec<Remote> {
    let Some(config) = config_file(dir) else {
        return Vec::new();
    };
    std::fs::read_to_string(config)
        .map(|text| parse(&text))
        .unwrap_or_default()
}

/// The `config` of the repository holding `dir`: a linked worktree's `.git` file points at its
/// git directory, whose `commondir` names the shared one.
fn config_file(dir: &Path) -> Option<PathBuf> {
    let mut current = Some(dir);
    while let Some(here) = current {
        let dot_git = here.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git.join("config"));
        }
        if dot_git.is_file() {
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
            let git_dir = here.join(target);
            let common = std::fs::read_to_string(git_dir.join("commondir"))
                .ok()
                .map(|c| git_dir.join(c.trim()));
            return Some(common.unwrap_or(git_dir).join("config"));
        }
        current = here.parent();
    }
    None
}

fn parse(text: &str) -> Vec<Remote> {
    let mut out: Vec<Remote> = Vec::new();
    let mut section: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            section = header
                .strip_suffix(']')
                .and_then(|h| h.trim().strip_prefix("remote"))
                .map(str::trim)
                .and_then(|name| name.strip_prefix('"')?.strip_suffix('"'))
                .map(str::to_owned);
            continue;
        }
        let Some(name) = &section else { continue };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("url") || out.iter().any(|r| &r.name == name) {
            continue;
        }
        let value = value.trim().trim_matches('"');
        out.push(Remote {
            name: name.clone(),
            url: without_user(value),
        });
    }
    out
}

/// `url` without the user information of a `scheme://user:secret@host` form; scp-like
/// `user@host:path` keeps its user name (it carries no secret).
fn without_user(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    match authority.rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://{host}{path}"),
        None => url.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_lose_their_credentials_and_keep_their_order() {
        let text = r#"
[core]
	bare = false
[remote "origin"]
	url = https://user:ghp_secret@github.com/acme/app.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
[remote "upstream"]
	url = git@github.com:other/app.git
	url = https://second.example/ignored
[remote "plain"]
	URL = "https://example.com/x"
"#;
        assert_eq!(
            parse(text),
            [
                Remote {
                    name: "origin".into(),
                    url: "https://github.com/acme/app.git".into()
                },
                Remote {
                    name: "upstream".into(),
                    url: "git@github.com:other/app.git".into()
                },
                Remote {
                    name: "plain".into(),
                    url: "https://example.com/x".into()
                },
            ]
        );
        assert_eq!(without_user("ssh://git@host:22/x"), "ssh://host:22/x");
        assert_eq!(without_user("/srv/repo.git"), "/srv/repo.git");
    }

    #[test]
    fn a_linked_worktree_reads_the_shared_config() {
        let root =
            std::env::temp_dir().join(format!("piarc-git remotes 远端 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let main = root.join("main");
        let shared = main.join(".git");
        let linked_git = shared.join("worktrees").join("w");
        std::fs::create_dir_all(&linked_git).expect("git dirs");
        std::fs::write(
            shared.join("config"),
            "[remote \"origin\"]\n\turl = https://example.com/r.git\n",
        )
        .expect("config");
        std::fs::write(linked_git.join("commondir"), "../..\n").expect("commondir");
        let tree = root.join("tree");
        std::fs::create_dir_all(tree.join("sub dir")).expect("tree");
        std::fs::write(
            tree.join(".git"),
            format!("gitdir: {}\n", linked_git.display()),
        )
        .expect(".git file");
        let found = remotes(&tree.join("sub dir"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].url, "https://example.com/r.git");
        assert_eq!(remotes(&main), found);
        assert!(remotes(&std::env::temp_dir().join("no such dir 无")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
