//! What the user changed in a session's browser between the agent's calls (design addendum
//! B2.7.3). The desktop client sends the session's task spaces when they differ from what the
//! agent last saw; Core keeps the newest as one `browserState` notice (key `browserState`, so a
//! newer state replaces a waiting one), sent with `session/remind` before the next request.
//! Titles and URLs come from pages: Core bounds them and lists no page of a Space the user
//! controls.

use std::sync::atomic::Ordering;

use piarc_protocol::browser::{BrowserStateController, BrowserStateUpdate};
use piarc_protocol::context::ReminderType;
use piarc_protocol::{ErrorKind, ErrorObject};

use super::ToolIo;
use crate::tasks::Notice;

/// Task spaces one session has at most.
const MAX_SPACES: usize = 4;
/// Tabs listed per Space.
const MAX_TABS: usize = 20;
/// Characters of a Space name, a title and a URL.
const NAME_CHARS: usize = 64;
const TITLE_CHARS: usize = 80;
const URL_CHARS: usize = 2048;

fn cut(text: &str, limit: usize) -> String {
    let mut chars = text.chars().filter(|c| !c.is_control());
    let mut out: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

impl ToolIo {
    /// Keeps `update` as the session's `browserState` reminder.
    ///
    /// # Errors
    /// `sessionNotFound` for a session Core does not know or a subagent's; `invalidParams` for
    /// more than four Spaces.
    pub fn browser_state(&self, update: &BrowserStateUpdate) -> Result<(), ErrorObject> {
        let session_id = update.session_id.0.as_str();
        let session = self.session(session_id)?;
        if session.subagent.is_some() {
            return Err(ErrorObject::new(
                ErrorKind::SessionNotFound,
                "a subagent's session has no browser of its own",
                false,
            ));
        }
        if update.summary.spaces.len() > MAX_SPACES {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "a session has at most four task spaces",
                false,
            ));
        }
        let mut summary = update.summary.clone();
        for space in &mut summary.spaces {
            space.name = cut(&space.name, NAME_CHARS);
            if space.controlled_by == BrowserStateController::User {
                space.tabs.clear();
            }
            space.tabs.truncate(MAX_TABS);
            for tab in &mut space.tabs {
                tab.title = cut(&tab.title, TITLE_CHARS);
                tab.url = cut(&tab.url, URL_CHARS);
            }
        }
        let text = serde_json::to_string(&summary)
            .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?;
        let count = self.browser.states.fetch_add(1, Ordering::Relaxed) + 1;
        self.tasks.add_notice(
            session_id,
            Notice {
                key: "browserState".to_owned(),
                source: format!("browser:{count}"),
                kind: ReminderType::BrowserState,
                text,
                wake: false,
            },
        );
        Ok(())
    }
}
