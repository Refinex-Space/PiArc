//! Loaded settings: every layer of a [`LayerTable`] read, checked and merged.
//!
//! - A file that is not valid JSON or has a schema error is skipped as a whole (at load) and
//!   reported with its path, the JSON Pointer and the reason; the other layers load normally.
//!   Unknown keys are warnings and do not skip the file.
//! - [`Settings::reload`] re-reads the files. A file that became invalid keeps its last valid
//!   content in the merge (and is reported); a file that disappeared becomes empty.
//! - Project-scope layers lose their executable values (hooks, allow rules) while the
//!   project is not trusted.
//! - A Claude Code layer contributes only the keys the mapping table marks active
//!   ([`crate::claude`]); the whole file is kept for the diagnostics.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::layers::{Format, LayerSpec, LayerTable, Scope, Source};
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
    /// 1-based line of a JSON syntax error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// 1-based column of a JSON syntax error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
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
pub(crate) struct LayerState {
    pub(crate) status: LayerStatus,
    /// The content used in the merge (the last valid one; for a Claude Code file, its
    /// projection).
    pub(crate) value: Option<Value>,
    /// The whole file as read with `value` (equal to it for PiArc files).
    pub(crate) raw: Option<Value>,
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

/// One layer's permission rules (see [`Settings::permission_lists`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionLists {
    /// The layer id.
    pub layer: &'static str,
    /// Who it belongs to.
    pub scope: Scope,
    /// Its file, for file layers.
    pub file: Option<PathBuf>,
    /// Whether PiArc may write it.
    pub writable: bool,
    /// `permissions.deny`.
    pub deny: Vec<String>,
    /// `permissions.ask`.
    pub ask: Vec<String>,
    /// `permissions.allow` (empty while an untrusted project's).
    pub allow: Vec<String>,
}

