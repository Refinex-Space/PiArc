//! Configuration diagnostics (architecture section 6.14): for every settings file, whether it
//! loaded, which of its keys apply, which a higher file overrides (and which file), which are
//! ignored and why, and its parse errors. Built from the same [`Settings`] the merge produced
//! and the same mapping table ([`crate::claude`]), so the report cannot disagree with what is
//! used.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;

use crate::claude::{self, KeyStatus, STATE_KEYS};
use crate::layers::{Format, LayerSpec, Scope};
use crate::schema::{Severity, push_token};
use crate::settings::{Issue, LayerStatus, Settings};

/// A file's load state in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    /// Read and valid; every value it sets is used.
    Loaded,
    /// The file does not exist.
    Missing,
    /// Not valid; never used since loading.
    Invalid,
    /// Not valid now; its last valid content is used.
    Stale,
    /// Read and valid, but the project is not trusted: its allow rules, additional
    /// directories and similar values are left out.
    Untrusted,
}

/// One key that takes part in the merge.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReport {
    /// JSON Pointer (lists are one key).
    pub pointer: String,
    /// This file's value.
    pub value: Value,
    /// The merged value PiArc uses.
    pub final_value: Value,
    /// The layer that decided the final value: this file's own id for an applied scalar,
    /// a higher layer for an overridden one. Lists merge across files, so a list's source is
    /// every file that sets it and this is `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    /// The file of `source`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_file: Option<PathBuf>,
}

/// Why a key of a file is not used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IgnoreReason {
    /// Not in the mapping table, or an unknown key of a PiArc file.
    Unknown,
    /// The mapping table marks it ignored.
    Ignored,
    /// A later task supports it (`task`).
    Planned,
    /// Left out until the project is trusted.
    Untrusted,
    /// `bypassPermissions` and `auto` never apply from a project file.
    ProjectMode,
}

/// One key that is not used.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredKey {
    /// JSON Pointer of the key in the file.
    pub pointer: String,
    /// Why.
    pub reason: IgnoreReason,
    /// The task that will support it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<&'static str>,
    /// The mapping table's note: the PiArc feature, or why the key is ignored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

/// The report of one file.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReport {
    /// Layer id (`claudeState` for `~/.claude.json`, which is not a settings layer).
    pub layer: &'static str,
    /// The file.
    pub file: PathBuf,
    /// Its format.
    pub format: Format,
    /// Whose it is.
    pub scope: Scope,
    /// Higher wins; `None` for a file outside the merge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precedence: Option<u16>,
    /// Whether PiArc writes it.
    pub writable: bool,
    /// Load state.
    pub status: FileStatus,
    /// Keys whose value applies (scalars this file decides, lists it contributes to).
    pub effective: Vec<KeyReport>,
    /// Scalars a higher file overrides.
    pub overridden: Vec<KeyReport>,
    /// Keys that are not used.
    pub ignored: Vec<IgnoredKey>,
    /// Parse errors and schema findings.
    pub issues: Vec<Issue>,
}

/// The layer id of `~/.claude.json` in reports.
pub const CLAUDE_STATE: &str = "claudeState";

impl Settings {
    /// The report of every file layer, highest precedence first.
    #[must_use]
    pub fn diagnostics(&self) -> Vec<FileReport> {
        let layers = self.table.layers();
        let mut reports: Vec<FileReport> = layers
            .iter()
            .enumerate()
            .filter_map(|(index, spec)| Some(self.file_report(index, spec, spec.file()?)))
            .collect();
        reports.reverse();
        reports
    }

