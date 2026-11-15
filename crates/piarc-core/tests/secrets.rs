//! `secrets/*` answered by Core's `SecretsService` over a real vault file, with the in-memory
//! credential store double: change push, structured vault errors, locks and their lease, and
//! concurrent read-modify-write without lost updates (T08-A06, A09 at the Core level).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use piarc_core::agent_host::Peer;
use piarc_core::secrets::{SecretsConfig, SecretsService};
use piarc_ports::SecretStoreError;
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_secrets::{MemorySecretStore, test_master_key_name};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

struct Fixture {
    dir: PathBuf,
    store: Arc<MemorySecretStore>,
    service: SecretsService,
}

impl Fixture {
    fn new(label: &str, lease: Duration) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc core secrets {label} {}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Arc::new(MemorySecretStore::new());
        let mut config = SecretsConfig::with_master_key(&dir, test_master_key_name("core"));
        config.lock_lease = lease;
        let service = SecretsService::new(config, Arc::clone(&store) as _);
        Self {
            dir,
            store,
            service,
        }
    }

    async fn call(&self, peer: &Peer, method: &str, params: Value) -> Result<Value, ErrorObject> {
        let Value::Object(params) = params else {
            panic!("params must be an object")
        };
        self.service.dispatch(method, params, peer.clone()).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn oauth(access: &str) -> Value {
    json!({ "type": "oauth", "access": access, "refresh": "r", "expires": 1 })
}

/// The next `secrets/changed` params on `frames`.
async fn next_change(frames: &mut mpsc::Receiver<Vec<u8>>) -> Map<String, Value> {
    let frame = tokio::time::timeout(Duration::from_secs(5), frames.recv())
        .await
        .expect("a notification arrives")
        .expect("the connection is open");
    let message: Value = serde_json::from_slice(&frame).expect("JSON frame");
    assert_eq!(message["method"], "secrets/changed");
    message["params"].as_object().expect("params").clone()
}

#[tokio::test]
async fn reads_writes_and_pushes_changes_to_subscribed_connections() {
    let f = Fixture::new("push", Duration::from_secs(30));
    let (host_a, mut frames_a) = Peer::channel(16);
    let (host_b, mut frames_b) = Peer::channel(16);
    let (bystander, mut frames_c) = Peer::channel(16);

    for peer in [&host_a, &host_b] {
        let all = f
            .call(peer, "secrets/getAll", json!({}))
            .await
            .expect("getAll");
        assert_eq!(all, json!({ "entries": [] }));
    }
    let set = f
        .call(
            &host_a,
            "secrets/set",
            json!({ "key": "oauth/example", "value": oauth("a1") }),
        )
        .await
        .expect("set");
    let revision = set["revision"].as_u64().expect("revision");
    for frames in [&mut frames_a, &mut frames_b] {
        let change = next_change(frames).await;
        assert_eq!(change["key"], "oauth/example");
        assert_eq!(change["revision"], revision);
        assert_eq!(change["value"], oauth("a1"));
    }
    let got = f
        .call(&bystander, "secrets/get", json!({ "key": "oauth/example" }))
        .await
        .expect("get");
    assert_eq!(got["entry"]["value"], oauth("a1"));

    let deleted = f
        .call(&host_b, "secrets/delete", json!({ "key": "oauth/example" }))
        .await
        .expect("delete");
    let delete_revision = deleted["revision"].as_u64().expect("revision");
    assert!(delete_revision > revision);
    for frames in [&mut frames_a, &mut frames_b] {
        let change = next_change(frames).await;
        assert_eq!(change["revision"], delete_revision);
        assert!(!change.contains_key("value"), "a deletion carries no value");
    }
    assert_eq!(
        f.call(&host_b, "secrets/delete", json!({ "key": "oauth/example" }))
            .await
            .expect("second delete"),
        json!({})
    );
    // `bystander` never called getAll: nothing was pushed to it.
    assert!(frames_c.try_recv().is_err());
    // A closed connection is dropped from the subscribers without affecting writes.
    drop(frames_b);
    f.call(
        &host_a,
        "secrets/set",
        json!({ "key": "provider/x", "value": { "type": "api_key" } }),
    )
    .await
    .expect("set after a subscriber left");
    assert_eq!(next_change(&mut frames_a).await["key"], "provider/x");
}

#[tokio::test]
async fn vault_failures_are_structured_and_the_next_request_retries() {
    let f = Fixture::new("failures", Duration::from_secs(30));
    let (peer, _frames) = Peer::channel(16);
    f.store
        .fail_with(SecretStoreError::AccessDenied("user denied".into()));
    let error = f
        .call(&peer, "secrets/getAll", json!({}))
        .await
        .expect_err("store refuses");
    assert_eq!(error.data.kind, ErrorKind::CredentialStoreUnavailable);
    assert!(error.data.retryable);
    assert_eq!(
        error.data.details,
        Some(json!({ "reason": "accessDenied" }))
    );
    assert!(
        std::fs::read_dir(&f.dir).expect("dir").next().is_none(),
        "nothing written while the store refuses"
    );

    f.store.recover();
    f.call(
        &peer,
        "secrets/set",
        json!({ "key": "provider/x", "value": { "type": "api_key", "key": "k" } }),
    )
    .await
    .expect("works once access is granted");

    // A fresh service (Core restart) whose key has vanished from the store.
    let config = SecretsConfig::with_master_key(&f.dir, test_master_key_name("core-missing"));
    let other = SecretsService::new(config, Arc::new(MemorySecretStore::new()));
    let error = other
        .dispatch("secrets/getAll", Map::new(), peer.clone())
        .await
        .expect_err("the vault exists, its key does not");
    assert_eq!(error.data.kind, ErrorKind::MasterKeyMissing);
    assert!(!error.data.retryable);

    // Invalid params never echo the value.
    let error = f
        .call(
            &peer,
            "secrets/set",
            json!({ "key": "provider/x", "value": "plain-secret-value" }),
        )
        .await
        .expect_err("a string is not a credential");
    assert_eq!(error.data.kind, ErrorKind::InvalidParams);
    assert!(!error.message.contains("plain-secret-value"));
}

#[tokio::test]
async fn locks_serialize_writers_until_unlocked() {
    let f = Fixture::new("locks", Duration::from_millis(300));
    let (a, _fa) = Peer::channel(16);
    let (b, _fb) = Peer::channel(16);
    f.call(
        &a,
        "secrets/set",
        json!({ "key": "oauth/p", "value": oauth("v1") }),
    )
    .await
    .expect("seed");

    let locked = f
        .call(
            &a,
            "secrets/lock",
            json!({ "keys": ["provider/p", "oauth/p"] }),
        )
        .await
        .expect("lock");
    let lock_id = locked["lockId"].as_str().expect("lock id").to_owned();
    assert_eq!(locked["entries"][0]["value"], oauth("v1"));
    assert_eq!(locked["expiresInMs"], 300);

    // B's unlocked write of a locked key waits; an unrelated key does not.
    let service = f.service.clone();
    let b2 = b.clone();
    let waiting = tokio::spawn(async move {
        let Value::Object(p) = json!({ "key": "oauth/p", "value": oauth("from-b") }) else {
            unreachable!()
        };
        service.dispatch("secrets/set", p, b2).await
    });
    f.call(
        &b,
        "secrets/set",
        json!({ "key": "oauth/other", "value": oauth("x") }),
    )
    .await
    .expect("other keys are free");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished(), "the locked key's write waits");

    // The holder writes under its lock, a key outside it is refused.
    f.call(
        &a,
        "secrets/set",
        json!({ "key": "oauth/p", "value": oauth("v2"), "lockId": lock_id }),
    )
    .await
    .expect("write under the lock");
    let error = f
        .call(
            &a,
            "secrets/set",
            json!({ "key": "oauth/other", "value": oauth("y"), "lockId": lock_id }),
        )
        .await
        .expect_err("not covered");
    assert_eq!(error.data.kind, ErrorKind::SecretLockLost);
    assert_eq!(
        f.call(&a, "secrets/unlock", json!({ "lockId": lock_id }))
            .await
            .expect("unlock"),
        json!({ "released": true })
    );
    waiting
        .await
        .expect("task")
        .expect("B's write proceeds after the unlock");
    let got = f
        .call(&a, "secrets/get", json!({ "key": "oauth/p" }))
        .await
        .expect("get");
    assert_eq!(
        got["entry"]["value"],
        oauth("from-b"),
        "B wrote after A, nothing lost"
    );
}

