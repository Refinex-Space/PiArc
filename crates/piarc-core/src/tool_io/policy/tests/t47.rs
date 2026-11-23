//! T47 through the real Core preflight: the `Memory` tool's decision, `memory/apply` with its
//! permission and audit, the index in the memory snapshot, and turning auto memory off.
use super::*;

impl Fixture {
    async fn memory(&self, call: &str, input: Value) -> Result<Value, ErrorObject> {
        let mut params = input.as_object().expect("input").clone();
        params.insert("sessionId".into(), json!(SESSION));
        params.insert("toolCallId".into(), json!(call));
        self.io
            .dispatch("memory/apply", params, self.peer.clone())
            .await
    }

    async fn allowed_memory(&self, call: &str, input: Value) -> Result<Value, ErrorObject> {
        let decision = self.evaluate(call, "Memory", input.clone()).await;
        assert_eq!(decision["allowed"], true, "{decision}");
        self.memory(call, input).await
    }

    fn memory_rows(&self) -> Vec<Value> {
        self.storage
            .with(|s| s.session_audit_events(SESSION, 200))
            .expect("open")
            .expect("audit")
            .iter()
            .filter(|r| r.kind == "memory")
            .map(|r| serde_json::from_str(&r.detail).expect("detail"))
            .collect()
    }
}

/// T47-A02's Core side: a save writes the topic and the index under the data directory and an
/// audit row with the session; reads and deletes follow; nothing runs without its permission.
#[expect(
    clippy::too_many_lines,
    reason = "one memory's whole life: save, reads and a delete bound to their calls, the audit"
)]
#[tokio::test]
async fn memory_calls_are_allowed_bound_to_their_call_and_audited() {
    let f = Fixture::new().await;
    let status =
        f.io.dispatch(
            "memory/status",
            json!({"sessionId": SESSION}).as_object().unwrap().clone(),
            f.peer.clone(),
        )
        .await
        .expect("status");
    assert_eq!(status, json!({"enabled": true, "tool": true}));
    let save = json!({"action": "save", "name": "build", "type": "project",
        "description": "Run cargo check before committing", "content": "Use cargo check --workspace."});
    let saved = f.allowed_memory("m1", save.clone()).await.expect("save");
    assert_eq!(saved["changed"], true);
    assert!(
        saved["text"]
            .as_str()
            .unwrap()
            .starts_with("Saved memory \"build\"")
    );
    let index = &saved["index"];
    assert_eq!(index["kind"], "autoMemory");
    assert!(
        index["content"]
            .as_str()
            .unwrap()
            .contains("- [build](build.md) (project, ")
    );
    let dir = Path::new(index["path"].as_str().unwrap())
        .parent()
        .unwrap()
        .to_owned();
    assert_eq!(
        dir.parent().and_then(Path::file_name),
        Some(std::ffi::OsStr::new(crate::auto_memory::ROOT_DIR))
    );
    assert!(dir.join("build.md").is_file() && dir.join("MEMORY.md").is_file());
    let rows = f.memory_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["action"], "save");
    assert_eq!(rows[0]["by"], "agent");
    assert_eq!(rows[0]["toolCallId"], "m1");
    assert_eq!(rows[0]["created"], true);

    // The permission is the call's own: a second apply, or another name, is refused.
    assert!(f.memory("m1", save.clone()).await.is_err());
    let decision = f
        .evaluate("m2", "Memory", json!({"action": "delete", "name": "build"}))
        .await;
    assert_eq!(decision["allowed"], true, "{decision}");
    assert!(
        f.memory("m2", json!({"action": "delete", "name": "other"}))
            .await
            .is_err()
    );

    let read = f
        .allowed_memory("m3", json!({"action": "read", "name": "build"}))
        .await
        .expect("read");
    assert!(
        read["text"]
            .as_str()
            .unwrap()
            .contains("Use cargo check --workspace.")
    );
    assert!(read.get("changed").is_none(), "a read changes nothing");
    // A restore read after a compaction needs no call and cannot write.
    let restored = f
        .memory(
            "restore",
            json!({"action": "read", "name": "build", "restore": true}),
        )
        .await
        .expect("restore");
    assert!(
        restored["text"]
            .as_str()
            .unwrap()
            .contains("Memory \"build\" (project")
    );
    assert!(
        f.memory(
            "restore",
            json!({"action": "save", "name": "x", "restore": true})
        )
        .await
        .is_err()
    );

    let session = f.io.session(SESSION).unwrap();
    let file = f.io.auto_memory_index(&session).await.expect("index");
    assert!(file.content.starts_with("# Auto memory"));

    f.allowed_memory("m4", json!({"action": "delete", "name": "build"}))
        .await
        .expect("delete");
    assert_eq!(f.memory_rows().len(), 2);
    assert!(f.io.auto_memory_index(&session).await.is_none());
}

/// T47-A05's Core side: turned off, the snapshot has no index, the session offers no tool and
/// a call is refused; a deny rule removes the tool like any other.
#[tokio::test]
async fn auto_memory_turned_off_offers_nothing() {
    let f = Fixture::new().await;
    f.allowed_memory(
        "m1",
        json!({"action": "save", "name": "a", "type": "user",
        "description": "d", "content": "b"}),
    )
    .await
    .expect("save");
    std::fs::write(
        f.work.join(".piarc/settings.local.json"),
        r#"{"autoMemoryEnabled": false}"#,
    )
    .expect("settings");
    let status =
        f.io.dispatch(
            "memory/status",
            json!({"sessionId": SESSION}).as_object().unwrap().clone(),
            f.peer.clone(),
        )
        .await
        .expect("status");
    assert_eq!(status, json!({"enabled": false, "tool": false}));
    let session = f.io.session(SESSION).unwrap();
    assert!(f.io.auto_memory_index(&session).await.is_none());
    let refused = f
        .allowed_memory("m2", json!({"action": "read"}))
        .await
        .expect_err("off");
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);

    std::fs::write(
        f.work.join(".piarc/settings.local.json"),
        r#"{"autoMemoryEnabled": true, "permissions": {"deny": ["Memory"]}}"#,
    )
    .expect("settings");
    let denied = f.evaluate("m3", "Memory", json!({"action": "read"})).await;
    assert_eq!(denied["allowed"], false, "{denied}");
}
