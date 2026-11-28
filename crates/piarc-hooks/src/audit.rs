//! The audit record of one handler's run (`audit_events`, `kind: "hook"`). Nothing that can
//! carry a credential is recorded as written: a command by its program name and a SHA-256
//! digest, an `http` handler by its URL's origin and digest, a `prompt` handler by its prompt's
//! digest, with the model that answered and its tokens.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::config::{Action, Handler};
use crate::event::HookEvent;
use crate::output::Outcome;
use crate::runner::Detail;

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `scheme://host[:port]` of `url`.
fn origin(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit('@').next().unwrap_or_default();
    format!("{scheme}://{authority}")
}

/// The audit record of one handler's run.
#[must_use]
pub fn audit_detail(
    event: HookEvent,
    subject: Option<&str>,
    outcome: &Outcome,
    verdict: &str,
) -> Value {
    let handler = &outcome.handler;
    let mut record = describe(event, subject, handler);
    match &outcome.detail {
        Detail::Process => {}
        Detail::McpTool { is_error } => {
            record.insert("toolError".into(), json!(is_error));
        }
        Detail::Http { status } => {
            record.insert("httpStatus".into(), json!(status));
        }
        Detail::Prompt {
            model,
            input_tokens,
            output_tokens,
        } => {
            record.insert("model".into(), json!(model));
            record.insert("inputTokens".into(), json!(input_tokens));
            record.insert("outputTokens".into(), json!(output_tokens));
        }
    }
    record.insert("exitCode".into(), json!(outcome.exit_code));
    record.insert("durationMs".into(), json!(outcome.duration_ms));
    record.insert("timedOut".into(), json!(outcome.timed_out));
    record.insert("cancelled".into(), json!(outcome.cancelled));
    record.insert("decision".into(), json!(verdict));
    Value::Object(record)
}

/// The audit record of a hook handler that did not run because managed settings allow only
/// managed hooks (T47, `allowManagedHooksOnly`): the same fields that name the handler, and
/// `decision: "skipped"` with the reason.
#[must_use]
pub fn skipped_detail(
    event: HookEvent,
    subject: Option<&str>,
    handler: &Handler,
    reason: &str,
) -> Value {
    let mut record = describe(event, subject, handler);
    record.insert("decision".into(), json!("skipped"));
    record.insert("skipped".into(), json!(reason));
    Value::Object(record)
}

/// The fields that name a handler: event, matcher value, where it is defined, its type and a
/// hash of what it runs.
fn describe(event: HookEvent, subject: Option<&str>, handler: &Handler) -> Map<String, Value> {
    let mut record = Map::new();
    record.insert("event".into(), json!(event.name()));
    record.insert("matcherValue".into(), json!(subject));
    record.insert("layer".into(), json!(handler.source.layer));
    record.insert(
        "source".into(),
        json!(
            handler
                .source
                .file
                .as_ref()
                .map(|f| f.display().to_string())
        ),
    );
    record.insert("pointer".into(), json!(handler.pointer));
    record.insert("type".into(), json!(handler.kind().name()));
    match &handler.action {
        Action::Command(command) => {
            let mut text = command.command.clone();
            for arg in command.args.iter().flatten() {
                text.push('\0');
                text.push_str(arg);
            }
            let program: String = command
                .command
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .chars()
                .take(64)
                .collect();
            record.insert("program".into(), json!(program));
            record.insert("commandSha256".into(), json!(sha256(&text)));
        }
        Action::Http(http) => {
            record.insert("urlOrigin".into(), json!(origin(&http.url)));
            record.insert("urlSha256".into(), json!(sha256(&http.url)));
        }
        Action::Prompt(prompt) => {
            record.insert("promptSha256".into(), json!(sha256(&prompt.prompt)));
        }
        Action::McpTool(tool) => {
            record.insert("server".into(), json!(tool.server));
            record.insert("tool".into(), json!(tool.tool));
        }
    }
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_drop_paths_queries_and_credentials() {
        assert_eq!(
            origin("https://u:p@hooks.example:8443/a?token=x"),
            "https://hooks.example:8443"
        );
        assert_eq!(origin("http://localhost/x"), "http://localhost");
    }
}