#[tokio::test]
async fn a_lock_ends_after_its_lease_or_when_its_connection_ends() {
    let f = Fixture::new("lease", Duration::from_millis(300));
    let (a, _fa) = Peer::channel(16);
    let (b, _fb) = Peer::channel(16);
    // Lease: an abandoned lock ends on its own, and its id stops working.
    let locked = f
        .call(&a, "secrets/lock", json!({ "keys": ["oauth/p"] }))
        .await
        .expect("lock");
    let stale = locked["lockId"].as_str().expect("id").to_owned();
    let started = std::time::Instant::now();
    f.call(&b, "secrets/lock", json!({ "keys": ["oauth/p"] }))
        .await
        .expect("granted once the lease ran out");
    assert!(started.elapsed() >= Duration::from_millis(200));
    let error = f
        .call(
            &a,
            "secrets/set",
            json!({ "key": "oauth/p", "value": oauth("late"), "lockId": stale }),
        )
        .await
        .expect_err("expired lock");
    assert_eq!(error.data.kind, ErrorKind::SecretLockLost);
    assert_eq!(
        f.call(&a, "secrets/unlock", json!({ "lockId": stale }))
            .await
            .expect("unlock"),
        json!({ "released": false })
    );

    // Connection end: a holder that goes away releases its lock at once.
    let (gone, frames) = Peer::channel(16);
    f.call(&gone, "secrets/lock", json!({ "keys": ["mcp/s"] }))
        .await
        .expect("lock");
    drop(frames);
    let started = std::time::Instant::now();
    f.call(&a, "secrets/lock", json!({ "keys": ["mcp/s"] }))
        .await
        .expect("lock after holder left");
    assert!(started.elapsed() < Duration::from_millis(250));
}

