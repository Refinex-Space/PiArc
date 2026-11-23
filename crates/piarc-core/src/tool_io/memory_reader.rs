//! Blocking memory discovery for one session. Only fixed memory filenames have implicit
//! authority outside the workspace. An import or a redirected filename needs its own decision.
//!
//! Claude Code rules (T24, [`rules`]) are memory documents too: `~/.claude/rules/` follows
//! `~/.claude/CLAUDE.md`, the workspace root's `.claude/rules/` follows its
//! `.claude/CLAUDE.md`. A rule with `paths:` is included only once a matching file was read
//! or written in the session; its frontmatter is not part of the delivered text.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_fs::{DirectoryBinding, Scope, display, encoding};
use piarc_protocol::memory::{MemoryFile, MemoryKind};

mod markdown;
mod rules;
#[cfg(test)]
mod tests;

pub(super) use rules::RuleQuery;

const FILE_LIMIT: u64 = 4 * 1024 * 1024;
const IMPORT_DEPTH: usize = 4;

#[derive(Clone)]
pub(super) enum ImportAccess {
    Allowed,
    Denied(Option<String>),
}

/// Keep already-observed sources when an approval interrupts expansion. The authorized
/// target is opened only after the user answers, even when it needs a nested import.
#[derive(Clone, Default)]
pub(super) struct Inputs {
    sources: Vec<PathBuf>,
    /// Rule sources and their `paths:` globs (`None` for an unconditional rule).
    rules: HashMap<PathBuf, Option<Vec<String>>>,
    targets: HashMap<PathBuf, Option<(PathBuf, DirectoryBinding)>>,
    contents: HashMap<PathBuf, Option<Arc<str>>>,
    /// The organization's managed `CLAUDE.md` files (T47): first, marked `managed`.
    managed: HashSet<PathBuf>,
}

#[derive(Clone)]
pub(super) struct Collection {
    pub(super) files: Vec<MemoryFile>,
    pub(super) pending: Vec<PathBuf>,
    pub(super) inputs: Option<Inputs>,
    /// A conditional rule is not included yet.
    pub(super) inactive_rules: bool,
}

