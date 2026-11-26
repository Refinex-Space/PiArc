//! Registry of the wire messages covered by L1 contract tests.
//!
//! Every top-level message type and every method message is listed in [`CONTRACTS`]. The
//! registry drives the JSON Schema export ([`crate::export_schema`]), the sample
//! completeness check (`scripts/ci/check-contract-samples.mjs`, via the exported
//! `contracts.json`) and the Rust round-trip tests over `tests/contracts/<name>/`.
//!
//! Adding a message: define its types, add one entry here, run `npm run gen:protocol`, and
//! add samples under `tests/contracts/<name>/` (see `docs/engineering/testing.md`, L1).

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::checkpoint::{SessionBranches, SessionRewind, SessionSwitchBranch};
use crate::context::{
    ContextSettingsGet, FsChanges, FsForgetReads, SessionGetContextUsage, SessionRemind,
    SessionUsage,
};
use crate::exec::{ExecKill, ExecOutput, ExecRun, ExecShells};
use crate::fs::{FsGlob, FsGrep, FsList, FsMkdir, FsPdf, FsRead, FsSpill, FsStat, FsWrite};
use crate::handshake::HostHello;
use crate::harness::{HarnessPlan, HarnessTodo, UiAsk};
use crate::history::{HarnessEntry, SessionGetEntries, SessionHistory};
use crate::hooks::{HooksMcpTool, HooksPrompt, HooksRun};
use crate::host::{HostPing, HostShutdown};
use crate::jsonrpc::{ErrorResponse, Notification, Request, SuccessResponse};
use crate::mcp::{
    McpCancelElicitation, McpElicit, McpLogin, McpReconnect, McpServersMethod, McpSetEnabled,
    McpStatusChanged, McpStatusMethod,
};
use crate::memory::{FsMemory, MemoryApply, MemoryStatus};
use crate::method::{Method, NotificationMessage, RequestMessage, ResultMessage};
use crate::models::{
    ModelsCredential, ModelsCredentialStatus, ModelsDiscover, ModelsList, ModelsLoginCancel,
    ModelsLoginStart, ModelsLogout, ModelsReload, ModelsTest, SessionPreviewModelSwitch,
    SessionSetEffort, SessionSetModel, UiLoginInteraction,
};
use crate::plugins::PluginsExtensionsMethod;
use crate::policy::{
    PolicyCancel, PolicyEvaluate, PolicyInputChunk, PolicyPending, PolicyReview, PolicyTools,
};
use crate::queue::{QueueChanged, QueueDelete, QueueEdit, QueueReorder};
use crate::secrets::{
    SecretsChanged, SecretsDelete, SecretsGet, SecretsGetAll, SecretsLock, SecretsRenew,
    SecretsSet, SecretsUnlock,
};
use crate::session::{
    PolicyRecover, SessionAbort, SessionClose, SessionCommitMessage, SessionCompact, SessionCreate,
    SessionEventNotification, SessionFollowUp, SessionFork, SessionPrompt, SessionResume,
    SessionSetPermissionMode, SessionSteer, SideChatAsk, SideChatControl,
};
use crate::skills::{
    ResourcesListCommands, ResourcesListSkills, ResourcesReload, SkillsInvoke, SkillsListMethod,
    SkillsMatch,
};
use crate::subagent::{
    AgentsListMethod, ResourcesListAgents, SubagentCompleted, SubagentFinish, SubagentProgress,
    SubagentStart, SubagentStarted, SubagentStop,
};
use crate::tasks::{ExecMonitor, TaskKill, TaskListMethod, TaskRead};
use crate::trust::TrustGet;
use crate::turn::{
    ItemAgentMessageDelta, ItemCompleted, ItemReasoningDelta, ItemStarted, ItemUpdated,
    TurnCompleted, TurnRetrying, TurnStarted, TurnUsageReport,
};
use crate::web::{WebFetch, WebSearch, WebSearchBackend};

/// What a contract describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractKind {
    /// A top-level message type that does not interpret the method.
    Message,
    /// A request for one method.
    Request,
    /// The successful response to one request method.
    Response,
    /// A notification for one method.
    Notification,
}

/// One entry of the contract registry.
#[derive(Debug, Clone, Copy)]
pub struct Contract {
    name: &'static str,
    kind: ContractKind,
    method: Option<&'static str>,
    schema_name: fn() -> Cow<'static, str>,
    register: fn(&mut SchemaGenerator) -> Schema,
    roundtrip: fn(Value) -> Result<Value, serde_json::Error>,
}

