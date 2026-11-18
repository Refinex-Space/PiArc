//! Loaded settings: every layer of a [`LayerTable`] read, checked and merged.
//!
//! - A file that is not valid JSON or has a schema error is skipped as a whole (at load) and
//!   reported with its path, the JSON Pointer and the reason; the other layers load normally.
//!   Unknown keys are warnings and do not skip the file.
//! - [`Settings::reload`] re-reads the files. A file that became invalid keeps its last valid
//!   content in the merge (and is reported); a file that disappeared becomes empty.
//! - Project-scope layers lose their executable values (hooks, allow rules) while the
//!   project is not trusted.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::layers::{LayerSpec, LayerTable, Scope, Source};
use crate::merge::{changed_keys, merge_all};
use crate::schema::{Severity, validate};
use crate::trust::TrustState;

/// A problem with one settings file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// The layer.
    pub layer: &'static str,
    /// The file, for file layers.
    pub file: Option<PathBuf>,
    /// JSON Pointer of the value (`""` for the whole file).
    pub pointer: String,
    /// What is wrong.
    pub message: String,
    /// An error skips the file; a warning only ignores the key.
    pub severity: Severity,
}

/// How a layer stands after the last load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LayerStatus {
    /// Read and valid.
    Loaded,
    /// The file does not exist (an empty layer).
    Missing,
    /// Invalid and never valid since loading: not used.
    Invalid,
    /// Invalid now; its last valid content is still used.
    Stale,
}

#[derive(Debug, Clone)]
struct LayerState {
    status: LayerStatus,
    /// The content used in the merge (the last valid one).
    value: Option<Value>,
}

/// The result of [`Settings::reload`] and [`Settings::set_trust`].
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// JSON Pointers of merged values that changed.
    pub changed: Vec<String>,
    /// Problems found while reading (errors and warnings).
    pub issues: Vec<Issue>,
}

/// The settings of one workspace.
#[derive(Debug)]
pub struct Settings {
    table: LayerTable,
    states: Vec<LayerState>,
    trust: TrustState,
    merged: Value,
    issues: Vec<Issue>,
}

impl Settings {
    /// Reads every layer of `table` and merges them for a project with `trust`.
    #[must_use]
    pub fn load(table: LayerTable, trust: TrustState) -> Self {
        let mut settings = Self {
            states: vec![
                LayerState {
                    status: LayerStatus::Missing,
                    value: None,
                };
                table.layers().len()
            ],
            table,
            trust,
            merged: Value::Object(serde_json::Map::new()),
            issues: Vec::new(),
        };
        settings.reload();
        settings
    }

    /// Re-reads the layers and merges again; see the module docs for invalid files.
    pub fn reload(&mut self) -> Change {
        let mut issues = Vec::new();
        for (spec, state) in self.table.layers().iter().zip(&mut self.states) {
            match read_layer(spec) {
                Read::Missing => {
                    *state = LayerState {
                        status: LayerStatus::Missing,
                        value: None,
                    };
                }
                Read::Valid(value, warnings) => {
                    issues.extend(warnings);
                    *state = LayerState {
                        status: LayerStatus::Loaded,
                        value: Some(value),
                    };
                }
                Read::Invalid(errors) => {
                    issues.extend(errors);
                    state.status = if state.value.is_some() {
                        LayerStatus::Stale
                    } else {
                        LayerStatus::Invalid
                    };
                }
            }
        }
        self.issues.clone_from(&issues);
        Change {
            changed: self.remerge(),
            issues,
        }
    }

    /// Changes the project's trust and merges again.
    pub fn set_trust(&mut self, trust: TrustState) -> Change {
        self.trust = trust;
        Change {
            changed: self.remerge(),
            issues: Vec::new(),
        }
    }

    fn remerge(&mut self) -> Vec<String> {
        let trusted = self.trust.is_trusted();
        let values: Vec<Value> = self
            .table
            .layers()
            .iter()
            .zip(&self.states)
            .filter_map(|(spec, state)| {
                let mut value = state.value.clone()?;
                let project = spec.scope == Scope::Project;
                let mode = value
                    .pointer("/permissions/defaultMode")
                    .and_then(Value::as_str);
                if project
                    && (matches!(mode, Some("auto" | "bypassPermissions"))
                        || (!trusted && mode == Some("acceptEdits")))
                {
                    remove_pointer(&mut value, "/permissions/defaultMode");
                }
                if project && !trusted {
                    for pointer in spec.executable {
                        remove_pointer(&mut value, pointer);
                    }
                }
                Some(value)
            })
            .collect();
        let merged = merge_all(&values);
        let changed = changed_keys(&self.merged, &merged);
        self.merged = merged;
        changed
    }

