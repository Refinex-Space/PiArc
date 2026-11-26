//! The `Browser` tool's runs (ADR-0089, design addendum `docs/architecture/addenda/browser.md`
//! B2.1).
//!
//! `browser/run` consumes the grant of the same `Browser` call (one approval, one run), then
//! hands the run to the desktop client: Core emits a `run` event on `core/browser` and waits for
//! the client's `answer_browser_run`. A turn interrupt, the connection closing or the timeout
//! cancel the run (a `cancel` event tells the client). The output is cut to the inline budget
//! and the whole text spilled to the session's temporary directory; every run writes one
//! `browser` audit row (script hash, duration, outcome, blocked hosts), never the script or the
//! page.
//!
//! The client registers itself with [`ToolIo::attach_browser_client`] when the app starts;
//! without it Core answers `hostUnavailable` at once and offers no `browser` capability.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use piarc_protocol::browser::{
    BrowserClientEvent, BrowserImage, BrowserRunAnswer, BrowserRunParams, BrowserRunResult,
};
use piarc_protocol::session::SessionId;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use piarc_host::Peer;

use super::{ToolIo, lock, policy, to_value};
use crate::events::Event;
use crate::route::RouteKey;

/// The default run time.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// The longest run time a call may ask for.
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// The shortest run time a call may ask for.
pub const MIN_TIMEOUT_MS: u64 = 1_000;
/// Extra time for the client to report a timed-out run before Core gives up on it.
const ANSWER_GRACE: Duration = Duration::from_secs(2);
/// Characters of output the model gets inline; the rest is in the spill file.
pub const INLINE_OUTPUT_CHARS: usize = 30_000;
/// Images one run may attach.
pub const MAX_IMAGES: usize = 8;
/// Bytes of one attached image's base64.
pub const MAX_IMAGE_BASE64: usize = 5 * 1024 * 1024;

/// The runs waiting for the desktop client.
#[derive(Debug, Default)]
pub(crate) struct BrowserRuns {
    attached: AtomicBool,
    next: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<BrowserRunAnswer>>>,
}

fn unavailable() -> ErrorObject {
    let mut error = ErrorObject::new(
        ErrorKind::HostUnavailable,
        "the built-in browser is not available: no desktop client is attached",
        false,
    );
    error.data.details = Some(json!({ "reason": "browserClient" }));
    error
}

/// Whose browser a run uses: the main session's Spaces in the workspace's partition.
struct RunOwner {
    main_session_id: String,
    agent_type: Option<String>,
    workspace: String,
}

enum Ended {
    Answered(BrowserRunAnswer),
    Cancelled,
    TimedOut,
}

impl ToolIo {
    /// The desktop client is ready to run `Browser` scripts (the app's main process calls it at
    /// start). Workspaces started from now on offer the `browser` capability.
    pub fn attach_browser_client(&self) {
        self.browser.attached.store(true, Ordering::SeqCst);
    }

    /// Whether a desktop client runs `Browser` scripts.
    #[must_use]
    pub fn browser_attached(&self) -> bool {
        self.browser.attached.load(Ordering::SeqCst)
    }

    /// Whether workspaces started now offer the `Browser` tool: a client is attached and the
    /// user has not turned it off (`browser.agentEnabled` in their own settings file, default
    /// on; project settings cannot change it).
    #[must_use]
    pub fn browser_offered(&self) -> bool {
        self.browser_attached() && agent_enabled(&self.config.data_dir)
    }

    /// The client's answer to run `run_id`; false when no run waits for it (it ended).
    pub fn answer_browser_run(&self, run_id: &str, answer: BrowserRunAnswer) -> bool {
        let sender = lock(&self.browser.pending).remove(run_id);
        sender.is_some_and(|sender| sender.send(answer).is_ok())
    }

