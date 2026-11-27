//! JSON Schema export.
//!
//! [`export_schema`] produces the two files committed under `packages/protocol/schema/`:
//!
//! - `ahp.schema.json`: a JSON Schema (draft 2020-12) document whose `$defs` hold every
//!   contract message and every type they reference;
//! - `contracts.json`: the protocol version and the contract registry (name, kind, method,
//!   schema name), read by the TypeScript generator and the sample completeness check.
//!
//! Output is deterministic: object keys are sorted recursively and nothing depends on the
//! time, the machine or the user.

use schemars::generate::SchemaSettings;
use serde_json::{Map, Value, json};

use crate::contract::CONTRACTS;
use crate::version::PROTOCOL_VERSION;

/// File name of the schema document.
pub const SCHEMA_FILE: &str = "ahp.schema.json";
/// File name of the contract registry.
pub const CONTRACTS_FILE: &str = "contracts.json";

/// The exported files, keyed by file name.
#[must_use]
pub fn export_schema() -> Vec<(&'static str, Value)> {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    for contract in CONTRACTS {
        // The returned `$ref` is not needed: registering puts the definition in `$defs`.
        let _reference = contract.register(&mut generator);
    }
    // Also publish the Core API types consumed by desktop clients.
    generator.subschema_for::<crate::policy::ApprovalRequest>();
    generator.subschema_for::<crate::policy::ApprovalAnswer>();
    generator.subschema_for::<crate::policy::AnswerStatus>();
    generator.subschema_for::<crate::policy::PermissionMode>();
    generator.subschema_for::<crate::policy::AutoReviewStatus>();
    generator.subschema_for::<crate::memory::MemorySnapshot>();
    generator.subschema_for::<crate::checkpoint::RewindPreview>();
    generator.subschema_for::<crate::checkpoint::RewindRequest>();
    generator.subschema_for::<crate::checkpoint::RewindReport>();
    generator.subschema_for::<crate::checkpoint::ChangesView>();
    generator.subschema_for::<crate::checkpoint::DiscardRequest>();
    generator.subschema_for::<crate::tasks::TasksSnapshot>();
    generator.subschema_for::<crate::terminal::TerminalEvent>();
    generator.subschema_for::<crate::terminal::TerminalTextRange>();
    generator.subschema_for::<crate::terminal::TerminalInfo>();
    generator.subschema_for::<crate::terminal::TerminalCommand>();
    generator.subschema_for::<crate::terminal::TerminalMatch>();
    generator.subschema_for::<crate::terminal::TerminalPasteOutcome>();
    generator.subschema_for::<crate::terminal::TerminalScroll>();
    generator.subschema_for::<crate::terminal::TerminalLink>();
    generator.subschema_for::<crate::term_frame::Frame>();
    generator.subschema_for::<crate::plugins::PackagesList>();
    generator.subschema_for::<crate::plugins::PackageInstallRequest>();
    generator.subschema_for::<crate::plugins::PackageInstallResult>();
    generator.subschema_for::<crate::usage::UsageReport>();
    git_types(&mut generator);
    generator.subschema_for::<crate::browser::BrowserClientEvent>();
    generator.subschema_for::<crate::browser::BrowserRunAnswer>();
    generator.subschema_for::<crate::browser::BrowserSiteRequest>();
    generator.subschema_for::<crate::browser::BrowserSiteDecision>();
    generator.subschema_for::<crate::browser::BrowserFilesRequest>();
    generator.subschema_for::<crate::browser::BrowserFilesResult>();
    generator.subschema_for::<crate::browser::BrowserStateUpdate>();
    // A `browserState` reminder's text (the Agent Host reads it).
    generator.subschema_for::<crate::browser::BrowserStateSummary>();
    generator.subschema_for::<crate::dev_server::LaunchView>();
    generator.subschema_for::<crate::dev_server::DevServerStart>();
    let definitions = generator.take_definitions(true);
    let any_message: Vec<Value> = CONTRACTS
        .iter()
        .map(|c| json!({ "$ref": format!("#/$defs/{}", c.schema_name()) }))
        .collect();
    let schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "AhpMessage",
        "description": format!(
            "Any message covered by the Agent Host Protocol {PROTOCOL_VERSION} contracts. \
             Generated from the piarc-protocol crate by `npm run gen:protocol`; do not edit."
        ),
        "anyOf": any_message,
        "$defs": Value::Object(definitions),
    });
    let contracts: Vec<Value> = CONTRACTS
        .iter()
        .map(|c| {
            json!({
                "name": c.name(),
                "kind": c.kind(),
                "method": c.method(),
                "schema": c.schema_name(),
            })
        })
        .collect();
    let registry = json!({
        "$comment": "Generated from the piarc-protocol crate by `npm run gen:protocol`; do not edit.",
        "protocolVersion": PROTOCOL_VERSION.to_string(),
        "contracts": contracts,
    });
    vec![
        (SCHEMA_FILE, sort_keys(schema)),
        (CONTRACTS_FILE, sort_keys(registry)),
    ]
}

