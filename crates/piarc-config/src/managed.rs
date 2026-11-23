//! Managed (enterprise) settings (T47, design addendum
//! `docs/architecture/addenda/T47-auto-memory-and-managed-settings.md`, sections 5–8): the
//! documents an administrator places on the machine, merged into the `enterprise` layer of
//! every workspace's [`LayerTable`](crate::LayerTable) (precedence 80, ADR-0005 rule 3).
//!
//! Core reads the documents (files, macOS managed preferences, the Windows `HKLM` policy key)
//! and hands them over as [`RawSource`]s, highest precedence first: PiArc's policy, PiArc's
//! files (drop-ins in reverse name order, then `managed-settings.json`), Claude Code's policy,
//! Claude Code's files. [`Managed::build`] parses and checks each one, then merges them:
//!
//! - every document is a JSON object in PiArc's settings format; a Claude Code document keeps
//!   the keys the mapping table marks active or managed ([`crate::claude::project_managed`]);
//! - a key of the wrong type is dropped alone; a lock key ([`LOCKS`]) of the wrong type reads
//!   as its restrictive value, an invalid MCP allowlist entry is dropped;
//! - scalars: the higher document wins; objects merge key by key; lists concatenate;
//! - locks take the strictest value of any document; while `allowManagedMcpServersOnly` or
//!   `sandbox.network.allowManagedDomainsOnly` is on, its allowlist is the highest document's
//!   whole list; an MCP server of the same name is the highest document's whole definition.
//!
//! A document that is not a JSON object is an error ([`Managed::errors`]): Core refuses to
//! start on one; one that breaks while running keeps its last valid content (`stale`).

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::diagnostics::{FileReport, FileStatus, IgnoreReason, IgnoredKey, KeyReport, SourceKind};
use crate::layers::{Format, LayerSpec, Scope, Source, ids, precedence};
use crate::merge::merge_into;
use crate::schema::{PIARC_SETTINGS, Severity, push_token, validate};
use crate::settings::Issue;

/// JSON Pointers that only managed settings may set (design addendum section 5.3); other
/// layers lose them in the merge.
pub const ONLY: &[&str] = &[
    "/allowManagedHooksOnly",
    "/allowManagedPermissionRulesOnly",
    "/allowManagedMcpServersOnly",
    "/sandbox/network/allowManagedDomainsOnly",
];

const HTTP_HOOK_LISTS: [&str; 2] = ["/allowedHttpHookUrls", "/httpHookAllowedEnvVars"];

/// HTTP hook allowlists explicitly set by the administrator, including empty lists (ADR-0065).
pub(super) fn managed_http_lists(managed: Option<&Value>) -> impl Iterator<Item = &'static str> {
    HTTP_HOOK_LISTS
        .into_iter()
        .filter(move |pointer| managed.and_then(|v| v.pointer(pointer)).is_some())
}

/// Lock keys and their restrictive value: when any managed document sets the restrictive
/// value, the merged value is restrictive (section 6.3); a wrong type reads as restrictive
/// (section 8.1).
pub const LOCKS: &[(&str, Restrictive)] = &[
    ("/allowManagedHooksOnly", Restrictive::True),
    ("/allowManagedPermissionRulesOnly", Restrictive::True),
    ("/allowManagedMcpServersOnly", Restrictive::True),
    (
        "/sandbox/network/allowManagedDomainsOnly",
        Restrictive::True,
    ),
    ("/disableAutoMode", Restrictive::Disable),
    ("/permissions/enableBypassPermissions", Restrictive::False),
    ("/permissions/enableAutoMode", Restrictive::False),
];

/// The restrictive value of a lock key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restrictive {
    /// `true`.
    True,
    /// `false`.
    False,
    /// The string `"disable"`.
    Disable,
}

impl Restrictive {
    fn value(self) -> Value {
        match self {
            Self::True => Value::Bool(true),
            Self::False => Value::Bool(false),
            Self::Disable => Value::String("disable".into()),
        }
    }
}

