//! Auto mode's reviewer step (T46, design addendum `docs/architecture/addenda/T46-auto-mode.md`):
//! which rulings go to the reviewer model, how its answer is checked, and when review pauses.
//!
//! - Only a ruling that ends in the general question of step 7 (`step == "ask"`) is reviewed
//!   ([`reviewable`]); every other question (ask rules, critical deletions, protected paths,
//!   outside the workspace, unresolved commands, commands outside the sandbox, tools that need
//!   the user, plans) stays with the user.
//! - The answer is checked here a second time ([`check_answer`]): the verdict must be exactly
//!   `allow`, `deny` or `unsure`; the reason must be non-empty and is cleaned and truncated
//!   ([`clean_reason`]); an unknown category is dropped.
//! - Every failure, an `unsure` and a paused review hand the card to the user; the call never
//!   runs on a failure.
//! - [`Denials`] counts the reviewer's refusals in a session tree and pauses review after
//!   [`CONSECUTIVE_DENIAL_LIMIT`] in a row or [`TOTAL_DENIAL_LIMIT`] in all.

use std::time::Duration;

use piarc_protocol::policy::{REVIEW_REASON_CHARS, ReviewAnswer, ReviewFallback};

use crate::Ruling;

/// How long a review may take, retries included. Not a setting.
pub const REVIEW_TIMEOUT: Duration = Duration::from_secs(30);

/// Refusals in a row after which review pauses.
pub const CONSECUTIVE_DENIAL_LIMIT: u32 = 3;

/// Refusals in a session after which review pauses.
pub const TOTAL_DENIAL_LIMIT: u32 = 20;

/// The default blocked categories, `custom` (a user's own entry) and `none`.
pub const CATEGORIES: &[&str] = &[
    "credentialLeak",
    "weakenControls",
    "remoteCode",
    "dataEgress",
    "irreversibleLoss",
    "historyRewrite",
    "sharedSystems",
    "persistence",
    "actOnBehalf",
    "outOfScope",
    "custom",
    "none",
];

/// What the model reads after the reviewer's reason when it refused a call.
pub const DENIAL_NOTE: &str = "Do not try to reach the same effect another way. If the action is needed, ask the user to approve it or to run it themselves.";

/// Added to the refusal that paused review.
pub const PAUSE_NOTE: &str =
    "Automatic review is paused for this session: further actions need the user's approval.";

/// Whether the reviewer may answer this ruling: only the general question of step 7.
#[must_use]
pub fn reviewable(ruling: &Ruling) -> bool {
    ruling.outcome == crate::Outcome::Ask && ruling.step == "ask"
}

/// The reviewer's verdict after the check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Run the call (this time only).
    Allow,
    /// Refuse it with the reason.
    Deny,
    /// Ask the user.
    Unsure,
}

/// A checked answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    /// The verdict.
    pub verdict: Verdict,
    /// The cleaned, truncated reason.
    pub reason: String,
    /// A known category, if the reviewer named one.
    pub category: Option<String>,
}

/// Checks the reviewer's answer as the Agent Host passed it on.
///
/// # Errors
///
/// [`ReviewFallback::InvalidVerdict`] for a verdict other than the three (case-sensitive, not
/// trimmed); [`ReviewFallback::Unparsable`] for a reason that is empty once cleaned.
pub fn check_answer(answer: &ReviewAnswer) -> Result<Checked, ReviewFallback> {
    let verdict = match answer.verdict.as_str() {
        "allow" => Verdict::Allow,
        "deny" => Verdict::Deny,
        "unsure" => Verdict::Unsure,
        _ => return Err(ReviewFallback::InvalidVerdict),
    };
    let reason = clean_reason(&answer.reason);
    if reason.is_empty() {
        return Err(ReviewFallback::Unparsable);
    }
    let category = answer
        .category
        .as_deref()
        .filter(|c| CATEGORIES.contains(c))
        .map(str::to_owned);
    Ok(Checked {
        verdict,
        reason,
        category,
    })
}

/// `text` without control characters (line breaks and tabs become spaces), trimmed and cut to
/// [`REVIEW_REASON_CHARS`] Unicode characters. Used for every reviewer text shown or stored.
#[must_use]
pub fn clean_reason(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    cleaned.trim().chars().take(REVIEW_REASON_CHARS).collect()
}

/// Why review paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pause {
    /// [`CONSECUTIVE_DENIAL_LIMIT`] refusals in a row.
    Consecutive,
    /// [`TOTAL_DENIAL_LIMIT`] refusals in the session.
    Total,
}

impl Pause {
    /// The card's reason.
    #[must_use]
    pub fn fallback(self) -> ReviewFallback {
        match self {
            Self::Consecutive => ReviewFallback::PausedConsecutive,
            Self::Total => ReviewFallback::PausedTotal,
        }
    }

    /// The audit's name.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Consecutive => "consecutive",
            Self::Total => "total",
        }
    }
}

/// The counts after a refusal, as the audit records them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DenialCount {
    /// Refusals in a row, this one included.
    pub consecutive: u32,
    /// Refusals in the session since the last total pause, this one included.
    pub total: u32,
    /// This refusal paused review.
    pub paused: Option<Pause>,
}

/// The reviewer's refusals in a session tree (kept on the main session). Failures and
/// `unsure` do not count.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Denials {
    consecutive: u32,
    total: u32,
    paused: Option<Pause>,
}

impl Denials {
    /// Why review is paused, if it is.
    #[must_use]
    pub fn paused(&self) -> Option<Pause> {
        self.paused
    }

