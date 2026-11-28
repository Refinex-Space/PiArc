//! `prompt` handlers (Claude Code's semantics, ADR-0055): the prompt with the input JSON in place
//! of `$ARGUMENTS` (appended when the prompt has none; `\$` keeps a literal dollar), one model
//! call, and the answer `{ok, reason, impossible}` translated into the command output protocol
//! of the event:
//!
//! | Event | `ok: false` |
//! |---|---|
//! | `PreToolUse` | deny with the reason; the turn also ends unless `continueOnBlock` |
//! | `Stop`, `SubagentStop` | continue with the reason, unless `impossible` |
//! | `PostToolUse` | `continueOnBlock`: the reason for the model; otherwise the turn ends |
//! | `PostToolUseFailure` | the reason for the model |
//! | `UserPromptSubmit`, `PostToolBatch` | block with the reason |
//! | `PermissionRequest` | nothing |
//!
//! An answer without a JSON object holding a boolean `ok` is a non-blocking error.

use serde_json::{Map, Value, json};

use crate::config::Prompt;
use crate::event::HookEvent;

/// What a refusal without a reason says.
const NO_REASON: &str = "A prompt hook did not approve.";

/// `template` with `input` in place of each `$ARGUMENTS`; `\$` stands for `$`.
#[must_use]
pub fn fill(template: &str, input: &str) -> String {
    const PLACEHOLDER: &str = "$ARGUMENTS";
    let mut out = String::with_capacity(template.len() + input.len());
    let mut used = false;
    let mut rest = template;
    while let Some(at) = rest.find(['\\', '$']) {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        if let Some(escaped) = tail.strip_prefix("\\$") {
            out.push('$');
            rest = escaped;
        } else if let Some(after) = tail.strip_prefix(PLACEHOLDER) {
            out.push_str(input);
            used = true;
            rest = after;
        } else {
            out.push_str(&tail[..1]);
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    if !used {
        out.push_str("\n\n");
        out.push_str(input);
    }
    out
}

/// The JSON object in the model's text: the whole text, or the part from the first `{` to the
/// last `}` (models wrap answers in prose or code fences).
fn answer_object(text: &str) -> Option<Map<String, Value>> {
    let trimmed = text.trim();
    if let Ok(Value::Object(map)) = serde_json::from_str(trimmed) {
        return Some(map);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    match serde_json::from_str(trimmed.get(start..=end)?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// The command output JSON that `text`, the model's answer to `handler`, means on `event`.
///
/// # Errors
///
/// The answer has no JSON object with a boolean `ok`.
pub(crate) fn verdict(
    event: HookEvent,
    handler: &Prompt,
    text: &str,
) -> Result<Map<String, Value>, String> {
    let answer =
        answer_object(text).ok_or_else(|| "the model's answer is not a JSON object".to_owned())?;
    let ok = answer
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| "the model's answer has no boolean \"ok\"".to_owned())?;
    if ok {
        return Ok(Map::new());
    }
    let reason = answer
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or(NO_REASON);
    let impossible = answer.get("impossible") == Some(&Value::Bool(true));
    let block = || json!({ "decision": "block", "reason": reason });
    let stop = || json!({ "continue": false, "stopReason": reason });
    let output = match event {
        HookEvent::PreToolUse => {
            let mut deny = json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                },
            });
            if !handler.continue_on_block {
                deny["continue"] = json!(false);
                deny["stopReason"] = json!(reason);
            }
            deny
        }
        HookEvent::Stop | HookEvent::SubagentStop if impossible => json!({}),
        HookEvent::PostToolUse if !handler.continue_on_block => stop(),
        HookEvent::Stop
        | HookEvent::SubagentStop
        | HookEvent::PostToolUse
        | HookEvent::PostToolUseFailure
        | HookEvent::UserPromptSubmit
        | HookEvent::PostToolBatch => block(),
        _ => json!({}),
    };
    Ok(match output {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(continue_on_block: bool) -> Prompt {
        Prompt {
            prompt: "Check $ARGUMENTS".into(),
            model: None,
            continue_on_block,
        }
    }

    #[test]
    fn arguments_are_filled_escaped_or_appended() {
        assert_eq!(fill("Check $ARGUMENTS now", "{}"), "Check {} now");
        assert_eq!(fill("a $ARGUMENTS b $ARGUMENTS", "X"), "a X b X");
        assert_eq!(fill(r"Costs \$1.00: $ARGUMENTS", "X"), "Costs $1.00: X");
        assert_eq!(fill(r"Keep \$ARGUMENTS", "X"), "Keep $ARGUMENTS\n\nX");
        assert_eq!(
            fill("No placeholder", "{\"a\":1}"),
            "No placeholder\n\n{\"a\":1}"
        );
        assert_eq!(fill("$1 and $HOME", "X"), "$1 and $HOME\n\nX");
    }

    #[test]
    fn answers_translate_per_event() {
        let no = r#"Here: ```json
{"ok": false, "reason": "tests fail"}
```"#;
        let v = |event, cob, text| verdict(event, &prompt(cob), text);
        assert_eq!(v(HookEvent::Stop, false, r#"{"ok": true}"#), Ok(Map::new()));
        assert_eq!(
            v(HookEvent::Stop, false, no).map(Value::Object),
            Ok(json!({"decision": "block", "reason": "tests fail"}))
        );
        assert_eq!(
            v(
                HookEvent::SubagentStop,
                false,
                r#"{"ok":false,"reason":"r","impossible":true}"#
            ),
            Ok(Map::new())
        );
        let deny = v(HookEvent::PreToolUse, false, no).map(Value::Object);
        assert_eq!(
            deny,
            Ok(json!({
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "tests fail"},
                "continue": false, "stopReason": "tests fail"
            }))
        );
        let goes_on = v(HookEvent::PreToolUse, true, no).map(Value::Object);
        assert_eq!(goes_on.map(|j| j.get("continue").cloned()), Ok(None));
        assert_eq!(
            v(HookEvent::PostToolUse, false, no).map(Value::Object),
            Ok(json!({"continue": false, "stopReason": "tests fail"}))
        );
        assert_eq!(
            v(HookEvent::PostToolUse, true, no).map(Value::Object),
            Ok(json!({"decision": "block", "reason": "tests fail"}))
        );
        assert_eq!(
            v(HookEvent::UserPromptSubmit, false, r#"{"ok": false}"#).map(Value::Object),
            Ok(json!({"decision": "block", "reason": NO_REASON}))
        );
        assert_eq!(v(HookEvent::PermissionRequest, false, no), Ok(Map::new()));
        assert!(v(HookEvent::Stop, false, "I think it is fine").is_err());
        assert!(v(HookEvent::Stop, false, r#"{"ok": "yes"}"#).is_err());
    }
}
