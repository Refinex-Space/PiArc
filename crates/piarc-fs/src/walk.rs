//! Directory-relative traversal for Glob, Grep and composer file mentions (ADR-0036).
//! Project ignore inputs and search results share the same directory authority. The
//! user's global Git excludes are a separate, host-selected input.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::Dir;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::overrides::Override;

use crate::bound::{BoundPath, open_regular_at};
use crate::error::{Error, Result};
use crate::scope::Scope;

/// Visit an entry, omit its descendants, or end the entire walk.
pub(super) enum Visit {
    Continue,
    Prune,
    Stop,
}

/// Traversal descends only into ordinary directories and searches only regular files.
/// A link name can still match a Glob, without following it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    File,
    Directory,
    Other,
}

impl Kind {
    fn of(file: bool, directory: bool) -> Self {
        if file {
            Self::File
        } else if directory {
            Self::Directory
        } else {
            Self::Other
        }
    }

    pub fn is_file(self) -> bool {
        self == Self::File
    }
    pub fn is_dir(self) -> bool {
        self == Self::Directory
    }
}

/// Metadata obtained by enumerating the open parent. Reading uses the same parent handle.
pub(super) struct Entry<'a> {
    pub path: PathBuf,
    pub name: OsString,
    pub kind: Kind,
    parent: &'a Dir,
}

impl Entry<'_> {
    pub fn open_file(&self) -> io::Result<File> {
        open_regular_at(self.parent, &self.name)
    }
}

struct Frame {
    dir: Dir,
    path: PathBuf,
    entries: Box<dyn Iterator<Item = (OsString, Kind)>>,
}

/// Rules at one directory, ordered by ripgrep/fd's source priority.
struct Rules {
    custom: Gitignore,
    ignore: Gitignore,
    gitignore: Gitignore,
    exclude: Gitignore,
    repository: bool,
}

struct IgnoreFiles<'a> {
    /// Cap for project-controlled paths in rule files, including linked Git directories.
    base: &'a Dir,
    base_path: &'a Path,
    custom: &'static str,
}

impl IgnoreFiles<'_> {
    /// Resolve a project-controlled config pointer to its canonical spelling, then open
    /// only below the retained scope directory, one non-link component at a time.
    fn open(&self, candidate: &Path) -> Option<File> {
        let target = candidate.canonicalize().ok()?;
        let relative = target.strip_prefix(self.base_path).ok()?;
        let mut dir = self.base.try_clone().ok()?;
        for component in relative.parent()?.components() {
            dir = dir.open_dir_nofollow(component.as_os_str()).ok()?;
        }
        let name = relative.file_name()?;
        open_regular_at(&dir, name).ok()
    }

    fn read(&self, dir: &Dir, path: &Path, name: &str) -> Option<File> {
        let meta = dir.symlink_metadata(name).ok()?;
        if meta.is_file() {
            return open_regular_at(dir, name.as_ref()).ok();
        }
        if meta.is_symlink() {
            return self.open(&path.join(name));
        }
        None
    }

    fn load(&self, dir: &Dir, path: &Path) -> Rules {
        let dot_git = dir.symlink_metadata(".git").ok();
        let exclude = match dot_git.as_ref() {
            Some(m) if m.is_dir() => self.open(&path.join(".git/info/exclude")),
            Some(m) if m.is_file() => {
                self.read(dir, path, ".git")
                    .and_then(first_line)
                    .and_then(|pointer| {
                        let git_dir = path.join(pointer.strip_prefix("gitdir: ")?);
                        let common = self.open(&git_dir.join("commondir")).and_then(first_line)?;
                        self.open(&git_dir.join(common).join("info/exclude"))
                    })
            }
            _ => None,
        };
        let rules = |name| compile_rules(path, self.read(dir, path, name));
        Rules {
            custom: rules(self.custom),
            ignore: rules(".ignore"),
            gitignore: rules(".gitignore"),
            exclude: compile_rules(path, exclude),
            repository: dot_git.is_some() || dir.symlink_metadata(".jj").is_ok(),
        }
    }
}

fn first_line(file: File) -> Option<String> {
    BufReader::new(file).lines().next()?.ok()
}

