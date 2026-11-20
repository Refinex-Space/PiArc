//! Writing settings: only to the layers marked writable (`.piarc/` files and the user file),
//! through a temporary file in the same directory renamed over the target, so a reader never
//! sees half a file. Any path inside a `.claude` directory or named `.claude.json` is refused
//! with [`WriteError::ClaudeConfig`] before anything is touched (ADR-0005 rule 2), whatever
//! the layer table says.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

use crate::executables::{Category, Item};
use crate::layers::{LayerTable, ids};

/// Why a write was refused or failed.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// No layer has this id.
    #[error("there is no settings layer {0:?}")]
    UnknownLayer(String),
    /// The layer is read-only for PiArc.
    #[error("the settings layer {0:?} is not writable")]
    ReadOnly(String),
    /// The target is Claude Code configuration, which PiArc only reads.
    #[error("{} is Claude Code configuration; PiArc does not write it", path.display())]
    ClaudeConfig {
        /// The refused file.
        path: PathBuf,
    },
    /// The pointer is empty or not of the `/key/key` form.
    #[error("invalid settings key {0:?}")]
    InvalidPointer(String),
    /// The existing file is not a JSON object; it is left as it is.
    #[error("{} is not a JSON object; it was not changed", path.display())]
    NotAnObject {
        /// The file.
        path: PathBuf,
    },
    /// The local permission update could not be applied without changing other data.
    #[error("invalid settings update: {0}")]
    InvalidUpdate(String),
    /// A file system step failed; the file keeps its previous content.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The file.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
}

/// Sets (`Some`) or removes (`None`) the value at `pointer` in the file of layer `layer`,
/// creating the file, its directory and intermediate objects as needed. Returns the file.
///
/// # Errors
///
/// See [`WriteError`]. On any error the file is unchanged.
pub fn write_value(
    table: &LayerTable,
    layer: &str,
    pointer: &str,
    value: Option<Value>,
) -> Result<PathBuf, WriteError> {
    let tokens = parse_pointer(pointer)?;
    update_file(table, layer, |document| {
        apply(document, &tokens, value);
        Ok(())
    })
}

/// Append natively confirmed permissions to the project-local settings in a single
/// read-modify-write. The returned items are the only additions confirmed by this action.
///
/// # Errors
///
/// Reject malformed permissions, unexpected categories, redirected configuration paths or
/// a failed write. The same process lock protects this operation and ordinary settings edits.
pub fn append_local_permissions(
    table: &LayerTable,
    permissions: &[(Category, &str)],
) -> Result<Vec<Item>, WriteError> {
    let mut items = Vec::with_capacity(permissions.len());
    update_file(table, ids::PROJECT_LOCAL, |document| {
        for &(category, name) in permissions {
            let key = match category {
                Category::AllowRule => "allow",
                Category::AdditionalDirectory => "additionalDirectories",
                _ => {
                    return Err(WriteError::InvalidUpdate(
                        "expected an allow rule or directory".to_owned(),
                    ));
                }
            };
            if name.trim().is_empty()
                || name.chars().any(char::is_control) && category == Category::AdditionalDirectory
            {
                return Err(WriteError::InvalidUpdate(format!("invalid {key} entry")));
            }
            let permissions = document
                .as_object_mut()
                .expect("validated object")
                .entry("permissions")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| {
                    WriteError::InvalidUpdate("permissions must be an object".to_owned())
                })?;
            let list = permissions
                .entry(key)
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .filter(|list| list.iter().all(Value::is_string))
                .ok_or_else(|| {
                    WriteError::InvalidUpdate(format!("permissions.{key} must be a string list"))
                })?;
            if !list.iter().any(|v| v.as_str() == Some(name)) {
                list.push(Value::String(name.to_owned()));
            }
            items.push(Item {
                category,
                source: ".piarc/settings.local.json".to_owned(),
                name: name.to_owned(),
            });
        }
        Ok(())
    })?;
    Ok(items)
}

