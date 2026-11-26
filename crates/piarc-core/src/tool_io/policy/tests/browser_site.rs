//! ADR-0089, design addendum B2.6.3: site cards. A page of a running `Browser` call asks for a
//! host; rules and the mode may decide, otherwise a card shows the address and the run's other
//! waiting hosts, and the answer holds for the call, the session or (saved as a rule) always.
use super::*;
use piarc_protocol::browser::{BrowserSiteRequest, BrowserSiteScope};
use piarc_protocol::session::SessionId;
use tokio_util::sync::CancellationToken;

const CALL: &str = "browser-1";

fn request(host: &str, pending: &[&str]) -> BrowserSiteRequest {
    BrowserSiteRequest {
        session_id: SessionId(SESSION.into()),
        tool_call_id: CALL.into(),
        url: format!("https://{host}/page"),
        host: host.into(),
        local: false,
        sensitive: false,
        pending: pending.iter().map(|h| (*h).to_owned()).collect(),
    }
}

/// Marks call `CALL` as a running `Browser` run; answers its token.
fn running(f: &Fixture) -> CancellationToken {
    let token = CancellationToken::new();
    let session = f.io.session(SESSION).expect("registered");
    lock(&session.running).insert(format!("browser:{CALL}"), token.clone());
    token
}

fn user_settings(f: &Fixture, value: &Value) {
    std::fs::write(f.root.join("data/settings.json"), value.to_string()).expect("settings");
}

fn nothing_pending(f: &Fixture) -> bool {
    lock(&f.io.session(SESSION).expect("session").policy)
        .first_pending()
        .is_none()
}

#[tokio::test]
async fn without_a_running_call_nothing_is_asked() {
    let f = Fixture::new().await;
    let decision =
        f.io.decide_site(&request("example.com", &[]), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(!decision.allowed);
    assert!(nothing_pending(&f));
}

#[tokio::test]
async fn rules_decide_without_a_card() {
    let f = Fixture::new().await;
    let _run = running(&f);
    user_settings(
        &f,
        &json!({"permissions": {
            "allow": ["Browser(domain:*.example.com)"],
            "deny": ["Browser(domain:evil.example)"],
        }}),
    );
    let allowed =
        f.io.decide_site(&request("app.example.com", &[]), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(allowed.allowed);
    assert_eq!(allowed.scope, Some(BrowserSiteScope::Run));
    // A deny on any waiting host refuses the whole card.
    let denied =
        f.io.decide_site(
            &request("app.example.com", &["evil.example"]),
            Duration::from_secs(5),
        )
        .await
        .expect("decision");
    assert!(!denied.allowed);
    // An allow rule does not cover a sensitive (private or imported) host: it asks.
    let mut sensitive = request("app.example.com", &[]);
    sensitive.sensitive = true;
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move { io.decide_site(&sensitive, Duration::from_secs(5)).await })
    };
    let card = f.pending().await;
    assert_eq!(card.tool, "BrowserSite");
    assert!(card.rules.is_empty(), "no 'always' for a sensitive host");
    f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
        .await
        .expect("answer");
    assert!(!asking.await.expect("task").expect("decision").allowed);
}

#[tokio::test]
async fn plan_mode_allows_only_local_addresses() {
    let f = Fixture::new().await;
    let _run = running(&f);
    f.io.session_mode(SESSION, PermissionMode::Plan)
        .expect("plan mode");
    let remote =
        f.io.decide_site(&request("example.com", &[]), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(!remote.allowed);
    let mut local = request("localhost:5173", &[]);
    local.local = true;
    let decision =
        f.io.decide_site(&local, Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(decision.allowed);
}

#[tokio::test]
async fn a_session_answer_covers_the_waiting_hosts_for_the_whole_session() {
    let f = Fixture::new().await;
    let _run = running(&f);
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move {
            io.decide_site(
                &request("example.com", &["cdn.example.net"]),
                Duration::from_secs(5),
            )
            .await
        })
    };
    let card = f.pending().await;
    let site = card.site.clone().expect("site card");
    assert_eq!(site.url, "https://example.com/page");
    assert_eq!(site.hosts, vec!["cdn.example.net".to_owned()]);
    assert_eq!(card.domain.as_deref(), Some("example.com"));
    assert_eq!(
        card.rules,
        vec![
            "Browser(domain:example.com)".to_owned(),
            "Browser(domain:cdn.example.net)".to_owned()
        ]
    );
    f.io.answer_approval(answer(&card, ApprovalDecision::AllowSession))
        .await
        .expect("answer");
    let decision = asking.await.expect("task").expect("decision");
    assert_eq!(decision.scope, Some(BrowserSiteScope::Session));
    // No second card for either host.
    let again =
        f.io.decide_site(&request("cdn.example.net", &[]), Duration::from_secs(5))
            .await
            .expect("decision");
    assert!(again.allowed);
    assert!(nothing_pending(&f));
}

#[tokio::test]
async fn always_saves_the_card_rule_in_the_user_settings() {
    let f = Fixture::new().await;
    let _run = running(&f);
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move {
            io.decide_site(&request("docs.example.org", &[]), Duration::from_secs(5))
                .await
        })
    };
    let card = f.pending().await;
    let mut reply = answer(&card, ApprovalDecision::AllowAlways);
    reply.rules.clone_from(&card.rules);
    f.io.answer_approval(reply).await.expect("answer");
    assert!(asking.await.expect("task").expect("decision").allowed);
    let saved = std::fs::read_to_string(f.root.join("data/settings.json")).expect("settings");
    assert!(
        saved.contains("Browser(domain:docs.example.org)"),
        "{saved}"
    );
}

#[tokio::test]
async fn the_card_goes_away_with_the_run_and_on_timeout() {
    let f = Fixture::new().await;
    let run = running(&f);
    let asking = {
        let io = f.io.clone();
        tokio::spawn(async move {
            io.decide_site(&request("example.com", &[]), Duration::from_secs(30))
                .await
        })
    };
    let _card = f.pending().await;
    run.cancel();
    assert!(!asking.await.expect("task").expect("decision").allowed);
    assert!(nothing_pending(&f));
    let _run = running(&f);
    let timed_out =
        f.io.decide_site(&request("example.com", &[]), Duration::from_millis(50))
            .await
            .expect("decision");
    assert!(!timed_out.allowed);
    assert!(nothing_pending(&f));
}