impl Contract {
    /// Contract name; also the sample directory `tests/contracts/<name>/`.
    #[must_use]
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// What the contract describes.
    #[must_use]
    pub fn kind(&self) -> ContractKind {
        self.kind
    }

    /// The method, for request, response and notification contracts.
    #[must_use]
    pub fn method(&self) -> Option<&'static str> {
        self.method
    }

    /// Name of the message schema under `$defs` in the exported schema.
    #[must_use]
    pub fn schema_name(&self) -> Cow<'static, str> {
        (self.schema_name)()
    }

    /// Adds the message schema (and everything it references) to `generator`.
    pub(crate) fn register(&self, generator: &mut SchemaGenerator) -> Schema {
        (self.register)(generator)
    }

    /// Deserializes `sample` into the contract's Rust type and serializes it back. Used by
    /// L1 contract tests: a valid sample must come back equal, an invalid one must fail.
    ///
    /// # Errors
    ///
    /// The deserialization or serialization error.
    pub fn roundtrip(&self, sample: Value) -> Result<Value, serde_json::Error> {
        (self.roundtrip)(sample)
    }
}

fn roundtrip<T: Serialize + DeserializeOwned>(sample: Value) -> Result<Value, serde_json::Error> {
    serde_json::to_value(serde_json::from_value::<T>(sample)?)
}

const fn entry<T: Serialize + DeserializeOwned + JsonSchema>(
    name: &'static str,
    kind: ContractKind,
    method: Option<&'static str>,
) -> Contract {
    Contract {
        name,
        kind,
        method,
        schema_name: T::schema_name,
        register: SchemaGenerator::subschema_for::<T>,
        roundtrip: roundtrip::<T>,
    }
}

const fn request<M: crate::method::RequestMethod>(name: &'static str) -> Contract {
    entry::<RequestMessage<M>>(name, ContractKind::Request, Some(M::NAME))
}

const fn response<M: crate::method::RequestMethod>(name: &'static str) -> Contract {
    entry::<ResultMessage<M>>(name, ContractKind::Response, Some(M::NAME))
}

const fn notification<M: crate::method::NotificationMethod>() -> Contract {
    entry::<NotificationMessage<M>>(M::NAME, ContractKind::Notification, Some(M::NAME))
}

