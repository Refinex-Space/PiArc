//! T13-A10 and T13-A12: project-level Pi extensions follow Core's trust decision. An
//! extension in the workspace's `.pi/extensions/` registers a tool; the model request lists
//! it only after the project is trusted, and no longer after the trust is revoked and the
//! workspace's Agent Host restarted (the session is reopened on the new process).

use piarc_core::DataDirs;
use piarc_core::agent_host::{self, HostEvent};
use piarc_core::storage::Storage;
use piarc_core::trust::TrustService;
use serde_json::{Value, json};

use crate::harness::{Env, offered_tools, open, prompt_text};

const PROBE: &str = r#"
id: trust-probe
steps:
  - text: "first"
  - text: "second"
  - text: "third"
"#;

/// The fixture extension: one tool, no imports (Pi loads it with jiti).
const EXTENSION: &str = r#"export default function (pi: any) {
  pi.registerTool({
    name: 'fixture_probe',
    label: 'Fixture probe',
    description: 'Registered by the project extension fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'probe' }], details: {} };
    },
  });
}
"#;

async fn confirm_project(service: &TrustService, path: &std::path::Path) {
    let view = service.view(path).await.expect("displayed inventory");
    let decision = service
        .decide(path, true, &view.version)
        .await
        .expect("confirm");
    assert!(decision.applied && decision.trusted);
}

const PROBE_TOOL: &str = "fixture_probe";

fn offers_probe(body: &str) -> bool {
    offered_tools(body)
        .iter()
        .any(|(name, _)| name == PROBE_TOOL)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_extensions_load_only_while_core_trusts_the_project() {
    let env = Env::new("trust", &[PROBE], json!({})).await;
    let extensions = env.ws[0].join(".pi").join("extensions");
    std::fs::create_dir_all(&extensions).expect("extensions dir");
    std::fs::write(extensions.join("probe-tool.ts"), EXTENSION).expect("fixture extension");

    let dirs = DataDirs::new(env.data_dir.clone(), env.root.join("cache")).expect("dirs");
    dirs.create_layout().expect("layout");
    let trust = TrustService::new(Storage::open(dirs).expect("store"));
    let (supervisor, mut events, core) = env.start_with_trust(trust.clone());
    let restarts = agent_host::restart_on_trust_change(supervisor.clone(), &env.ws[0], &trust)
        .expect("watch trust changes");
    events
        .until(|e| matches!(e, HostEvent::Connected { epoch: 1, .. }))
        .await;

    // Untrusted: the extension is not loaded.
    let session = open(&supervisor, &core, &env.cwd(0), "mock-large").await;
    let turn = supervisor
        .prompt(&session, "r1", &prompt_text("hello", "trust-probe"))
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    let requests = env.requests("trust-probe");
    assert!(
        !offers_probe(&requests[0].body),
        "untrusted: {:?}",
        offered_tools(&requests[0].body)
    );

    // Trusted: Core restarts the Agent Host, the session is reopened and the tool is offered.
    confirm_project(&trust, &env.ws[0]).await;
    let restored = events
        .until(|e| matches!(e, HostEvent::SessionRestored { epoch: 2, .. }))
        .await;
    println!("after trusting: {restored:?}");
    let turn = supervisor
        .prompt(&session, "r2", &prompt_text("again", "trust-probe"))
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    let requests = env.requests("trust-probe");
    assert!(
        offers_probe(&requests[1].body),
        "trusted: {:?}",
        offered_tools(&requests[1].body)
    );

    // Revoked: trust/get answers false and the restarted Agent Host no longer loads it.
    trust.revoke(&env.ws[0]).await.expect("revoke");
    let answer: Value = trust
        .trust_get(serde_json::from_value(json!({ "path": env.cwd(0) })).expect("params"))
        .await
        .expect("answered");
    assert_eq!(answer, json!({ "trusted": false }));
    events
        .until(|e| matches!(e, HostEvent::SessionRestored { epoch: 3, .. }))
        .await;
    let turn = supervisor
        .prompt(&session, "r3", &prompt_text("once more", "trust-probe"))
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    let requests = env.requests("trust-probe");
    assert_eq!(requests.len(), 3);
    assert!(
        !offers_probe(&requests[2].body),
        "revoked: {:?}",
        offered_tools(&requests[2].body)
    );
    let restarted = events
        .all
        .iter()
        .filter(|e| matches!(e, HostEvent::Restarting { .. }))
        .count();
    assert_eq!(restarted, 0, "trust restarts are not failures");
    let asked = core.asked.lock().expect("lock").clone();
    println!("trust/get asked for: {asked:?}");
    assert!(
        asked.len() >= 3,
        "every (re)opened session asked Core: {asked:?}"
    );

    restarts.abort();
    supervisor.shutdown().await;
}
