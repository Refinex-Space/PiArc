//! ADR-0083 through Core's public API, the settings Host and the mock authorization server:
//! signing in again adds an account (the first moves aside, Core-only), switching and removing
//! accounts, the connection test reaching the provider with the account in use, and turning a
//! provider off hiding its models from the workspaces.
use piarc_core::providers::Operation;
use piarc_testkit::auth_server::{AuthBehavior, MockAuthServer};
use serde_json::Value;

use super::login::{PROVIDER, list, provider_file, start};
use super::support::{Env, answer, reply, shutdown};

async fn op(core: &piarc_core::CoreRuntime, operation: Operation) -> Value {
    let (done, rx) = reply();
    core.provider_op(operation, done).expect("queued");
    answer(rx).await.expect("provider operation")
}

async fn sign_in(core: &piarc_core::CoreRuntime) {
    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    answer(rx).await.expect("signed in");
}

/// The accounts of the test provider: (id, in use).
fn accounts(view: &Value) -> Vec<(String, bool)> {
    view["accounts"]
        .as_array()
        .expect("accounts")
        .iter()
        .filter(|a| a["provider"] == PROVIDER)
        .map(|a| {
            (
                a["id"].as_str().expect("id").to_owned(),
                a["active"] == true,
            )
        })
        .collect()
}

async fn workspace_models(core: &piarc_core::CoreRuntime, env: &Env) -> Vec<String> {
    let (done, rx) = reply();
    core.workspace_models(env.ws.clone(), done).expect("queued");
    let models = answer(rx).await.expect("models");
    models["models"]
        .as_array()
        .expect("models")
        .iter()
        .map(|m| {
            format!(
                "{}/{}",
                m["provider"].as_str().unwrap(),
                m["id"].as_str().unwrap()
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_accounts_switch_remove_test_and_turn_off() {
    let env = Env::new("accounts 账号").await;
    let auth = MockAuthServer::start(AuthBehavior::Approve, 0)
        .await
        .expect("auth server");
    let (core, _events) = start(&env, &provider_file(&env, &auth, "deviceCode"));

    sign_in(&core).await;
    sign_in(&core).await;
    let view = list(&core).await;
    let two = accounts(&view);
    assert_eq!(two.len(), 2, "{view}");
    assert_eq!(two.iter().filter(|(_, active)| *active).count(), 1);
    let (aside, _) = two.iter().find(|(_, active)| !active).cloned().unwrap();

    // The connection test asks the provider's model with the account in use. The strict mock
    // has no script for it and refuses, which proves the request reached it.
    let test = op(&core, Operation::Test(PROVIDER.into())).await;
    println!("connection test: {test}");
    assert_eq!(test["model"], "oauth-model", "{test}");
    assert!(test["ok"].is_boolean());

    // Switching: the account aside comes back, the other moves aside.
    let view = op(&core, Operation::UseAccount(PROVIDER.into(), aside.clone())).await;
    let switched = accounts(&view);
    assert!(switched.contains(&(aside.clone(), true)), "{view}");
    let (other, _) = switched
        .iter()
        .find(|(_, active)| !active)
        .cloned()
        .unwrap();
    assert!(
        op_err(&core, Operation::UseAccount(PROVIDER.into(), aside.clone())).await,
        "the account in use is not aside"
    );

    let view = op(&core, Operation::RemoveAccount(PROVIDER.into(), other)).await;
    assert_eq!(accounts(&view), vec![(aside, true)]);

    // Turning the provider off hides its models from the workspaces; on brings them back.
    let model = format!("{PROVIDER}/oauth-model");
    assert!(workspace_models(&core, &env).await.contains(&model));
    let view = op(&core, Operation::SetEnabled(PROVIDER.into(), false)).await;
    assert_eq!(view["disabled"][0], PROVIDER);
    assert!(!workspace_models(&core, &env).await.contains(&model));
    // The settings window still sees it signed in.
    assert_eq!(accounts(&view).len(), 1);
    op(&core, Operation::SetEnabled(PROVIDER.into(), true)).await;
    assert!(workspace_models(&core, &env).await.contains(&model));

    // Tokens are in the vault only.
    let tokens = auth.issued();
    let needles: Vec<&[u8]> = tokens.iter().map(String::as_bytes).collect();
    let scan = piarc_testkit::plaintext::scan(&[&env.data, &env.cache, &env.ws], &needles, None);
    assert!(scan.findings.is_empty(), "{:?}", scan.findings);
    shutdown(core).await;
}

async fn op_err(core: &piarc_core::CoreRuntime, operation: Operation) -> bool {
    let (done, rx) = reply();
    core.provider_op(operation, done).expect("queued");
    answer(rx).await.is_err()
}
