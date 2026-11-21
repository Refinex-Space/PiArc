use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use piarc_ports::ExitStatus;
use serde_json::json;

use super::*;
use crate::config::{Handler, Source};
use crate::runner::{HandlerRun, RunStatus};

fn handler(block_on_failure: bool) -> Arc<Handler> {
    Arc::new(Handler {
        action: crate::config::Action::Command(crate::config::Command {
            command: "hook".into(),
            args: None,
            shell: None,
        }),
        timeout: None,
        condition: None,
        block_on_failure,
        source: Source {
            layer: "user".into(),
            file: Some(PathBuf::from("settings.json")),
        },
        pointer: "/hooks/x/0/hooks/0".into(),
    })
}

fn out(event: HookEvent, code: i32, stdout: &str, stderr: &str) -> Outcome {
    Outcome::read(
        event,
        HandlerRun {
            handler: handler(false),
            status: RunStatus::Exited(ExitStatus {
                code: Some(code),
                signal: None,
            }),
            stdout: stdout.into(),
            stderr: stderr.into(),
            duration: Duration::from_millis(1),
            detail: crate::runner::Detail::Process,
        },
    )
}

fn json_out(event: HookEvent, value: &serde_json::Value) -> Outcome {
    out(event, 0, &value.to_string(), "")
}

fn specific(event: HookEvent, fields: serde_json::Value) -> serde_json::Value {
    let mut fields = fields;
    fields["hookEventName"] = json!(event.name());
    json!({ "hookSpecificOutput": fields })
}

const PRE: HookEvent = HookEvent::PreToolUse;

#[test]
fn pre_tool_use_merges_deny_over_ask_over_allow() {
    let allow = json_out(
        PRE,
        &specific(
            PRE,
            json!({"permissionDecision": "allow", "permissionDecisionReason": "ok"}),
        ),
    );
    let ask = json_out(
        PRE,
        &specific(
            PRE,
            json!({"permissionDecision": "ask", "permissionDecisionReason": "check"}),
        ),
    );
    let deny = json_out(
        PRE,
        &specific(
            PRE,
            json!({"permissionDecision": "deny", "permissionDecisionReason": "no"}),
        ),
    );
    let d = Decision::merge(PRE, &[allow.clone(), ask.clone()]);
    assert_eq!(
        (d.permission, d.permission_reason.as_deref()),
        (Some(Permission::Ask), Some("check"))
    );
    let d = Decision::merge(PRE, &[ask, deny, allow.clone()]);
    assert_eq!(
        (d.permission, d.permission_reason.as_deref()),
        (Some(Permission::Deny), Some("no"))
    );
    assert_eq!(d.verdicts, ["ask", "deny", "allow"]);
    let d = Decision::merge(PRE, &[allow]);
    assert_eq!(d.permission, Some(Permission::Allow));
    let defer = json_out(PRE, &specific(PRE, json!({"permissionDecision": "defer"})));
    assert_eq!(
        Decision::merge(PRE, &[defer]).permission,
        Some(Permission::Ask)
    );
}

#[test]
fn pre_tool_use_exit_two_denies_with_stderr_even_with_an_allow() {
    let blocked = out(
        PRE,
        2,
        &specific(PRE, json!({"permissionDecision": "allow"})).to_string(),
        "rm is not allowed\n",
    );
    let d = Decision::merge(PRE, &[blocked]);
    assert_eq!(d.permission, Some(Permission::Deny));
    assert_eq!(d.permission_reason.as_deref(), Some("rm is not allowed"));
    let silent = out(PRE, 2, "", "");
    assert_eq!(
        Decision::merge(PRE, &[silent]).permission_reason.as_deref(),
        Some("")
    );
    let deprecated = json_out(PRE, &json!({"decision": "block", "reason": "old style"}));
    let d = Decision::merge(PRE, &[deprecated]);
    assert_eq!(
        (d.permission, d.permission_reason.as_deref()),
        (Some(Permission::Deny), Some("old style"))
    );
}

