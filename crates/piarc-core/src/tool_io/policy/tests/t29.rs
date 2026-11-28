//! T29: `web/fetch` needs an approved WebFetch call for exactly its URL, consumes it, refuses
//! internal addresses outside the allowlist and is audited; `WebFetch(domain:…)` rules and the
//! "always allow" suggestion use the host the fetch connects to.
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::tool_io::WebConfig;

/// A server answering every request with one HTML page.
async fn page_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf).await;
            let body = "<html><body><h1>Fetched page</h1></body></html>";
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });
    port
}

impl Fixture {
    async fn with_web(allowlist: &[&str]) -> Self {
        Self::build_with(
            super::super::super::CommandEnv::process(),
            Path::to_path_buf,
            false,
            system_clock(),
            WebConfig {
                allowlist: allowlist.iter().map(|s| (*s).to_owned()).collect(),
                ..WebConfig::default()
            },
        )
        .await
    }

    async fn fetch(&self, call: &str, url: &str) -> Result<Value, ErrorObject> {
        let params = json!({
            "sessionId": SESSION,
            "origin": {"tool": "WebFetch", "toolCallId": call},
            "url": url,
        });
        self.io
            .dispatch(
                "web/fetch",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
    }

    /// The user's settings: their rules need no project trust.
    fn user_rules(&self, rules: &Value) {
        std::fs::write(
            self.root.join("data/settings.json"),
            json!({ "permissions": rules }).to_string(),
        )
        .expect("user settings");
    }

    fn allow_rule(&self, rule: &str) {
        self.user_rules(&json!({ "allow": [rule] }));
    }
}

#[tokio::test]
async fn an_allowed_call_fetches_once_and_is_audited() {
    let port = page_server().await;
    let f = Fixture::with_web(&["127.0.0.1"]).await;
    f.allow_rule("WebFetch(domain:127.0.0.1)");
    let url = format!("http://127.0.0.1:{port}/docs");
    let ruling = f
        .evaluate(
            "fetch-1",
            "WebFetch",
            json!({"url": url, "prompt": "title"}),
        )
        .await;
    assert_eq!(ruling["allowed"], true, "{ruling}");
    let page = f.fetch("fetch-1", &url).await.expect("fetched");
    assert_eq!(page["status"], 200);
    assert_eq!(page["format"], "markdown");
    assert!(
        page["content"].as_str().unwrap().contains("# Fetched page"),
        "{page}"
    );
    // One approval is one fetch.
    let again = f.fetch("fetch-1", &url).await.unwrap_err();
    assert_eq!(again.data.kind, ErrorKind::PermissionDenied);
    let audit = f
        .storage
        .run(|s| s.audit_events(20))
        .await
        .expect("storage")
        .expect("audit");
    let row = audit
        .iter()
        .find(|r| r.kind == "webFetch")
        .expect("fetch audited");
    let detail: Value = serde_json::from_str(&row.detail).expect("detail");
    assert_eq!(detail["url"], url);
    assert_eq!(detail["status"], 200);
}

#[tokio::test]
async fn a_fetch_needs_the_approved_url() {
    let port = page_server().await;
    let f = Fixture::with_web(&["127.0.0.1"]).await;
    f.allow_rule("WebFetch(domain:127.0.0.1)");
    let url = format!("http://127.0.0.1:{port}/a");
    // No preflight at all.
    assert_eq!(
        f.fetch("never-asked", &url).await.unwrap_err().data.kind,
        ErrorKind::PermissionDenied
    );
    let ruling = f
        .evaluate("fetch-2", "WebFetch", json!({"url": url, "prompt": "p"}))
        .await;
    assert_eq!(ruling["allowed"], true);
    let other = format!("http://127.0.0.1:{port}/b");
    assert_eq!(
        f.fetch("fetch-2", &other).await.unwrap_err().data.kind,
        ErrorKind::PermissionDenied
    );
}

#[tokio::test]
async fn internal_addresses_stay_refused_without_the_allowlist() {
    let port = page_server().await;
    let f = Fixture::with_web(&[]).await;
    f.allow_rule("WebFetch(domain:127.0.0.1)");
    let url = format!("http://127.0.0.1:{port}/");
    let ruling = f
        .evaluate("fetch-3", "WebFetch", json!({"url": url, "prompt": "p"}))
        .await;
    assert_eq!(ruling["allowed"], true, "the rule allows the domain");
    let error = f.fetch("fetch-3", &url).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
    assert_eq!(error.data.details.unwrap()["reason"], "blockedAddress");
    assert!(error.message.contains("loopback"), "{}", error.message);
}

#[tokio::test]
async fn manual_mode_asks_and_offers_a_domain_rule() {
    let f = Fixture::with_web(&[]).await;
    let ask = f.evaluate(
        "fetch-4",
        "WebFetch",
        json!({"url": "https://Docs.Example.com:8443/guide?q=1", "prompt": "p"}),
    );
    let check = async {
        let card = f.pending().await;
        assert_eq!(card.tool, "WebFetch");
        assert_eq!(
            card.rules,
            vec!["WebFetch(domain:docs.example.com)".to_owned()]
        );
        f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
            .await
            .expect("answered");
    };
    let (ruling, ()) = tokio::join!(ask, check);
    assert_eq!(ruling["allowed"], false);
    // A URL without a fetchable host offers no rule (a bare `WebFetch` would allow everything).
    let ask = f.evaluate(
        "fetch-5",
        "WebFetch",
        json!({"url": "notaurl", "prompt": "p"}),
    );
    let check = async {
        let card = f.pending().await;
        assert!(card.rules.is_empty(), "{:?}", card.rules);
        f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
            .await
            .expect("answered");
    };
    tokio::join!(ask, check);
}

#[tokio::test]
async fn deny_and_ask_rules_match_the_fetched_host() {
    let f = Fixture::with_web(&[]).await;
    f.user_rules(&json!({
        "deny": ["WebFetch(domain:*.blocked.test)"],
        "allow": ["WebFetch(domain:*)"],
    }));
    let ruling = f
        .evaluate(
            "fetch-6",
            "WebFetch",
            json!({"url": "https://api.BLOCKED.test/x", "prompt": "p"}),
        )
        .await;
    assert_eq!(ruling["allowed"], false, "{ruling}");
    let ruling = f
        .evaluate(
            "fetch-7",
            "WebFetch",
            json!({"url": "https://open.test/x", "prompt": "p"}),
        )
        .await;
    assert_eq!(ruling["allowed"], true, "{ruling}");
}