    /// `browser/run`: runs an allowed `Browser` call's script in the session's browser.
    pub(super) async fn browser_run(
        &self,
        p: BrowserRunParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id.0)?;
        if self.policy.is_some() {
            policy::claim_browser(&session, &p, &peer)?;
        }
        let Some(events) = self.notices.clone().filter(|_| self.browser_attached()) else {
            return Err(unavailable());
        };
        let timeout_ms = p
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        let call = p.origin.tool_call_id.clone();
        let key = format!("browser:{call}");
        let token = CancellationToken::new();
        lock(&session.running).insert(key.clone(), token.clone());
        let started = Instant::now();
        let owner = RunOwner {
            main_session_id: session
                .subagent
                .as_ref()
                .map_or_else(|| p.session_id.0.clone(), |link| link.root_id.clone()),
            agent_type: session
                .subagent
                .as_ref()
                .map(|link| link.agent_type.clone()),
            workspace: session.project().to_string_lossy().into_owned(),
        };
        let ended = self
            .await_run(&events, &p, &owner, timeout_ms, &token, &peer)
            .await;
        lock(&session.running).remove(&key);
        let outcome = match &ended {
            Ended::Answered(answer) if answer.error.is_some() => "error",
            Ended::Answered(_) => "ok",
            Ended::Cancelled => "cancelled",
            Ended::TimedOut => "timeout",
        };
        let detail = audit_detail(&p, &ended, outcome, started.elapsed());
        if let Some(services) = &self.policy {
            services
                .record("browser", &p.session_id.0, session.project(), &detail)
                .await?;
        }
        match ended {
            Ended::Answered(answer) => {
                let mut result = shape_result(answer, |text| {
                    piarc_fs::spill(&session.tmp_dir, &format!("browser-{call}"), text)
                        .ok()
                        .map(|spilled| piarc_fs::model_path(&spilled.path))
                });
                if let Some(images) = result.images.take() {
                    let dir = session.blob_dir.clone();
                    result.images = Some(
                        tokio::task::spawn_blocking(move || keep_images(&dir, images))
                            .await
                            .map_err(|e| {
                                ErrorObject::new(ErrorKind::InternalError, e.to_string(), false)
                            })?,
                    );
                }
                to_value(&result)
            }
            Ended::Cancelled => Err(ErrorObject::new(
                ErrorKind::Cancelled,
                "the browser run was cancelled",
                false,
            )),
            Ended::TimedOut => Err(ErrorObject::new(
                ErrorKind::Timeout,
                format!("the browser script did not finish within {timeout_ms} ms"),
                true,
            )),
        }
    }

    /// Emits the run to the client and waits for its answer, a cancel or the timeout; a run
    /// that ends without an answer is cancelled on the client.
    async fn await_run(
        &self,
        events: &crate::events::EventSender,
        p: &BrowserRunParams,
        owner: &RunOwner,
        timeout_ms: u64,
        token: &CancellationToken,
        peer: &Peer,
    ) -> Ended {
        let run_id = format!(
            "run-{}-{}",
            self.browser.next.fetch_add(1, Ordering::SeqCst),
            p.origin.tool_call_id
        );
        let (tx, rx) = oneshot::channel();
        lock(&self.browser.pending).insert(run_id.clone(), tx);
        emit(
            events,
            &BrowserClientEvent::Run {
                run_id: run_id.clone(),
                session_id: p.session_id.clone(),
                main_session_id: SessionId(owner.main_session_id.clone()),
                agent_type: owner.agent_type.clone(),
                workspace: owner.workspace.clone(),
                tool_call_id: p.origin.tool_call_id.clone(),
                script: p.script.clone(),
                timeout_ms,
            },
        )
        .await;
        let ended = tokio::select! {
            answer = rx => answer.map_or(Ended::Cancelled, Ended::Answered),
            () = token.cancelled() => Ended::Cancelled,
            () = peer.closed() => Ended::Cancelled,
            () = tokio::time::sleep(Duration::from_millis(timeout_ms) + ANSWER_GRACE) => {
                Ended::TimedOut
            }
        };
        lock(&self.browser.pending).remove(&run_id);
        if !matches!(ended, Ended::Answered(_)) {
            emit(events, &BrowserClientEvent::Cancel { run_id }).await;
        }
        ended
    }
}

/// How long a site card waits for the user by default (B2.6.3), and the range of the user's
/// `browser.approvalTimeout` (seconds).
const SITE_TIMEOUT: Duration = Duration::from_secs(120);
const SITE_TIMEOUT_SECONDS: (u64, u64) = (10, 600);

