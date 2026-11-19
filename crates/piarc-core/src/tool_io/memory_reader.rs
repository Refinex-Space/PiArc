//! Blocking memory discovery for one session. Only fixed memory filenames have implicit
//! authority outside the workspace. An import or a redirected filename needs its own decision.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_fs::{Scope, display, encoding};
use piarc_protocol::memory::MemoryFile;

mod markdown;
#[cfg(test)]
mod tests;

const FILE_LIMIT: u64 = 4 * 1024 * 1024;
const IMPORT_DEPTH: usize = 4;

/// Keep already-observed sources when an approval interrupts expansion. The authorized
/// target is opened only after the user answers, even when it needs a nested import.
#[derive(Clone, Default)]
pub(super) struct Inputs {
    sources: Vec<PathBuf>,
    targets: HashMap<PathBuf, Option<PathBuf>>,
    contents: HashMap<PathBuf, Option<Arc<str>>>,
}

#[derive(Clone)]
pub(super) struct Collection {
    pub(super) files: Vec<MemoryFile>,
    pub(super) pending: Vec<PathBuf>,
    pub(super) inputs: Option<Inputs>,
}

pub(super) fn collect(
    scope: &Scope,
    home: Option<&Path>,
    data: &Path,
    directories: &[String],
    read_both: bool,
    decide: impl FnMut(&Path) -> Option<bool>,
) -> io::Result<Collection> {
    let mut sources = Vec::new();
    if let Some(home) = home {
        user_source(home, ".claude/CLAUDE.md", &mut sources)?;
    }
    user_source(data, "MEMORY.md", &mut sources)?;
    let mut ancestors: Vec<_> = scope.cwd().ancestors().collect();
    ancestors.reverse();
    // On Windows the system temp directory often sits *below* the login home. An injected
    // home must also replace its place in the ancestor search, not just the user-level file.
    let system_home = std::env::home_dir().and_then(|p| p.canonicalize().ok());
    let configured_home = home.and_then(|p| p.canonicalize().ok());
    for dir in ancestors {
        if system_home.as_deref() != Some(dir) || configured_home == system_home {
            directory_sources(dir, read_both, &mut sources)?;
        }
    }
    let mut visited = HashSet::new();
    for requested in directories {
        let dir = scope.locate(requested).map_err(io::Error::other)?;
        if let Ok(relative) = dir.strip_prefix(scope.cwd()) {
            let mut current = scope.cwd().to_owned();
            for part in relative.components() {
                current.push(part);
                if visited.insert(current.clone()) {
                    directory_sources(&current, read_both, &mut sources)?;
                }
            }
        }
    }
    Inputs {
        sources,
        ..Inputs::default()
    }
    .expand(scope, home, decide)
}

impl Inputs {
    pub(super) fn expand(
        mut self,
        scope: &Scope,
        home: Option<&Path>,
        decide: impl FnMut(&Path) -> Option<bool>,
    ) -> io::Result<Collection> {
        let mut reader = Reader {
            scope,
            home,
            decide,
            seen: HashSet::new(),
            pending: Vec::new(),
            targets: &mut self.targets,
            contents: &mut self.contents,
        };
        let mut files = Vec::new();
        for source in &self.sources {
            if let Some(file) = reader.document(source, 0)? {
                files.push(file);
            }
        }
        let pending = reader.pending;
        Ok(Collection {
            files,
            inputs: (!pending.is_empty()).then_some(self),
            pending,
        })
    }
}