    fn file_report(&self, index: usize, spec: &LayerSpec, file: &Path) -> FileReport {
        let state = &self.states[index];
        let effective = self.effective[index].as_ref();
        let mut ignored = Vec::new();
        if let Some(raw) = &state.raw {
            classify_raw(spec, raw, &mut ignored);
        }
        let removed = self.removed_by_filters(spec, index, &mut ignored);
        let issues: Vec<Issue> = self
            .issues
            .iter()
            .filter(|i| i.layer == spec.id)
            .cloned()
            .collect();
        if spec.format == Format::Piarc {
            for warning in issues.iter().filter(|i| i.severity == Severity::Warning) {
                ignored.push(IgnoredKey {
                    pointer: warning.pointer.clone(),
                    reason: IgnoreReason::Unknown,
                    task: None,
                    note: None,
                });
            }
        }
        ignored.sort_by(|a, b| a.pointer.cmp(&b.pointer));
        let (mut applied, mut overridden) = (Vec::new(), Vec::new());
        if let Some(value) = effective {
            for (pointer, value) in leaves(value) {
                let report = self.key_report(index, &pointer, value);
                if report.source.is_none() || report.source == Some(spec.id) {
                    applied.push(report);
                } else {
                    overridden.push(report);
                }
            }
        }
        let status = match state.status {
            LayerStatus::Loaded if removed => FileStatus::Untrusted,
            LayerStatus::Loaded => FileStatus::Loaded,
            LayerStatus::Missing => FileStatus::Missing,
            LayerStatus::Invalid => FileStatus::Invalid,
            LayerStatus::Stale => FileStatus::Stale,
        };
        FileReport {
            layer: spec.id,
            file: file.to_owned(),
            format: spec.format,
            scope: spec.scope,
            precedence: Some(spec.precedence),
            writable: spec.writable,
            status,
            effective: applied,
            overridden,
            ignored,
            issues,
        }
    }

    /// Adds the values the trust and mode filters removed; `true` when trust removed any.
    fn removed_by_filters(
        &self,
        spec: &LayerSpec,
        index: usize,
        out: &mut Vec<IgnoredKey>,
    ) -> bool {
        let (Some(before), Some(after)) = (&self.states[index].value, &self.effective[index])
        else {
            return false;
        };
        let mut untrusted = false;
        for (pointer, _) in leaves(before) {
            if after.pointer(&pointer).is_some() {
                continue;
            }
            let project_mode = self
                .ignored_modes
                .iter()
                .any(|(layer, _)| *layer == spec.id)
                && pointer == "/permissions/defaultMode";
            let reason = if project_mode {
                IgnoreReason::ProjectMode
            } else {
                untrusted = true;
                IgnoreReason::Untrusted
            };
            out.push(IgnoredKey {
                pointer,
                reason,
                task: None,
                note: None,
            });
        }
        untrusted
    }

    fn key_report(&self, index: usize, pointer: &str, value: &Value) -> KeyReport {
        let final_value = self.merged.pointer(pointer).cloned().unwrap_or(Value::Null);
        // The highest layer that sets a scalar decides it; lists merge.
        let source = if value.is_array() {
            None
        } else {
            self.table
                .layers()
                .iter()
                .zip(&self.effective)
                .rev()
                .find(|(_, v)| v.as_ref().is_some_and(|v| v.pointer(pointer).is_some()))
                .map(|(spec, _)| spec)
                .or_else(|| self.table.layers().get(index))
        };
        KeyReport {
            pointer: pointer.to_owned(),
            value: value.clone(),
            final_value,
            source: source.map(|s| s.id),
            source_file: source.and_then(|s| s.file().map(Path::to_owned)),
        }
    }
}

fn classify_raw(spec: &LayerSpec, raw: &Value, out: &mut Vec<IgnoredKey>) {
    if spec.format != Format::ClaudeCode {
        return;
    }
    for class in claude::classify(raw, claude::SETTINGS_KEYS) {
        let (reason, task) = match (class.row.is_some(), class.status()) {
            (_, KeyStatus::Active) => continue,
            (false, _) => (IgnoreReason::Unknown, None),
            (true, KeyStatus::Planned(task)) => (IgnoreReason::Planned, Some(task)),
            (true, KeyStatus::Ignored) => (IgnoreReason::Ignored, None),
        };
        out.push(IgnoredKey {
            pointer: class.pointer,
            reason,
            task,
            note: class.row.map(|r| r.target),
        });
    }
}