#[test]
fn pre_tool_use_keeps_the_input_of_the_winning_decision() {
    let allow_input = json_out(
        PRE,
        &specific(
            PRE,
            json!({"permissionDecision": "allow", "updatedInput": {"command": "ls -a"}}),
        ),
    );
    let ask_input = json_out(
        PRE,
        &specific(
            PRE,
            json!({"permissionDecision": "ask", "updatedInput": {"command": "ls -l"}}),
        ),
    );
    let loose = json_out(
        PRE,
        &specific(
            PRE,
            json!({"updatedInput": {"command": "ls -1"}, "additionalContext": "ctx"}),
        ),
    );
    let d = Decision::merge(PRE, &[allow_input.clone(), ask_input.clone()]);
    assert_eq!(
        d.updated_input,
        json!({"command": "ls -l"}).as_object().cloned()
    );
    let d = Decision::merge(PRE, std::slice::from_ref(&loose));
    assert_eq!(
        d.updated_input,
        json!({"command": "ls -1"}).as_object().cloned()
    );
    assert_eq!(d.context, ["ctx"]);
    assert_eq!(d.verdicts, ["updated"]);
    let deny = json_out(PRE, &specific(PRE, json!({"permissionDecision": "deny"})));
    let d = Decision::merge(PRE, &[allow_input, deny]);
    assert_eq!(d.updated_input, None);
    assert_eq!(
        d.permission_reason.as_deref(),
        Some("Blocked by a PreToolUse hook.")
    );
}

#[test]
fn other_exit_codes_are_errors_and_on_failure_block_denies() {
    let failing = out(PRE, 1, "", "boom\n");
    let d = Decision::merge(PRE, std::slice::from_ref(&failing));
    assert_eq!(d.permission, None);
    assert_eq!(
        d.errors,
        ["PreToolUse hook error: exited with code 1: boom"]
    );
    assert_eq!(d.verdicts, ["error"]);
    let strict = Outcome {
        handler: handler(true),
        ..failing
    };
    let d = Decision::merge(PRE, std::slice::from_ref(&strict));
    assert_eq!(d.permission, Some(Permission::Deny));
    let stop = Outcome {
        handler: handler(true),
        ..out(HookEvent::Stop, 1, "", "x")
    };
    assert!(Decision::merge(HookEvent::Stop, &[stop]).block.is_some());
    let post = Outcome {
        handler: handler(true),
        ..out(HookEvent::PostToolUse, 1, "", "x")
    };
    assert_eq!(
        Decision::merge(HookEvent::PostToolUse, &[post]).verdicts,
        ["error"]
    );
}

