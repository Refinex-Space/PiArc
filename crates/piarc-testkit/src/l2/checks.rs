//! Request and file assertions of a scenario.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::Path;

use serde_json::Value;

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
                check_request(expect, &view)
                    .into_iter()
                    .map(|f| format!("{name}.{f}")),
            ),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    failures
}

/// Mismatches of one request, each starting with the field.
fn check_request(expect: &RequestExpect, view: &RequestView) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