/// Rebuilds every object with its keys in sorted order, regardless of whether
/// `serde_json/preserve_order` is enabled somewhere in the dependency graph.
fn sort_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let sorted: Map<String, Value> = entries
                .into_iter()
                .map(|(k, v)| (k, sort_keys(v)))
                .collect();
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sort_keys).collect()),
        other => other,
    }
}

/// The Git panel types the desktop client reads (ADR-0084).
fn git_types(generator: &mut schemars::SchemaGenerator) {
    generator.subschema_for::<crate::git::GitCall>();
    generator.subschema_for::<crate::git::GitStatus>();
    generator.subschema_for::<crate::git::GitProbe>();
    generator.subschema_for::<crate::git::GitChanges>();
    generator.subschema_for::<crate::git::GitFileChange>();
    generator.subschema_for::<crate::git::GitText>();
    generator.subschema_for::<crate::git::GitCommits>();
    generator.subschema_for::<crate::git::GitBranches>();
    generator.subschema_for::<crate::git::GitFileStages>();
    generator.subschema_for::<crate::git::GitLastCommit>();
    generator.subschema_for::<crate::git::GitCommitMessage>();
    generator.subschema_for::<crate::git::GitOpResult>();
    generator.subschema_for::<crate::git::GitDescription>();
    generator.subschema_for::<crate::git::GitFailure>();
    generator.subschema_for::<crate::git::GitEvent>();
    // Voice dictation (ADR-0094): window events, requests and model state.
    generator.subschema_for::<crate::dictation::DictationEvent>();
    generator.subschema_for::<crate::dictation::DictationStart>();
    generator.subschema_for::<crate::dictation::DictationStarted>();
    generator.subschema_for::<crate::dictation::DictationStatus>();
    generator.subschema_for::<crate::dictation::InputDevice>();
    generator.subschema_for::<crate::dictation::SpeechModels>();
    generator.subschema_for::<crate::git::GitLog>();
    generator.subschema_for::<crate::git::GitCommitDetail>();
    generator.subschema_for::<crate::git::GitStashes>();
    generator.subschema_for::<crate::git::GitBlob>();
    generator.subschema_for::<crate::git::GitConflictSides>();
    generator.subschema_for::<crate::git::GitRebasePlan>();
    generator.subschema_for::<crate::git::GitPrDraft>();
    generator.subschema_for::<crate::git::GitReview>();
    generator.subschema_for::<crate::git::GitPullRequestStatus>();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_is_deterministic() {
        assert_eq!(export_schema(), export_schema());
    }

    #[test]
    fn every_contract_schema_is_defined() {
        let files = export_schema();
        let schema = &files
            .iter()
            .find(|(name, _)| *name == SCHEMA_FILE)
            .expect("schema file")
            .1;
        for contract in CONTRACTS {
            let name = contract.schema_name();
            assert!(
                schema["$defs"].get(name.as_ref()).is_some(),
                "missing $defs/{name}"
            );
        }
    }
}
