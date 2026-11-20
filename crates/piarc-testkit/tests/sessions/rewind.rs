//! T28 rewinds through Core's session actor (ADR-0044 rule 5): the session stays busy while a
//! rewind moves its files and conversation.

use std::time::Duration;

use piarc_core::composer::UserInput;
use piarc_core::sessions::{CheckpointOp, Op};
use piarc_protocol::checkpoint::{RewindReport, RewindRequest, RewindScope};
use piarc_protocol::turn::TurnId;

use crate::support::{Env, answer, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

/// R3: a rewind checks that no turn runs when it starts, and then takes as long as a summary
/// request. A prompt sent in that time used to start a turn that the rewind's reopening of the
/// session then destroyed; Core now refuses it until the rewind ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_during_a_rewind_is_refused_as_busy() {
    let env = Env::new("rewind busy").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let first = prompt(&core, &id, &prompt_text("First request.", "rewind-busy")).await;
    events.turn_completed(&id, &first).await;

    let (done, rewound) = reply();
    let request = RewindRequest {
        turn_id: TurnId(first),
        scope: RewindScope::Summarize,
        choices: Vec::new(),
    };
    core.session_op(
        id.clone(),
        Op::Checkpoint(CheckpointOp::Rewind(request)),
        done,
    )
    .expect("queued");
    // The summary request has reached the mock and streams slowly.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while env.requests("rewind-busy").len() < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the summary request never came"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let (done, rx) = reply();
    core.session_op(
        id.clone(),
        Op::Prompt(UserInput::text("Sent during the rewind.")),
        done,
    )
    .expect("queued");
    let refused = answer(rx).await;
    let report = answer(rewound).await.expect("the rewind ends");
    let report: RewindReport = serde_json::from_value(report).expect("a rewind report");
    assert!(report.completed, "{report:?}");
    let error = refused.expect_err("a prompt during a rewind is refused");
    assert_eq!(error.kind(), piarc_protocol::ErrorKind::SessionBusy);

    // Afterwards the session takes prompts again, on the new branch.
    let next = prompt(&core, &id, "Go on.").await;
    let completed = events.turn_completed(&id, &next).await;
    assert_eq!(completed["status"], "completed", "{completed}");
    assert_eq!(env.requests("rewind-busy").len(), 3);
    shutdown(core).await;
}
