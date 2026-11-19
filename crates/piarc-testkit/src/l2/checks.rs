//! Request and file assertions of a scenario.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use super::format::{RequestExpect, ScenarioSpec};
use super::matcher::{compact, subset_mismatch};
use crate::record::RequestRecord;
use crate::request::{Request, Role, parse_request};

/// The parts of a recorded request the assertions look at.
struct RequestView {
    request: Request,
    body: Value,
    raw: String,
}

impl RequestView {
    fn of(record: &RequestRecord) -> Result<Self, String> {
        let format = record
            .format
            .ok_or_else(|| format!("{} {} is not a model request", record.method, record.path))?;
        let body: Value =
            serde_json::from_str(&record.body).map_err(|e| format!("the body is not JSON: {e}"))?;
        let request = parse_request(format, &body)
            .map_err(|v| format!("the body is not a {format:?} request: {}", v.message))?;
        Ok(Self {
            request,
            body,
            raw: record.body.clone(),
        })
    }

    /// Keep the exact JSON received by the endpoint, including escapes, whitespace and key order.
    fn system(&self) -> Result<Vec<&str>, String> {
        #[derive(Deserialize)]
        struct Wire<'a> {
            #[serde(borrow)]
            system: Option<&'a RawValue>,
            #[serde(borrow)]
            messages: Vec<&'a RawValue>,
        }
        let wire: Wire<'_> = serde_json::from_str(&self.raw)
            .map_err(|e| format!("cannot extract raw system bytes: {e}"))?;
        // Both format parsers retain one role per wire message in the same order.
        let system_messages = wire
            .messages
            .into_iter()
            .zip(&self.request.messages)
            .filter_map(|(raw, message)| (message.role == Role::System).then_some(raw));
        Ok(wire
            .system
            .into_iter()
            .chain(system_messages)
            .map(RawValue::get)
            .collect())
    }

    fn same_system_as(&self, earlier: &RequestRecord) -> Result<bool, String> {
        let previous = Self::of(earlier)?;
        let system = previous.system()?;
        Ok(!system.is_empty() && system == self.system()?)
    }

    fn roles(&self) -> Vec<String> {
        self.request
            .messages
            .iter()
            .map(|m| m.role.as_str().to_owned())
            .collect()
    }

    fn tools(&self) -> BTreeSet<String> {
        self.request
            .tools
            .iter()
            .filter_map(|t| t.name.clone())
            .collect()
    }

    /// The text of each user message that has text, in order.
    fn user_texts(&self) -> Vec<String> {
        self.request
            .messages
            .iter()
            .filter(|m| m.role == Role::User && !m.texts.is_empty())
            .map(|m| m.texts.join("\n"))
            .collect()
    }
}