/// Whose format a document has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    /// PiArc's own (`cn.piarc.desktop`, `HKLM\SOFTWARE\Policies\PiArc`, `…/PiArc/`).
    Piarc,
    /// Claude Code's (`com.anthropic.claudecode`, `HKLM\SOFTWARE\Policies\ClaudeCode`,
    /// `…/ClaudeCode/`), read only.
    ClaudeCode,
}

/// How a document reaches the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    /// A configuration profile's managed preferences (macOS) or the `HKLM` policy key
    /// (Windows).
    Policy,
    /// `managed-settings.json` or a file of `managed-settings.d/`.
    File,
}

/// One document as Core read it.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSource {
    /// Whose format.
    pub family: Family,
    /// How it is delivered.
    pub channel: Channel,
    /// Where it is: the file, or the registry value (`HKLM\SOFTWARE\Policies\PiArc\Settings`).
    pub location: PathBuf,
    /// What was read.
    pub body: RawBody,
}

/// The content of a [`RawSource`].
#[derive(Debug, Clone, PartialEq)]
pub enum RawBody {
    /// JSON text (a file, a registry string).
    Text(Vec<u8>),
    /// A value already decoded (a property list); dates and data are `null`.
    Value(Value),
    /// The document exists but cannot be decoded (a broken property list).
    Invalid(String),
    /// The operating system denied reading it: skipped, not an error.
    Unreadable(String),
}

/// How a document stands after [`Managed::build`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    /// Read and used.
    Loaded,
    /// Not a JSON object and never valid since Core started: an error.
    Invalid,
    /// Not valid now; its last valid content is used.
    Stale,
    /// The operating system denied reading it; skipped.
    Unreadable,
}

/// One document after checking.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceState {
    /// Whose format.
    pub family: Family,
    /// How it is delivered.
    pub channel: Channel,
    /// Where it is.
    pub location: PathBuf,
    /// Its state.
    pub status: SourceStatus,
    /// The document as read (for the diagnostics' ignored keys).
    pub raw: Option<Value>,
    /// The checked value in PiArc's format, as merged.
    pub value: Option<Value>,
    /// Keys left out and why.
    pub ignored: Vec<IgnoredKey>,
    /// Problems found.
    pub issues: Vec<Issue>,
}

/// Every managed document and their merge.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Managed {
    /// Highest precedence first.
    pub sources: Vec<SourceState>,
    /// The merged value: the `enterprise` layer (an empty object without documents).
    pub value: Value,
}

impl Managed {
    /// Checks and merges `sources` (highest first). A document that cannot be read now keeps
    /// the content it had in `previous` (same location).
    #[must_use]
    pub fn build(sources: Vec<RawSource>, previous: Option<&Self>) -> Self {
        let states: Vec<SourceState> = sources
            .into_iter()
            .map(|raw| {
                let before = previous.and_then(|p| {
                    p.sources
                        .iter()
                        .find(|s| s.location == raw.location && s.value.is_some())
                });
                check_source(raw, before)
            })
            .collect();
        let value = merge_sources(&states);
        Self {
            sources: states,
            value,
        }
    }

    /// Documents that are not valid and have no earlier valid content: Core refuses to start.
    pub fn errors(&self) -> impl Iterator<Item = &SourceState> {
        self.sources
            .iter()
            .filter(|s| s.status == SourceStatus::Invalid)
    }

