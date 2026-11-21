//! L3 runs (T30): the PiArc side of the behavior comparison. The scenario runs as usual with
//! its mocks in [`Mode::L3`]; before the root is removed, [`Driver::capture`] keeps what the
//! comparison needs, all of it structure:
//!
//! - `requests`: per endpoint, the structures the mock recorded (never bodies);
//! - `tool_calls`: every tool item Core delivered, `{id, tool, status}` in completion order;
//! - `asks`: every approval card in order, `{tool, call, decision, scripted}`, answered with
//!   the scenario's approval naming the card's tool call; a card no approval names is refused
//!   (`scripted: false`) instead of failing the run;
//! - `turns`: each turn's final `status` (and `errorKind`);
//! - `files`: the workspace's files and a hash of their bytes, without `.l3/`;
//! - `workspace`, `home`: the absolute paths of this run, which the recorder replaces with
//!   placeholders;
//! - `logs`: the JSON lines the L3 fixtures wrote under `.l3/` (hook and approval records,
//!   already structure-only).
use std::collections::BTreeMap;
use std::path::Path;

use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision, ApprovalRequest};
use serde_json::{Map, Value, json};

use super::{Driver, RunOutcome, RunnerConfig, ScenarioSpec, call, run_with};
use crate::server::Mode;

/// The workspace directory the L3 fixtures write their logs to; not part of `files`.
pub const L3_DIR: &str = ".l3";

/// Runs `spec` as the PiArc side of an L3 comparison and returns the outcome with the
/// capture described in the module documentation.
#[must_use]
pub fn run_l3(spec: &ScenarioSpec, config: &RunnerConfig) -> (RunOutcome, Value) {
    let (outcome, capture) = run_with(spec, config, Mode::L3);
    (outcome, capture.unwrap_or(Value::Null))
}

impl Driver<'_> {
    /// Refuses an approval card no scripted answer covers (L3 only).
    pub(super) async fn refuse_unscripted(
        &mut self,
        card: ApprovalRequest,
        pending: Option<String>,
    ) -> Result<(), String> {
        self.asks.push(
            json!({"tool": card.tool, "call": pending, "decision": "deny", "scripted": false}),
        );
        let answer = ApprovalAnswer {
            request_id: card.request_id.clone(),
            session_id: card.session_id,
            revision: card.revision,
            connection_epoch: card.connection_epoch,
            decision: ApprovalDecision::Deny,
            feedback: None,
            rules: Vec::new(),
            directory: None,
            domain: None,
            mode: None,
            comments: Vec::new(),
            answers: Vec::new(),
            via: None,
        };
        let result = call(
            |done| self.core.answer_approval(answer, done),
            "refusing an unscripted approval",
        )
        .await?;
        if result["status"] != "applied" {
            return Err(format!("refusal was not applied: {result}"));
        }
        self.answered.insert(card.request_id);
        Ok(())
    }

    /// The tool call of `tool` that has started and not completed: the call an approval
    /// card for `tool` belongs to (tool calls that ask run one at a time).
    pub(super) fn pending_call(&self, tool: &str) -> Option<String> {
        let mut open: Vec<String> = Vec::new();
        for event in self.observed() {
            let item = &event.params["item"];
            let Some(id) = item["itemId"].as_str() else {
                continue;
            };
            match event.method.as_str() {
                "item/started" if item["tool"] == tool => open.push(id.to_owned()),
                "item/completed" => open.retain(|o| o != id),
                _ => {}
            }
        }
        open.pop()
    }

    /// What the comparison needs from this run (see the module documentation).
    pub(super) fn capture(&self) -> Value {
        let mut tool_calls = Vec::new();
        let mut turns = Vec::new();
        for event in self.observed() {
            match event.method.as_str() {
                "item/completed" => {
                    let item = &event.params["item"];
                    if let Some(tool) = item["tool"].as_str() {
                        tool_calls.push(json!({
                            "id": item["itemId"], "tool": tool, "status": item["status"],
                        }));
                    }
                }
                "turn/completed" => {
                    let mut turn = Map::new();
                    turn.insert("status".into(), event.params["status"].clone());
                    if let Some(kind) = event.params.get("errorKind") {
                        turn.insert("errorKind".into(), kind.clone());
                    }
                    turns.push(Value::Object(turn));
                }
                _ => {}
            }
        }
        let requests: BTreeMap<String, Vec<Value>> = self
            .env
            .records()
            .into_iter()
            .map(|(name, records)| {
                let shapes = records
                    .into_iter()
                    .map(|r| {
                        json!({
                            "structure": r.structure,
                            "outcome": r.outcome,
                            "violations": r.violations.iter().map(|v| v.rule.id()).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                (name, shapes)
            })
            .collect();
        json!({
            "workspace": self.env.workspace,
            "home": self.env.home,
            "requests": requests,
            "tool_calls": tool_calls,
            "asks": self.asks,
            "turns": turns,
            "files": files(&self.env.workspace),
            "logs": logs(&self.env.workspace.join(L3_DIR)),
        })
    }
}

/// Every file under `workspace` (outside `.l3/`) by `/`-separated relative path, with
/// [`crate::l3::file_hash`] of its bytes.
fn files(workspace: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut pending = vec![workspace.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(workspace) else {
                continue;
            };
            let name: Vec<String> = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            if name.first().map(String::as_str) == Some(L3_DIR) {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind) if kind.is_file() => {
                    if let Ok(bytes) = std::fs::read(&path) {
                        out.insert(name.join("/"), crate::l3::file_hash(&bytes));
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// The `.jsonl` files under `dir`, by file name, each as its parsed lines (a line that is
/// not JSON is kept as `{"unparsed": <length>}`).
fn logs(dir: &Path) -> BTreeMap<String, Vec<Value>> {
    let mut out = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".jsonl") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let lines = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .unwrap_or_else(|_| json!({"unparsed": line.chars().count()}))
            })
            .collect();
        out.insert(name, lines);
    }
    out
}
