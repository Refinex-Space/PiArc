//! ADR-0089: a `Browser` call is allowed without asking (its script can only drive the browser;
//! hosts, ports and files are decided while it runs), deny rules still apply, and `browser/run`
//! needs the approved call for exactly its script and a desktop client.
use super::*;

impl Fixture {
    async fn run_script(&self, call: &str, script: &str) -> Result<Value, ErrorObject> {
        let params = json!({
            "sessionId": SESSION,
            "origin": {"tool": "Browser", "toolCallId": call},
            "script": script,
        });
        self.io
            .dispatch(
                "browser/run",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
    }
}

#[tokio::test]
async fn a_browser_call_is_allowed_without_asking() {
    let f = Fixture::new().await;
    let ruling = f
        .evaluate("browser-1", "Browser", json!({"script": "console.log(1)"}))
        .await;
    assert_eq!(ruling["allowed"], true, "{ruling}");
}

#[tokio::test]
async fn a_deny_rule_turns_the_browser_off() {
    let f = Fixture::new().await;
    std::fs::write(
        f.root.join("data/settings.json"),
        json!({ "permissions": { "deny": ["Browser"] } }).to_string(),
    )
    .expect("user settings");
    let ruling = f
        .evaluate("browser-1", "Browser", json!({"script": "console.log(1)"}))
        .await;
    assert_eq!(ruling["allowed"], false, "{ruling}");
}

#[tokio::test]
async fn a_run_needs_the_approved_script_and_a_client() {
    let f = Fixture::new().await;
    // No preflight: no grant.
    let refused = f
        .run_script("browser-1", "console.log(1)")
        .await
        .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);
    let ruling = f
        .evaluate("browser-1", "Browser", json!({"script": "console.log(1)"}))
        .await;
    assert_eq!(ruling["allowed"], true, "{ruling}");
    // Another script than the approved one.
    let other = f
        .run_script("browser-1", "console.log(2)")
        .await
        .unwrap_err();
    assert_eq!(other.data.kind, ErrorKind::PermissionDenied);
    // The approved script, but no desktop client is attached.
    let unavailable = f
        .run_script("browser-1", "console.log(1)")
        .await
        .unwrap_err();
    assert_eq!(unavailable.data.kind, ErrorKind::HostUnavailable);
    assert_eq!(
        unavailable
            .data
            .details
            .as_ref()
            .map(|d| d["reason"].clone()),
        Some(json!("browserClient"))
    );
    // The grant was consumed by that attempt.
    let again = f
        .run_script("browser-1", "console.log(1)")
        .await
        .unwrap_err();
    assert_eq!(again.data.kind, ErrorKind::PermissionDenied);
}
