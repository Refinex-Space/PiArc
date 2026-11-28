//! Session titles (ADR-0106): the first message of a session this Core created asks the Agent
//! Host, on the side, for a short title. The request runs beside the first turn and never holds
//! it up; until the answer comes, and whenever none comes, the list shows the first message.
//! A message that is a command waits for the next one, a short message is its own title, a
//! renamed session keeps the user's name, and a resumed or forked session is never titled.
//! The title is Core's own metadata (`auto_title`), stored like the user's.

use std::time::Duration;

use piarc_host::HostSupervisor;
use piarc_protocol::session::{SessionTitle, SessionTitleParams};

use super::{Request, SessionActor, SessionMsg};
use crate::error::Result;
use crate::sessions::host_error;

/// Single-line messages up to this many columns (a CJK character is two) are their own title.
const SHORT_MESSAGE_COLUMNS: usize = 32;
/// The most UTF-16 units of the message sent.
const MESSAGE_UNITS: usize = 4000;
/// The most characters of a title kept.
const TITLE_CHARS: usize = 80;
/// How long the Agent Host may take (its own limit is 30 s).
const TIMEOUT: Duration = Duration::from_secs(40);
/// Requests per session: a failed one is tried again with the next message.
const ATTEMPTS: u8 = 2;

/// What a message can do for the title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Material {
    /// Ask with this text.
    Ask(String),
    /// Short enough to be the title itself: nothing to ask, ever.
    Itself,
    /// A command or nothing: wait for the next message.
    Later,
}

/// What a message offers: a command (`/name …`) or an empty message names nothing.
pub(super) fn material(text: &str) -> Material {
    let text = text.trim();
    if text.is_empty() || text.starts_with('/') {
        return Material::Later;
    }
    let columns: usize = text.chars().map(columns).sum();
    if !text.contains('\n') && columns <= SHORT_MESSAGE_COLUMNS {
        return Material::Itself;
    }
    Material::Ask(cut_utf16(text, MESSAGE_UNITS))
}

/// Display columns of a character: two for the wide scripts (CJK, Hangul, Kana, fullwidth).
fn columns(c: char) -> usize {
    if matches!(u32::from(c), 0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x20000..=0x3FFFD)
    {
        2
    } else {
        1
    }
}