/// `(pointer, value)` of every leaf: objects are descended into, lists and scalars are leaves.
fn leaves(value: &Value) -> Vec<(String, &Value)> {
    fn walk<'a>(value: &'a Value, pointer: &mut String, out: &mut Vec<(String, &'a Value)>) {
        match value.as_object() {
            Some(map) => {
                for (key, child) in map {
                    let len = pointer.len();
                    push_token(pointer, key);
                    walk(child, pointer, out);
                    pointer.truncate(len);
                }
            }
            None if !pointer.is_empty() => out.push((pointer.clone(), value)),
            None => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut String::new(), &mut out);
    out
}

/// The report of `<home>/.claude.json`: only key names are read (values are skipped while
/// parsing, nothing is logged). Its MCP servers, top-level and the entry of `workspace`
/// under `projects`, are T36's; everything else is Claude Code's own state, ignored.
#[must_use]
pub fn claude_state_report(home: &Path, workspace: &Path) -> FileReport {
    let file = home.join(claude::CLAUDE_STATE_FILE);
    let mut report = FileReport {
        layer: CLAUDE_STATE,
        file: file.clone(),
        format: Format::ClaudeCode,
        scope: Scope::User,
        precedence: None,
        writable: false,
        status: FileStatus::Missing,
        effective: Vec::new(),
        overridden: Vec::new(),
        ignored: Vec::new(),
        issues: Vec::new(),
    };
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return report,
        Err(error) => {
            report.status = FileStatus::Invalid;
            report.issues.push(state_issue(
                &file,
                format!("cannot read the file: {error}"),
                None,
            ));
            return report;
        }
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let keys: BTreeMap<String, IgnoredAny> = match serde_json::from_slice(text) {
        Ok(keys) => keys,
        Err(error) => {
            report.status = FileStatus::Invalid;
            let at = (error.line() > 0).then(|| (error.line(), error.column()));
            report
                .issues
                .push(state_issue(&file, format!("not valid JSON: {error}"), at));
            return report;
        }
    };
    report.status = FileStatus::Loaded;
    for key in keys.keys() {
        let mut pointer = String::new();
        push_token(&mut pointer, key);
        let row = STATE_KEYS.iter().find(|r| r.key == key);
        report.ignored.push(match row {
            Some(row) => IgnoredKey {
                pointer,
                reason: match row.status {
                    KeyStatus::Planned(_) => IgnoreReason::Planned,
                    _ => IgnoreReason::Ignored,
                },
                task: match row.status {
                    KeyStatus::Planned(task) => Some(task),
                    _ => None,
                },
                note: Some(row.target),
            },
            None => IgnoredKey {
                pointer,
                reason: IgnoreReason::Ignored,
                task: None,
                note: Some("Claude Code state"),
            },
        });
    }
    if keys.contains_key("projects") && project_has_mcp(text, workspace) {
        let mut pointer = "/projects".to_owned();
        push_token(&mut pointer, &workspace.to_string_lossy());
        push_token(&mut pointer, "mcpServers");
        report.ignored.push(IgnoredKey {
            pointer,
            reason: IgnoreReason::Planned,
            task: Some("T36"),
            note: Some("MCP servers"),
        });
    }
    report.ignored.sort_by(|a, b| a.pointer.cmp(&b.pointer));
    report
}

fn project_has_mcp(text: &[u8], workspace: &Path) -> bool {
    #[derive(Deserialize)]
    struct State {
        projects: BTreeMap<String, Project>,
    }
    #[derive(Deserialize)]
    struct Project {
        #[serde(rename = "mcpServers")]
        mcp_servers: Option<IgnoredAny>,
    }
    serde_json::from_slice::<State>(text).is_ok_and(|state| {
        state
            .projects
            .get(workspace.to_string_lossy().as_ref())
            .is_some_and(|p| p.mcp_servers.is_some())
    })
}

fn state_issue(file: &Path, message: String, at: Option<(usize, usize)>) -> Issue {
    Issue {
        layer: CLAUDE_STATE,
        file: Some(file.to_owned()),
        pointer: String::new(),
        message,
        severity: Severity::Error,
        line: at.map(|(l, _)| l),
        column: at.map(|(_, c)| c),
    }
}
