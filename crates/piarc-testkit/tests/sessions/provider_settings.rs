//! Provider settings exercise the same NAPI-facing operation with the isolated in-memory
//! keychain and a real Pi ModelRuntime. No third-party endpoint is contacted.
use std::sync::Arc;

use piarc_core::agent_host::{HostEvent, start_for};
use piarc_core::providers::Operation;
use piarc_core::secrets::{SecretsConfig, SecretsService};
use piarc_protocol::models::{CredentialStatusParams, ModelsCredentialStatus};
use serde_json::{Value, json};

use super::support::{Env, answer, reply, shutdown};

#[path = "../support/process_environment.rs"]
mod process_environment;

async fn run(core: &piarc_core::CoreRuntime, op: Operation) -> Value {
    let (done, rx) = reply();
    core.provider_op(op, done).expect("queued");
    answer(rx).await.expect("provider operation")
}

fn save(config: &Value, key: Option<&str>) -> Operation {
    let secret = key.map(|key| json!({"key":key}).to_string());
    Operation::save(&config.to_string(), secret.as_deref()).expect("valid settings")
}

// A fresh Host reopens the on-disk vault through the same master key, proving removal and
// retention independently of both the writing Host and the non-secret settings document.
async fn inspect(env: &Env, needles: &[String], id: &str) -> bool {
    let config = env.config(&[]);
    let vault = SecretsService::new(
        SecretsConfig::with_master_key(&env.data, env.master_key.clone()),
        env.key_store.clone(),
    );
    let (host, mut events) = start_for(
        config.sessions.launch.as_ref().unwrap(),
        env.ws.clone(),
        env.data.clone(),
        Arc::new(vault),
        &|_| {},
    )
    .expect("start");
    let Some(HostEvent::Connected { pid: Some(pid), .. }) = events.recv().await else {
        panic!("inspector did not connect")
    };
    let status = host
        .call::<ModelsCredentialStatus>(CredentialStatusParams {
            provider: id.to_owned(),
        })
        .await
        .expect("credential status");
    process_environment::check_process_environment(
        "settings credential inspection Host",
        pid,
        needles,
    );
    host.shutdown().await;
    status.has_credential
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_settings_crud_keeps_credentials_in_the_vault() {
    let env = Env::new("provider-settings").await;
    let (core, _) = env.start(env.config(&[]));
    run(&core, Operation::Refresh(false)).await;
    let id = "test-relay";
    let mut relay = json!({"kind":"custom","id":id,"api":"anthropic-messages","baseUrl":env.mock.anthropic_base_url(),"models":["one"]});
    let secret = "t21-FAKE-unique-exercise-key";
    run(&core, save(&relay, Some(secret))).await;
    relay["models"] = json!(["one", "two"]);
    let response = run(&core, save(&relay, None)).await;
    assert_eq!(response["providers"][0]["hasCredential"], true);
    assert_eq!(response["providers"][0]["models"], json!(["one", "two"]));
    assert!(!response.to_string().contains(secret));
    let mut local = json!({"kind":"local","id":"local-test","api":"openai-completions","baseUrl":"http://127.0.0.1:2/v1","models":["tiny"]});
    let mut cloud =
        json!({"kind":"cloud","id":"amazon-bedrock","auth":"bearer","region":"us-east-1"});
    let builtin = json!({"kind":"builtin","id":"qwen-token-plan-cn"});
    for config in [&local, &cloud, &builtin] {
        run(&core, save(config, (config != &local).then_some(secret))).await;
    }
    local["models"] = json!(["tiny", "other"]);
    cloud["region"] = json!("eu-west-1");
    for config in [&local, &cloud, &builtin] {
        run(&core, save(config, None)).await;
    }
    let catalog = run(&core, Operation::List).await;
    assert_eq!(catalog["providers"].as_array().unwrap().len(), 4);
    assert_eq!(catalog["catalogRefresh"], false);
    let scan = piarc_testkit::plaintext::scan(&[&env.data], &[secret.as_bytes()], None);
    assert!(
        scan.findings.is_empty() && scan.unreadable.is_empty(),
        "files: {} findings: {:?} unreadable: {:?}",
        scan.files,
        scan.findings,
        scan.unreadable
    );
    assert!(env.data.join("secrets.vault").is_file());
    assert!(!env.data.join("pi/auth.json").exists());
    shutdown(core).await;
    let needles = vec![secret.to_owned()];
    assert!(inspect(&env, &needles, id).await);
    let (core, _) = env.start(env.config(&[]));
    for config in [&local, &cloud, &builtin, &relay] {
        run(
            &core,
            Operation::Delete(config["id"].as_str().unwrap().into()),
        )
        .await;
    }
    assert!(
        run(&core, Operation::List).await["providers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    shutdown(core).await;
    assert!(!inspect(&env, &needles, id).await);
}
