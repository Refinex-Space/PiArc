//! T27 through the real Core preflight: reading a file back after a compaction (`fs/read` with
//! `restore`, no tool call) and the compaction settings of `context/settings`.
use super::*;

impl Fixture {
    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        self.io
            .dispatch(
                method,
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
    }

    /// What the Agent Host's Read does after its preflight.
    async fn read_with_tool(&self, call: &str, path: &str) {
        assert_eq!(
            self.evaluate(call, "Read", json!({"path": path})).await["allowed"],
            true
        );
        let origin = json!({"tool": "Read", "toolCallId": call});
        let read = json!({"sessionId": SESSION, "path": path, "read": {}, "origin": origin});
        self.call("fs/stat", read.clone()).await.expect("stat");
        self.call(
            "fs/read",
            json!({"sessionId": SESSION, "path": path, "origin": origin}),
        )
        .await
        .expect("read");
        let mut done = read;
        done["completeRead"] = true.into();
        self.call("fs/stat", done).await.expect("complete read");
    }

    async fn restore(&self, path: &str) -> Result<Value, ErrorObject> {
        self.call(
            "fs/read",
            json!({"sessionId": SESSION, "path": path, "restore": true}),
        )
        .await
    }
}

#[tokio::test]
async fn restored_reads_need_a_file_the_session_saw() {
    let f = Fixture::new().await;
    let work = f.root.join("workspace");
    std::fs::write(work.join("seen.txt"), "first\n").expect("file");
    std::fs::write(work.join("unseen.txt"), "secret\n").expect("file");
    assert_eq!(
        f.restore("seen.txt")
            .await
            .expect_err("not read yet")
            .data
            .kind,
        ErrorKind::PermissionDenied
    );
    f.read_with_tool("r1", "seen.txt").await;
    std::fs::write(work.join("seen.txt"), "second\n").expect("changed outside");
    let restored = f.restore("seen.txt").await.expect("restored");
    assert_eq!(restored["text"], "second\n", "the current content");
    assert_eq!(
        f.restore("unseen.txt")
            .await
            .expect_err("never read")
            .data
            .kind,
        ErrorKind::PermissionDenied
    );
    // Without `restore` an origin-less read is still refused.
    assert!(
        f.call("fs/read", json!({"sessionId": SESSION, "path": "seen.txt"}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn context_settings_come_from_the_merged_layers() {
    let f = Fixture::new().await;
    let params = json!({"sessionId": SESSION});
    assert_eq!(
        f.call("context/settings", params.clone())
            .await
            .expect("settings"),
        json!({"autoCompactEnabled": true})
    );
    std::fs::create_dir_all(f.root.join("workspace/.claude")).expect("claude dir");
    std::fs::write(
        f.root.join("workspace/.claude/settings.json"),
        r#"{"autoCompactEnabled": false, "autoCompactWindow": 300000}"#,
    )
    .expect("claude settings");
    assert_eq!(
        f.call("context/settings", params).await.expect("settings"),
        json!({"autoCompactEnabled": false, "autoCompactWindow": 300000})
    );
}