/// Two connections each run 25 locked read-increment-write cycles on one key at the same
/// time; the counter ends at 50.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_locked_updates_lose_nothing() {
    let f = Arc::new(Fixture::new("counter", Duration::from_secs(30)));
    let (seed, _) = Peer::channel(16);
    f.call(
        &seed,
        "secrets/set",
        json!({ "key": "oauth/c", "value": { "n": 0 } }),
    )
    .await
    .expect("seed");
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let f = Arc::clone(&f);
        tasks.push(tokio::spawn(async move {
            let (peer, _frames) = Peer::channel(64);
            for _ in 0..25 {
                let locked = f
                    .call(&peer, "secrets/lock", json!({ "keys": ["oauth/c"] }))
                    .await
                    .expect("lock");
                let n = locked["entries"][0]["value"]["n"].as_u64().expect("n");
                tokio::task::yield_now().await;
                f.call(
                    &peer,
                    "secrets/set",
                    json!({ "key": "oauth/c", "value": { "n": n + 1 }, "lockId": locked["lockId"] }),
                )
                .await
                .expect("set");
                f.call(&peer, "secrets/unlock", json!({ "lockId": locked["lockId"] }))
                    .await
                    .expect("unlock");
            }
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }
    let got = f
        .call(&seed, "secrets/get", json!({ "key": "oauth/c" }))
        .await
        .expect("get");
    assert_eq!(got["entry"]["value"]["n"], 50);
}