/// `text` cut to at most `units` UTF-16 units, on a character boundary.
fn cut_utf16(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

/// The Agent Host's answer made safe to list: one line, no control characters, bounded.
pub(super) fn clean(title: &str) -> Option<String> {
    let line = title.lines().map(str::trim).find(|line| !line.is_empty())?;
    let title: String = line
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(TITLE_CHARS)
        .collect();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// One session's titling: whether it may still be titled, and the input on its way.
#[derive(Debug, Default)]
pub(super) struct Titling {
    /// Created by this Core (not resumed or forked) and titles are on.
    eligible: bool,
    /// Titled, or its first message is its title: nothing more to ask.
    settled: bool,
    asking: bool,
    attempts: u8,
    /// The text of an input in flight that could name the session.
    candidate: Option<String>,
}

impl Titling {
    pub(super) fn new(eligible: bool) -> Self {
        Self {
            eligible,
            ..Self::default()
        }
    }

    fn open(&self) -> bool {
        self.eligible && !self.settled && !self.asking && self.attempts < ATTEMPTS
    }

    /// A prompt, steer or follow-up is on its way.
    pub(super) fn offer(&mut self, text: &str) {
        if self.open() && self.candidate.is_none() {
            self.candidate = Some(text.to_owned());
        }
    }

    /// The input on its way ended, `taken` when Core accepted it; the text to ask with when it
    /// names the session now. `renamed`: the user gave the session a title.
    pub(super) fn ended(&mut self, taken: bool, renamed: bool) -> Option<String> {
        let text = self.candidate.take()?;
        if !taken || !self.open() {
            return None;
        }
        if renamed {
            self.settled = true;
            return None;
        }
        match material(&text) {
            Material::Ask(text) => {
                self.asking = true;
                self.attempts += 1;
                Some(text)
            }
            Material::Itself => {
                self.settled = true;
                None
            }
            Material::Later => None,
        }
    }

    /// The request ended; `titled` when it gave a title.
    pub(super) fn answered(&mut self, titled: bool) {
        self.asking = false;
        self.settled |= titled;
    }
}

impl Request {
    /// `session/title` (ADR-0106): one auxiliary request outside the turn.
    pub(super) async fn session_title(&self, text: String) -> Result<Option<String>> {
        let host: HostSupervisor = self.host().await?;
        let params = SessionTitleParams {
            session_id: self.id.clone(),
            text,
        };
        let answer = host
            .session_call_within::<SessionTitle>(&self.id, params, TIMEOUT)
            .await
            .map_err(host_error)?;
        Ok(clean(&answer.title))
    }
}

impl SessionActor {
    /// An input ended (`taken` when Core accepted it): asks for a title when it names the
    /// session. The answer comes back as [`SessionMsg::Titled`].
    pub(super) fn ask_title(&mut self, taken: bool) {
        let renamed = matches!(self.prefs.custom_title, Some(Some(_)));
        let Some(text) = self.titling.ended(taken, renamed) else {
            return;
        };
        let request = self.request();
        let tx = self.tx.clone();
        self.ctx.handle.spawn(async move {
            let title = tokio::select! {
                result = request.session_title(text) => result,
                () = request.cancel.cancelled() => return,
            };
            let title = title.unwrap_or_else(|error| {
                // The error's kind only: a provider's message may quote the conversation.
                tracing::info!(
                    target: "piarc_core::sessions",
                    session = %request.id.0,
                    kind = ?error.kind(),
                    "no session title"
                );
                None
            });
            let _ = tx.send(SessionMsg::Titled(title)).await;
        });
    }

    /// The title request ended: a title shows at once and is stored with the session's state.
    pub(super) fn titled(&mut self, title: Option<String>) {
        self.titling.answered(title.is_some());
        let Some(title) = title else {
            return;
        };
        self.prefs.auto_title = Some(title);
        self.publish();
        self.persist();
    }
}

#[cfg(test)]
mod tests {
    use super::{Material, Titling, clean, material};

    const LONG: &str = "我想系统地学习 Spring Boot，请帮我规划一个四周完成的入门学习计划";

    #[test]
    fn long_messages_ask_short_ones_are_their_own_title_and_commands_wait() {
        assert_eq!(material(LONG), Material::Ask(LONG.to_owned()));
        assert_eq!(material("  你好  "), Material::Itself);
        assert_eq!(material("Fix the flaky login test"), Material::Itself);
        assert_eq!(material("你好 [[piarc-scenario:chat]]"), Material::Itself);
        // Sixteen CJK characters are 32 columns; seventeen ask.
        assert_eq!(material(&"字".repeat(16)), Material::Itself);
        assert!(matches!(material(&"字".repeat(17)), Material::Ask(_)));
        assert!(matches!(material("short\nbut two lines"), Material::Ask(_)));
        assert_eq!(
            material("/review the last commit please, carefully"),
            Material::Later
        );
        assert_eq!(material("   "), Material::Later);
        let Material::Ask(sent) = material(&"😀".repeat(3000)) else {
            panic!("asks")
        };
        assert_eq!(sent.encode_utf16().count(), 4000);
    }

    #[test]
    fn answers_become_one_bounded_line() {
        assert_eq!(
            clean("\n  Spring Boot 入门学习计划  \nmore"),
            Some("Spring Boot 入门学习计划".into())
        );
        assert_eq!(clean("a\u{7}b"), Some("a b".into()));
        assert_eq!(clean(" \n "), None);
        assert_eq!(clean(&"x".repeat(200)).map(|t| t.chars().count()), Some(80));
    }

    #[test]
    fn a_session_is_asked_at_most_twice_and_never_after_a_title() {
        let mut t = Titling::new(true);
        // A command waits; the next prose message asks.
        t.offer("/compact");
        assert_eq!(t.ended(true, false), None);
        t.offer(LONG);
        assert_eq!(t.ended(true, false), Some(LONG.to_owned()));
        // Nothing more while asking.
        t.offer(LONG);
        assert_eq!(t.ended(true, false), None);
        // A failed request is tried again once.
        t.answered(false);
        t.offer(LONG);
        assert!(t.ended(true, false).is_some());
        t.answered(false);
        t.offer(LONG);
        assert_eq!(t.ended(true, false), None, "two attempts at most");

        let mut titled = Titling::new(true);
        titled.offer(LONG);
        assert!(titled.ended(true, false).is_some());
        titled.answered(true);
        titled.offer(LONG);
        assert_eq!(titled.ended(true, false), None);
    }

    #[test]
    fn refused_inputs_renames_short_messages_and_resumed_sessions_ask_nothing() {
        let mut refused = Titling::new(true);
        refused.offer(LONG);
        assert_eq!(refused.ended(false, false), None);
        refused.offer(LONG);
        assert!(
            refused.ended(true, false).is_some(),
            "the next accepted input asks"
        );

        let mut renamed = Titling::new(true);
        renamed.offer(LONG);
        assert_eq!(renamed.ended(true, true), None);
        renamed.offer(LONG);
        assert_eq!(renamed.ended(true, false), None);

        let mut short = Titling::new(true);
        short.offer("你好");
        assert_eq!(short.ended(true, false), None);
        short.offer(LONG);
        assert_eq!(
            short.ended(true, false),
            None,
            "its first message is its title"
        );

        let mut resumed = Titling::new(false);
        resumed.offer(LONG);
        assert_eq!(resumed.ended(true, false), None);
    }
}
