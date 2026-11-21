//! Answers from a system notification (T42, FR-SY-03): which cards a notification may allow,
//! and the check of such an answer. A notification has no room for the reading gate of
//! architecture section 8.5, so only an ordinary command or file change short enough to read
//! there may be allowed from it; everything else only opens the card. The answer goes through
//! the same ledger as the card's (first valid answer wins, a stale one is refused).
use piarc_protocol::policy::{AnswerVia, CommandPlace};

use super::*;

/// The longest command a notification shows whole (one line).
pub(super) const NOTIFY_COMMAND_CHARS: usize = 160;

/// The most changed lines a file change a notification may allow has.
pub(super) const NOTIFY_DIFF_LINES: u64 = 12;

/// Whether `card` may be allowed from a notification.
pub(super) fn allowed(card: &ApprovalRequest) -> bool {
    if card.protected_path == Some(true) || card.sandbox == Some(CommandPlace::Unsandboxed) {
        return false;
    }
    match card.kind {
        // No rule to save: a critical deletion or a command that cannot be analyzed.
        ApprovalKind::Command => {
            !card.rules.is_empty()
                && card
                    .command
                    .as_deref()
                    .is_some_and(|c| !c.contains('\n') && c.chars().count() <= NOTIFY_COMMAND_CHARS)
        }
        ApprovalKind::FileChange => card
            .diff
            .as_ref()
            .is_some_and(|d| d.degraded != Some(true) && d.added + d.removed <= NOTIFY_DIFF_LINES),
        _ => false,
    }
}

/// A notification's answer: allow once (only where the card says so) or deny, nothing else.
pub(super) fn check_answer(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    if answer.via != Some(AnswerVia::Notification) {
        return Ok(());
    }
    match answer.decision {
        ApprovalDecision::Deny if answer.feedback.is_none() => Ok(()),
        ApprovalDecision::AllowOnce if request.notification_allow => Ok(()),
        _ => Err(denied(
            "This request can only be answered on its approval card.",
        )),
    }
}