/// Add, replace or remove one rule of `permissions.<key>` (`allow`, `ask` or `deny`) in a
/// writable layer: `old` names the rule to replace or remove; without it `new` is appended
/// (once). Returns the file.
///
/// # Errors
///
/// The layer is read-only, the key is not a rule list, the file's list is not a string list,
/// `old` is not in it, or the write fails; the file is then unchanged.
pub fn edit_permission_rule(
    table: &LayerTable,
    layer: &str,
    key: &str,
    old: Option<&str>,
    new: Option<&str>,
) -> Result<PathBuf, WriteError> {
    if !matches!(key, "allow" | "ask" | "deny") {
        return Err(WriteError::InvalidUpdate(format!(
            "unknown rule list {key:?}"
        )));
    }
    if new.is_some_and(|r| r.trim().is_empty() || r.chars().any(char::is_control)) {
        return Err(WriteError::InvalidUpdate(
            "empty or invalid rule".to_owned(),
        ));
    }
    update_file(table, layer, |document| {
        let permissions = document
            .as_object_mut()
            .ok_or_else(|| WriteError::InvalidUpdate("settings must be an object".to_owned()))?
            .entry("permissions")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| WriteError::InvalidUpdate("permissions must be an object".to_owned()))?;
        let list = permissions
            .entry(key)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .filter(|list| list.iter().all(Value::is_string))
            .ok_or_else(|| {
                WriteError::InvalidUpdate(format!("permissions.{key} must be a string list"))
            })?;
        match old {
            Some(old) => {
                let at = list
                    .iter()
                    .position(|v| v.as_str() == Some(old))
                    .ok_or_else(|| {
                        WriteError::InvalidUpdate(format!("{old:?} is not in permissions.{key}"))
                    })?;
                match new {
                    Some(new) => list[at] = Value::String(new.to_owned()),
                    None => {
                        list.remove(at);
                    }
                }
            }
            None => {
                if let Some(new) = new
                    && !list.iter().any(|v| v.as_str() == Some(new))
                {
                    list.push(Value::String(new.to_owned()));
                }
            }
        }
        Ok(())
    })
}

// One writer in Core, including simultaneous confirmations from different windows.
static SETTINGS_WRITE: Mutex<()> = Mutex::new(());

fn update_file(
    table: &LayerTable,
    layer: &str,
    update: impl FnOnce(&mut Value) -> Result<(), WriteError>,
) -> Result<PathBuf, WriteError> {
    let _writer = SETTINGS_WRITE
        .lock()
        .map_err(|_| WriteError::InvalidUpdate("settings writer is unavailable".to_owned()))?;
    let spec = table
        .get(layer)
        .ok_or_else(|| WriteError::UnknownLayer(layer.to_owned()))?;
    let path = match (spec.writable, spec.file()) {
        (_, Some(path)) if crate::claude::is_claude_path(path) => {
            return Err(WriteError::ClaudeConfig {
                path: path.to_owned(),
            });
        }
        (true, Some(path)) => path.to_owned(),
        _ => return Err(WriteError::ReadOnly(layer.to_owned())),
    };
    // Links resolved: a repository's `.piarc` linked to `~/.claude` is still Claude Code's.
    let real = real_location(&path)?;
    if crate::claude::is_claude_path(&real) {
        return Err(WriteError::ClaudeConfig { path: real });
    }
    if layer == ids::PROJECT_LOCAL || layer == ids::PROJECT {
        // A repository must not redirect a write to another project or user file.
        for component in path.parent().into_iter().chain([path.as_path()]) {
            match fs::symlink_metadata(component) {
                Ok(meta) if redirected(&meta) => {
                    return Err(WriteError::InvalidUpdate(format!(
                        "settings path is a link: {}",
                        component.display()
                    )));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(WriteError::Io {
                        op: "cannot inspect",
                        path: component.to_owned(),
                        source,
                    });
                }
            }
        }
    }
    let mut document = match fs::read(&path) {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Value::Object(Map::new()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| WriteError::NotAnObject { path: path.clone() })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Value::Object(Map::new()),
        Err(source) => {
            return Err(WriteError::Io {
                op: "cannot read",
                path,
                source,
            });
        }
    };
    if !document.is_object() {
        return Err(WriteError::NotAnObject { path });
    }
    update(&mut document)?;
    let mut text = serde_json::to_string_pretty(&document)
        .map_err(|error| WriteError::InvalidUpdate(error.to_string()))?;
    text.push('\n');
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|source| WriteError::Io {
            op: "cannot create",
            path: dir.to_owned(),
            source,
        })?;
    }
    replace_file(&path, text.as_bytes())?;
    Ok(path)
}