/// The settings of one workspace.
#[derive(Debug)]
pub struct Settings {
    pub(crate) table: LayerTable,
    pub(crate) states: Vec<LayerState>,
    pub(crate) trust: TrustState,
    pub(crate) merged: Value,
    pub(crate) issues: Vec<Issue>,
    /// Each layer's value as merged (after the trust and mode filters), by layer index.
    pub(crate) effective: Vec<Option<Value>>,
    /// Project layers whose `bypassPermissions` or `auto` default mode was left out.
    pub(crate) ignored_modes: Vec<(&'static str, String)>,
    /// Sandbox values of project layers that would loosen the sandbox, left out (T39):
    /// `(layer, JSON Pointer)`.
    pub(crate) ignored_sandbox: Vec<(&'static str, String)>,
    /// The extension packages in effect (T40), set by Core after the load
    /// ([`Settings::set_packages`]): the settings name them, Core's records say where they are.
    pub(crate) packages: crate::plugins::Packages,
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
                    raw: None,
                };
                table.layers().len()
            ],
            table,
            trust,
            merged: Value::Object(serde_json::Map::new()),
            issues: Vec::new(),
            effective: Vec::new(),
            ignored_modes: Vec::new(),
            ignored_sandbox: Vec::new(),
            packages: crate::plugins::Packages::default(),
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
                        raw: None,
                    };
                }
                Read::Valid {
                    value,
                    raw,
                    warnings,
                } => {
                    issues.extend(warnings);
                    *state = LayerState {
                        status: LayerStatus::Loaded,
                        value: Some(value),
                        raw: Some(raw),
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
        let mut ignored = Vec::new();
        let mut ignored_sandbox = Vec::new();
        let effective: Vec<Option<Value>> = self
            .table
            .layers()
            .iter()
            .zip(&self.states)
            .map(|(spec, state)| {
                let mut value = state.value.clone()?;
                let project = spec.scope == Scope::Project;
                let mode = value
                    .pointer("/permissions/defaultMode")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if project && matches!(mode.as_deref(), Some("auto" | "bypassPermissions")) {
                    ignored.push((spec.id, mode.clone().unwrap_or_default()));
                }
                if project
                    && (matches!(mode.as_deref(), Some("auto" | "bypassPermissions"))
                        || (!trusted && mode.as_deref() == Some("acceptEdits")))
                {
                    remove_pointer(&mut value, "/permissions/defaultMode");
                }
                if project && !trusted {
                    for pointer in spec.executable {
                        remove_pointer(&mut value, pointer);
                    }
                }
                if project {
                    for pointer in crate::sandbox::loosening(&value) {
                        remove_pointer(&mut value, pointer);
                        ignored_sandbox.push((spec.id, pointer.to_owned()));
                    }
                }
                Some(value)
            })
            .collect();
        let values: Vec<Value> = effective.iter().flatten().cloned().collect();
        let merged = merge_all(&values);
        let changed = changed_keys(&self.merged, &merged);
        self.merged = merged;
        self.effective = effective;
        self.ignored_modes = ignored;
        self.ignored_sandbox = ignored_sandbox;
        changed
    }

    /// The permission rule lists of every layer, highest precedence first, as they apply:
    /// an untrusted project's allow rules are left out (deny and ask always apply).
    #[must_use]
    pub fn permission_lists(&self) -> Vec<PermissionLists> {
        let strings = |value: &Value, key: &str| -> Vec<String> {
            value
                .pointer(&format!("/permissions/{key}"))
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        self.table
            .layers()
            .iter()
            .zip(&self.effective)
            .rev()
            .filter_map(|(spec, value)| {
                let value = value.as_ref()?;
                Some(PermissionLists {
                    layer: spec.id,
                    scope: spec.scope,
                    file: spec.file().map(Path::to_owned),
                    writable: spec.writable,
                    deny: strings(value, "deny"),
                    ask: strings(value, "ask"),
                    allow: strings(value, "allow"),
                })
            })
            .collect()
    }

    /// One layer's value as it applies (after the trust and mode filters).
    #[must_use]
    pub fn layer(&self, id: &str) -> Option<&Value> {
        self.table
            .layers()
            .iter()
            .zip(&self.effective)
            .find(|(spec, _)| spec.id == id)
            .and_then(|(_, value)| value.as_ref())
    }

    /// One layer's value as its file was loaded, before the trust and mode filters: for
    /// listing what an untrusted project defines without applying it (T36's MCP servers).
    #[must_use]
    pub fn loaded(&self, id: &str) -> Option<&Value> {
        self.table
            .layers()
            .iter()
            .zip(&self.states)
            .find(|(spec, _)| spec.id == id)
            .and_then(|(_, state)| state.value.as_ref())
    }

    /// Project layers that asked for `bypassPermissions` or `auto`, which never apply.
    #[must_use]
    pub fn ignored_modes(&self) -> &[(&'static str, String)] {
        &self.ignored_modes
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

    /// The extension packages in effect (empty until Core sets them).
    #[must_use]
    pub fn packages(&self) -> &crate::plugins::Packages {
        &self.packages
    }

    /// Sets the extension packages in effect (Core computes them with
    /// [`crate::plugins::active`] from these settings and its install records).
    pub fn set_packages(&mut self, packages: crate::plugins::Packages) {
        self.packages = packages;
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
    Valid {
        value: Value,
        raw: Value,
        warnings: Vec<Issue>,
    },
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
        let empty = Value::Object(serde_json::Map::new());
        return Read::Valid {
            value: empty.clone(),
            raw: empty,
            warnings: Vec::new(),
        };
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(value) => check(spec, Some(file), value),
        Err(error) => {
            let mut found = issue(
                spec,
                Some(file),
                "",
                format!("not valid JSON: {error}"),
                Severity::Error,
            );
            if error.line() > 0 {
                found.line = Some(error.line());
                found.column = Some(error.column());
            }
            Read::Invalid(vec![found])
        }
    }
}

fn check(spec: &LayerSpec, file: Option<&Path>, raw: Value) -> Read {
    let value = match spec.format {
        Format::Piarc => raw.clone(),
        // The other keys are classified by the diagnostics, not validated.
        Format::ClaudeCode if raw.is_object() => crate::claude::project(&raw),
        Format::ClaudeCode => raw.clone(),
    };
    let findings = validate(&value, spec.schema);
    let issues: Vec<Issue> = findings
        .into_iter()
        .map(|f| issue(spec, file, &f.pointer, f.message, f.severity))
        .collect();
    if issues.iter().any(|i| i.severity == Severity::Error) {
        Read::Invalid(issues)
    } else {
        Read::Valid {
            value,
            raw,
            warnings: issues,
        }
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
        line: None,
        column: None,
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