/// Checks the request assertions, the request counts and that every request passed the
/// strict mock's validation. `records` holds each endpoint's requests in arrival order.
#[must_use]
pub fn check_requests(
    spec: &ScenarioSpec,
    records: &BTreeMap<String, Vec<RequestRecord>>,
) -> Vec<String> {
    let mut failures = Vec::new();
    for (provider, list) in records {
        for (n, record) in list.iter().enumerate() {
            if !record.violations.is_empty() {
                let rules: Vec<String> = record
                    .violations
                    .iter()
                    .map(|v| format!("{} ({})", v.rule.id(), v.message))
                    .collect();
                failures.push(format!(
                    "requests[{provider}#{n}] was rejected by the strict mock: {}",
                    rules.join("; ")
                ));
            }
        }
    }
    for (provider, expected) in &spec.expect.request_counts {
        let actual = records.get(provider).map_or(0, Vec::len);
        if actual != *expected {
            failures.push(format!(
                "request_counts.{provider}: expected {expected} requests, got {actual}"
            ));
        }
    }
    for expect in &spec.expect.requests {
        let provider = spec
            .provider_label(expect.provider.as_deref())
            .unwrap_or_default();
        let name = format!("requests[{provider}#{}]", expect.index);
        let list = records.get(&provider).map_or(&[][..], Vec::as_slice);
        let Some(record) = list.get(expect.index) else {
            failures.push(format!(
                "{name}: the endpoint received only {} requests",
                list.len()
            ));
            continue;
        };
        match RequestView::of(record) {
            Ok(view) => failures.extend(
                check_request(expect, &view, list)
                    .into_iter()
                    .map(|f| format!("{name}.{f}")),
            ),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    failures
}

/// Mismatches of one request, each starting with the field.
fn check_request(
    expect: &RequestExpect,
    view: &RequestView,
    records: &[RequestRecord],
) -> Vec<String> {
    let mut out = Vec::new();
    let mut compare =
        |field: &str, expected: &dyn std::fmt::Debug, actual: &dyn std::fmt::Debug| {
            let (e, a) = (format!("{expected:?}"), format!("{actual:?}"));
            if e != a {
                out.push(format!("{field}: expected {e}, got {a}"));
            }
        };
    if let Some(roles) = &expect.roles {
        compare("roles", roles, &view.roles());
    }
    let tools = view.tools();
    if let Some(expected) = &expect.tools {
        let expected: BTreeSet<String> = expected.iter().cloned().collect();
        compare("tools", &expected, &tools);
    }
    if let Some(user_texts) = &expect.user_texts {
        compare("user_texts", user_texts, &view.user_texts());
    }
    if let Some(last) = &expect.last_user_text {
        compare("last_user_text", &Some(last), &view.user_texts().last());
    }
    for name in expect.tools_include.iter().flatten() {
        if !tools.contains(name) {
            out.push(format!(
                "tools_include: `{name}` is not offered; offered: {tools:?}"
            ));
        }
    }
    for name in expect.tools_exclude.iter().flatten() {
        if tools.contains(name) {
            out.push(format!(
                "tools_exclude: `{name}` is offered; offered: {tools:?}"
            ));
        }
    }
    for text in expect.contains.iter().flatten() {
        if !view.raw.contains(text.as_str()) {
            out.push(format!("contains: the body does not contain {text:?}"));
        }
    }
    for text in expect.not_contains.iter().flatten() {
        if view.raw.contains(text.as_str()) {
            out.push(format!("not_contains: the body contains {text:?}"));
        }
    }
    check_context(expect, view, records, &mut out);
    if let Some(results) = &expect.tool_results {
        check_tool_results(results, view, &mut out);
    }
    if let Some(body) = &expect.body
        && let Some(why) = subset_mismatch(body, &view.body, "body")
    {
        out.push(why);
    }
    out
}

fn check_context(
    expect: &RequestExpect,
    view: &RequestView,
    records: &[RequestRecord],
    out: &mut Vec<String>,
) {
    for (text, expected) in &expect.occurrences {
        let count = view.raw.matches(text).count();
        if count != *expected {
            out.push(format!(
                "occurrences: expected {text:?} {expected} time(s), found {count}"
            ));
        }
    }
    if let Some(parts) = &expect.user_message_contains
        && !view
            .user_texts()
            .iter()
            .any(|message| parts.iter().all(|part| message.contains(part)))
    {
        out.push(format!(
            "user_message_contains: no user message contains all of {parts:?}"
        ));
    }
    if let Some(index) = expect.same_system_as {
        match records
            .get(index)
            .map(|earlier| view.same_system_as(earlier))
        {
            Some(Ok(true)) => {}
            Some(Ok(false)) => out.push(format!(
                "same_system_as: system content is missing or differs from request #{index}"
            )),
            Some(Err(why)) => out.push(format!(
                "same_system_as: could not compare with request #{index}: {why}"
            )),
            None => out.push(format!(
                "same_system_as: request #{index} was never received"
            )),
        }
    }
}

fn check_tool_results(
    expected: &[super::format::ToolResultExpect],
    view: &RequestView,
    out: &mut Vec<String>,
) {
    let actual: Vec<_> = view
        .request
        .messages
        .iter()
        .flat_map(|m| m.tool_result_contents.iter())
        .collect();
    let ids: Vec<&str> = actual.iter().map(|r| r.id.as_str()).collect();
    let want: Vec<&str> = expected.iter().map(|r| r.id.as_str()).collect();
    if ids != want {
        out.push(format!("tool_results: expected ids {want:?}, got {ids:?}"));
        return;
    }
    for (n, (want, have)) in expected.iter().zip(&actual).enumerate() {
        if let Some(is_error) = want.is_error
            && have.is_error != Some(is_error)
        {
            out.push(format!(
                "tool_results[{n}] ({}).is_error: expected {is_error}, got {:?}",
                want.id, have.is_error
            ));
        }
        if let Some(text) = &want.contains
            && !have.text.contains(text.as_str())
        {
            out.push(format!(
                "tool_results[{n}] ({}).contains: {text:?} is not in {}",
                want.id,
                compact(&Value::String(have.text.clone()), 200)
            ));
        }
    }
}

/// Checks the expected workspace files under `workspace`.
#[must_use]
pub fn check_files(expected: &BTreeMap<String, Option<String>>, workspace: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    for (path, content) in expected {
        let file = path
            .split('/')
            .fold(workspace.to_path_buf(), |p, part| p.join(part));
        let actual = match std::fs::read(&file) {
            Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                failures.push(format!("files.{path}: cannot read: {e}"));
                continue;
            }
        };
        match (content, actual) {
            (None, Some(actual)) => failures.push(format!(
                "files.{path}: expected no file, found one with {} bytes",
                actual.len()
            )),
            (Some(_), None) => failures.push(format!("files.{path}: expected a file, found none")),
            (Some(want), Some(have)) if *want != have => {
                failures.push(format!("files.{path}: {}", text_diff(want, &have)));
            }
            _ => {}
        }
    }
    failures
}

/// Checks `expect.fixtures`: each workspace file has exactly the bytes of its fixture.
#[must_use]
pub fn check_fixture_files(spec: &ScenarioSpec, workspace: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    for (path, name) in &spec.expect.fixtures {
        let file = path
            .split('/')
            .fold(workspace.to_path_buf(), |p, part| p.join(part));
        let (actual, expected) = match (std::fs::read(&file), std::fs::read(spec.fixture(name))) {
            (Ok(actual), Ok(expected)) => (actual, expected),
            (Err(e), _) => {
                failures.push(format!("files.{path}: cannot read: {e}"));
                continue;
            }
            (_, Err(e)) => {
                failures.push(format!("files.{path}: cannot read fixture {name}: {e}"));
                continue;
            }
        };
        if actual != expected {
            let at = actual
                .iter()
                .zip(&expected)
                .position(|(a, e)| a != e)
                .unwrap_or_else(|| actual.len().min(expected.len()));
            let window = |bytes: &[u8]| {
                let start = at.saturating_sub(8);
                let end = (at + 16).min(bytes.len());
                bytes
                    .get(start..end)
                    .map(|b| b.escape_ascii().to_string())
                    .unwrap_or_default()
            };
            failures.push(format!(
                "files.{path}: bytes differ from fixture {name} at byte {at} ({} vs {} bytes): \
                 expected …{}…, got …{}…",
                expected.len(),
                actual.len(),
                window(&expected),
                window(&actual)
            ));
        }
    }
    failures
}

/// The first differing line and both texts, line-numbered.
#[must_use]
pub fn text_diff(expected: &str, actual: &str) -> String {
    let want: Vec<&str> = expected.split('\n').collect();
    let have: Vec<&str> = actual.split('\n').collect();
    let line = want
        .iter()
        .zip(&have)
        .position(|(w, h)| w != h)
        .unwrap_or_else(|| want.len().min(have.len()));
    let mut out = format!(
        "content differs at line {}: expected {:?}, got {:?}\n",
        line + 1,
        want.get(line).copied().unwrap_or("<end of file>"),
        have.get(line).copied().unwrap_or("<end of file>")
    );
    for (title, lines) in [("expected", &want), ("actual", &have)] {
        let _ = writeln!(out, "    --- {title} ({} lines)", lines.len());
        for (n, text) in lines.iter().enumerate().take(40) {
            let marker = if n == line { ">" } else { " " };
            let _ = writeln!(out, "    {marker}{:>4} | {text:?}", n + 1);
        }
    }
    out
}

/// `expected` (`trusted`, `files` keyed by layer id) against Core's configuration diagnostics,
/// whose `files` are a list; `None` when it holds.
pub(super) fn config_diagnostics_mismatch(expected: &Value, report: &Value) -> Option<String> {
    let files: serde_json::Map<String, Value> = report["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| Some((f["layer"].as_str()?.to_owned(), f.clone())))
        .collect();
    let mut actual = report.clone();
    actual["files"] = Value::Object(files);
    subset_mismatch(expected, &actual, "config_diagnostics")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn differences(format: crate::request::WireFormat, first: &str, later: &str) -> Vec<String> {
        let record = |body: &str| RequestRecord {
            seq: 0,
            method: "POST".into(),
            path: "/model".into(),
            format: Some(format),
            scenario: None,
            step_index: None,
            headers: BTreeMap::new(),
            body: body.into(),
            violations: Vec::new(),
            outcome: crate::record::Outcome::Streamed,
        };
        let expect = serde_json::from_value(serde_json::json!({"index":1,"same_system_as":0}))
            .expect("request assertion");
        let view = RequestView::of(&record(later)).expect("valid model request");
        check_request(&expect, &view, &[record(first)])
    }

    #[test]
    fn same_system_as_compares_the_original_anthropic_json_bytes() {
        let first = r#"{"system":[{"type":"text","text":"é"}],"messages":[{"role":"user","content":"first"}]}"#;
        let changed_user = first.replace("first", "second");
        let wire = crate::request::WireFormat::AnthropicMessages;
        assert!(differences(wire, first, &changed_user).is_empty());
        let escaped = changed_user.replace('é', r"\u00e9");
        assert_eq!(
            differences(wire, first, &escaped).len(),
            1,
            "JSON escape spelling changed"
        );
    }

    #[test]
    fn same_system_as_compares_the_original_openai_message_bytes() {
        let first = r#"{"messages":[{"role":"system","content":"identity"},{"role":"developer","content":"rules"},{"role":"user","content":"first"}]}"#;
        let wire = crate::request::WireFormat::OpenaiChatCompletions;
        let changed_user = first.replace("first", "second");
        assert!(differences(wire, first, &changed_user).is_empty());
        let reordered = changed_user.replace(
            r#""role":"developer","content":"rules""#,
            r#""content":"rules", "role":"developer""#,
        );
        assert_eq!(
            differences(wire, first, &reordered).len(),
            1,
            "JSON member order changed"
        );
    }

    #[test]
    fn a_text_diff_names_the_first_differing_line() {
        let diff = text_diff("a\nb\nc\n", "a\nB\nc\n");
        assert!(
            diff.starts_with("content differs at line 2: expected \"b\", got \"B\""),
            "{diff}"
        );
        assert!(diff.contains(">   2 | \"B\""), "{diff}");
    }
}