#[expect(
    clippy::too_many_arguments,
    reason = "the places of one discovery: scope, home, data, managed, visited directories, choices"
)]
pub(super) fn collect(
    scope: &Scope,
    home: Option<&Path>,
    data: &Path,
    managed: &[PathBuf],
    directories: &[String],
    read_both: bool,
    query: &RuleQuery,
    decide: impl FnMut(&Path) -> Option<ImportAccess>,
) -> io::Result<Collection> {
    let mut sources = Vec::new();
    let mut managed_sources = HashSet::new();
    // The organization's managed instructions come before everything (T47).
    for file in managed {
        if let Ok(file) = file.canonicalize() {
            managed_sources.insert(file.clone());
            sources.push(file);
        }
    }
    let mut rules = rules::Selection::default();
    if let Some(home) = home {
        user_source(home, ".claude/CLAUDE.md", &mut sources)?;
        if let Ok(home) = home.canonicalize() {
            rules.add(
                scope,
                &home.join(".claude").join("rules"),
                query,
                &mut sources,
            )?;
        }
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
        if dir == scope.root() {
            // Same precedence as the root's `.claude/CLAUDE.md`, right after it.
            let nested = dir.join(".claude").join("CLAUDE.md");
            let at = sources
                .iter()
                .position(|s| *s == nested)
                .map_or(sources.len(), |i| i + 1);
            let mut found = Vec::new();
            rules.add(scope, &nested.with_file_name("rules"), query, &mut found)?;
            sources.splice(at..at, found);
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
    let inactive_rules = rules.inactive;
    let mut collection = Inputs {
        sources,
        rules: rules.globs,
        managed: managed_sources,
        ..Inputs::default()
    }
    .expand(scope, home, decide)?;
    collection.inactive_rules = inactive_rules;
    Ok(collection)
}

impl Inputs {
    pub(super) fn expand(
        mut self,
        scope: &Scope,
        home: Option<&Path>,
        decide: impl FnMut(&Path) -> Option<ImportAccess>,
    ) -> io::Result<Collection> {
        let mut reader = Reader {
            scope,
            home,
            rules: &self.rules,
            decide,
            seen: HashSet::new(),
            pending: Vec::new(),
            targets: &mut self.targets,
            contents: &mut self.contents,
        };
        let mut files = Vec::new();
        for source in &self.sources {
            if let Some(mut file) = reader.document(source, 0)? {
                if self.managed.contains(source) {
                    file.kind = Some(MemoryKind::Managed);
                }
                files.push(file);
            }
        }
        let pending = reader.pending;
        Ok(Collection {
            files,
            inputs: (!pending.is_empty()).then_some(self),
            pending,
            inactive_rules: false,
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
    rules: &'a HashMap<PathBuf, Option<Vec<String>>>,
    decide: F,
    targets: &'a mut HashMap<PathBuf, Option<(PathBuf, DirectoryBinding)>>,
    contents: &'a mut HashMap<PathBuf, Option<Arc<str>>>,
    seen: HashSet<PathBuf>,
    pending: Vec<PathBuf>,
}

impl<F: FnMut(&Path) -> Option<ImportAccess>> Reader<'_, F> {
    /// The notice that replaces an out-of-workspace document without an approval.
    fn unapproved(&mut self, target: &Path, path: &str) -> Option<String> {
        match (self.decide)(target) {
            Some(ImportAccess::Allowed) => None,
            Some(ImportAccess::Denied(feedback)) => {
                let mut note = format!("[Memory import denied: {path}]");
                if let Some(feedback) = feedback.filter(|text| !text.trim().is_empty()) {
                    note.push_str("\nUser feedback: ");
                    note.push_str(&feedback);
                }
                Some(note)
            }
            None => {
                if !self.pending.iter().any(|p| p == target) {
                    self.pending.push(target.to_owned());
                }
                Some(format!("[Memory import not approved: {path}]"))
            }
        }
    }

    fn document(&mut self, requested: &Path, depth: usize) -> io::Result<Option<MemoryFile>> {
        let target = match self.targets.entry(requested.to_owned()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let target = if depth == 0 && !exists(requested)? {
                    None
                } else {
                    let path = self
                        .scope
                        .locate(&display(requested))
                        .map_err(io::Error::other)?;
                    let binding = DirectoryBinding::capture(&path).map_err(io::Error::other)?;
                    Some((path, binding))
                };
                e.insert(target)
            }
        };
        let Some((target, binding)) = target.clone() else {
            return Ok(None);
        };
        let path = display(&target);
        let rule = if depth == 0 {
            self.rules.get(requested)
        } else {
            None
        };
        let paths = rule.cloned().flatten();
        // Ancestors and the two user files are named by Core. A symlink from those filenames
        // to a different out-of-workspace target has the same boundary as an explicit import.
        let fixed = depth == 0 && requested == target;
        if !fixed
            && !target.starts_with(self.scope.root())
            && let Some(content) = self.unapproved(&target, &path)
        {
            return Ok(Some(MemoryFile {
                path,
                content,
                paths,
                kind: None,
            }));
        }
        // An imported file can live on a volume with different case rules from the
        // workspace. Canonical paths already carry the on-disk spelling.
        if !self.seen.insert(target.clone()) {
            return Ok(None);
        }
        let source = match self.contents.entry(target.clone()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(read_limited(&target, &binding)?.map(Arc::from))
            }
        };
        let Some(source) = source.clone() else {
            return Ok(None);
        };
        let dir = target
            .parent()
            .ok_or_else(|| io::Error::other("Memory file has no parent"))?;
        let text = source.trim_start_matches('\u{feff}');
        let body = rule.map(|_| piarc_config::rules::parse(text).body);
        let content = markdown::expand(body.as_deref().unwrap_or(text), |reference| {
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
        Ok(Some(MemoryFile {
            path,
            content,
            paths,
            kind: None,
        }))
    }
}

pub(super) fn read_limited(path: &Path, binding: &DirectoryBinding) -> io::Result<Option<String>> {
    let file = match binding.open_file(path) {
        Ok(file) => file,
        Err(error)
            if matches!(error, piarc_fs::Error::NotFound { .. })
                || matches!(error.code(), Some("ENOTDIR" | "EISDIR")) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(io::Error::other(error)),
    };
    if file.metadata()?.len() <= FILE_LIMIT {
        let mut bytes = Vec::new();
        file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 <= FILE_LIMIT {
            return Ok(Some(encoding::decode(encoding::detect(&bytes), &bytes)));
        }
    }
    tracing::warn!(target: "piarc_core", path = %piarc_fs::display(path), limit_bytes = FILE_LIMIT, "Skipped oversized memory file");
    Ok(None)
}