    /// Whether no document sets anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.value.as_object().is_none_or(Map::is_empty)
    }

    /// The `enterprise` layer of a [`LayerTable`](crate::LayerTable).
    #[must_use]
    pub fn layer(&self) -> LayerSpec {
        LayerSpec {
            id: ids::ENTERPRISE,
            precedence: precedence::ENTERPRISE,
            scope: Scope::Enterprise,
            source: Source::Value(self.value.clone()),
            format: Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: false,
            executable: &[],
        }
    }

    /// JSON Pointers the managed settings set (lists are one pointer), sorted.
    #[must_use]
    pub fn pointers(&self) -> Vec<String> {
        let mut out: Vec<String> = leaves(&self.value).into_iter().map(|(p, _)| p).collect();
        out.sort();
        out
    }

    /// The report of every document for the configuration diagnostics (section 8.3),
    /// highest first.
    #[must_use]
    pub fn reports(&self) -> Vec<FileReport> {
        self.sources
            .iter()
            .enumerate()
            .map(|(index, source)| self.report(index, source))
            .collect()
    }

    fn report(&self, index: usize, source: &SourceState) -> FileReport {
        let (mut effective, mut overridden) = (Vec::new(), Vec::new());
        if let Some(value) = &source.value {
            for (pointer, own) in leaves(value) {
                let decider = if own.is_array() && !HTTP_HOOK_LISTS.contains(&pointer.as_str()) {
                    None
                } else {
                    self.sources.iter().take(index + 1).find(|s| {
                        s.value
                            .as_ref()
                            .is_some_and(|v| v.pointer(&pointer).is_some())
                    })
                };
                let key = KeyReport {
                    final_value: self.value.pointer(&pointer).cloned().unwrap_or(Value::Null),
                    value: own.clone(),
                    pointer,
                    source: Some(ids::ENTERPRISE),
                    source_file: Some(decider.map_or(&source.location, |s| &s.location).clone()),
                };
                if decider.is_some_and(|d| d.location != source.location) {
                    overridden.push(key);
                } else {
                    effective.push(key);
                }
            }
        }
        FileReport {
            kind: SourceKind::Enterprise,
            layer: ids::ENTERPRISE,
            file: source.location.clone(),
            format: match source.family {
                Family::Piarc => Format::Piarc,
                Family::ClaudeCode => Format::ClaudeCode,
            },
            scope: Scope::Enterprise,
            precedence: Some(precedence::ENTERPRISE),
            writable: false,
            status: match source.status {
                SourceStatus::Loaded => FileStatus::Loaded,
                SourceStatus::Invalid | SourceStatus::Unreadable => FileStatus::Invalid,
                SourceStatus::Stale => FileStatus::Stale,
            },
            effective,
            overridden,
            ignored: source.ignored.clone(),
            issues: source.issues.clone(),
        }
    }
}

/// Whether managed settings `managed` (the `enterprise` layer's value) lock the setting at
/// `pointer`: a scalar or object they set at it or above it, and the lists a managed lock
/// takes over (permission rules, hooks, the MCP allowlist, the sandbox's domains). A list
/// they only contribute to stays editable: its other entries are the user's (section 5.4).
#[must_use]
pub fn locked(managed: Option<&Value>, pointer: &str) -> bool {
    let Some(managed) = managed else {
        return false;
    };
    if taken(Some(managed))
        .iter()
        .any(|list| pointer == *list || pointer.starts_with(&format!("{list}/")))
    {
        return true;
    }
    let mut prefix = String::new();
    for token in pointer.split('/').skip(1) {
        prefix.push('/');
        prefix.push_str(token);
        match managed.pointer(&prefix) {
            None => return false,
            Some(Value::Array(_)) => return false,
            Some(Value::Object(_)) if prefix != pointer => {}
            Some(_) => return true,
        }
    }
    // An object the managed settings fill in: writing it whole would replace their keys.
    managed
        .pointer(pointer)
        .is_some_and(|v| v.as_object().is_some_and(|m| !m.is_empty()))
}

