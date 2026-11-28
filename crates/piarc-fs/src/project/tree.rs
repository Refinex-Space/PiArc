//! Directory pages retain only the first visible rows and an optional reveal target.
use super::{Access, Error, FileKind, Result, Scope, Value, json, relative};
use crate::{bound::BoundPath, display};
use std::{collections::BTreeMap, ffi::OsString};

const PAGE_SIZE: usize = 500;

pub(super) fn excluded(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | ".DS_Store")
}

/// Lists one directory, with directories before regular files, describing unresolved links
/// without opening their targets. A reveal can keep its named child in a capped page.
///
/// # Errors
/// The directory is unreadable, missing, or outside the retained directory.
pub fn list(scope: &Scope, path: &str, include_child: Option<&str>) -> Result<Value> {
    let requested = relative(path, true)?;
    let bound = scope.bind(requested, Access::Read)?;
    let dir = bound.open_dir()?;
    let mut rows = BTreeMap::new();
    let mut total = 0;
    let mut retained = None;
    let mut visit = |name: OsString, is_directory: bool, is_file: bool, is_link: bool| {
        let Ok(name) = name.into_string() else {
            return;
        };
        if excluded(&name) {
            return;
        }
        let rel = if requested == "." {
            name.clone()
        } else {
            format!("{requested}/{name}")
        };
        let (kind, link) = if is_link {
            describe_link(scope, &bound, &dir, &name)
        } else {
            (
                if is_directory {
                    FileKind::Directory
                } else if is_file {
                    FileKind::File
                } else {
                    FileKind::Other
                },
                None,
            )
        };
        let key = (
            kind != FileKind::Directory,
            name.to_lowercase(),
            name.clone(),
        );
        total += 1;
        if rows.len() == PAGE_SIZE
            && rows.last_key_value().is_some_and(|(max, _)| &key > max)
            && include_child != Some(&name)
        {
            return;
        }
        let mut item = json!({"name":name,"path":rel,"kind":kind});
        if let Some(link) = link {
            item["link"] = link;
        }
        if include_child == Some(&name) {
            retained = Some((key.clone(), item.clone()));
        }
        rows.insert(key, item);
        if rows.len() > PAGE_SIZE {
            rows.pop_last();
        }
    };
    visit_children(&bound, &dir, &mut visit)?;
    if let Some((key, item)) = retained
        && !rows.contains_key(&key)
    {
        rows.pop_last();
        rows.insert(key, item);
    }
    bound.verify()?;
    Ok(json!({"entries":rows.into_values().collect::<Vec<_>>(),"truncated":total>PAGE_SIZE}))
}

fn visit_children(
    bound: &BoundPath,
    dir: &cap_std::fs::Dir,
    mut visit: impl FnMut(OsString, bool, bool, bool),
) -> Result<()> {
    #[cfg(not(windows))]
    for entry in dir.entries().map_err(|e| Error::io(bound.path(), e))? {
        let entry = entry.map_err(|e| Error::io(bound.path(), e))?;
        let ty = match entry.file_type() {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(Error::io(bound.path(), e)),
        };
        visit(
            entry.file_name(),
            ty.is_dir(),
            ty.is_file(),
            ty.is_symlink(),
        );
    }
    #[cfg(windows)]
    crate::bound::with_pinned_windows_path(dir, bound.path(), |p| {
        use std::os::windows::fs::MetadataExt as _;
        for entry in std::fs::read_dir(p)? {
            let entry = entry?;
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            visit(
                entry.file_name(),
                meta.is_dir(),
                meta.is_file(),
                meta.file_attributes() & 0x400 != 0,
            );
        }
        Ok(())
    })
    .map_err(|e| Error::io(bound.path(), e))?;
    Ok(())
}

fn describe_link(
    scope: &Scope,
    bound: &BoundPath,
    dir: &cap_std::fs::Dir,
    name: &str,
) -> (FileKind, Option<Value>) {
    let target = dir
        .read_link_contents(name)
        .map(|p| display(&p))
        .unwrap_or_default();
    let full = display(&bound.path().join(name));
    let inner = scope.bind(&full, Access::Read);
    let (kind, state) = match inner.and_then(|b| b.metadata()) {
        Ok(m) => (
            if m.is_dir() {
                FileKind::Directory
            } else if m.is_file() {
                FileKind::File
            } else {
                FileKind::Other
            },
            "ok",
        ),
        Err(Error::NeedsApproval { .. } | Error::OutsideWorkspace { .. }) => {
            (FileKind::Other, "external")
        }
        Err(e) if e.code() == Some("ELOOP") => (FileKind::Other, "cycle"),
        Err(_) => (FileKind::Other, "dangling"),
    };
    (kind, Some(json!({"state":state,"target":target})))
}
