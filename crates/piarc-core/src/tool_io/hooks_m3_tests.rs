//! T38 through the real Core: `http` hooks against a local server (A06), `prompt` hooks through
//! a stand-in for the Agent Host's model call (A07), untrusted projects (A12), and the common
//! fields `prompt_id` and `effort` (I115).
use piarc_ports::BoxFuture;
use piarc_protocol::hooks::{HooksPromptParams, HooksPromptResult};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::hooks::HookOutlet;

/// One request the server saw.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

/// A local HTTP server: `/block` answers a Stop block, `/error` 500, `/plain` text, `/slow`
/// never; every request is recorded.
async fn server() -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("address").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buf = [0u8; 8192];
                let (head, body) = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length: usize = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if text.len() >= end + 4 + length {
                        break (text[..end].to_owned(), text[end + 4..].to_owned());
                    }
                };
                let mut lines = head.lines();
                let path = lines
                    .next()
                    .and_then(|l| l.split(' ').nth(1))
                    .unwrap_or_default()
                    .to_owned();
                let headers = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
                    .collect();
                lock(&log).push(Seen {
                    path: path.clone(),
                    headers,
                    body,
                });
                let (status, reply) = match path.as_str() {
                    "/block" => ("200 OK", r#"{"decision":"block","reason":"from http"}"#),
                    "/context" => (
                        "200 OK",
                        r#"{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"batch noted"}}"#,
                    ),
                    "/error" => ("500 Internal Server Error", r#"{"decision":"block"}"#),
                    "/plain" => ("200 OK", "fine"),
                    "/slow" => {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    _ => ("204 No Content", ""),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

fn http(url: String, extra: Value) -> Value {
    let mut handler = json!({ "type": "http", "url": url });
    if let (Value::Object(h), Value::Object(e)) = (&mut handler, extra) {
        h.extend(e);
    }
    handler
}

fn env_with_token() -> Option<CommandEnv> {
    Some(CommandEnv::Fixed(vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOOK_TOKEN".into(), "tok-1".into()),
        ("OTHER_SECRET".into(), "never-sent".into()),
    ]))
}

fn stop() -> Value {
    json!({"sessionId": SESSION, "event": "stop", "cwd": "", "input": {"last_assistant_message": "done"}})
}

fn in_work(fixture: &Fixture, mut params: Value) -> Value {
    params["cwd"] = json!(fixture.work.to_string_lossy());
    params
}

#[tokio::test]
async fn http_hooks_decide_interpolate_only_allowed_variables_and_respect_the_url_allowlist() {
    let (port, seen) = server().await;
    let base = format!("http://127.0.0.1:{port}");
    let f = Fixture::new(Setup {
        user: json!({"Stop": group("", &[
            http(format!("{base}/block"), json!({
                "headers": {"Authorization": "Bearer $HOOK_TOKEN", "X-Other": "${OTHER_SECRET}"},
                "allowedEnvVars": ["HOOK_TOKEN", "OTHER_SECRET"]
            })),
            http(format!("{base}/outside"), json!({})),
        ])}),
        user_settings: json!({
            "allowedHttpHookUrls": [format!("http://127.0.0.1:{port}/block*")],
            "httpHookAllowedEnvVars": ["HOOK_TOKEN"]
        }),
        command_env: env_with_token(),
        ..Setup::default()
    })
    .await;
    let result = f.hooks_run(in_work(&f, stop())).await.expect("hooks/run");
    assert_eq!(result["block"], "from http");
    let requests = lock(&seen).clone();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0].path, "/block");
    let header = |name: &str| {
        requests[0]
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(header("authorization").as_deref(), Some("Bearer tok-1"));
    assert_eq!(header("x-other").as_deref(), Some(""));
    assert_eq!(header("content-type").as_deref(), Some("application/json"));
    let body: Value = serde_json::from_str(&requests[0].body).expect("JSON body");
    assert_eq!(body["hook_event_name"], "Stop");
    assert_eq!(body["session_id"], SESSION);
    let notices = f.notices().await;
    assert!(
        notices.iter().any(|n| n["message"]
            .as_str()
            .is_some_and(|m| m.contains("allowedHttpHookUrls"))),
        "{notices:?}"
    );
    let audit = f.hook_audit().await;
    let posted = audit
        .iter()
        .find(|a| a["httpStatus"] == 200)
        .expect("an audited post");
    assert_eq!(posted["type"], "http");
    assert_eq!(posted["urlOrigin"], base);
    assert!(!audit.iter().any(|a| a.to_string().contains("tok-1")));
}

#[tokio::test]
async fn failed_http_hooks_do_not_block() {
    let (port, _) = server().await;
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        listener.local_addr().expect("address").port()
    };
    let base = format!("http://127.0.0.1:{port}");
    let f = Fixture::new(Setup {
        user: json!({"PostToolBatch": group("", &[
            http(format!("{base}/error"), json!({})),
            http(format!("{base}/slow"), json!({"timeout": 1})),
            http(format!("http://127.0.0.1:{closed}/gone"), json!({})),
            http(format!("{base}/plain"), json!({})),
            http(format!("{base}/context"), json!({})),
        ])}),
        ..Setup::default()
    })
    .await;
    let started = Instant::now();
    let params = json!({"sessionId": SESSION, "event": "postToolBatch", "cwd": "", "input": {"tool_calls": []}});
    let result = f.hooks_run(in_work(&f, params)).await.expect("hooks/run");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(result.get("block"), None, "{result}");
    assert_eq!(result["context"], "batch noted");
    let errors: Vec<String> = f
        .notices()
        .await
        .iter()
        .filter(|n| n["level"] == "error")
        .filter_map(|n| n["message"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(errors.len(), 4, "{errors:?}");
    assert!(errors.iter().any(|e| e.contains("HTTP 500")));
    assert!(errors.iter().any(|e| e.contains("timed out")));
    assert!(errors.iter().any(|e| e.contains("not a JSON object")));
}

/// Answers by the prompt: "deny-me" refuses, "slow" outlasts any timeout, "garbled" is no JSON.
struct Judge(Arc<Mutex<Vec<HooksPromptParams>>>);

impl HookOutlet for Judge {
    fn judge(
        &self,
        params: HooksPromptParams,
    ) -> BoxFuture<'static, Result<HooksPromptResult, String>> {
        lock(&self.0).push(params.clone());
        Box::pin(async move {
            let text = if params.prompt.contains("deny-me") {
                r#"{"ok": false, "reason": "tests are missing"}"#
            } else if params.prompt.contains("slow") {
                tokio::time::sleep(Duration::from_secs(30)).await;
                r#"{"ok": true}"#
            } else if params.prompt.contains("garbled") {
                "Looks good to me."
            } else {
                r#"{"ok": true}"#
            };
            Ok(HooksPromptResult {
                text: text.into(),
                model: "piarc-mock/judge".into(),
                input_tokens: 40,
                output_tokens: 9,
            })
        })
    }
}

fn prompt(text: &str, extra: Value) -> Value {
    let mut handler = json!({ "type": "prompt", "prompt": text });
    if let (Value::Object(h), Value::Object(e)) = (&mut handler, extra) {
        h.extend(e);
    }
    handler
}

#[tokio::test]
async fn prompt_hooks_block_with_the_reason_and_fail_open() {
    let f = Fixture::new(Setup {
        user: json!({
            "Stop": group("", &[prompt("deny-me: $ARGUMENTS", json!({"model": "fast"}))]),
            "PreToolUse": group("Bash", &[prompt("deny-me", json!({"continueOnBlock": true}))]),
            "PostToolBatch": group("", &[
                prompt("slow", json!({"timeout": 1})),
                prompt("garbled", json!({})),
            ]),
        }),
        ..Setup::default()
    })
    .await;
    let asked = Arc::new(Mutex::new(Vec::new()));
    f.io.set_hook_outlet(Arc::new(Judge(Arc::clone(&asked))));
    let result = f.hooks_run(in_work(&f, stop())).await.expect("hooks/run");
    assert_eq!(result["block"], "tests are missing");
    let first = lock(&asked)[0].clone();
    assert_eq!(first.session_id, SESSION);
    assert_eq!(first.model.as_deref(), Some("fast"));
    assert_eq!(first.timeout_ms, 30_000);
    let input = first
        .prompt
        .strip_prefix("deny-me: ")
        .expect("the input in place of $ARGUMENTS");
    let input: Value = serde_json::from_str(input).expect("input JSON");
    assert_eq!(input["hook_event_name"], "Stop");
    let denied = f
        .evaluate("call-1", "Bash", json!({"command": "printenv HOME"}))
        .await;
    assert_eq!(denied["allowed"], false);
    assert!(
        denied["reason"]
            .as_str()
            .is_some_and(|r| r.contains("tests are missing")),
        "{denied}"
    );
    assert_eq!(
        denied.get("stop"),
        None,
        "continueOnBlock keeps the turn going"
    );
    let params = json!({"sessionId": SESSION, "event": "postToolBatch", "cwd": "", "input": {"tool_calls": []}});
    let started = Instant::now();
    let batch = f.hooks_run(in_work(&f, params)).await.expect("hooks/run");
    assert_eq!(batch.get("block"), None);
    assert!(started.elapsed() < Duration::from_secs(10));
    let errors = f
        .notices()
        .await
        .iter()
        .filter(|n| n["level"] == "error" && n["event"] == "PostToolBatch")
        .count();
    assert_eq!(errors, 2);
    let audit = f.hook_audit().await;
    let judged = audit
        .iter()
        .find(|a| a["event"] == "Stop")
        .expect("audited");
    assert_eq!(judged["type"], "prompt");
    assert_eq!(judged["model"], "piarc-mock/judge");
    assert_eq!(judged["inputTokens"], 40);
    assert_eq!(judged["outputTokens"], 9);
}

#[tokio::test]
async fn an_untrusted_projects_http_and_prompt_hooks_do_not_run() {
    let (port, seen) = server().await;
    let f = Fixture::new(Setup {
        trusted: false,
        project: json!({"Stop": group("", &[
            http(format!("http://127.0.0.1:{port}/block"), json!({})),
            prompt("deny-me", json!({})),
        ])}),
        ..Setup::default()
    })
    .await;
    let asked = Arc::new(Mutex::new(Vec::new()));
    f.io.set_hook_outlet(Arc::new(Judge(Arc::clone(&asked))));
    let result = f.hooks_run(in_work(&f, stop())).await.expect("hooks/run");
    assert_eq!(result.get("block"), None);
    assert!(lock(&seen).is_empty());
    assert!(lock(&asked).is_empty());
    f.trust
        .decide(
            &f.work,
            true,
            &f.trust.view(&f.work).await.expect("view").version,
        )
        .await
        .expect("trust");
    let trusted = f.hooks_run(in_work(&f, stop())).await.expect("hooks/run");
    assert_eq!(trusted["block"], "from http");
    assert_eq!(lock(&asked).len(), 1);
}

#[tokio::test]
async fn inputs_carry_the_prompt_id_and_the_effort_of_tool_events() {
    let f = Fixture::new(Setup {
        user: json!({
            "Stop": group("", &[command(&records("stop"))]),
            "SessionEnd": group("", &[command(&records("end"))]),
        }),
        ..Setup::default()
    })
    .await;
    let before = json!({"sessionId": SESSION, "event": "stop", "cwd": "", "input": {"effort": {"level": "high"}}});
    f.hooks_run(in_work(&f, before.clone()))
        .await
        .expect("hooks/run");
    assert_eq!(f.log("stop")[0].get("prompt_id"), None);
    f.io.user_prompt_submit(SESSION, "hello", &CancellationToken::new())
        .await
        .expect("no hooks block it");
    f.hooks_run(in_work(&f, before)).await.expect("hooks/run");
    let end = json!({"sessionId": SESSION, "event": "sessionEnd", "cwd": "", "input": {"reason": "other", "effort": {"level": "high"}}});
    f.hooks_run(in_work(&f, end)).await.expect("hooks/run");
    let stops = f.log("stop");
    let id = stops[1]["prompt_id"].as_str().expect("a prompt id");
    assert_eq!(stops[1]["effort"], json!({"level": "high"}));
    let ends = f.log("end");
    assert_eq!(ends[0]["prompt_id"], id);
    assert_eq!(ends[0].get("effort"), None, "SessionEnd has no effort");
    assert_eq!(ends[0].get("agent_id"), None);
}
