//! Commit message generation (ADR-0086).

use piarc_protocol::git::{GitFailure, GitFailureKind, GitLanguage};
use serde_json::Value;

use crate::Result;
use crate::git::reply_failure;
use crate::git::write::Context;

/// Generates a commit message from the staged changes of `context`'s repository.
pub(crate) async fn generate(
    context: &Context<'_>,
    language: GitLanguage,
    instructions: &str,
    amend: bool,
) -> Result<Value> {
    let _ = (context.session, language, instructions, amend);
    reply_failure(GitFailure::of(GitFailureKind::NoModel))
}
