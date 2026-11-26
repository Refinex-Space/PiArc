//! Design addendum B2.7.3: what the user changed in a session's browser reaches the model as one
//! `browserState` reminder, the newest replacing the older one, with page data bounded.
use super::*;
use piarc_protocol::browser::{
    BrowserStateController, BrowserStateSpace, BrowserStateSummary, BrowserStateTab,
    BrowserStateUpdate,
};
use piarc_protocol::context::ReminderType;
use piarc_protocol::session::SessionId;

fn update(
    session: &str,
    title: &str,
    tabs: usize,
    controlled_by: BrowserStateController,
) -> BrowserStateUpdate {
    BrowserStateUpdate {
        session_id: SessionId(session.to_owned()),
        summary: BrowserStateSummary {
            spaces: vec![BrowserStateSpace {
                id: 3,
                name: "checkout".to_owned(),
                controlled_by,
                tabs: (0..tabs)
                    .map(|n| BrowserStateTab {
                        title: format!("{title} {n}"),
                        url: format!("http://localhost:5173/{n}"),
                    })
                    .collect(),
                tab_count: tabs as u64,
            }],
            user_tabs: 2,
        },
    }
}

fn notices(f: &Fixture) -> Vec<crate::tasks::Notice> {
    f.io.tasks()
        .pending(SESSION)
        .into_iter()
        .filter(|n| n.kind == ReminderType::BrowserState)
        .collect()
}

#[tokio::test]
async fn the_newest_state_replaces_the_waiting_one() {
    let f = Fixture::new().await;
    f.io.browser_state(&update(SESSION, "Cart", 1, BrowserStateController::Agent))
        .expect("first");
    f.io.browser_state(&update(SESSION, "Pay", 2, BrowserStateController::Agent))
        .expect("second");
    let waiting = notices(&f);
    assert_eq!(waiting.len(), 1);
    let notice = &waiting[0];
    assert_eq!(notice.key, "browserState");
    assert!(!notice.wake);
    let summary: BrowserStateSummary = serde_json::from_str(&notice.text).expect("json");
    assert_eq!(summary.spaces[0].tabs.len(), 2);
    assert_eq!(summary.spaces[0].tabs[1].title, "Pay 1");
    assert_eq!(summary.user_tabs, 2);
}

#[tokio::test]
async fn a_space_the_user_controls_lists_no_pages_and_text_is_bounded() {
    let f = Fixture::new().await;
    f.io.browser_state(&update(
        SESSION,
        "Secret inbox",
        3,
        BrowserStateController::User,
    ))
    .expect("user");
    let summary: BrowserStateSummary = serde_json::from_str(&notices(&f)[0].text).expect("json");
    assert!(summary.spaces[0].tabs.is_empty());
    assert_eq!(summary.spaces[0].tab_count, 3);

    let long = "t".repeat(500);
    let mut many = update(SESSION, &long, 30, BrowserStateController::Agent);
    many.summary.spaces[0].name = "n".repeat(200);
    many.summary.spaces[0].tabs[0].url = format!("https://example.com/{}", "x".repeat(5000));
    f.io.browser_state(&many).expect("bounded");
    let summary: BrowserStateSummary = serde_json::from_str(&notices(&f)[0].text).expect("json");
    let space = &summary.spaces[0];
    assert_eq!(space.tabs.len(), 20);
    assert_eq!(space.tab_count, 30);
    assert!(space.name.chars().count() <= 65);
    assert!(space.tabs[0].title.chars().count() <= 81);
    assert!(space.tabs[0].url.chars().count() <= 2049);
}

#[tokio::test]
async fn unknown_sessions_and_too_many_spaces_are_refused() {
    let f = Fixture::new().await;
    let refused =
        f.io.browser_state(&update("nobody", "x", 1, BrowserStateController::Agent))
            .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::SessionNotFound);
    let mut five = update(SESSION, "x", 1, BrowserStateController::Agent);
    let space = five.summary.spaces[0].clone();
    five.summary.spaces = vec![space; 5];
    let refused = f.io.browser_state(&five).unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::InvalidParams);
    assert!(notices(&f).is_empty());
}