/// An unreadable ignore file or malformed pattern is skipped, as by the native search tools;
/// valid lines preceding a malformed line remain effective.
fn compile_rules(path: &Path, file: Option<File>) -> Gitignore {
    let Some(file) = file else {
        return Gitignore::empty();
    };
    let mut builder = GitignoreBuilder::new(path);
    for (i, line) in BufReader::new(file)
        .lines()
        .map_while(std::result::Result::ok)
        .enumerate()
    {
        let line = if i == 0 {
            line.trim_start_matches('\u{feff}')
        } else {
            &line
        };
        let _ = builder.add_line(None, line);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn ignored(
    path: &Path,
    is_dir: bool,
    layers: &[Rules],
    require_git: bool,
    global: &Gitignore,
    overrides: Option<&Override>,
) -> bool {
    if let Some(rule) = overrides {
        let m = rule.matched(path, is_dir);
        if !m.is_none() {
            return m.is_ignore();
        }
    }
    // Each source has precedence over the next at every depth. Within one source,
    // the nearest matching directory wins, including its negation rules.
    let matched = |layers: &[Rules], select: fn(&Rules) -> &Gitignore| {
        layers.iter().rev().find_map(|layer| {
            let rule = select(layer).matched(path, is_dir);
            (!rule.is_none()).then(|| rule.is_ignore())
        })
    };
    let local = matched(layers, |r| &r.custom).or_else(|| matched(layers, |r| &r.ignore));
    if let Some(excluded) = local {
        return excluded;
    }
    let git_layers = if require_git {
        let Some(root) = layers.iter().rposition(|r| r.repository) else {
            return false;
        };
        &layers[root..]
    } else {
        layers
    };
    if let Some(excluded) =
        matched(git_layers, |r| &r.gitignore).or_else(|| matched(git_layers, |r| &r.exclude))
    {
        return excluded;
    }
    global.matched(path, is_dir).is_ignore()
}

impl Frame {
    fn new(dir: Dir, path: PathBuf, sorted: bool) -> io::Result<Self> {
        #[cfg(not(windows))]
        let entries = {
            let entries = dir.entries()?.filter_map(|entry| {
                // Directory entries concurrently removed or unreadable are skipped.
                let entry = entry.ok()?;
                let kind = entry.file_type().ok()?;
                Some((entry.file_name(), Kind::of(kind.is_file(), kind.is_dir())))
            });
            if sorted {
                let mut names: Vec<_> = entries.collect();
                names.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                Box::new(names.into_iter()) as Box<dyn Iterator<Item = _>>
            } else {
                Box::new(entries)
            }
        };
        #[cfg(windows)]
        let entries = {
            use std::os::windows::fs::MetadataExt as _;
            // cap-primitives 4.0.3 strips verbatim UNC prefixes before FindFirstFile.
            // Use the original absolute path while all directory handles deny delete.
            let mut names = crate::bound::with_pinned_windows_path(&dir, &path, |parent| {
                let entries = std::fs::read_dir(parent)?.filter_map(|e| {
                    let entry = e.ok()?;
                    let m = entry.metadata().ok()?;
                    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                    let kind = if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        Kind::Other
                    } else {
                        Kind::of(m.is_file(), m.is_dir())
                    };
                    Some((entry.file_name(), kind))
                });
                Ok(entries.collect::<Vec<_>>())
            })?;
            if sorted {
                names.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            }
            Box::new(names.into_iter()) as Box<dyn Iterator<Item = _>>
        };
        Ok(Self { dir, path, entries })
    }

    fn verify_child(&self, child: &Frame) -> Result<()> {
        let check = || -> io::Result<bool> {
            let name = child
                .path
                .file_name()
                .ok_or_else(|| io::Error::other("missing child name"))?;
            let current = self.dir.open_dir_nofollow(name)?.dir_metadata()?;
            let held = child.dir.dir_metadata()?;
            Ok((current.dev(), current.ino()) == (held.dev(), held.ino()))
        };
        if !check().map_err(|e| Error::io(&child.path, e))? {
            return Err(Error::coded(
                &child.path,
                "ESTALE",
                "the search directory changed",
            ));
        }
        Ok(())
    }
}

/// Selects the ignore rules and output order of the corresponding native tool.
#[derive(Clone, Copy)]
pub(super) enum Search<'a> {
    Glob,
    Grep(Option<&'a Override>),
    Mentions,
}

/// Glob and Grep sort each directory by name. Composer mentions keep native order.
/// On Unix their enumeration is lazy, including for a single large directory.
pub(super) fn visit(
    scope: &Scope,
    root: &BoundPath,
    search: Search<'_>,
    mut visit_entry: impl FnMut(&Entry<'_>) -> Result<Visit>,
) -> Result<()> {
    let (custom, require_git, overrides, sorted) = match search {
        Search::Glob => (".fdignore", false, None, true),
        Search::Grep(overrides) => (".rgignore", true, overrides, true),
        Search::Mentions => (".fdignore", false, None, false),
    };
    let path = root.path();
    let base_path = scope.search_root(path).unwrap_or(path);
    let base = if base_path == path {
        root.open_dir()?
    } else {
        scope.bind_search_ancestor(root, base_path)?.open_dir()?
    };
    let loader = IgnoreFiles {
        base: &base,
        base_path,
        custom,
    };
    let global = Gitignore::global().0;
    let mut layers = Vec::new();
    let mut ancestors: Vec<_> = path
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(base_path))
        .collect();
    ancestors.reverse();
    for ancestor in ancestors {
        let bound = scope.bind_search_ancestor(root, ancestor)?;
        layers.push(loader.load(&bound.open_dir()?, ancestor));
        bound.verify()?;
    }
    let mut stack = Vec::new();
    let first =
        Frame::new(root.open_dir()?, path.to_owned(), sorted).map_err(|e| Error::io(path, e))?;
    layers.push(loader.load(&first.dir, path));
    stack.push(first);
    while let Some(frame) = stack.last_mut() {
        let Some((name, kind)) = frame.entries.next() else {
            let done = stack.pop().expect("current directory");
            if let Some(parent) = stack.last() {
                parent.verify_child(&done)?;
            }
            layers.pop();
            continue;
        };
        let path = frame.path.join(&name);
        if ignored(
            &path,
            kind.is_dir(),
            &layers,
            require_git,
            &global,
            overrides,
        ) {
            continue;
        }
        let entry = Entry {
            path,
            name,
            kind,
            parent: &frame.dir,
        };
        match visit_entry(&entry)? {
            Visit::Stop => break,
            Visit::Prune => continue,
            Visit::Continue if !entry.kind.is_dir() => continue,
            Visit::Continue => {}
        }
        // An unreadable or removed child is skipped, as by WalkBuilder. Once a
        // directory is open its identity must still match before publishing any results.
        if let Ok(child) = frame
            .dir
            .open_dir_nofollow(&entry.name)
            .and_then(|dir| Frame::new(dir, entry.path, sorted))
        {
            layers.push(loader.load(&child.dir, &child.path));
            stack.push(child);
        }
    }
    for pair in stack.windows(2) {
        pair[0].verify_child(&pair[1])?;
    }
    root.verify()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn closer_rules_negations_overrides_and_repository_excludes() {
        let tree = TempTree::new("walk-rule-priorities");
        tree.file("ws/.git/info/exclude", "hidden.txt\n");
        tree.file("ws/.gitignore", "*.txt\n!visible.txt\n");
        tree.file("ws/.ignore", "keep.txt\n");
        tree.file("ws/.fdignore", "!keep.txt\n");
        tree.file("ws/sub/.gitignore", "!other.txt\n");
        tree.file("ws/sub/.ignore", "!visible.txt\n");
        tree.file("ws/sub/.fdignore", "visible.txt\n");
        for name in ["keep", "hidden", "visible", "other"] {
            tree.file(&format!("ws/sub/{name}.txt"), "needle");
        }
        let root = tree.path("ws");
        let scope = Scope::new(&root, &root).expect("scope");
        let found = crate::glob(&scope, "sub", "*.txt", &[], None).expect("glob");
        assert_eq!(found.matches, ["keep.txt", "other.txt"]);
        let query = crate::GrepQuery {
            pattern: "needle",
            glob: Some("hidden.txt"),
            ..crate::GrepQuery::default()
        };
        let found = crate::grep(&scope, "sub", &query).expect("grep override");
        assert_eq!(found.match_count, 1);
        assert_eq!(found.lines[0].path, "hidden.txt");
    }

    #[test]
    fn worktree_excludes_under_the_workspace_are_read_relative_to_the_git_pointer() {
        let tree = TempTree::new("walk-worktree-excludes");
        tree.file("workspace/repo/.git/info/exclude", "build.txt\n");
        tree.file("workspace/repo/.git/worktrees/linked/commondir", "../..\n");
        tree.file(
            "workspace/linked/.git",
            "gitdir: ../repo/.git/worktrees/linked\n",
        );
        tree.file("workspace/linked/build.txt", "artifact");
        tree.file("workspace/linked/source.txt", "source");
        let base = tree.path("workspace");
        let scope = Scope::new(&base, &base).expect("scope");
        let found = crate::glob(&scope, "linked", "*.txt", &[], None).expect("glob");
        assert_eq!(found.matches, ["source.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn ignore_files_can_link_to_rules_within_the_authorized_workspace() {
        let tree = TempTree::new("walk-shared-filters");
        tree.file("workspace/filters/rules", "hidden.txt\n");
        tree.file("workspace/child/hidden.txt", "fixture");
        tree.file("workspace/child/visible.txt", "fixture");
        tree.symlink("../filters/rules", "workspace/child/.fdignore");
        let root = tree.path("workspace");
        let scope = Scope::new(&root, &root).expect("scope");
        assert_eq!(
            crate::glob(&scope, "child", "*.txt", &[], None)
                .expect("glob")
                .matches,
            ["visible.txt"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_move_before_early_stop_invalidates_the_walk() {
        let tree = TempTree::new("walk-moved");
        tree.file("ws/src/note.txt", "ordinary fixture");
        let root = tree.path("ws");
        let scope = Scope::new(&root, &root).expect("scope");
        let bound = scope.bind(".", crate::Access::Read).expect("bind");
        let result = visit(&scope, &bound, Search::Glob, |entry| {
            if entry.name == "note.txt" {
                std::fs::rename(tree.path("ws/src"), tree.path("ws/renamed"))
                    .expect("move directory");
                return Ok(Visit::Stop);
            }
            Ok(Visit::Continue)
        });
        assert!(
            result.is_err(),
            "the directory identity must be rechecked even at the match limit"
        );
    }
}