impl ToolIo {
    /// `browserSite` (Core API): whether a page of the running `Browser` call may reach a
    /// host; may show the user a site card (`policy/site.rs`).
    ///
    /// # Errors
    /// `sessionNotFound` for an unknown session; a permission service failure.
    pub async fn browser_site(
        &self,
        request: &piarc_protocol::browser::BrowserSiteRequest,
    ) -> Result<piarc_protocol::browser::BrowserSiteDecision, ErrorObject> {
        let timeout = user_setting(&self.config.data_dir, "/browser/approvalTimeout")
            .and_then(|v| v.as_u64())
            .map_or(SITE_TIMEOUT, |seconds| {
                Duration::from_secs(seconds.clamp(SITE_TIMEOUT_SECONDS.0, SITE_TIMEOUT_SECONDS.1))
            });
        self.decide_site(request, timeout).await
    }
}

/// A value of the user's settings file.
fn user_setting(data_dir: &std::path::Path, pointer: &str) -> Option<Value> {
    std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.pointer(pointer).cloned())
}

/// `browser.agentEnabled` of the user's settings file; on when absent or unreadable.
fn agent_enabled(data_dir: &std::path::Path) -> bool {
    user_setting(data_dir, "/browser/agentEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

async fn emit(events: &crate::events::EventSender, event: &BrowserClientEvent) {
    if let Ok(event) = Event::from_json(RouteKey::browser(), event) {
        let _ = events.send(event).await;
    }
}

fn audit_detail(p: &BrowserRunParams, ended: &Ended, outcome: &str, took: Duration) -> Value {
    let hash = Sha256::digest(p.script.as_bytes());
    let script_sha256: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    let mut detail = json!({
        "tool": "Browser",
        "toolCallId": p.origin.tool_call_id,
        "scriptSha256": script_sha256,
        "scriptChars": p.script.chars().count(),
        "durationMs": u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
        "outcome": outcome,
    });
    if let Ended::Answered(answer) = ended {
        detail["images"] = json!(answer.images.as_ref().map_or(0, Vec::len));
        if let Some(hosts) = &answer.blocked_hosts {
            detail["blockedHosts"] = json!(hosts);
        }
        if let Some(code) = answer.error.as_ref().and_then(|e| e.code.as_ref()) {
            detail["errorCode"] = json!(code);
        }
    }
    detail
}

/// Keeps each image in the session's blobs under its SHA-256 (ADR-0093) and names the blob;
/// an image that cannot be decoded or written stays without one (the model still gets it).
fn keep_images(dir: &std::path::Path, images: Vec<BrowserImage>) -> Vec<BrowserImage> {
    use base64::Engine as _;
    images
        .into_iter()
        .map(|mut image| {
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&image.data) else {
                return image;
            };
            let hash: String = Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let path = dir.join(&hash);
            let kept = path.is_file()
                || std::fs::create_dir_all(dir).is_ok() && {
                    let partial = dir.join(format!("{hash}.{}.partial", std::process::id()));
                    std::fs::write(&partial, &bytes).is_ok()
                        && std::fs::rename(&partial, &path).is_ok()
                };
            if kept {
                image.blob = Some(hash);
            }
            image
        })
        .collect()
}

/// The result the model gets: output cut to the inline budget (the whole text spilled through
/// `spill`), at most [`MAX_IMAGES`] images of acceptable size.
fn shape_result(
    answer: BrowserRunAnswer,
    spill: impl FnOnce(&str) -> Option<String>,
) -> BrowserRunResult {
    let chars = answer.output.chars().count();
    let (output, truncated, spilled) = if chars > INLINE_OUTPUT_CHARS {
        let cut: String = answer.output.chars().take(INLINE_OUTPUT_CHARS).collect();
        let path = spill(&answer.output);
        (cut, Some(true), path)
    } else {
        (answer.output, None, None)
    };
    let images = answer.images.map(|images| {
        images
            .into_iter()
            .filter(|image| {
                image.data.len() <= MAX_IMAGE_BASE64
                    && (image.media_type == "image/png" || image.media_type == "image/jpeg")
            })
            .take(MAX_IMAGES)
            .collect::<Vec<_>>()
    });
    BrowserRunResult {
        output,
        truncated,
        spill: spilled,
        images: images.filter(|list| !list.is_empty()),
        error: answer.error,
        blocked_hosts: answer.blocked_hosts.filter(|hosts| !hosts.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use piarc_protocol::browser::{BrowserImage, BrowserScriptError};

    fn image(media_type: &str, len: usize) -> BrowserImage {
        BrowserImage {
            media_type: media_type.into(),
            data: "A".repeat(len),
            width: 10,
            height: 10,
            blob: None,
        }
    }

    /// ADR-0093: each image the model gets is kept in the session's blobs under its hash.
    #[test]
    fn images_are_kept_as_session_blobs() {
        use base64::Engine as _;
        let dir = std::env::temp_dir().join(crate::sessions::new_session_id().expect("id"));
        let bytes = b"\x89PNG\r\n\x1a\nnot really";
        let images = keep_images(
            &dir,
            vec![
                BrowserImage {
                    media_type: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    width: 2,
                    height: 2,
                    blob: None,
                },
                image("image/png", 3),
            ],
        );
        let hash: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(images[0].blob.as_deref(), Some(hash.as_str()));
        assert_eq!(std::fs::read(dir.join(&hash)).expect("blob"), bytes);
        // "AAA" is not valid base64 for a whole image: no blob, the model still gets it.
        assert_eq!(images[1].blob, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn short_output_stays_inline() {
        let result = shape_result(
            BrowserRunAnswer {
                output: "done".into(),
                images: None,
                error: None,
                blocked_hosts: Some(Vec::new()),
            },
            |_| panic!("nothing to spill"),
        );
        assert_eq!(result.output, "done");
        assert_eq!(result.truncated, None);
        assert_eq!(result.blocked_hosts, None);
    }

    #[test]
    fn long_output_is_cut_and_spilled() {
        let output = "界".repeat(INLINE_OUTPUT_CHARS + 10);
        let result = shape_result(
            BrowserRunAnswer {
                output: output.clone(),
                images: None,
                error: Some(BrowserScriptError {
                    name: "Error".into(),
                    message: "late".into(),
                    code: None,
                }),
                blocked_hosts: None,
            },
            |whole| {
                assert_eq!(whole, output);
                Some("~/tmp/browser.txt".into())
            },
        );
        assert_eq!(result.output.chars().count(), INLINE_OUTPUT_CHARS);
        assert_eq!(result.truncated, Some(true));
        assert_eq!(result.spill.as_deref(), Some("~/tmp/browser.txt"));
        assert!(result.error.is_some());
    }

    #[derive(Default)]
    struct Collect(std::sync::Mutex<Vec<(String, Value)>>);

    impl crate::events::EventSink for Collect {
        fn deliver(
            &self,
            batches: Vec<crate::events::EventBatch>,
            done: crate::events::DeliveryDone,
        ) -> Result<(), crate::events::SinkClosed> {
            let mut seen = self.0.lock().expect("sink");
            for batch in batches {
                let events: Vec<Value> =
                    serde_json::from_slice(&batch.payload).expect("JSON array");
                for event in events {
                    seen.push((batch.route.as_str().to_owned(), event));
                }
            }
            drop(done);
            Ok(())
        }
    }

    impl Collect {
        /// The first `core/browser` event of `kind`, waiting up to 5 s for it.
        async fn next(&self, kind: &str) -> Value {
            for _ in 0..500 {
                let found = self
                    .0
                    .lock()
                    .expect("sink")
                    .iter()
                    .find(|(route, e)| route == "core/browser" && e["type"] == kind)
                    .map(|(_, e)| e.clone());
                if let Some(event) = found {
                    return event;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no {kind} event on core/browser");
        }
    }

    /// A Core without the permission ladder (the grant step is covered in
    /// `policy::tests::browser`), with one session and an attached client.
    fn attached() -> (
        std::sync::Arc<ToolIo>,
        std::sync::Arc<Collect>,
        std::path::PathBuf,
    ) {
        let sink = std::sync::Arc::new(Collect::default());
        let (events, coalescer, _) = crate::events::channel(
            Duration::from_millis(1),
            sink.clone(),
            CancellationToken::new(),
        );
        tokio::spawn(coalescer.run());
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("id"));
        let work = root.join("workspace");
        std::fs::create_dir_all(&work).expect("workspace");
        let io = ToolIo::with_notices(
            super::super::ToolIoConfig::new(root.join("data")),
            Some(events),
        );
        io.open_session("s-1", &work, &work).expect("session");
        io.attach_browser_client();
        (std::sync::Arc::new(io), sink, root)
    }

    fn run_params(script: &str) -> serde_json::Map<String, Value> {
        json!({
            "sessionId": "s-1",
            "origin": {"tool": "Browser", "toolCallId": "call-1"},
            "script": script,
            "timeoutMs": 5000,
        })
        .as_object()
        .expect("params")
        .clone()
    }

    /// B2.1.2: the run reaches the client with its owner, and the client's answer is the result.
    #[tokio::test]
    async fn an_attached_client_runs_the_script() {
        let (io, sink, root) = attached();
        let (peer, _frames) = Peer::channel(4);
        let running = {
            let io = io.clone();
            tokio::spawn(async move {
                io.dispatch("browser/run", run_params("print(1)"), peer)
                    .await
            })
        };
        let run = sink.next("run").await;
        assert_eq!(run["script"], "print(1)");
        assert_eq!(run["mainSessionId"], "s-1");
        assert_eq!(run["timeoutMs"], 5000);
        assert!(run.get("agentType").is_none());
        let answered = io.answer_browser_run(
            run["runId"].as_str().expect("run id"),
            BrowserRunAnswer {
                output: "1".into(),
                images: None,
                error: None,
                blocked_hosts: Some(vec!["cdn.example.com".into()]),
            },
        );
        assert!(answered);
        let result = running.await.expect("task").expect("result");
        assert_eq!(result["output"], "1");
        assert_eq!(result["blockedHosts"], json!(["cdn.example.com"]));
        let _ = std::fs::remove_dir_all(root);
    }

    /// B2.1.1: the tool is offered with a client until the user turns it off.
    #[tokio::test]
    async fn the_user_setting_turns_the_tool_off() {
        let (io, _sink, root) = attached();
        assert!(io.browser_offered());
        let data = root.join("data");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::write(
            data.join("settings.json"),
            json!({ "browser": { "agentEnabled": false } }).to_string(),
        )
        .expect("settings");
        assert!(!io.browser_offered());
        let _ = std::fs::remove_dir_all(root);
    }

    /// B2.1.3: an interrupt cancels the run, the client hears `cancel`, a late answer is refused.
    #[tokio::test]
    async fn an_interrupt_cancels_the_run() {
        let (io, sink, root) = attached();
        let (peer, _frames) = Peer::channel(4);
        let running = {
            let io = io.clone();
            tokio::spawn(async move {
                io.dispatch("browser/run", run_params("for(;;){}"), peer)
                    .await
            })
        };
        let run = sink.next("run").await;
        io.cancel_running("s-1");
        let error = running.await.expect("task").unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Cancelled);
        let cancel = sink.next("cancel").await;
        assert_eq!(cancel["runId"], run["runId"]);
        let late = BrowserRunAnswer {
            output: String::new(),
            images: None,
            error: None,
            blocked_hosts: None,
        };
        assert!(!io.answer_browser_run(run["runId"].as_str().expect("run id"), late));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn images_are_limited_by_kind_size_and_count() {
        let mut images = vec![
            image("image/gif", 10),
            image("image/png", MAX_IMAGE_BASE64 + 1),
        ];
        images.extend((0..20).map(|_| image("image/jpeg", 10)));
        let result = shape_result(
            BrowserRunAnswer {
                output: String::new(),
                images: Some(images),
                error: None,
                blocked_hosts: None,
            },
            |_| None,
        );
        let kept = result.images.expect("images");
        assert_eq!(kept.len(), MAX_IMAGES);
        assert!(kept.iter().all(|i| i.media_type == "image/jpeg"));
    }
}
