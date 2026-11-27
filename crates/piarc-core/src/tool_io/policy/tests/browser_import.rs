//! ADR-0090, design addendum B5.4: sites with sign-ins imported from Chrome are sensitive in
//! Core whatever the client says: an allow rule and Bypass permissions do not allow them, and
//! their card never offers "always". Subdomains of an imported site count as well.
use super::*;
use piarc_protocol::browser::BrowserSiteRequest;
use piarc_protocol::session::SessionId;
use tokio_util::sync::CancellationToken;

const CALL: &str = "browser-import-1";

fn request(host: &str) -> BrowserSiteRequest {
    BrowserSiteRequest {
        session_id: SessionId(SESSION.into()),
        tool_call_id: CALL.into(),
        url: format!("https://{host}/"),
        host: host.into(),
        local: false,
        // The client did not mark it: Core must.
        sensitive: false,
        pending: Vec::new(),
    }
}

fn running(f: &Fixture) -> CancellationToken {
    let token = CancellationToken::new();
    let session = f.io.session(SESSION).expect("registered");
    lock(&session.running).insert(format!("browser:{CALL}"), token.clone());
    token
}

async fn imported(f: &Fixture, site: &str) {
    let key = crate::browser::import::workspace_key(&f.work);
    let site = site.to_owned();
    f.storage
        .run(move |s| s.put_browser_import(&key, &site, 2, "Default", 1))
        .await
        .expect("run")
        .expect("record");
}

#[tokio::test]
async fn thr17_an_allow_rule_does_not_cover_an_imported_site() {
    let f = Fixture::new().await;
    let _run = running(&f);
    std::fs::write(
        f.root.join("data/settings.json"),
        json!({"permissions": {"allow": ["Browser(domain:*.github.com)", "Browser(domain:github.com)"]}})
            .to_string(),
    )
    .expect("settings");
    // Before the import the rule allows the run.
    let before =
        f.io.decide_site(&request("api.github.com"), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(before.allowed);
    imported(&f, "github.com").await;
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move {
            io.decide_site(&request("api.github.com"), Duration::from_secs(5))
                .await
        })
    };
    let card = f.pending().await;
    assert_eq!(card.tool, "BrowserSite");
    assert!(card.rules.is_empty(), "no 'always' for an imported site");
    f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
        .await
        .expect("answer");
    assert!(!asking.await.expect("task").expect("decision").allowed);
    // A site that only shares a suffix is not covered.
    let other =
        f.io.decide_site(&request("notgithub.com"), Duration::from_millis(50))
            .await
            .expect("decision");
    assert!(!other.allowed, "no rule: the card timed out");
}

#[tokio::test]
async fn thr17_bypass_permissions_asks_for_an_imported_site() {
    let f = Fixture::new().await;
    let _run = running(&f);
    imported(&f, "example.test").await;
    f.io.session_mode(SESSION, PermissionMode::BypassPermissions)
        .expect("bypass");
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move {
            io.decide_site(&request("example.test"), Duration::from_secs(5))
                .await
        })
    };
    let card = f.pending().await;
    assert!(card.rules.is_empty());
    f.io.answer_approval(answer(&card, ApprovalDecision::AllowSession))
        .await
        .expect("answer");
    let decision = asking.await.expect("task").expect("decision");
    assert!(decision.allowed);
    // A public site that was not imported still goes through under Bypass permissions.
    let public =
        f.io.decide_site(&request("docs.rs"), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(public.allowed);
}
