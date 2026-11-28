//! Local assets of a Markdown file. Only the session root and the specific picture directory
//! selected in the OS picker are capabilities. The agent's file scope is never extended.
#[cfg(test)]
mod tests;
mod validation;
use super::{invalid, relative};
use crate::{Access, Error, Result, Scope, atomic, display};
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use url::Url;

/// Largest image import or embedded image preview.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Preferences are read only from the user's own file. The directory identity belongs to
/// the trusted native picker, so the renderer can choose its mode but cannot supply a grant.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub mode: Location,
    pub folder: String,
    pub link: LinkStyle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<Directory>,
}
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Location {
    Reference,
    Document,
    #[default]
    Assets,
    Named,
    Relative,
    Selected,
}
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkStyle {
    #[default]
    RelativeDot,
    Relative,
    Absolute,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Directory {
    path: PathBuf,
    identity: String,
}
impl Directory {
    /// Binds the directory the system chooser returned to its current filesystem identity.
    ///
    /// # Errors
    /// The selection is not a local, existing, accessible directory.
    pub fn selected(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || display(path).starts_with("//")
            || display(path).starts_with("\\\\")
        {
            return Err(invalid("expected a local directory"));
        }
        let scope = Scope::new(path, path)?;
        if crate::access::protected_component(
            scope.root(),
            cfg!(windows) || cfg!(target_os = "macos"),
        )
        .is_some()
        {
            return Err(invalid("image directory is protected"));
        }
        let (dev, ino) = scope.root_identity();
        Ok(Self {
            path: scope.root().to_owned(),
            identity: format!("{dev}:{ino}"),
        })
    }
    fn scope(&self) -> Result<Scope> {
        let scope = Scope::new(&self.path, &self.path)?;
        let (dev, ino) = scope.root_identity();
        if scope.root() != self.path || format!("{dev}:{ino}") != self.identity {
            return Err(invalid("the image directory changed; select it again"));
        }
        Ok(scope)
    }
    #[must_use]
    pub fn display(&self) -> String {
        display(&self.path)
    }
}
fn reserved(part: &str) -> bool {
    let prefix = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(prefix.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || prefix
            .strip_prefix("COM")
            .or_else(|| prefix.strip_prefix("LPT"))
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}
/// Subdirectory templates are portable between both desktop platforms.
/// # Errors
/// The resulting directory could escape the document's folder or is not a portable name.
pub fn folder(template: &str, stem: &str) -> Result<String> {
    let value = template
        .strip_prefix("./")
        .unwrap_or(template)
        .replace("${filename}", stem);
    if value.len() > 240
        || relative(&value, false).is_err()
        || value.split('/').any(|p| {
            p.trim() != p
                || p.ends_with('.')
                || p.contains([':', '<', '>', '|', '"', '?', '*', '$'])
                || reserved(p)
        })
    {
        return Err(invalid("invalid image subdirectory"));
    }
    Ok(value)
}
fn document<'a>(scope: &Scope, path: &'a str) -> Result<(&'a Path, PathBuf)> {
    relative(path, false)?;
    let p = Path::new(path);
    if !p.extension().and_then(|v| v.to_str()).is_some_and(|s| {
        ["md", "mdx", "markdown", "mdown", "mkd"].contains(&s.to_ascii_lowercase().as_str())
    }) {
        return Err(invalid("expected a Markdown document"));
    }
    let bound = scope.bind(path, Access::Read)?;
    let _ = bound.open_file()?;
    Ok((
        p,
        bound
            .path()
            .parent()
            .ok_or_else(|| invalid("invalid document directory"))?
            .to_owned(),
    ))
}
fn link(base: &Path, target: &Path, style: LinkStyle) -> Result<String> {
    let base = PathBuf::from(display(base));
    let target = PathBuf::from(display(target));
    let from = Url::from_directory_path(&base).map_err(|()| invalid("invalid document path"))?;
    let to = Url::from_file_path(&target).map_err(|()| invalid("invalid image path"))?;
    let mut value =
        if style != LinkStyle::Absolute && base.components().next() == target.components().next() {
            let relative = from
                .make_relative(&to)
                .ok_or_else(|| invalid("cannot make image reference"))?;
            if style == LinkStyle::RelativeDot && !relative.starts_with("../") {
                format!("./{relative}")
            } else {
                relative
            }
        } else {
            to.to_string()
        };
    for (c, encoded) in [('(', "%28"), (')', "%29"), ('[', "%5B"), (']', "%5D")] {
        value = value.replace(c, encoded);
    }
    Ok(value)
}
fn source_scope<'a>(scope: &'a Scope, prefs: &Preferences, path: &Path) -> Result<Cow<'a, Scope>> {
    let plain = PathBuf::from(display(path));
    if plain.starts_with(PathBuf::from(display(scope.root()))) {
        return Ok(Cow::Borrowed(scope));
    }
    let grant = prefs
        .directory
        .as_ref()
        .ok_or_else(|| invalid("image is outside the project and selected image directory"))?;
    if !plain.starts_with(PathBuf::from(display(&grant.path))) {
        return Err(invalid(
            "image is outside the project and selected image directory",
        ));
    }
    Ok(Cow::Owned(grant.scope()?))
}
fn read_bytes(scope: &Scope, absolute: &Path) -> Result<Vec<u8>> {
    let bound = scope.bind(&display(absolute), Access::Read)?;
    let mut file = bound.open_file()?;
    if file.metadata().map_err(|e| Error::io(absolute, e))?.len() > MAX_IMAGE_BYTES as u64 {
        return Err(invalid("image exceeds 8 MiB"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(absolute, e))?;
    bound.verify()?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(invalid("image exceeds 8 MiB"));
    }
    Ok(bytes)
}
/// Resolves an escaped Markdown reference for the dedicated read-only image protocol.
/// # Errors
/// The reference is not a supported local image or lies outside both bound directories.
pub fn preview(scope: &Scope, prefs: &Preferences, path: &str, reference: &str) -> Result<Value> {
    let (_, base) = document(scope, path)?;
    if reference.len() > 8192
        || reference.starts_with("//")
        || reference.contains('\\')
        || reference.chars().any(char::is_control)
    {
        return Err(invalid("invalid local image reference"));
    }
    let mut url = Url::from_directory_path(PathBuf::from(display(&base)))
        .map_err(|()| invalid("invalid document path"))?
        .join(reference)
        .map_err(|_| invalid("invalid local image reference"))?;
    if url.scheme() != "file" || url.host_str().is_some() {
        return Err(invalid("only local images can be previewed"));
    }
    url.set_query(None);
    url.set_fragment(None);
    let target = url
        .to_file_path()
        .map_err(|()| invalid("invalid local image path"))?;
    let scope = source_scope(scope, prefs, &target)?;
    let bytes = read_bytes(scope.as_ref(), &target)?;
    let kind = validation::inspect(&bytes)?;
    Ok(
        json!({"base64":BASE64_STANDARD.encode(bytes),"mime":kind.mime,"extension":kind.extension,"external":matches!(scope,Cow::Owned(_))}),
    )
}
/// Imports the bounded bytes sent by the native UI. Only image types may be published.
///
/// # Errors
/// Invalid base64, unsupported image, unavailable document, protected scope or directory change.
pub fn import_base64(
    scope: &Scope,
    prefs: &Preferences,
    path: &str,
    name: &str,
    encoded: &str,
    source: Option<&Path>,
    read_only: fn(&Path) -> bool,
) -> Result<Value> {
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| invalid("invalid image bytes"))?;
    import(scope, prefs, path, name, &bytes, source, read_only)
}
/// Publishes an original image under a free name. Equal content in a previous candidate
/// is reused. Concurrent windows race through exclusive atomic creation, never replacement.
/// # Errors
/// Invalid picture bytes, protected destinations, changed directory identity or unavailable disk.
pub fn import(
    scope: &Scope,
    prefs: &Preferences,
    path: &str,
    name: &str,
    bytes: &[u8],
    source: Option<&Path>,
    read_only: fn(&Path) -> bool,
) -> Result<Value> {
    let (doc, base) = document(scope, path)?;
    let original = scope.bind(path, Access::Write)?;
    if read_only(original.path()) {
        return Err(invalid("Markdown document is read-only"));
    }
    let kind = validation::inspect(bytes)?;
    let alt = safe_stem(name);
    if prefs.mode == Location::Reference
        && let Some(original) = source
        && original.is_absolute()
        && let Ok(owner) = source_scope(scope, prefs, original)
        && let Ok(known) = read_bytes(&owner, original)
        && known == bytes
    {
        return Ok(json!({"alt":alt,"href":link(&base,original,prefs.link)?}));
    }
    let (owner, directory) = destination(scope, prefs, doc, &base)?;
    let dir = owner.bind(&display(&directory), Access::Write)?;
    if dir.path() != directory || read_only(dir.path()) {
        return Err(invalid("image directory is redirected or protected"));
    }
    dir.mkdir()?;
    let mut candidate = String::new();
    for number in 1..=1000 {
        candidate.clear();
        if number == 1 {
            candidate.push_str(&alt);
        } else {
            candidate = format!("{alt}-{number}");
        }
        let target = directory.join(format!("{candidate}.{}", kind.extension));
        let bound = owner.bind(&display(&target), Access::Write)?;
        if bound.path() != target || read_only(bound.path()) {
            return Err(invalid("image destination is redirected or protected"));
        }
        match bound.metadata() {
            Ok(meta) if meta.is_file() && meta.len() == bytes.len() as u64 => {
                if read_bytes(&owner, &target)? == bytes {
                    return Ok(json!({"alt":alt,"href":link(&base,&target,prefs.link)?}));
                }
            }
            Ok(_) => {}
            Err(Error::NotFound { .. }) => {
                match atomic::create_bound(&bound, |f| f.write_all(bytes)) {
                    Ok(_) => return Ok(json!({"alt":alt,"href":link(&base,&target,prefs.link)?})),
                    Err(error) if error.code() == Some("EEXIST") => {
                        if read_bytes(&owner, &target)? == bytes {
                            return Ok(json!({"alt":alt,"href":link(&base,&target,prefs.link)?}));
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(invalid("too many colliding image names"))
}
fn destination<'a>(
    scope: &'a Scope,
    prefs: &Preferences,
    doc: &Path,
    base: &Path,
) -> Result<(Cow<'a, Scope>, PathBuf)> {
    if prefs.mode == Location::Selected {
        let grant = prefs
            .directory
            .as_ref()
            .ok_or_else(|| invalid("choose an image directory"))?;
        let selected = grant.scope()?;
        return Ok((Cow::Owned(selected), grant.path.clone()));
    }
    let stem = doc
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let directory = match prefs.mode {
        Location::Relative => base.join(folder(&prefs.folder, stem)?),
        Location::Named => base.join(folder("${filename}.assets", stem)?),
        Location::Document => base.to_owned(),
        Location::Assets | Location::Reference => base.join("assets"),
        Location::Selected => unreachable!("handled the selected folder above"),
    };
    Ok((Cow::Borrowed(scope), directory))
}
fn safe_stem(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let raw = leaf.rsplit_once('.').map_or(leaf, |(stem, _)| stem).trim();
    let mut stem = String::new();
    for c in raw.chars() {
        if stem.len() + c.len_utf8() > 160 {
            break;
        }
        stem.push(if c.is_control() || "<>:\"/\\|?*".contains(c) {
            '_'
        } else {
            c
        });
    }
    let stem = stem.trim_matches(['.', ' ']);
    if stem.is_empty() {
        "image".into()
    } else if reserved(stem) {
        format!("_{stem}")
    } else {
        stem.to_owned()
    }
}
