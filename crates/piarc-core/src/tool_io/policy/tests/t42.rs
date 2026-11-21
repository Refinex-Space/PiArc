//! T42-A04, A05 through the real Core preflight: answers from a system notification go through
//! the approval ledger (first valid answer wins, the later one is refused), are audited with the
//! source "notification", and only short ordinary requests may be allowed from a notification;
//! long or multi-line commands and protected paths only open their card.
use piarc_protocol::policy::AnswerVia;

use super::*;

fn from_notification(card: &ApprovalRequest, decision: ApprovalDecision) -> ApprovalAnswer {
    let mut reply = answer(card, decision);
    reply.via = Some(AnswerVia::Notification);
    reply
}

#[tokio::test]
async fn a_notification_allows_once_through_the_ledger_and_is_audited() {
    let f = Fixture::new().await;
    let answering = async {
        let card = f.pending_of(SESSION).await;
        assert!(card.notification_allow, "{card:?}");
        // Allowing for the session or always is the card's, not the notification's.
        let mut wider = from_notification(&card, ApprovalDecision::AllowSession);
        wider.rules.clone_from(&card.rules);
        assert!(f.io.answer_approval(wider).await.is_err());
        let status =
            f.io.answer_approval(from_notification(&card, ApprovalDecision::AllowOnce))
                .await
                .expect("answer");
        assert_eq!(status["status"], "applied");
        // The card answered a moment later: the ledger already took the first answer.
        let late =
            f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
                .await
                .expect("answer");
        assert_ne!(late["status"], "applied", "{late}");
        card
    };
    let (result, card) = tokio::join!(
        f.evaluate("n1", "Bash", json!({"command": "printenv HOME"})),
        answering
    );
    assert_eq!(result["allowed"], true);
    let audit = f.child_audit(SESSION);
    let row = audit
        .iter()
        .find(|r| r["toolCallId"] == "n1")
        .expect("audited");
    assert_eq!(row["source"], "notification", "{row}");
    assert_eq!(card.connection_epoch, f.peer.epoch());
}

#[tokio::test]
async fn long_and_multi_line_commands_and_protected_paths_only_open_the_card() {
    let f = Fixture::new().await;
    let long = format!("printenv {}", "X".repeat(notify::NOTIFY_COMMAND_CHARS));
    for (call, input) in [
        ("long", json!({"command": long})),
        ("lines", json!({"command": "printenv HOME\nprintenv PATH"})),
    ] {
        let answering = async {
            let card = f.pending_of(SESSION).await;
            assert!(!card.notification_allow, "{call}: {card:?}");
            assert!(
                f.io.answer_approval(from_notification(&card, ApprovalDecision::AllowOnce))
                    .await
                    .is_err(),
                "{call}: a notification cannot allow it"
            );
            // Refusing from the notification is always possible.
            let status =
                f.io.answer_approval(from_notification(&card, ApprovalDecision::Deny))
                    .await
                    .expect("deny");
            assert_eq!(status["status"], "applied");
        };
        let (result, ()) = tokio::join!(f.evaluate(call, "Bash", input), answering);
        assert_eq!(result["allowed"], false, "{call}");
    }
    // A protected path (the project's Claude Code settings) asks with an open-only card.
    std::fs::create_dir_all(f.work.join(".claude")).expect("dir");
    let answering = async {
        let card = f.pending_of(SESSION).await;
        assert_eq!(card.protected_path, Some(true));
        assert!(!card.notification_allow);
        f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
            .await
            .expect("deny");
    };
    let (result, ()) = tokio::join!(
        f.evaluate(
            "protected",
            "Write",
            json!({"path": ".claude/notes.md", "content": "x\n"})
        ),
        answering
    );
    assert_eq!(result["allowed"], false);
}
