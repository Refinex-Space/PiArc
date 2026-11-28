//! T38: `web/search` needs an approved WebSearch call for exactly its query and consumes it;
//! the backend is the user's choice, its key comes from the vault and never reaches an Agent
//! Host; the search is audited without the key; domain filters apply.
use std::sync::Mutex as StdMutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::secrets::{MemorySecretStore, SecretsConfig, SecretsService, test_master_key_name};
use crate::tool_io::WebConfig;

/// A Brave-shaped search service recording the request lines and token headers it saw.
async fn search_server(seen: Arc<StdMutex<Vec<String>>>) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            seen.lock().expect("seen").push(head);
            let body = r#"{"web":{"results":[
                {"title":"Tokio docs","url":"https://docs.rs/tokio","description":"An <strong>async</strong> runtime"},
                {"title":"Elsewhere","url":"https://example.com/tokio","description":"x"}
            ]}}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });
    port
}

struct Search {
    f: Fixture,
    io: ToolIo,
    secrets: SecretsService,
    seen: Arc<StdMutex<Vec<String>>>,
}

async fn search_fixture() -> Search {
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let port = search_server(Arc::clone(&seen)).await;
    let f = Fixture::build_with(
        super::super::super::CommandEnv::process(),
        Path::to_path_buf,
        false,
        system_clock(),
        WebConfig {
            search_endpoints: [(
                "brave".to_owned(),
                format!("http://127.0.0.1:{port}/res/v1/web/search"),
            )]
            .into(),
            ..WebConfig::default()
        },
    )
    .await;
    let secrets = SecretsService::new(
        SecretsConfig::with_master_key(&f.root.join("data"), test_master_key_name("t38")),
        Arc::new(MemorySecretStore::new()),
    );
    let io = f.io.clone().with_secrets(secrets.clone());
    Search {
        f,
        io,
        secrets,
        seen,
    }
}

impl Search {
    fn choose(&self, backend: Option<&str>) {
        std::fs::write(
            self.f.root.join("data/settings.json"),
            json!({ "webSearch": { "backend": backend }, "permissions": { "allow": ["WebSearch"] } })
                .to_string(),
        )
        .expect("user settings");
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        self.io
            .dispatch(
                method,
                params.as_object().expect("params").clone(),
                self.f.peer.clone(),
            )
            .await
    }

    async fn search(&self, call: &str, query: &str, extra: Value) -> Result<Value, ErrorObject> {
        let mut params = json!({
            "sessionId": SESSION,
            "origin": {"tool": "WebSearch", "toolCallId": call},
            "query": query,
        });
        if let (Value::Object(p), Value::Object(e)) = (&mut params, extra) {
            p.extend(e);
        }
        self.call("web/search", params).await
    }
}

#[tokio::test]
async fn the_backend_needs_a_choice_and_a_key() {
    let s = search_fixture().await;
    let none = s
        .call("web/searchBackend", json!({}))
        .await
        .expect("answer");
    assert_eq!(none, json!({"unavailable": "notConfigured"}));
    s.choose(Some("brave"));
    let no_key = s
        .call("web/searchBackend", json!({}))
        .await
        .expect("answer");
    assert_eq!(no_key, json!({"unavailable": "noKey"}));
    s.io.store_search_key(
        piarc_web::search::backend("brave").expect("brave"),
        Some("brave-key-1"),
    )
    .await
    .expect("stored");
    let ready = s
        .call("web/searchBackend", json!({}))
        .await
        .expect("answer");
    assert_eq!(
        ready,
        json!({"backend": {"id": "brave", "name": "Brave Search"}})
    );
}

#[tokio::test]
async fn an_allowed_call_searches_once_with_the_vaults_key_and_is_audited() {
    let s = search_fixture().await;
    s.choose(Some("brave"));
    s.io.store_search_key(
        piarc_web::search::backend("brave").expect("brave"),
        Some("brave-key-1"),
    )
    .await
    .expect("stored");
    // No approval: no search.
    let early = s.search("search-1", "tokio", json!({})).await.unwrap_err();
    assert_eq!(early.data.kind, ErrorKind::PermissionDenied);
    let ruling =
        s.f.evaluate("search-1", "WebSearch", json!({"query": "tokio"}))
            .await;
    assert_eq!(ruling["allowed"], true, "{ruling}");
    // Another query than the approved one is refused and keeps the grant.
    let other = s.search("search-1", "other", json!({})).await.unwrap_err();
    assert_eq!(other.data.kind, ErrorKind::PermissionDenied);
    let found = s
        .search(
            "search-1",
            "tokio",
            json!({"blockedDomains": ["example.com"]}),
        )
        .await
        .expect("searched");
    assert_eq!(found["backend"], "brave");
    assert_eq!(
        found["results"],
        json!([{"title": "Tokio docs", "url": "https://docs.rs/tokio", "snippet": "An async runtime"}])
    );
    let again = s.search("search-1", "tokio", json!({})).await.unwrap_err();
    assert_eq!(again.data.kind, ErrorKind::PermissionDenied);
    let seen = s.seen.lock().expect("seen").clone();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].starts_with("GET /res/v1/web/search?q=tokio&count=10 "));
    assert!(
        seen[0]
            .to_ascii_lowercase()
            .contains("x-subscription-token: brave-key-1")
    );
    let audit =
        s.f.storage
            .run(|db| db.audit_events(50))
            .await
            .expect("storage")
            .expect("audit");
    let row = audit
        .iter()
        .find(|r| r.kind == "webSearch")
        .expect("search audited");
    let detail: Value = serde_json::from_str(&row.detail).expect("detail");
    assert_eq!(detail["query"], "tokio");
    assert_eq!(detail["results"], 1);
    assert!(!audit.iter().any(|r| r.detail.contains("brave-key-1")));
}

#[tokio::test]
async fn agent_hosts_cannot_reach_search_keys() {
    let s = search_fixture().await;
    s.io.store_search_key(
        piarc_web::search::backend("brave").expect("brave"),
        Some("brave-key-1"),
    )
    .await
    .expect("stored");
    let ask = |method: &str, params: Value| {
        let secrets = s.secrets.clone();
        let peer = s.f.peer.clone();
        let method = method.to_owned();
        async move {
            secrets
                .dispatch(&method, params.as_object().expect("params").clone(), peer)
                .await
        }
    };
    let all = ask("secrets/getAll", json!({})).await.expect("getAll");
    assert!(!all.to_string().contains("brave-key-1"), "{all}");
    for (method, params) in [
        ("secrets/get", json!({"key": "websearch/brave"})),
        (
            "secrets/set",
            json!({"key": "websearch/brave", "value": {"apiKey": "x"}}),
        ),
        ("secrets/delete", json!({"key": "websearch/brave"})),
        (
            "secrets/lock",
            json!({"keys": ["provider/a", "websearch/brave"]}),
        ),
    ] {
        let refused = ask(method, params).await.unwrap_err();
        assert_eq!(refused.data.kind, ErrorKind::PermissionDenied, "{method}");
    }
}