fn user_source(base: &Path, relative: &str, out: &mut Vec<PathBuf>) -> io::Result<()> {
    match base.canonicalize() {
        Ok(mut dir) => {
            dir.extend(Path::new(relative).components());
            out.push(dir);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(())
}

fn directory_sources(dir: &Path, both: bool, out: &mut Vec<PathBuf>) -> io::Result<()> {
    let primary = dir.join("CLAUDE.md");
    let has_primary = exists(&primary)?;
    if has_primary {
        out.push(primary);
    }
    out.push(dir.join(".claude").join("CLAUDE.md"));
    if both || !has_primary {
        out.push(dir.join("AGENTS.md"));
    }
    out.push(dir.join("CLAUDE.local.md"));
    Ok(())
}

// Inspect only the directory entry. In particular, a symlink does not grant permission
// to open its target just because the entry has a conventional memory filename.
fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(m.is_file() || m.is_symlink()),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

struct Reader<'a, F> {
    scope: &'a Scope,
    home: Option<&'a Path>,
    decide: F,
    targets: &'a mut HashMap<PathBuf, Option<PathBuf>>,
    contents: &'a mut HashMap<PathBuf, Option<Arc<str>>>,
    seen: HashSet<PathBuf>,
    pending: Vec<PathBuf>,
}

impl<F: FnMut(&Path) -> Option<bool>> Reader<'_, F> {
    fn document(&mut self, requested: &Path, depth: usize) -> io::Result<Option<MemoryFile>> {
        let target = match self.targets.entry(requested.to_owned()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let target = if depth == 0 && !exists(requested)? {
                    None
                } else {
                    Some(
                        self.scope
                            .locate(&display(requested))
                            .map_err(io::Error::other)?,
                    )
                };
                e.insert(target)
            }
        };
        let Some(target) = target.clone() else {
            return Ok(None);
        };
        let path = display(&target);
        // Ancestors and the two user files are named by Core. A symlink from those filenames
        // to a different out-of-workspace target has the same boundary as an explicit import.
        let fixed = depth == 0 && requested == target;
        if !fixed && !target.starts_with(self.scope.root()) {
            let decision = (self.decide)(&target);
            if decision != Some(true) {
                let status = if decision.is_none() {
                    if !self.pending.contains(&target) {
                        self.pending.push(target);
                    }
                    "not approved"
                } else {
                    "denied"
                };
                return Ok(Some(MemoryFile {
                    content: format!("[Memory import {status}: {path}]"),
                    path,
                }));
            }
        }
        // An imported file can live on a volume with different case rules from the
        // workspace. Canonical paths already carry the on-disk spelling.
        if !self.seen.insert(target.clone()) {
            return Ok(None);
        }
        let source = match self.contents.entry(target.clone()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(read_limited(&target)?.map(Arc::from))
            }
        };
        let Some(source) = source.clone() else {
            return Ok(None);
        };
        let dir = target
            .parent()
            .ok_or_else(|| io::Error::other("Memory file has no parent"))?;
        let content = markdown::expand(source.trim_start_matches('\u{feff}'), |reference| {
            if depth == IMPORT_DEPTH {
                return Ok(Some(format!("[Memory import depth limit: {reference}]")));
            }
            let import = match reference.strip_prefix("~/") {
                Some(suffix) => match self.home {
                    Some(home) => home.join(suffix),
                    None => return Ok(None),
                },
                None => PathBuf::from(display(dir)).join(reference),
            };
            let Some(file) = self.document(&import, depth + 1)? else {
                return Ok(None);
            };
            Ok(Some(format!(
                "\n[Memory source: {}]\n{}\n[End of memory source]\n",
                file.path, file.content
            )))
        })?;
        Ok(Some(MemoryFile { path, content }))
    }
}

fn read_limited(path: &Path) -> io::Result<Option<String>> {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() <= FILE_LIMIT {
        let mut bytes = Vec::new();
        let file = File::open(path)?;
        if !file.metadata()?.is_file() || path.canonicalize()? != path {
            return Err(io::Error::other("Memory file changed during discovery"));
        }
        file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 <= FILE_LIMIT {
            return Ok(Some(encoding::decode(encoding::detect(&bytes), &bytes)));
        }
    }
    tracing::warn!(target: "piarc_core", path = %piarc_fs::display(path), limit_bytes = FILE_LIMIT, "Skipped oversized memory file");
    Ok(None)
}
