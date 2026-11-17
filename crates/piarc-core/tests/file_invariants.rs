//! The file tools' invariants on Core's side (T16, architecture section 6.1.2), through
//! `ToolIo::dispatch` without an Agent Host: the file state table (read before write, external
//! changes, repeated reads, separate tables per session), uploads with the diff of the write,
//! long results kept in the session's temporary directory, protected paths and PDF pages.

use std::path::PathBuf;

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{ToolIo, ToolIoConfig};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};

struct Fixture {
    root: PathBuf,
    io: ToolIo,
}

impl Fixture {
    /// Workspace `ws 工作区` shared by sessions `a` and `b`.
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc file-invariants {name} 中文 {}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        for dir in ["ws 工作区/.git", "data"] {
            std::fs::create_dir_all(root.join(dir)).expect("dir created");
        }
        let io = ToolIo::new(ToolIoConfig::new(root.join("data")));
        let ws = root.join("ws 工作区");
        for id in ["a", "b"] {
            io.open_session(id, &ws, &ws).expect("session opens");
        }
        Self { root, io }
    }

    fn file(&self, rel: &str) -> PathBuf {
        self.root.join("ws 工作区").join(rel)
    }

    fn put(&self, rel: &str, bytes: &[u8]) {
        std::fs::write(self.file(rel), bytes).expect("written");
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        let (peer, _frames) = Peer::channel(64);
        let Value::Object(params) = params else {
            panic!("params must be an object");
        };
        self.io.dispatch(method, params, peer).await
    }

    async fn read(&self, session: &str, path: &str, range: Value) -> Value {
        self.call(
            "fs/stat",
            json!({ "sessionId": session, "path": path, "read": range }),
        )
        .await
        .expect("stat for read")
    }

    async fn write(&self, session: &str, path: &str, content: &str) -> Result<Value, ErrorObject> {
        self.call(
            "fs/write",
            json!({ "sessionId": session, "path": path, "content": content }),
        )
        .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn kind(result: Result<Value, ErrorObject>) -> ErrorKind {
    result.expect_err("an error").data.kind
}

/// T16-A02 (Core side): an existing file is replaced only after this session read it, and only
/// while it is unchanged since; each session has its own table.
#[tokio::test]
async fn writes_need_a_fresh_read_by_the_same_session() {
    let f = Fixture::new("fresh");
    f.put("a.txt", b"one\n");
    assert_eq!(
        kind(f.write("a", "a.txt", "x").await),
        ErrorKind::FileNotRead
    );
    let fresh = json!({ "sessionId": "a", "path": "a.txt", "requireFresh": true });
    assert_eq!(
        kind(f.call("fs/read", fresh.clone()).await),
        ErrorKind::FileNotRead
    );

    f.read("a", "a.txt", json!({})).await;
    f.call("fs/read", fresh.clone()).await.expect("fresh read");
    // Session b has not read it.
    assert_eq!(
        kind(f.write("b", "a.txt", "x").await),
        ErrorKind::FileNotRead
    );

    f.put("a.txt", b"changed outside\n");
    let error = f.write("a", "a.txt", "x").await.expect_err("modified");
    assert_eq!(error.data.kind, ErrorKind::FileModified);
    assert!(error.message.contains("Read it again"), "{}", error.message);
    assert_eq!(
        kind(f.call("fs/read", fresh).await),
        ErrorKind::FileModified
    );
    assert_eq!(
        std::fs::read(f.file("a.txt")).expect("reads"),
        b"changed outside\n"
    );

    f.read("a", "a.txt", json!({})).await;
    f.write("a", "a.txt", "two\n").await.expect("written");
    // b's view is stale now that a wrote it.
    f.read("b", "a.txt", json!({ "offset": 1 })).await;
    f.write("a", "a.txt", "three\n")
        .await
        .expect("written again");
    assert_eq!(
        kind(f.write("b", "a.txt", "x").await),
        ErrorKind::FileModified
    );
}

/// T16-A06 (Core side): a read repeats the previous one only with the same range and content.
#[tokio::test]
async fn repeated_reads_are_recognized_per_range_and_content() {
    let f = Fixture::new("repeat");
    f.put("r.txt", b"x\n");
    let whole = json!({});
    assert_eq!(
        f.read("a", "r.txt", whole.clone()).await["unchanged"],
        false
    );
    assert_eq!(f.read("a", "r.txt", whole.clone()).await["unchanged"], true);
    assert_eq!(
        f.read("b", "r.txt", whole.clone()).await["unchanged"],
        false
    );
    let part = json!({ "offset": 2, "limit": 10 });
    assert_eq!(f.read("a", "r.txt", part.clone()).await["unchanged"], false);
    assert_eq!(f.read("a", "r.txt", part.clone()).await["unchanged"], true);
    f.put("r.txt", b"y\n");
    assert_eq!(f.read("a", "r.txt", part).await["unchanged"], false);
    // A directory is not recorded.
    let dir = f.read("a", ".", whole).await;
    assert_eq!(dir["kind"], "directory");
    assert!(dir.get("unchanged").is_none());
}

/// T16-A10 (Core side): a text in pieces is written once, atomically, and the result carries
/// the diff of the change.
#[tokio::test]
async fn an_upload_is_written_when_complete_with_its_diff() {
    let f = Fixture::new("upload");
    f.put("big.txt", b"keep\r\nold\r\n");
    f.read("a", "big.txt", json!({})).await;
    let piece = |content: &str, last: bool| {
        json!({
            "sessionId": "a",
            "path": "big.txt",
            "content": content,
            "lineEndings": "matchFile",
            "upload": { "id": "u1", "last": last },
        })
    };
    let staged = f
        .call("fs/write", piece("keep\nn", false))
        .await
        .expect("staged");
    assert_eq!(staged["staged"], true);
    assert_eq!(
        std::fs::read(f.file("big.txt")).expect("reads"),
        b"keep\r\nold\r\n"
    );
    let done = f
        .call("fs/write", piece("ew\n", true))
        .await
        .expect("written");
    assert_eq!(
        std::fs::read(f.file("big.txt")).expect("reads"),
        b"keep\r\nnew\r\n"
    );
    let diff = &done["diff"];
    assert_eq!(diff["path"], "big.txt");
    assert_eq!(
        (diff["added"].as_u64(), diff["removed"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(
        diff["hunks"][0]["lines"],
        json!([
            { "kind": "context", "text": "keep" },
            { "kind": "removed", "text": "old" },
            { "kind": "added", "text": "new" },
        ])
    );
    assert!(
        diff["unified"]
            .as_str()
            .expect("text")
            .contains("-old\n+new\n")
    );
    // A piece for another file under the same id is refused.
    f.call("fs/write", piece("a", false)).await.expect("staged");
    let other = json!({
        "sessionId": "a", "path": "other.txt", "content": "b",
        "upload": { "id": "u1", "last": true },
    });
    assert_eq!(
        kind(f.call("fs/write", other).await),
        ErrorKind::InvalidParams
    );
}

/// T16-A07 (Core side): protected paths need approval; until approvals exist they are refused
/// with a reason, and nothing is written.
#[tokio::test]
async fn protected_paths_are_refused_with_a_reason() {
    let f = Fixture::new("protected");
    for path in [".git/config", ".claude/settings.json", ".zshrc"] {
        let error = f.write("a", path, "x").await.expect_err("refused");
        assert_eq!(error.data.kind, ErrorKind::PermissionDenied, "{path}");
        let details = error.data.details.expect("details");
        assert_eq!(details["reason"], "protectedPath", "{path}");
        assert!(
            error.message.contains("protected path"),
            "{}",
            error.message
        );
        assert!(!f.file(path).exists(), "{path}");
    }
    let error = f
        .call(
            "fs/mkdir",
            json!({ "sessionId": "a", "path": ".pi/extensions" }),
        )
        .await
        .expect_err("refused");
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
}

/// T16-A05 (Core side): a long result goes to the session's temporary directory, under a path
/// without the user name that the session may read.
#[tokio::test]
async fn spilled_results_are_readable_by_their_session_only() {
    let f = Fixture::new("spill");
    let text = "line\n".repeat(20_000);
    let spilled = f
        .call(
            "fs/spill",
            json!({ "sessionId": "a", "name": "toolu_01", "content": text }),
        )
        .await
        .expect("spilled");
    let path = spilled["path"].as_str().expect("path").to_owned();
    assert!(path.ends_with("toolu_01.txt"), "{path}");
    let home = std::env::home_dir().expect("home");
    assert!(!path.contains(&*home.to_string_lossy()), "{path}");
    let on_disk = f.root.join("data/sessions/a/tmp/tool-results/toolu_01.txt");
    assert_eq!(std::fs::read_to_string(&on_disk).expect("reads"), text);
    let absolute = on_disk.to_string_lossy().into_owned();
    let read = f
        .call(
            "fs/read",
            json!({ "sessionId": "a", "path": absolute, "length": 10 }),
        )
        .await
        .expect("readable");
    assert_eq!(read["text"], "line\nline\n");
    let error = f
        .call("fs/read", json!({ "sessionId": "b", "path": absolute }))
        .await
        .expect_err("another session's directory");
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
    let write = json!({ "sessionId": "a", "path": absolute, "content": "x" });
    assert_eq!(
        kind(f.call("fs/write", write).await),
        ErrorKind::PermissionDenied
    );
}

/// T16-A03 (Core side): legacy encodings are reported and kept.
#[tokio::test]
async fn legacy_encodings_are_read_and_written_back() {
    let f = Fixture::new("encoding");
    let (gbk, _, _) = encoding_rs::GBK.encode("第一行是中文，编码为国标。\r\n第二行\r\n");
    f.put("gbk.txt", &gbk);
    let read = f
        .call("fs/read", json!({ "sessionId": "a", "path": "gbk.txt" }))
        .await
        .expect("read");
    assert_eq!(read["encoding"], "GBK");
    assert_eq!(read["text"], "第一行是中文，编码为国标。\r\n第二行\r\n");
    f.read("a", "gbk.txt", json!({})).await;
    let written = f
        .write(
            "a",
            "gbk.txt",
            "第一行是中文，编码为国标。\r\n第二行已改\r\n",
        )
        .await
        .expect("written");
    assert_eq!(written["encoding"], "GBK");
    let (expected, _, _) = encoding_rs::GBK.encode("第一行是中文，编码为国标。\r\n第二行已改\r\n");
    assert_eq!(std::fs::read(f.file("gbk.txt")).expect("reads"), &*expected);
    let error = f
        .write("a", "gbk.txt", "表情 🙂\n")
        .await
        .expect_err("emoji");
    assert_eq!(error.data.kind, ErrorKind::UnencodableText);
}
