//! `http` and `prompt` handlers through fake ports: allowlist, timeout, cancellation, a missing
//! port, and what the audit gets.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use piarc_ports::BoxFuture;
use serde_json::json;

use super::*;
use crate::config::Source;
use crate::ports::{HttpCall, HttpReply, JudgeReply};

struct NoSpawn;

impl ProcessSpawner for NoSpawn {
    fn spawn(&self, _spec: SpawnSpec) -> std::io::Result<piarc_ports::SpawnedProcess> {
        Err(std::io::Error::other("no processes here"))
    }
}

struct NoLaunch;

impl Launcher for NoLaunch {
    fn spec(&self, _command: &Command, _cwd: &Path) -> Result<SpawnSpec, Error> {
        Err(Error::CannotStart("no shell".into()))
    }
}

/// Answers every post with `reply` after `delay`, recording the calls.
struct FakeHttp {
    reply: Result<HttpReply, String>,
    delay: Duration,
    calls: Mutex<Vec<HttpCall>>,
}

impl HttpPort for FakeHttp {
    fn post(&self, call: HttpCall) -> BoxFuture<'static, Result<HttpReply, String>> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(call);
        let (reply, delay) = (self.reply.clone(), self.delay);
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            reply
        })
    }
}

struct FakeJudge {
    text: &'static str,
    calls: Mutex<Vec<JudgeCall>>,
}

impl JudgePort for FakeJudge {
    fn judge(&self, call: JudgeCall) -> BoxFuture<'static, Result<JudgeReply, String>> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(call);
        let text = self.text.to_owned();
        Box::pin(async move {
            Ok(JudgeReply {
                text,
                model: "mock/judge".into(),
                input_tokens: 12,
                output_tokens: 3,
            })
        })
    }
}

fn handler(action: Action, timeout: Option<Duration>) -> Arc<Handler> {
    Arc::new(Handler {
        action,
        timeout,
        condition: None,
        block_on_failure: false,
        source: Source {
            layer: "user".into(),
            file: None,
        },
        pointer: "/hooks/Stop/0/hooks/0".into(),
    })
}

fn http(url: &str) -> Action {
    Action::Http(Http {
        url: url.into(),
        headers: BTreeMap::from([("X-Token".into(), "$TOKEN".into())]),
        allowed_env_vars: vec!["TOKEN".into()],
    })
}

fn runner() -> Runner {
    Runner::new(
        Arc::new(NoSpawn),
        Arc::new(NoLaunch),
        RunnerConfig::default(),
    )
}

fn rules(urls: Option<Vec<String>>) -> HttpRules {
    HttpRules {
        allowed_urls: urls,
        allowed_env_vars: None,
        env: HashMap::from([("TOKEN".to_owned(), "secret-1".to_owned())]),
    }
}

async fn run_one(runner: &Runner, event: HookEvent, h: Arc<Handler>) -> HandlerRun {
    let cancel = CancellationToken::new();
    runner
        .run(
            event,
            &[h],
            &json!({"hook_event_name": event.name()}),
            Path::new("/"),
            &cancel,
        )
        .await
        .remove(0)
}