#[test]
fn permission_request_deny_beats_allow_and_allows_combine() {
    let ev = HookEvent::PermissionRequest;
    let allow = |rule: &str, input: Option<serde_json::Value>| {
        let mut decision = json!({"behavior": "allow", "updatedPermissions": [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": rule}], "behavior": "allow", "destination": "session"}]});
        if let Some(input) = input {
            decision["updatedInput"] = input;
        }
        json_out(ev, &specific(ev, json!({ "decision": decision })))
    };
    let d = Decision::merge(
        ev,
        &[
            allow("ls *", None),
            allow("pwd", Some(json!({"command": "pwd"}))),
        ],
    );
    let answer = d.request.unwrap_or_else(|| panic!("no answer"));
    assert!(answer.allow);
    assert_eq!(answer.updated_permissions.len(), 2);
    assert_eq!(
        answer.updated_input,
        json!({"command": "pwd"}).as_object().cloned()
    );
    let deny = json_out(
        ev,
        &specific(
            ev,
            json!({"decision": {"behavior": "deny", "message": "not now", "interrupt": true}}),
        ),
    );
    let d = Decision::merge(ev, &[allow("ls *", None), deny]);
    let answer = d.request.unwrap_or_else(|| panic!("no answer"));
    assert!(!answer.allow);
    assert_eq!(answer.message.as_deref(), Some("not now"));
    assert!(answer.interrupt);
    // Exit 2 without a decision object changes nothing.
    assert_eq!(
        Decision::merge(ev, &[out(ev, 2, "", "ignored")]).request,
        None
    );
}

#[test]
fn user_prompt_submit_blocks_and_adds_plain_and_json_context() {
    let ev = HookEvent::UserPromptSubmit;
    let d = Decision::merge(
        ev,
        &[
            out(ev, 0, "Branch: main\n", ""),
            json_out(ev, &specific(ev, json!({"additionalContext": "Ticket 12"}))),
        ],
    );
    assert_eq!(d.context, ["Branch: main", "Ticket 12"]);
    assert_eq!(d.block, None);
    let d = Decision::merge(
        ev,
        &[json_out(
            ev,
            &json!({"decision": "block", "reason": "secrets in prompt"}),
        )],
    );
    assert_eq!(d.block.as_deref(), Some("secrets in prompt"));
    let d = Decision::merge(ev, &[out(ev, 2, "", "nope")]);
    assert_eq!(d.block.as_deref(), Some("nope"));
    let d = Decision::merge(
        ev,
        &[json_out(
            ev,
            &json!({"continue": false, "stopReason": "paused"}),
        )],
    );
    assert_eq!(d.block.as_deref(), Some("paused"));
}

#[test]
fn stop_continues_with_the_reason_unless_a_handler_says_continue_false() {
    let ev = HookEvent::Stop;
    let d = Decision::merge(
        ev,
        &[
            json_out(ev, &json!({"decision": "block", "reason": "run the tests"})),
            out(ev, 2, "", "and lint"),
        ],
    );
    assert_eq!(d.block.as_deref(), Some("run the tests"));
    let d = Decision::merge(
        ev,
        &[json_out(
            ev,
            &specific(ev, json!({"additionalContext": "check docs"})),
        )],
    );
    assert_eq!(
        (d.block.as_deref(), d.context.as_slice()),
        (None, &["check docs".to_owned()][..])
    );
    let d = Decision::merge(
        ev,
        &[
            json_out(ev, &json!({"decision": "block", "reason": "more"})),
            json_out(
                ev,
                &json!({"continue": false, "stopReason": "budget", "systemMessage": "Stopping"}),
            ),
        ],
    );
    assert_eq!(d.block, None);
    assert_eq!(d.stop, Some(Some("budget".into())));
    assert_eq!(d.messages, ["Stopping"]);
}

#[test]
fn pre_compact_blocks_or_gives_instructions_and_ignores_common_fields() {
    let ev = HookEvent::PreCompact;
    let d = Decision::merge(
        ev,
        &[
            out(ev, 0, "Keep the API decisions.\n", ""),
            out(ev, 0, "Keep test names.", ""),
        ],
    );
    assert_eq!(
        d.instructions,
        ["Keep the API decisions.", "Keep test names."]
    );
    let d = Decision::merge(
        ev,
        &[json_out(
            ev,
            &json!({"decision": "block", "systemMessage": "x", "continue": false}),
        )],
    );
    assert_eq!(d.block.as_deref(), Some("Blocked by a PreCompact hook."));
    assert!(d.messages.is_empty() && d.stop.is_none());
    assert_eq!(
        Decision::merge(ev, &[out(ev, 2, "", "not now")])
            .block
            .as_deref(),
        Some("not now")
    );
}

#[test]
fn post_tool_use_feedback_context_and_replaced_output() {
    let ev = HookEvent::PostToolUse;
    let d = Decision::merge(
        ev,
        &[
            json_out(ev, &json!({"decision": "block", "reason": "lint failed"})),
            out(ev, 2, "", "format failed"),
            json_out(
                ev,
                &specific(
                    ev,
                    json!({"additionalContext": "see docs", "updatedToolOutput": "[redacted]"}),
                ),
            ),
        ],
    );
    assert_eq!(d.feedback, ["lint failed", "format failed"]);
    assert_eq!(d.context, ["see docs"]);
    assert_eq!(d.updated_output, Some(json!("[redacted]")));
    assert_eq!(d.block, None);
    let failure = HookEvent::PostToolUseFailure;
    let d = Decision::merge(
        failure,
        &[json_out(
            failure,
            &specific(
                failure,
                json!({"additionalContext": "retry with -v", "updatedToolOutput": "ignored"}),
            ),
        )],
    );
    assert_eq!(d.context, ["retry with -v"]);
    assert_eq!(d.updated_output, None);
}

#[test]
fn session_events_route_context_and_user_errors() {
    let start = HookEvent::SessionStart;
    let d = Decision::merge(
        start,
        &[
            out(start, 0, "Today: deploy freeze", ""),
            out(start, 2, "", "cannot reach tracker"),
        ],
    );
    assert_eq!(d.context, ["Today: deploy freeze"]);
    assert_eq!(d.errors, ["SessionStart hook: cannot reach tracker"]);
    assert_eq!(d.block, None);
    let end = HookEvent::SessionEnd;
    let d = Decision::merge(
        end,
        &[json_out(
            end,
            &json!({"systemMessage": "bye", "decision": "block"}),
        )],
    );
    assert_eq!(
        d,
        Decision {
            verdicts: vec!["none"],
            ..Decision::default()
        }
    );
    let notification = HookEvent::Notification;
    let d = Decision::merge(notification, &[out(notification, 2, "", "ignored")]);
    assert!(d.errors.is_empty());
}

fn replied(event: HookEvent, value: &serde_json::Value, block_on_failure: bool) -> Outcome {
    Outcome::read(
        event,
        HandlerRun {
            handler: handler(block_on_failure),
            status: RunStatus::Replied(value.as_object().cloned().unwrap_or_default()),
            stdout: String::new(),
            stderr: String::new(),
            duration: Duration::from_millis(1),
            detail: crate::runner::Detail::Http { status: Some(200) },
        },
    )
}

fn failed(event: HookEvent, why: &str, block_on_failure: bool) -> Outcome {
    Outcome::read(
        event,
        HandlerRun {
            handler: handler(block_on_failure),
            status: RunStatus::Failed(why.into()),
            stdout: String::new(),
            stderr: String::new(),
            duration: Duration::from_millis(1),
            detail: crate::runner::Detail::Http { status: Some(500) },
        },
    )
}

#[test]
fn subagent_stop_continues_like_stop_and_ignores_on_failure_block() {
    let e = HookEvent::SubagentStop;
    let d = Decision::merge(
        e,
        &[json_out(e, &json!({"decision": "block", "reason": "more"}))],
    );
    assert_eq!(d.block.as_deref(), Some("more"));
    let two = Decision::merge(e, &[out(e, 2, "", "keep going")]);
    assert_eq!(two.block.as_deref(), Some("keep going"));
    let stopped = Decision::merge(
        e,
        &[
            json_out(e, &json!({"decision": "block", "reason": "more"})),
            json_out(e, &json!({"continue": false})),
        ],
    );
    assert_eq!(stopped.block, None);
    let errored = Decision::merge(e, &[failed(e, "down", true)]);
    assert_eq!(errored.block, None);
    assert_eq!(errored.verdicts, ["error"]);
}

#[test]
fn subagent_start_adds_context_and_never_blocks() {
    let e = HookEvent::SubagentStart;
    let d = Decision::merge(
        e,
        &[json_out(
            e,
            &json!({"decision": "block", "hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": "use the fixtures"}}),
        )],
    );
    assert_eq!(d.block, None);
    assert_eq!(d.context, ["use the fixtures"]);
    let two = Decision::merge(e, &[out(e, 2, "", "careful")]);
    assert_eq!(two.block, None);
    assert_eq!(two.errors, ["SubagentStart hook: careful"]);
}

#[test]
fn post_tool_batch_blocks_with_the_reason_or_stops() {
    let e = HookEvent::PostToolBatch;
    let d = Decision::merge(
        e,
        &[json_out(e, &json!({"decision": "block", "reason": "lint"}))],
    );
    assert_eq!(d.block.as_deref(), Some("lint"));
    let two = Decision::merge(e, &[out(e, 2, "", "tests fail")]);
    assert_eq!(two.block.as_deref(), Some("tests fail"));
    let stop = Decision::merge(
        e,
        &[json_out(
            e,
            &json!({"continue": false, "stopReason": "done"}),
        )],
    );
    assert_eq!(stop.stop, Some(Some("done".into())));
    let context = Decision::merge(
        e,
        &[json_out(
            e,
            &json!({"hookSpecificOutput": {"hookEventName": "PostToolBatch", "additionalContext": "3 files changed"}}),
        )],
    );
    assert_eq!(context.context, ["3 files changed"]);
}

#[test]
fn replies_read_as_json_and_failures_as_errors() {
    let e = HookEvent::PreToolUse;
    let deny = Decision::merge(
        e,
        &[replied(
            e,
            &specific(
                e,
                json!({"permissionDecision": "deny", "permissionDecisionReason": "no"}),
            ),
            false,
        )],
    );
    assert_eq!(deny.permission, Some(Permission::Deny));
    let empty = Decision::merge(e, &[replied(e, &json!({}), false)]);
    assert_eq!(empty.permission, None);
    assert_eq!(empty.verdicts, ["none"]);
    let error = Decision::merge(e, &[failed(e, "the server answered HTTP 500", false)]);
    assert_eq!(error.permission, None);
    assert_eq!(
        error.errors,
        ["PreToolUse hook error: the server answered HTTP 500"]
    );
    let closed = Decision::merge(e, &[failed(e, "connection refused", true)]);
    assert_eq!(closed.permission, Some(Permission::Deny));
}