    /// The reviewer refused a call. A count that reaches its limit pauses review and starts
    /// again from zero.
    pub fn deny(&mut self) -> DenialCount {
        self.consecutive += 1;
        self.total += 1;
        let paused = if self.consecutive >= CONSECUTIVE_DENIAL_LIMIT {
            Some(Pause::Consecutive)
        } else if self.total >= TOTAL_DENIAL_LIMIT {
            Some(Pause::Total)
        } else {
            None
        };
        let count = DenialCount {
            consecutive: self.consecutive,
            total: self.total,
            paused,
        };
        if let Some(pause) = paused {
            self.paused = Some(pause);
            self.consecutive = 0;
            if pause == Pause::Total {
                self.total = 0;
            }
        }
        count
    }

    /// The reviewer allowed a call: the run of refusals ends.
    pub fn reviewer_allowed(&mut self) {
        self.consecutive = 0;
    }

    /// The user allowed a call on a card, or selected Auto mode again: the run of refusals
    /// ends and a pause lifts.
    pub fn resume(&mut self) {
        self.consecutive = 0;
        self.paused = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Outcome, Ruling};

    fn answer(verdict: &str, reason: &str, category: Option<&str>) -> ReviewAnswer {
        ReviewAnswer {
            verdict: verdict.into(),
            reason: reason.into(),
            category: category.map(str::to_owned),
        }
    }

    fn ruling(outcome: Outcome, step: &'static str) -> Ruling {
        Ruling {
            outcome,
            step,
            hits: Vec::new(),
            reason: None,
        }
    }

    #[test]
    fn only_the_general_question_is_reviewed() {
        assert!(reviewable(&ruling(Outcome::Ask, "ask")));
        for step in [
            "askRule",
            "invalidRule",
            "hookAsk",
            "criticalPath",
            "requiresUserInteraction",
            "planApproval",
            "unsandboxed",
            "protectedPath",
            "outsideWorkspace",
            "unresolved",
        ] {
            assert!(!reviewable(&ruling(Outcome::Ask, step)), "{step}");
        }
        assert!(!reviewable(&ruling(Outcome::Allow, "ask")));
        assert!(!reviewable(&ruling(Outcome::Deny, "ask")));
    }

    #[test]
    fn the_verdict_must_be_one_of_three_exactly() {
        for (text, verdict) in [
            ("allow", Verdict::Allow),
            ("deny", Verdict::Deny),
            ("unsure", Verdict::Unsure),
        ] {
            let checked = check_answer(&answer(text, "why", None)).expect("checked");
            assert_eq!(checked.verdict, verdict);
        }
        for text in ["Allow", " allow", "allow ", "yes", "", "ALLOW"] {
            assert_eq!(
                check_answer(&answer(text, "why", None)),
                Err(ReviewFallback::InvalidVerdict),
                "{text:?}"
            );
        }
    }

    #[test]
    fn an_empty_reason_is_unparsable_and_categories_are_known_ids() {
        assert_eq!(
            check_answer(&answer("allow", " \n\u{7} ", None)),
            Err(ReviewFallback::Unparsable)
        );
        let known = check_answer(&answer("deny", "r", Some("remoteCode"))).expect("known");
        assert_eq!(known.category.as_deref(), Some("remoteCode"));
        let unknown = check_answer(&answer("deny", "r", Some("Remote code"))).expect("unknown");
        assert_eq!(unknown.category, None);
        assert_eq!(unknown.verdict, Verdict::Deny);
    }

    #[test]
    fn reasons_lose_control_characters_and_stop_at_the_limit() {
        assert_eq!(clean_reason("a\nb\tc\u{1b}[31md\u{0}"), "a b c[31md");
        let long: String = "审".repeat(REVIEW_REASON_CHARS + 20);
        let cut = clean_reason(&long);
        assert_eq!(cut.chars().count(), REVIEW_REASON_CHARS);
        // Direction controls are not control characters: the client reveals them.
        assert_eq!(clean_reason("x\u{202e}y"), "x\u{202e}y");
    }

    #[test]
    fn three_refusals_in_a_row_pause_and_an_allow_resets_the_run() {
        let mut d = Denials::default();
        assert_eq!(d.deny().paused, None);
        assert_eq!(d.deny().paused, None);
        d.reviewer_allowed();
        assert_eq!(d.deny().consecutive, 1);
        assert_eq!(d.deny().consecutive, 2);
        let third = d.deny();
        assert_eq!(
            third,
            DenialCount {
                consecutive: 3,
                total: 5,
                paused: Some(Pause::Consecutive)
            }
        );
        assert_eq!(d.paused(), Some(Pause::Consecutive));
        d.resume();
        assert_eq!(d.paused(), None);
        assert_eq!(d.deny().consecutive, 1);
    }

    #[test]
    fn twenty_refusals_in_a_session_pause_and_start_again() {
        let mut d = Denials::default();
        for n in 1..=TOTAL_DENIAL_LIMIT {
            let count = d.deny();
            d.reviewer_allowed();
            assert_eq!(count.total, n);
            if n < TOTAL_DENIAL_LIMIT {
                assert_eq!(count.paused, None, "{n}");
            } else {
                assert_eq!(count.paused, Some(Pause::Total));
            }
        }
        assert_eq!(d.paused(), Some(Pause::Total));
        // The reviewer's allow does not lift a pause; the user does.
        d.reviewer_allowed();
        assert_eq!(d.paused(), Some(Pause::Total));
        d.resume();
        assert_eq!(d.deny().total, 1);
    }
}