#[tokio::test]
async fn http_handlers_post_the_input_and_read_the_reply() {
    let port = Arc::new(FakeHttp {
        reply: Ok(HttpReply {
            status: 200,
            body: br#"{"decision":"block","reason":"not yet"}"#.to_vec(),
        }),
        delay: Duration::ZERO,
        calls: Mutex::default(),
    });
    let runner = runner().with_http(port.clone(), rules(None));
    let run = run_one(
        &runner,
        HookEvent::Stop,
        handler(http("https://h.example/stop"), None),
    )
    .await;
    assert_eq!(
        run.status,
        RunStatus::Replied(
            json!({"decision": "block", "reason": "not yet"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );
    assert_eq!(run.detail, Detail::Http { status: Some(200) });
    let calls = port
        .calls
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(calls[0].url, "https://h.example/stop");
    assert!(
        calls[0]
            .headers
            .contains(&("X-Token".into(), "secret-1".into()))
    );
    assert_eq!(calls[0].body, br#"{"hook_event_name":"Stop"}"#);
}

#[tokio::test]
async fn urls_outside_the_allowlist_get_no_request() {
    let port = Arc::new(FakeHttp {
        reply: Ok(HttpReply {
            status: 200,
            body: Vec::new(),
        }),
        delay: Duration::ZERO,
        calls: Mutex::default(),
    });
    let runner = runner().with_http(
        port.clone(),
        rules(Some(vec!["https://allowed.example/*".into()])),
    );
    let run = run_one(
        &runner,
        HookEvent::Stop,
        handler(http("https://other.example/x"), None),
    )
    .await;
    assert!(matches!(&run.status, RunStatus::Failed(why) if why.contains("allowedHttpHookUrls")));
    assert!(
        port.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
}

#[tokio::test]
async fn http_timeouts_errors_and_a_missing_port_do_not_block() {
    let slow = Arc::new(FakeHttp {
        reply: Ok(HttpReply {
            status: 200,
            body: Vec::new(),
        }),
        delay: Duration::from_secs(5),
        calls: Mutex::default(),
    });
    let runner_slow = runner().with_http(slow, rules(None));
    let started = Instant::now();
    let run = run_one(
        &runner_slow,
        HookEvent::Stop,
        handler(http("https://h.example/"), Some(Duration::from_millis(100))),
    )
    .await;
    assert_eq!(run.status, RunStatus::TimedOut(Duration::from_millis(100)));
    assert!(started.elapsed() < Duration::from_secs(2));
    let refused = Arc::new(FakeHttp {
        reply: Err("connection refused".into()),
        delay: Duration::ZERO,
        calls: Mutex::default(),
    });
    let run = run_one(
        &runner().with_http(refused, rules(None)),
        HookEvent::Stop,
        handler(http("https://h.example/"), None),
    )
    .await;
    assert_eq!(run.status, RunStatus::Failed("connection refused".into()));
    let missing = run_one(
        &runner(),
        HookEvent::Stop,
        handler(http("https://h.example/"), None),
    )
    .await;
    assert!(matches!(missing.status, RunStatus::NotStarted(_)));
}

struct FailingMcp(piarc_protocol::ErrorKind);

impl McpToolPort for FailingMcp {
    fn call(
        &self,
        _call: McpToolCall,
    ) -> BoxFuture<'static, Result<crate::McpToolReply, piarc_protocol::ErrorObject>> {
        let kind = self.0;
        Box::pin(async move {
            Err(piarc_protocol::ErrorObject::new(
                kind,
                "remote failure",
                false,
            ))
        })
    }
}

#[tokio::test]
async fn an_mcp_tool_timeout_reported_by_the_host_counts_as_a_timeout() {
    let timeout = Duration::from_secs(1);
    let hook = handler(
        Action::McpTool(crate::config::McpTool {
            server: "checks".into(),
            tool: "reply".into(),
            input: json!({}),
        }),
        Some(timeout),
    );
    for (kind, expected) in [
        (
            piarc_protocol::ErrorKind::Timeout,
            RunStatus::TimedOut(timeout),
        ),
        (
            piarc_protocol::ErrorKind::InternalError,
            RunStatus::Failed("remote failure".into()),
        ),
    ] {
        let runner = runner().with_mcp(Arc::new(FailingMcp(kind)));
        assert_eq!(
            run_one(&runner, HookEvent::PostToolUse, hook.clone())
                .await
                .status,
            expected
        );
    }
}

#[tokio::test]
async fn cancelling_the_event_stops_remote_handlers() {
    let slow = Arc::new(FakeHttp {
        reply: Ok(HttpReply {
            status: 200,
            body: Vec::new(),
        }),
        delay: Duration::from_secs(30),
        calls: Mutex::default(),
    });
    let runner = runner().with_http(slow, rules(None));
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stopper.cancel();
    });
    let runs = runner
        .run(
            HookEvent::Stop,
            &[handler(http("https://h.example/"), None)],
            &json!({}),
            Path::new("/"),
            &cancel,
        )
        .await;
    assert_eq!(runs[0].status, RunStatus::Cancelled);
}

#[tokio::test]
async fn prompt_handlers_ask_the_judge_and_translate_its_answer() {
    let judge = Arc::new(FakeJudge {
        text: r#"{"ok": false, "reason": "run the tests first"}"#,
        calls: Mutex::default(),
    });
    let runner = runner().with_judge(judge.clone());
    let action = Action::Prompt(Prompt {
        prompt: "Is this done? $ARGUMENTS".into(),
        model: Some("fast".into()),
        continue_on_block: false,
    });
    let run = run_one(&runner, HookEvent::Stop, handler(action, None)).await;
    assert_eq!(
        run.status,
        RunStatus::Replied(
            json!({"decision": "block", "reason": "run the tests first"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );
    assert_eq!(
        run.detail,
        Detail::Prompt {
            model: Some("mock/judge".into()),
            input_tokens: 12,
            output_tokens: 3
        }
    );
    let first = judge
        .calls
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)[0]
        .clone();
    assert_eq!(first.prompt, r#"Is this done? {"hook_event_name":"Stop"}"#);
    assert_eq!(first.model.as_deref(), Some("fast"));
    assert_eq!(first.timeout_ms, 30_000);
    let unreadable = Arc::new(FakeJudge {
        text: "Looks fine to me.",
        calls: Mutex::default(),
    });
    let action = Action::Prompt(Prompt {
        prompt: "p".into(),
        model: None,
        continue_on_block: false,
    });
    let run = run_one(
        &runner.with_judge(unreadable),
        HookEvent::Stop,
        handler(action, None),
    )
    .await;
    assert!(matches!(run.status, RunStatus::Failed(_)));
}