/// Every contract, in export order.
///
/// Method contracts are named after their method. A response contract has its own name:
/// `core/welcome` for `host/hello`, `<method>/result` for later request methods. Top-level
/// message types use the reserved families
/// `jsonrpc/` and `envelope/`, which no method may use; `framing/` holds the frame codec
/// cases and is not a contract either.
pub static CONTRACTS: &[Contract] = &[
    entry::<Request>("jsonrpc/request", ContractKind::Message, None),
    entry::<SuccessResponse>("jsonrpc/response", ContractKind::Message, None),
    entry::<ErrorResponse>("jsonrpc/errorResponse", ContractKind::Message, None),
    entry::<Notification>("jsonrpc/notification", ContractKind::Message, None),
    entry::<SessionEventNotification>("envelope/sessionEvent", ContractKind::Message, None),
    request::<HostHello>(HostHello::NAME),
    response::<HostHello>("core/welcome"),
    request::<HostPing>(HostPing::NAME),
    response::<HostPing>("host/ping/result"),
    request::<HostShutdown>(HostShutdown::NAME),
    response::<HostShutdown>("host/shutdown/result"),
    request::<SessionCreate>(SessionCreate::NAME),
    response::<SessionCreate>("session/create/result"),
    request::<SessionResume>(SessionResume::NAME),
    response::<SessionResume>("session/resume/result"),
    request::<SessionClose>(SessionClose::NAME),
    response::<SessionClose>("session/close/result"),
    request::<SessionAbort>(SessionAbort::NAME),
    response::<SessionAbort>("session/abort/result"),
    request::<SessionPrompt>(SessionPrompt::NAME),
    response::<SessionPrompt>("session/prompt/result"),
    request::<PolicyInputChunk>("policy/inputChunk"),
    response::<PolicyInputChunk>("policy/inputChunk/result"),
    notification::<PolicyPending>(),
    request::<PolicyCancel>("policy/cancel"),
    response::<PolicyCancel>("policy/cancel/result"),
    request::<PolicyRecover>("policy/recover"),
    response::<PolicyRecover>("policy/recover/result"),
    request::<PolicyTools>(PolicyTools::NAME),
    response::<PolicyTools>("policy/tools/result"),
    request::<ModelsList>(ModelsList::NAME),
    response::<ModelsList>("models/list/result"),
    request::<ModelsReload>(ModelsReload::NAME),
    response::<ModelsReload>("models/reload/result"),
    request::<SessionPreviewModelSwitch>(SessionPreviewModelSwitch::NAME),
    response::<SessionPreviewModelSwitch>("session/previewModelSwitch/result"),
    request::<SessionSetModel>(SessionSetModel::NAME),
    response::<SessionSetModel>("session/setModel/result"),
    request::<SessionSetEffort>(SessionSetEffort::NAME),
    response::<SessionSetEffort>("session/setEffort/result"),
    request::<ModelsCredential>(ModelsCredential::NAME),
    response::<ModelsCredential>("models/credential/result"),
    request::<ModelsCredentialStatus>(ModelsCredentialStatus::NAME),
    response::<ModelsCredentialStatus>("models/credentialStatus/result"),
    request::<SessionSetPermissionMode>("session/setPermissionMode"),
    response::<SessionSetPermissionMode>("session/setPermissionMode/result"),
    request::<SideChatAsk>(SideChatAsk::NAME),
    response::<SideChatAsk>("session/sideChatAsk/result"),
    request::<SideChatControl>(SideChatControl::NAME),
    response::<SideChatControl>("session/sideChatControl/result"),
    request::<SessionCommitMessage>(SessionCommitMessage::NAME),
    response::<SessionCommitMessage>("session/commitMessage/result"),
    request::<SessionCompact>(SessionCompact::NAME),
    response::<SessionCompact>("session/compact/result"),
    request::<SessionFork>(SessionFork::NAME),
    response::<SessionFork>("session/fork/result"),
    request::<SessionSteer>(SessionSteer::NAME),
    response::<SessionSteer>("session/steer/result"),
    request::<SessionFollowUp>(SessionFollowUp::NAME),
    response::<SessionFollowUp>("session/followUp/result"),
    request::<QueueEdit>(QueueEdit::NAME),
    response::<QueueEdit>("session/queue/edit/result"),
    request::<QueueDelete>(QueueDelete::NAME),
    response::<QueueDelete>("session/queue/delete/result"),
    request::<QueueReorder>(QueueReorder::NAME),
    response::<QueueReorder>("session/queue/reorder/result"),
    request::<SessionGetEntries>(SessionGetEntries::NAME),
    response::<SessionGetEntries>("session/getEntries/result"),
    request::<SessionHistory>(SessionHistory::NAME),
    response::<SessionHistory>("session/history/result"),
    request::<PolicyEvaluate>(PolicyEvaluate::NAME),
    response::<PolicyEvaluate>("policy/evaluate/result"),
    request::<PolicyReview>(PolicyReview::NAME),
    response::<PolicyReview>("policy/review/result"),
    request::<TrustGet>(TrustGet::NAME),
    response::<TrustGet>("trust/get/result"),
    request::<HooksRun>(HooksRun::NAME),
    response::<HooksRun>("hooks/run/result"),
    request::<HooksPrompt>(HooksPrompt::NAME),
    response::<HooksPrompt>("hooks/prompt/result"),
    request::<HooksMcpTool>(HooksMcpTool::NAME),
    response::<HooksMcpTool>("hooks/mcpTool/result"),
    request::<FsMemory>(FsMemory::NAME),
    response::<FsMemory>("fs/memory/result"),
    request::<MemoryStatus>(MemoryStatus::NAME),
    response::<MemoryStatus>("memory/status/result"),
    request::<MemoryApply>(MemoryApply::NAME),
    response::<MemoryApply>("memory/apply/result"),
    request::<FsStat>(FsStat::NAME),
    response::<FsStat>("fs/stat/result"),
    request::<FsRead>(FsRead::NAME),
    response::<FsRead>("fs/read/result"),
    request::<FsWrite>(FsWrite::NAME),
    response::<FsWrite>("fs/write/result"),
    request::<FsSpill>(FsSpill::NAME),
    response::<FsSpill>("fs/spill/result"),
    request::<FsPdf>(FsPdf::NAME),
    response::<FsPdf>("fs/pdf/result"),
    request::<FsMkdir>(FsMkdir::NAME),
    response::<FsMkdir>("fs/mkdir/result"),
    request::<FsList>(FsList::NAME),
    response::<FsList>("fs/list/result"),
    request::<FsGlob>(FsGlob::NAME),
    response::<FsGlob>("fs/glob/result"),
    request::<FsGrep>(FsGrep::NAME),
    response::<FsGrep>("fs/grep/result"),
    request::<ExecRun>(ExecRun::NAME),
    response::<ExecRun>("exec/run/result"),
    request::<ExecKill>(ExecKill::NAME),
    response::<ExecKill>("exec/kill/result"),
    request::<ExecShells>(ExecShells::NAME),
    response::<ExecShells>("exec/shells/result"),
    notification::<ExecOutput>(),
    request::<ExecMonitor>(ExecMonitor::NAME),
    response::<ExecMonitor>("exec/monitor/result"),
    request::<TaskListMethod>(TaskListMethod::NAME),
    response::<TaskListMethod>("exec/background/list/result"),
    request::<TaskRead>(TaskRead::NAME),
    response::<TaskRead>("exec/background/read/result"),
    request::<TaskKill>(TaskKill::NAME),
    response::<TaskKill>("exec/background/kill/result"),
    request::<SecretsGetAll>(SecretsGetAll::NAME),
    response::<SecretsGetAll>("secrets/getAll/result"),
    request::<SecretsGet>(SecretsGet::NAME),
    response::<SecretsGet>("secrets/get/result"),
    request::<SecretsSet>(SecretsSet::NAME),
    response::<SecretsSet>("secrets/set/result"),
    request::<SecretsDelete>(SecretsDelete::NAME),
    response::<SecretsDelete>("secrets/delete/result"),
    request::<SecretsLock>(SecretsLock::NAME),
    response::<SecretsLock>("secrets/lock/result"),
    request::<SecretsRenew>(SecretsRenew::NAME),
    response::<SecretsRenew>("secrets/renew/result"),
    request::<SecretsUnlock>(SecretsUnlock::NAME),
    response::<SecretsUnlock>("secrets/unlock/result"),
    notification::<SecretsChanged>(),
    notification::<TurnStarted>(),
    notification::<TurnCompleted>(),
    notification::<ItemStarted>(),
    notification::<ItemUpdated>(),
    notification::<ItemCompleted>(),
    notification::<ItemAgentMessageDelta>(),
    notification::<ItemReasoningDelta>(),
    notification::<TurnRetrying>(),
    notification::<TurnUsageReport>(),
    notification::<QueueChanged>(),
    notification::<HarnessEntry>(),
    notification::<HarnessTodo>(),
    notification::<HarnessPlan>(),
    request::<UiAsk>(UiAsk::NAME),
    response::<UiAsk>("ui/ask/result"),
    notification::<SessionUsage>(),
    request::<SessionGetContextUsage>(SessionGetContextUsage::NAME),
    response::<SessionGetContextUsage>("session/getContextUsage/result"),
    request::<SessionRemind>(SessionRemind::NAME),
    response::<SessionRemind>("session/remind/result"),
    request::<ContextSettingsGet>(ContextSettingsGet::NAME),
    response::<ContextSettingsGet>("context/settings/result"),
    request::<FsChanges>(FsChanges::NAME),
    response::<FsChanges>("fs/changes/result"),
    request::<FsForgetReads>(FsForgetReads::NAME),
    response::<FsForgetReads>("fs/forgetReads/result"),
    request::<WebFetch>(WebFetch::NAME),
    response::<WebFetch>("web/fetch/result"),
    request::<WebSearch>(WebSearch::NAME),
    response::<WebSearch>("web/search/result"),
    request::<WebSearchBackend>(WebSearchBackend::NAME),
    response::<WebSearchBackend>("web/searchBackend/result"),
    request::<ModelsLoginStart>(ModelsLoginStart::NAME),
    response::<ModelsLoginStart>("models/login/start/result"),
    request::<ModelsTest>(ModelsTest::NAME),
    response::<ModelsTest>("models/test/result"),
    request::<ModelsDiscover>(ModelsDiscover::NAME),
    response::<ModelsDiscover>("models/discover/result"),
    request::<ModelsLoginCancel>(ModelsLoginCancel::NAME),
    response::<ModelsLoginCancel>("models/login/cancel/result"),
    request::<ModelsLogout>(ModelsLogout::NAME),
    response::<ModelsLogout>("models/logout/result"),
    request::<UiLoginInteraction>(UiLoginInteraction::NAME),
    response::<UiLoginInteraction>("ui/loginInteraction/result"),
    request::<SessionRewind>(SessionRewind::NAME),
    response::<SessionRewind>("session/rewind/result"),
    request::<SessionSwitchBranch>(SessionSwitchBranch::NAME),
    response::<SessionSwitchBranch>("session/switchBranch/result"),
    notification::<SessionBranches>(),
    request::<AgentsListMethod>(AgentsListMethod::NAME),
    response::<AgentsListMethod>("agents/list/result"),
    request::<ResourcesListAgents>(ResourcesListAgents::NAME),
    response::<ResourcesListAgents>("resources/listAgents/result"),
    request::<SubagentStart>(SubagentStart::NAME),
    response::<SubagentStart>("subagent/start/result"),
    request::<SubagentFinish>(SubagentFinish::NAME),
    response::<SubagentFinish>("subagent/finish/result"),
    request::<SubagentStop>(SubagentStop::NAME),
    response::<SubagentStop>("subagent/stop/result"),
    notification::<SubagentStarted>(),
    notification::<SubagentProgress>(),
    notification::<SubagentCompleted>(),
    request::<McpServersMethod>(McpServersMethod::NAME),
    response::<McpServersMethod>("mcp/servers/result"),
    request::<McpStatusMethod>(McpStatusMethod::NAME),
    response::<McpStatusMethod>("mcp/status/result"),
    request::<McpReconnect>(McpReconnect::NAME),
    response::<McpReconnect>("mcp/reconnect/result"),
    request::<McpSetEnabled>(McpSetEnabled::NAME),
    response::<McpSetEnabled>("mcp/setEnabled/result"),
    request::<McpCancelElicitation>(McpCancelElicitation::NAME),
    response::<McpCancelElicitation>("mcp/cancelElicitation/result"),
    request::<McpElicit>(McpElicit::NAME),
    response::<McpElicit>("mcp/elicit/result"),
    request::<McpLogin>(McpLogin::NAME),
    response::<McpLogin>("mcp/login/result"),
    notification::<McpStatusChanged>(),
    request::<SkillsListMethod>(SkillsListMethod::NAME),
    response::<SkillsListMethod>("skills/list/result"),
    request::<SkillsInvoke>(SkillsInvoke::NAME),
    response::<SkillsInvoke>("skills/invoke/result"),
    request::<SkillsMatch>(SkillsMatch::NAME),
    response::<SkillsMatch>("skills/match/result"),
    request::<ResourcesListSkills>(ResourcesListSkills::NAME),
    response::<ResourcesListSkills>("resources/listSkills/result"),
    request::<ResourcesListCommands>(ResourcesListCommands::NAME),
    response::<ResourcesListCommands>("resources/listCommands/result"),
    request::<ResourcesReload>(ResourcesReload::NAME),
    response::<ResourcesReload>("resources/reload/result"),
    request::<PluginsExtensionsMethod>(PluginsExtensionsMethod::NAME),
    response::<PluginsExtensionsMethod>("plugins/extensions/result"),
];

/// Looks up a contract by name.
#[must_use]
pub fn contract(name: &str) -> Option<&'static Contract> {
    CONTRACTS.iter().find(|c| c.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_names_and_schema_names_are_unique() {
        let mut names: Vec<&str> = CONTRACTS.iter().map(Contract::name).collect();
        let mut schemas: Vec<String> = CONTRACTS
            .iter()
            .map(|c| c.schema_name().into_owned())
            .collect();
        names.sort_unstable();
        names.dedup();
        schemas.sort_unstable();
        schemas.dedup();
        assert_eq!(names.len(), CONTRACTS.len());
        assert_eq!(schemas.len(), CONTRACTS.len());
    }

    #[test]
    fn method_contracts_do_not_use_reserved_families() {
        for c in CONTRACTS
            .iter()
            .filter(|c| c.kind() != ContractKind::Message)
        {
            assert!(
                !["jsonrpc/", "envelope/", "framing/"]
                    .iter()
                    .any(|p| c.name().starts_with(p)),
                "{} uses a reserved family",
                c.name()
            );
        }
    }
}