    /// Executable items in the actual bytes loaded from project files. Use this alongside
    /// the live inventory when authorizing a merge, so a concurrent file replacement cannot
    /// apply a different rule from the one that was inspected.
    #[must_use]
    pub fn project_items(&self, checkout: &Path) -> Vec<crate::Item> {
        let mut items = BTreeSet::new();
        for (layer, state) in self.table.layers().iter().zip(&self.states) {
            if layer.scope != Scope::Project {
                continue;
            }
            if let (Some(path), Some(value)) = (layer.file(), state.value.as_ref()) {
                let source = path
                    .strip_prefix(checkout)
                    .unwrap_or(path)
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                crate::executables::settings_items(&source, value, &mut items);
            }
        }
        items.into_iter().collect()
    }

    /// The merged settings.
    #[must_use]
    pub fn merged(&self) -> &Value {
        &self.merged
    }

    /// The merged value at a JSON Pointer.
    #[must_use]
    pub fn get(&self, pointer: &str) -> Option<&Value> {
        self.merged.pointer(pointer)
    }

    /// The trust the merge was made for.
    #[must_use]
    pub fn trust(&self) -> TrustState {
        self.trust
    }

    /// Problems of the last read.
    #[must_use]
    pub fn issues(&self) -> &[Issue] {
        &self.issues
    }

    /// Each layer's id and status, lowest precedence first.
    #[must_use]
    pub fn statuses(&self) -> Vec<(&'static str, LayerStatus)> {
        self.table
            .layers()
            .iter()
            .zip(&self.states)
            .map(|(spec, state)| (spec.id, state.status))
            .collect()
    }

    /// The layer table.
    #[must_use]
    pub fn table(&self) -> &LayerTable {
        &self.table
    }

    /// Whether `path` is one of the layer files (for routing file change notifications).
    #[must_use]
    pub fn watches(&self, path: &Path) -> bool {
        self.table.files().any(|file| file == path)
    }
}

enum Read {
    Missing,
    Valid(Value, Vec<Issue>),
    Invalid(Vec<Issue>),
}

fn read_layer(spec: &LayerSpec) -> Read {
    let (text, file) = match &spec.source {
        Source::Value(value) => return check(spec, None, value.clone()),
        Source::File(path) => match std::fs::read(path) {
            Ok(bytes) => (bytes, path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Read::Missing,
            Err(error) => {
                return Read::Invalid(vec![issue(
                    spec,
                    Some(path),
                    "",
                    format!("cannot read the file: {error}"),
                    Severity::Error,
                )]);
            }
        },
    };
    let text = text.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&text);
    if text.iter().all(u8::is_ascii_whitespace) {
        // An empty file is an empty layer, as a missing one.
        return Read::Valid(Value::Object(serde_json::Map::new()), Vec::new());
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(value) => check(spec, Some(file), value),
        Err(error) => Read::Invalid(vec![issue(
            spec,
            Some(file),
            "",
            format!("not valid JSON: {error}"),
            Severity::Error,
        )]),
    }
}

fn check(spec: &LayerSpec, file: Option<&Path>, value: Value) -> Read {
    let findings = validate(&value, spec.schema);
    let issues: Vec<Issue> = findings
        .into_iter()
        .map(|f| issue(spec, file, &f.pointer, f.message, f.severity))
        .collect();
    if issues.iter().any(|i| i.severity == Severity::Error) {
        Read::Invalid(issues)
    } else {
        Read::Valid(value, issues)
    }
}

fn issue(
    spec: &LayerSpec,
    file: Option<&Path>,
    pointer: &str,
    message: String,
    severity: Severity,
) -> Issue {
    Issue {
        layer: spec.id,
        file: file.map(Path::to_owned),
        pointer: pointer.to_owned(),
        message,
        severity,
    }
}

/// Removes the value at `pointer` (`/a/b`, unescaped tokens only).
fn remove_pointer(value: &mut Value, pointer: &str) {
    let Some((parent, last)) = pointer.rsplit_once('/') else {
        return;
    };
    let target = if parent.is_empty() {
        Some(value)
    } else {
        value.pointer_mut(parent)
    };
    if let Some(Value::Object(map)) = target {
        map.remove(last);
    }
}