/// `path` with its deepest existing ancestor canonicalized (links resolved).
fn real_location(path: &Path) -> Result<PathBuf, WriteError> {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        match fs::canonicalize(existing) {
            Ok(real) => return Ok(rest.iter().rev().fold(real, |p, name| p.join(name))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
                    return Ok(path.to_owned());
                };
                rest.push(name);
                existing = parent;
            }
            Err(source) => {
                return Err(WriteError::Io {
                    op: "cannot inspect",
                    path: existing.to_owned(),
                    source,
                });
            }
        }
    }
}

#[cfg(windows)]
fn redirected(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // FILE_ATTRIBUTE_REPARSE_POINT, including directory junctions.
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn redirected(meta: &fs::Metadata) -> bool {
    meta.is_symlink()
}

fn parse_pointer(pointer: &str) -> Result<Vec<String>, WriteError> {
    let invalid = || WriteError::InvalidPointer(pointer.to_owned());
    let rest = pointer.strip_prefix('/').ok_or_else(invalid)?;
    rest.split('/')
        .map(|token| {
            if token.is_empty() {
                Err(invalid())
            } else {
                Ok(token.replace("~1", "/").replace("~0", "~"))
            }
        })
        .collect()
}

fn apply(document: &mut Value, tokens: &[String], value: Option<Value>) {
    let Some((last, parents)) = tokens.split_last() else {
        return;
    };
    let mut current = document;
    for token in parents {
        let Value::Object(map) = current else {
            return;
        };
        let child = map
            .entry(token.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !child.is_object() {
            if value.is_none() {
                return;
            }
            *child = Value::Object(Map::new());
        }
        current = child;
    }
    if let Value::Object(map) = current {
        match value {
            Some(value) => {
                map.insert(last.clone(), value);
            }
            None => {
                map.remove(last);
            }
        }
    }
}

/// Writes `bytes` to a temporary file next to `target`, flushes it and renames it over
/// `target`. On failure the temporary file is removed and `target` is unchanged.
///
/// # Errors
/// Returns [`WriteError::ClaudeConfig`] for a target in Claude Code's configuration, and
/// [`WriteError::Io`] when the temporary file cannot be created, synced or renamed.
pub fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    if crate::claude::is_claude_path(target) {
        return Err(WriteError::ClaudeConfig {
            path: target.to_owned(),
        });
    }
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = target.with_file_name(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let io_error = |op: &'static str, path: &Path| {
        let path = path.to_owned();
        move |source| WriteError::Io { op, path, source }
    };
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(io_error("cannot create", &temp))
        .and_then(|mut file| {
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(io_error("cannot write", &temp))
        })
        .and_then(|()| fs::rename(&temp, target).map_err(io_error("cannot replace", target)));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rules_are_added_replaced_and_removed_in_writable_layers_only() {
        let dir = std::env::temp_dir().join(format!("piarc-config-rules {}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let table = LayerTable::piarc(&dir.join("data"), &dir.join("ws"));
        let read = || -> Value {
            serde_json::from_slice(
                &fs::read(dir.join("ws/.piarc/settings.local.json")).expect("file"),
            )
            .expect("json")
        };
        let edit = |old: Option<&str>, new: Option<&str>| {
            edit_permission_rule(&table, ids::PROJECT_LOCAL, "deny", old, new)
        };
        edit(None, Some("Bash(rm *)")).expect("add");
        edit(None, Some("Bash(rm *)")).expect("add once");
        edit(None, Some("Read(.env)")).expect("add");
        assert_eq!(
            read()["permissions"]["deny"],
            json!(["Bash(rm *)", "Read(.env)"])
        );
        edit(Some("Bash(rm *)"), Some("Bash(rm -rf *)")).expect("replace");
        edit(Some("Read(.env)"), None).expect("remove");
        assert_eq!(read()["permissions"]["deny"], json!(["Bash(rm -rf *)"]));
        assert!(edit(Some("missing"), None).is_err());
        assert!(edit_permission_rule(&table, ids::DEFAULTS, "deny", None, Some("x")).is_err());
        assert!(edit_permission_rule(&table, ids::USER, "other", None, Some("x")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_code_paths_are_refused_by_every_write() {
        let dir = std::env::temp_dir().join(format!("piarc-config-claude {}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let home = dir.join("home");
        let workspace = dir.join("ws");
        let table = LayerTable::workspace(&dir.join("data"), &workspace, Some(&home));
        for layer in [
            ids::CLAUDE_USER,
            ids::CLAUDE_PROJECT,
            ids::CLAUDE_PROJECT_LOCAL,
        ] {
            let error = write_value(&table, layer, "/model", Some(json!("x"))).unwrap_err();
            assert!(
                matches!(error, WriteError::ClaudeConfig { .. }),
                "{layer}: {error}"
            );
            let error =
                edit_permission_rule(&table, layer, "allow", None, Some("Read")).unwrap_err();
            assert!(
                matches!(error, WriteError::ClaudeConfig { .. }),
                "{layer}: {error}"
            );
        }
        // Even a writable layer whose file was redirected into `.claude/` is refused.
        let mut redirected = LayerTable::piarc(&workspace.join(".claude"), &workspace);
        redirected.insert(crate::LayerSpec {
            id: ids::PROJECT_LOCAL,
            precedence: crate::precedence::PROJECT_LOCAL,
            scope: crate::Scope::Project,
            source: crate::Source::File(workspace.join(".claude").join("settings.local.json")),
            format: crate::Format::Piarc,
            schema: &crate::schema::PIARC_SETTINGS,
            writable: true,
            executable: crate::layers::PIARC_EXECUTABLE,
        });
        for layer in [ids::USER, ids::PROJECT_LOCAL] {
            let error = write_value(&redirected, layer, "/model", Some(json!("x"))).unwrap_err();
            assert!(
                matches!(error, WriteError::ClaudeConfig { .. }),
                "{layer}: {error}"
            );
        }
        let error =
            append_local_permissions(&redirected, &[(Category::AllowRule, "Read")]).unwrap_err();
        assert!(matches!(error, WriteError::ClaudeConfig { .. }), "{error}");
        for target in [
            home.join(".claude.json"),
            home.join(".claude").join("x.json"),
        ] {
            let error = replace_file(&target, b"{}").unwrap_err();
            assert!(matches!(error, WriteError::ClaudeConfig { .. }), "{error}");
        }
        assert!(!home.exists() && !workspace.join(".claude").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_project_settings_directory_linked_into_claude_code_config_is_refused() {
        // R3: a repository links `.piarc` to the user's `~/.claude`; a rule saved to the
        // project file would replace `~/.claude/settings.json`.
        let dir = std::env::temp_dir().join(format!("piarc-config-link {}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let claude = dir.join("home").join(".claude");
        let workspace = dir.join("ws");
        fs::create_dir_all(&claude).expect("claude dir");
        fs::create_dir_all(&workspace).expect("workspace");
        fs::write(claude.join("settings.json"), b"{\"model\": \"kept\"}\n").expect("file");
        std::os::unix::fs::symlink(&claude, workspace.join(".piarc")).expect("link");
        let table = LayerTable::piarc(&dir.join("data"), &workspace);
        for layer in [ids::PROJECT, ids::PROJECT_LOCAL] {
            let error = write_value(&table, layer, "/model", Some(json!("x"))).unwrap_err();
            assert!(
                matches!(
                    error,
                    WriteError::ClaudeConfig { .. } | WriteError::InvalidUpdate(_)
                ),
                "{layer}: {error}"
            );
        }
        assert_eq!(
            fs::read(claude.join("settings.json")).expect("file"),
            b"{\"model\": \"kept\"}\n"
        );
        assert!(!claude.join("settings.local.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pointers_create_and_remove_nested_keys() {
        let mut doc = json!({ "permissions": { "allow": ["Read"] }, "model": "x" });
        apply(
            &mut doc,
            &parse_pointer("/permissions/deny").expect("pointer"),
            Some(json!(["Bash(rm *)"])),
        );
        apply(&mut doc, &parse_pointer("/model").expect("pointer"), None);
        apply(
            &mut doc,
            &parse_pointer("/a~1b/c").expect("pointer"),
            Some(json!(1)),
        );
        assert_eq!(
            doc,
            json!({ "permissions": { "allow": ["Read"], "deny": ["Bash(rm *)"] }, "a/b": { "c": 1 } })
        );
        for bad in ["", "model", "/", "/a//b"] {
            assert!(parse_pointer(bad).is_err(), "{bad}");
        }
    }
}