/// The settings a managed lock takes over (section 5.3): the user's and the project's values
/// of these no longer apply.
#[must_use]
pub fn taken(managed: Option<&Value>) -> Vec<&'static str> {
    let Some(managed) = managed else {
        return Vec::new();
    };
    let on = |lock: &str| managed.pointer(lock) == Some(&Value::Bool(true));
    [
        ("/allowManagedPermissionRulesOnly", "/permissions/allow"),
        ("/allowManagedPermissionRulesOnly", "/permissions/ask"),
        ("/allowManagedPermissionRulesOnly", "/permissions/deny"),
        ("/allowManagedHooksOnly", "/hooks"),
        ("/allowManagedMcpServersOnly", "/allowedMcpServers"),
        (
            "/sandbox/network/allowManagedDomainsOnly",
            "/sandbox/network/allowedDomains",
        ),
    ]
    .into_iter()
    .filter(|(lock, _)| on(lock))
    .map(|(_, list)| list)
    .chain(managed_http_lists(Some(managed)))
    .collect()
}

/// What the settings window shows (section 5.4): the documents, the settings the managed
/// settings lock (scalars and objects, by JSON Pointer), the entries they add to lists, and the
/// lists a lock takes over.
#[must_use]
pub fn view(managed: &Managed) -> Value {
    let mut locked = Vec::new();
    let mut values = Map::new();
    let mut entries = Map::new();
    for (pointer, value) in leaves(&managed.value) {
        match value {
            Value::Array(_) => {
                entries.insert(pointer, value.clone());
            }
            _ => {
                values.insert(pointer.clone(), value.clone());
                locked.push(pointer);
            }
        }
    }
    locked.sort();
    let sources: Vec<Value> = managed
        .sources
        .iter()
        .map(|s| {
            serde_json::json!({
                "location": s.location.display().to_string(),
                "family": s.family,
                "channel": s.channel,
                "status": s.status,
                "issues": s.issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::json!({
        "configured": !managed.sources.is_empty(),
        "sources": sources,
        "locked": locked,
        "values": values,
        "entries": entries,
        "taken": taken(Some(&managed.value)),
    })
}

fn check_source(raw: RawSource, before: Option<&SourceState>) -> SourceState {
    let mut state = SourceState {
        family: raw.family,
        channel: raw.channel,
        location: raw.location,
        status: SourceStatus::Loaded,
        raw: None,
        value: None,
        ignored: Vec::new(),
        issues: Vec::new(),
    };
    let decoded = match raw.body {
        RawBody::Unreadable(reason) => {
            state.status = SourceStatus::Unreadable;
            state
                .issues
                .push(issue(&state, "", format!("cannot read it: {reason}"), None));
            return state;
        }
        RawBody::Invalid(reason) => Err((format!("not a valid property list: {reason}"), None)),
        RawBody::Value(value) => Ok(value),
        RawBody::Text(bytes) => parse_text(&bytes),
    };
    let raw_value = match decoded {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(_) => return broken(state, "not a JSON object".into(), None, before),
        Err((message, at)) => return broken(state, message, at, before),
    };
    let (value, ignored, issues) = check_value(&state, &raw_value);
    state.raw = Some(raw_value);
    state.value = Some(value);
    state.ignored = ignored;
    state.issues = issues;
    state
}

fn parse_text(bytes: &[u8]) -> Result<Value, (String, Option<(usize, usize)>)> {
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(text).map_err(|error| {
        let at = (error.line() > 0).then(|| (error.line(), error.column()));
        (format!("not valid JSON: {error}"), at)
    })
}

fn broken(
    mut state: SourceState,
    message: String,
    at: Option<(usize, usize)>,
    before: Option<&SourceState>,
) -> SourceState {
    state.issues.push(issue(&state, "", message, at));
    match before {
        Some(before) => {
            state.status = SourceStatus::Stale;
            state.raw.clone_from(&before.raw);
            state.value.clone_from(&before.value);
            state.ignored.clone_from(&before.ignored);
        }
        None => state.status = SourceStatus::Invalid,
    }
    state
}

/// The checked value of one document, its ignored keys and issues.
fn check_value(state: &SourceState, raw: &Value) -> (Value, Vec<IgnoredKey>, Vec<Issue>) {
    let mut ignored = Vec::new();
    let mut value = match state.family {
        Family::Piarc => raw.clone(),
        Family::ClaudeCode => {
            for class in crate::claude::classify(raw, crate::claude::SETTINGS_KEYS) {
                let (reason, task) = match (class.row.is_some(), class.status()) {
                    (_, crate::claude::KeyStatus::Active | crate::claude::KeyStatus::Managed) => {
                        continue;
                    }
                    (false, _) => (IgnoreReason::Unknown, None),
                    (true, crate::claude::KeyStatus::Planned(task)) => {
                        (IgnoreReason::Planned, Some(task))
                    }
                    (true, crate::claude::KeyStatus::Ignored) => (IgnoreReason::Ignored, None),
                };
                if class.pointer == "/permissions/disableBypassPermissionsMode" {
                    continue;
                }
                ignored.push(IgnoredKey {
                    pointer: class.pointer,
                    reason,
                    task,
                    note: class.row.map(|r| r.target),
                    detail: None,
                });
            }
            crate::claude::project_managed(raw)
        }
    };
    let mut issues = Vec::new();
    // Each round removes or replaces every value an error points at; the loop ends because
    // every round shrinks the value or turns a lock into its (valid) restrictive value.
    for _ in 0..8 {
        let findings = validate(&value, &PIARC_SETTINGS);
        let errors: Vec<_> = findings
            .iter()
            .filter(|f| f.severity == Severity::Error)
            .collect();
        for warning in findings.iter().filter(|f| f.severity == Severity::Warning) {
            if state.family == Family::Piarc
                && !ignored.iter().any(|i| i.pointer == warning.pointer)
            {
                ignored.push(IgnoredKey {
                    pointer: warning.pointer.clone(),
                    reason: IgnoreReason::Unknown,
                    task: None,
                    note: None,
                    detail: None,
                });
            }
        }
        if errors.is_empty() {
            break;
        }
        for finding in errors {
            issues.push(issue(
                state,
                &finding.pointer,
                finding.message.clone(),
                None,
            ));
            repair(&mut value, &finding.pointer);
        }
    }
    for entry in invalid_policy_entries(&value) {
        issues.push(issue(
            state,
            &entry,
            "an MCP policy entry needs exactly one of serverName, serverCommand, serverUrl".into(),
            None,
        ));
        remove_at(&mut value, &entry);
    }
    ignored.sort_by(|a, b| a.pointer.cmp(&b.pointer));
    ignored.dedup_by(|a, b| a.pointer == b.pointer);
    (value, ignored, issues)
}

/// Fixes the value an error points at: a lock becomes restrictive, an MCP policy entry is
/// dropped, anything else is removed.
fn repair(value: &mut Value, pointer: &str) {
    if let Some(list) = HTTP_HOOK_LISTS.into_iter().find(|list| {
        pointer == *list
            || pointer
                .strip_prefix(list)
                .is_some_and(|rest| rest.starts_with('/'))
    }) {
        set_at(value, list, Value::Array(Vec::new()));
        return;
    }
    if let Some((lock, restrictive)) = LOCKS
        .iter()
        .find(|(lock, _)| pointer == *lock || pointer.starts_with(&format!("{lock}/")))
    {
        set_at(value, lock, restrictive.value());
        return;
    }
    for list in ["/allowedMcpServers", "/deniedMcpServers"] {
        if let Some(rest) = pointer.strip_prefix(&format!("{list}/")) {
            let index = rest.split('/').next().unwrap_or_default();
            remove_at(value, &format!("{list}/{index}"));
            return;
        }
        if pointer == list {
            // A list that is not a list: an allowlist reads as empty (nothing allowed), a
            // denylist as absent.
            if list == "/allowedMcpServers" {
                set_at(value, list, Value::Array(Vec::new()));
            } else {
                remove_at(value, list);
            }
            return;
        }
    }
    remove_at(value, pointer);
}

fn invalid_policy_entries(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for list in ["/allowedMcpServers", "/deniedMcpServers"] {
        let Some(entries) = value.pointer(list).and_then(Value::as_array) else {
            continue;
        };
        for (index, entry) in entries.iter().enumerate().rev() {
            let keys = entry.as_object().map_or(0, |m| {
                ["serverName", "serverCommand", "serverUrl"]
                    .iter()
                    .filter(|k| m.contains_key(**k))
                    .count()
            });
            if keys != 1 {
                out.push(format!("{list}/{index}"));
            }
        }
    }
    out
}

/// Merges the checked documents (`states` highest first) by the rules of section 6.3.
fn merge_sources(states: &[SourceState]) -> Value {
    let values: Vec<&Value> = states.iter().filter_map(|s| s.value.as_ref()).collect();
    let mut merged = Value::Object(Map::new());
    for value in values.iter().rev() {
        merge_into(&mut merged, value);
    }
    for list in HTTP_HOOK_LISTS {
        if let Some(highest) = values.iter().find_map(|v| v.pointer(list)) {
            set_at(&mut merged, list, highest.clone());
        }
    }
    for (lock, restrictive) in LOCKS {
        let strict = restrictive.value();
        if values.iter().any(|v| v.pointer(lock) == Some(&strict)) {
            set_at(&mut merged, lock, strict);
        }
    }
    for (lock, list) in [
        ("/allowManagedMcpServersOnly", "/allowedMcpServers"),
        (
            "/sandbox/network/allowManagedDomainsOnly",
            "/sandbox/network/allowedDomains",
        ),
    ] {
        if merged.pointer(lock) == Some(&Value::Bool(true))
            && let Some(highest) = values.iter().find_map(|v| v.pointer(list))
        {
            set_at(&mut merged, list, highest.clone());
        }
    }
    let mut servers = BTreeMap::new();
    for value in &values {
        if let Some(map) = value.pointer("/mcpServers").and_then(Value::as_object) {
            for (name, definition) in map {
                servers
                    .entry(name.clone())
                    .or_insert_with(|| definition.clone());
            }
        }
    }
    if !servers.is_empty() {
        set_at(
            &mut merged,
            "/mcpServers",
            Value::Object(servers.into_iter().collect()),
        );
    }
    merged
}

fn issue(state: &SourceState, pointer: &str, message: String, at: Option<(usize, usize)>) -> Issue {
    Issue {
        layer: ids::ENTERPRISE,
        file: Some(state.location.clone()),
        pointer: pointer.to_owned(),
        message,
        severity: Severity::Error,
        line: at.map(|(l, _)| l),
        column: at.map(|(_, c)| c),
    }
}

fn tokens(pointer: &str) -> Vec<String> {
    pointer
        .split('/')
        .skip(1)
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn set_at(document: &mut Value, pointer: &str, value: Value) {
    let tokens = tokens(pointer);
    let Some((last, parents)) = tokens.split_last() else {
        *document = value;
        return;
    };
    let mut current = document;
    for token in parents {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let Value::Object(map) = current else {
            return;
        };
        current = map
            .entry(token.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    if let Value::Object(map) = current {
        map.insert(last.clone(), value);
    }
}

fn remove_at(document: &mut Value, pointer: &str) {
    let tokens = tokens(pointer);
    let Some((last, parents)) = tokens.split_last() else {
        *document = Value::Object(Map::new());
        return;
    };
    let mut parent_pointer = String::new();
    for token in parents {
        push_token(&mut parent_pointer, token);
    }
    let parent = if parent_pointer.is_empty() {
        Some(document)
    } else {
        document.pointer_mut(&parent_pointer)
    };
    match parent {
        Some(Value::Object(map)) => {
            map.remove(last);
        }
        Some(Value::Array(list)) => {
            if let Ok(index) = last.parse::<usize>()
                && index < list.len()
            {
                list.remove(index);
            }
        }
        _ => {}
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

#[cfg(test)]
mod tests;
