//! The L2 scenario file (architecture section 12.3): types, loading and checks.
//!
//! A file is checked in three passes, each reporting the file and the field:
//!
//! 1. the JSON Schema `tests/scenarios/schema.json` (embedded at build time, the single
//!    description of the format): missing fields, wrong types, unknown fields;
//! 2. deserialization into [`ScenarioSpec`];
//! 3. references the schema cannot express: the id equals the file name, sessions and
//!    providers exist, labels are defined before use, paths stay inside the workspace,
//!    mock scripts pass the mock's own checks.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use piarc_protocol::input::InputMention;
use serde::Deserialize;
use serde_json::Value;

use crate::scenario::{Scenario, Script, Step, ValidationConfig};

/// The format's JSON Schema, embedded so the loader and the documentation use one file.
pub const SCHEMA: &str = include_str!("../../../../tests/scenarios/schema.json");

/// A scenario file that failed to load: the file and every problem found, each naming the
/// field (a JSON pointer such as `/expect/events/0/method`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: invalid scenario:\n{}", file.display(), problems.iter().map(|p| format!("  - {p}")).collect::<Vec<_>>().join("\n"))]
pub struct FormatError {
    /// The scenario file.
    pub file: PathBuf,
    /// One line per problem, starting with the field.
    pub problems: Vec<String>,
}

/// A platform a scenario runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    /// macOS.
    Macos,
    /// Windows.
    Windows,
}

impl Platform {
    /// Every platform.
    pub const ALL: [Self; 2] = [Self::Macos, Self::Windows];

    /// The platform this binary was built for, if it is one of [`Self::ALL`].
    #[must_use]
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else {
            None
        }
    }

    /// The name used in scenario files.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
        }
    }
}

/// One scenario file.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioSpec {
    /// Equals the file name without extension.
    pub id: String,
    /// The behavior the scenario proves.
    pub description: String,
    /// Capability ids it covers.
    pub capabilities: Vec<String>,
    /// Platforms it runs on; both when absent.
    #[serde(default)]
    pub platforms: Option<Vec<Platform>>,
    /// Why a platform is left out.
    #[serde(default)]
    pub platform_reason: Option<String>,
    /// The workspace fixture.
    #[serde(default)]
    pub workspace: WorkspaceSpec,
    /// Mock endpoints by name.
    pub providers: BTreeMap<String, ProviderSpec>,
    /// A local web server for WebFetch (T29); see [`crate::l2::web`].
    #[serde(default)]
    pub web: Option<crate::l2::web::WebSpec>,
    /// A mock authorization server and the test OAuth provider (T29).
    #[serde(default)]
    pub oauth: Option<crate::l2::login_spec::OAuthSpec>,
    /// SDK cloud providers to configure with an isolated fake API key; never used for inference.
    #[serde(default)]
    pub cloud_providers: Vec<String>,
    /// Sessions by label; see [`ScenarioSpec::sessions`].
    #[serde(default, rename = "sessions")]
    pub declared_sessions: Option<BTreeMap<String, SessionSpec>>,
    /// What the runner does, in order.
    pub actions: Vec<Action>,
    /// Answers to approval requests, in order.
    #[serde(default)]
    pub approvals: Vec<Approval>,
    /// What must hold after the run.
    pub expect: Expect,
    /// Where `fixtures` entries are: `fixtures/` next to the scenario file (set by [`load`]).
    #[serde(skip)]
    pub fixture_dir: PathBuf,
}

impl ScenarioSpec {
    /// The file of fixture `name` (relative, forward slashes).
    #[must_use]
    pub fn fixture(&self, name: &str) -> PathBuf {
        name.split('/')
            .fold(self.fixture_dir.clone(), |path, part| path.join(part))
    }
}

/// The workspace fixture.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSpec {
    /// Relative path (forward slashes) to content.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// UTF-8 files relative to this scenario's isolated temporary root (including its home).
    #[serde(default)]
    pub run_files: BTreeMap<String, String>,
    /// Initialize the workspace as a Git repository before opening any sessions.
    #[serde(default)]
    pub git: bool,
    /// Relative path to a fixture file copied byte for byte (CRLF, byte order marks, legacy
    /// encodings, images, PDFs): its name below the scenarios' `fixtures/` directory.
    #[serde(default)]
    pub fixtures: BTreeMap<String, String>,
    /// Trust the workspace before opening it.
    #[serde(default)]
    pub trusted: bool,
}

/// A wire format of a mock endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wire {
    /// Anthropic Messages.
    Anthropic,
    /// OpenAI-compatible Chat Completions.
    Openai,
}

/// How a scenario provisions a mock through PiArc's provider settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointSetup {
    /// Custom endpoint with a fake vault key.
    Custom,
    /// Keyless local endpoint.
    Local,
}

/// One mock endpoint: its own mock provider, Pi provider and model.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSpec {
    /// Its wire format.
    pub wire: Wire,
    /// Use a settings operation instead of a pre-existing models.json definition.
    #[serde(default)]
    pub configure_as: Option<EndpointSetup>,
    /// Include thinking in the capabilities of an imported model fixture.
    #[serde(default)]
    pub reasoning: bool,
    /// Request validation; every rule on by default.
    #[serde(default)]
    pub validation: ValidationConfig,
    /// The endpoint's model takes images as input.
    #[serde(default)]
    pub vision: bool,
    /// The model's context window (T27); 200,000 when absent.
    #[serde(default)]
    pub context_window: Option<u64>,
    /// The model's largest output (T27); 4,096 when absent.
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// The model id (T31); `mock-model` when absent.
    #[serde(default)]
    pub model: Option<String>,
    /// One response per request.
    pub steps: Vec<Step>,
}

impl ProviderSpec {
    /// The endpoint's model id.
    #[must_use]
    pub fn model_id(&self) -> &str {
        self.model.as_deref().unwrap_or(super::runner::MOCK_MODEL)
    }

    /// The mock script of this endpoint.
    #[must_use]
    pub fn script(&self) -> Script {
        Script {
            validation: self.validation.clone(),
            steps: self.steps.clone(),
        }
    }
}

/// One session.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSpec {
    /// The endpoint its model talks to.
    pub provider: String,
    /// Explicit starting permission mode.
    #[serde(default)]
    pub mode: Option<piarc_protocol::policy::PermissionMode>,
    /// Create this session on its first input instead of at startup.
    #[serde(default)]
    pub deferred: bool,
    /// Working directory relative to the workspace.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Create the session without a model: the settings' defaults apply (T31).
    #[serde(default)]
    pub settings_model: bool,
}

/// A file the client attaches, read from the scenario fixtures and stored through Core.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentFixture {
    /// A path below the scenario's fixtures directory.
    pub fixture: String,
    /// The MIME type passed to Core.
    pub mime_type: String,
}

/// An input (prompt, steering message, follow-up).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputAction {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The text.
    pub text: String,
    /// The client-selected idempotency key.
    #[serde(default)]
    pub request_id: Option<String>,
    /// File references with UTF-16 offsets in the submitted text.
    #[serde(default)]
    pub mentions: Vec<InputMention>,
    /// Binary fixtures to store in this session before submitting the input.
    #[serde(default)]
    pub attachments: Vec<AttachmentFixture>,
    /// Label for the turn it started.
    #[serde(default)]
    pub turn: Option<String>,
    /// Label for the queue item it became.
    #[serde(default)]
    pub item: Option<String>,
    /// Core must refuse the input with an error containing this text (T25).
    #[serde(default)]
    pub rejected: Option<String>,
}

/// Client edits to session metadata.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrefsAction {
    /// Optional target label for a multi-session scenario.
    pub session: Option<String>,
    /// New session title, if requested.
    pub title: Option<String>,
    /// New pinned state, if requested.
    pub pinned: Option<bool>,
    /// New archived state, if requested.
    pub archived: Option<bool>,
}

/// One thing the runner does.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    /// `session_op(Prompt)`.
    Prompt(InputAction),
    /// `session_op(Steer)`.
    Steer(InputAction),
    /// `session_op(FollowUp)`.
    FollowUp(InputAction),
    /// Runs the built-in manual compaction command.
    Compact {
        /// The session; the only one when absent.
        #[serde(default)]
        session: Option<String>,
        /// What the summary should focus on (`/compact <focus>`, T27).
        #[serde(default)]
        instructions: Option<String>,
    },
    /// Edits a queue item.
    QueueEdit {
        /// The session.
        #[serde(default)]
        session: Option<String>,
        /// The item's label.
        item: String,
        /// Its new text.
        text: String,
    },
    /// Deletes a queue item.
    QueueDelete {
        /// The session.
        #[serde(default)]
        session: Option<String>,
        /// The item's label.
        item: String,
    },
    /// Reorders the queue.
    QueueReorder {
        /// The session.
        #[serde(default)]
        session: Option<String>,
        /// Every item's label in the new order.
        items: Vec<String>,
    },
    /// Interrupts the running turn.
    Abort {
        /// The session.
        #[serde(default)]
        session: Option<String>,
    },
    /// Change mode through the public session API.
    SetMode {
        /// Target session.
        #[serde(default)]
        session: Option<String>,
        /// New mode.
        mode: piarc_protocol::policy::PermissionMode,
    },
    /// Previews and confirms a model switch, checking the preview against a field subset.
    SetModel {
        /// Target session.
        #[serde(default)]
        session: Option<String>,
        /// Endpoint of the new model.
        provider: String,
        /// Fields required in the preview.
        preview: Value,
    },
    /// Sets the current session's thinking effort.
    SetEffort {
        /// Target session.
        #[serde(default)]
        session: Option<String>,
        /// The chosen effort.
        effort: piarc_protocol::models::EffortLevel,
    },
    /// Changes the same metadata as the sidebar actions.
    SetPrefs(PrefsAction),
    /// Deletes the target session through Core.
    DeleteSession { session: Option<String> },
    /// Checks persisted sidebar metadata, or absence when fields is null.
    CheckStoredSession {
        session: Option<String>,
        fields: Value,
    },
    /// Checks Core's view of the current workspace trust inventory.
    CheckTrust { fields: Value },
    /// Waits for events.
    Wait(WaitAction),
    /// Writes a workspace file (a signal for a waiting command).
    WriteFile {
        /// Relative path.
        path: String,
        /// Content.
        content: String,
    },
    /// Shuts Core down and starts it again on the same data directory, then reopens the
    /// workspace; sessions stay closed until `resume`.
    RestartCore {},
    /// Reopens a closed session from the index and its file.
    Resume {
        /// The session.
        #[serde(default)]
        session: Option<String>,
    },
    /// Forks a session at an agent message (T26).
    Fork(super::harness_spec::ForkAction),
    /// Checks a session's plan and task list (T26).
    CheckHarness(super::harness_spec::CheckHarnessAction),
    /// Checks a session's context usage (T27).
    CheckUsage(super::context_spec::CheckUsageAction),
    /// Rewinds to before a labeled turn (T28).
    Rewind(super::checkpoint_spec::RewindSpec),
    /// Undoes the latest rewind (T28).
    UndoRewind(super::checkpoint_spec::UndoRewindSpec),
    /// Checks the Changes view (T28).
    CheckChanges(super::checkpoint_spec::CheckChangesSpec),
    /// Discards a change in the Changes panel (T28).
    Discard(super::checkpoint_spec::DiscardSpec),
    /// Switches to another branch (T28).
    SwitchBranch(super::checkpoint_spec::SwitchBranchSpec),
    /// Checks the current branch's conversation (T28).
    CheckBranch(super::checkpoint_spec::CheckBranchSpec),
    /// Checks workspace files mid-scenario (T28).
    CheckFiles(super::checkpoint_spec::CheckFilesSpec),
    /// Signs in to the test OAuth provider (T29).
    SignIn(crate::l2::login_spec::SignInAction),
    /// Signs out of the test OAuth provider (T29).
    SignOut {},
}

impl Action {
    /// The action's name as written in the file.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Prompt(_) => "prompt",
            Self::Steer(_) => "steer",
            Self::FollowUp(_) => "follow_up",
            Self::Compact { .. } => "compact",
            Self::QueueEdit { .. } => "queue_edit",
            Self::QueueDelete { .. } => "queue_delete",
            Self::QueueReorder { .. } => "queue_reorder",
            Self::Abort { .. } => "abort",
            Self::SetMode { .. } => "set_mode",
            Self::SetModel { .. } => "set_model",
            Self::SetEffort { .. } => "set_effort",
            Self::SetPrefs(_) => "set_prefs",
            Self::DeleteSession { .. } => "delete_session",
            Self::CheckStoredSession { .. } => "check_stored_session",
            Self::CheckTrust { .. } => "check_trust",
            Self::Wait(_) => "wait",
            Self::WriteFile { .. } => "write_file",
            Self::RestartCore {} => "restart_core",
            Self::Resume { .. } => "resume",
            Self::Fork(_) => "fork",
            Self::CheckHarness(_) => "check_harness",
            Self::CheckUsage(_) => "check_usage",
            Self::Rewind(_) => "rewind",
            Self::UndoRewind(_) => "undo_rewind",
            Self::CheckChanges(_) => "check_changes",
            Self::Discard(_) => "discard",
            Self::SwitchBranch(_) => "switch_branch",
            Self::CheckBranch(_) => "check_branch",
            Self::CheckFiles(_) => "check_files",
            Self::SignIn(_) => "sign_in",
            Self::SignOut {} => "sign_out",
        }
    }

    fn session(&self) -> Option<&Option<String>> {
        match self {
            Self::Prompt(input) | Self::Steer(input) | Self::FollowUp(input) => {
                Some(&input.session)
            }
            Self::QueueEdit { session, .. }
            | Self::QueueDelete { session, .. }
            | Self::QueueReorder { session, .. }
            | Self::Compact { session, .. }
            | Self::SetModel { session, .. }
            | Self::SetEffort { session, .. }
            | Self::SetMode { session, .. }
            | Self::Abort { session }
            | Self::SetPrefs(PrefsAction { session, .. })
            | Self::CheckStoredSession { session, .. }
            | Self::DeleteSession { session }
            | Self::Resume { session } => Some(session),
            Self::Wait(wait) => Some(&wait.session),
            Self::Fork(fork) => Some(&fork.session),
            Self::CheckHarness(check) => Some(&check.session),
            Self::CheckUsage(check) => Some(&check.session),
            Self::Rewind(spec) => Some(&spec.session),
            Self::UndoRewind(spec) => Some(&spec.session),
            Self::CheckChanges(spec) => Some(&spec.session),
            Self::Discard(spec) => Some(&spec.session),
            Self::SwitchBranch(spec) => Some(&spec.session),
            Self::CheckBranch(spec) => Some(&spec.session),
            Self::CheckTrust { .. }
            | Self::WriteFile { .. }
            | Self::RestartCore {}
            | Self::CheckFiles(_)
            | Self::SignIn(_)
            | Self::SignOut {} => None,
        }
    }
}

/// Waits until `count` events match.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitAction {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The notification method.
    pub method: String,
    /// Field subset of `params`.
    #[serde(default)]
    pub params: Option<Value>,
    /// `params.turnId` is the turn with this label.
    #[serde(default)]
    pub turn: Option<String>,
    /// How many matching events; 1 when absent.
    #[serde(default)]
    pub count: Option<usize>,
}

impl WaitAction {
    /// What it waits for.
    #[must_use]
    pub fn matcher(&self) -> EventMatcher {
        EventMatcher {
            session: self.session.clone(),
            method: self.method.clone(),
            params: self.params.clone(),
            turn: self.turn.clone(),
        }
    }
}

/// A field subset of one session notification.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventMatcher {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The notification method.
    pub method: String,
    /// Field subset of `params`.
    #[serde(default)]
    pub params: Option<Value>,
    /// `params.turnId` is the turn with this label.
    #[serde(default)]
    pub turn: Option<String>,
}

/// An expected event, or several in any order.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum EventExpect {
    /// One event.
    One(EventMatcher),
    /// Events in any order, all after the previous item and before the next.
    AnyOrder {
        /// The events; all of the same session.
        any_order: Vec<EventMatcher>,
    },
}

impl EventExpect {
    /// The matchers of this item.
    #[must_use]
    pub fn matchers(&self) -> &[EventMatcher] {
        match self {
            Self::One(matcher) => std::slice::from_ref(matcher),
            Self::AnyOrder { any_order } => any_order,
        }
    }
}

/// An approval answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    /// The decision.
    pub decision: ApprovalDecision,
    /// The tool the request must be for.
    #[serde(default)]
    pub tool: Option<String>,
    /// The tool call the request must be for; L3 runs pick the approval by it (T30).
    #[serde(default)]
    pub call: Option<String>,
    /// The presentation kind the approval card must have.
    #[serde(default)]
    pub kind: Option<piarc_protocol::policy::ApprovalKind>,
    /// User feedback returned with a refusal.
    #[serde(default)]
    pub feedback: Option<String>,
    /// The mode an approved plan continues in (T26).
    #[serde(default)]
    pub mode: Option<piarc_protocol::policy::PermissionMode>,
    /// Inline comments sent with a declined plan (T26).
    #[serde(default)]
    pub comments: Vec<super::harness_spec::PlanCommentSpec>,
    /// One answer per question of a question card (T26).
    #[serde(default)]
    pub answers: Vec<super::harness_spec::QuestionAnswerSpec>,
    /// The subagent the card must come from (T31).
    #[serde(default)]
    pub subagent: Option<SubagentOriginSpec>,
}

/// Where an approval card must come from (T31).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubagentOriginSpec {
    /// The subagent type.
    #[serde(rename = "type")]
    pub kind: String,
    /// The task description the model gave.
    #[serde(default)]
    pub description: Option<String>,
}

/// Approval decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Allow the same invocation for this session.
    Session,
    /// Persist a confirmed permission.
    Always,
    /// Allow.
    Allow,
    /// Deny.
    Deny,
    /// Leave the card unanswered: a question form whose timeout answers it (T26).
    Wait,
}

/// What must hold after the run.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// Configured provider ids and the public settings fields expected for each.
    #[serde(default)]
    pub configured_providers: BTreeMap<String, Value>,
    /// Ordered subsequence of events per session.
    #[serde(default)]
    pub events: Vec<EventExpect>,
    /// Workspace files: content, or `None` for absent.
    #[serde(default)]
    pub files: BTreeMap<String, Option<String>>,
    /// Workspace files whose bytes equal a fixture file (`fixtures/` name).
    #[serde(default)]
    pub fixtures: BTreeMap<String, String>,
    /// Request assertions.
    #[serde(default)]
    pub requests: Vec<RequestExpect>,
    /// Exact request counts per endpoint.
    #[serde(default)]
    pub request_counts: BTreeMap<String, usize>,
    /// Tool call ids in the batches their Core requests arrive in.
    #[serde(default)]
    pub tool_batches: Vec<Vec<String>>,
    /// Core requests per tool call.
    #[serde(default)]
    pub core_io: Vec<CoreIoExpect>,
    /// A subset of Core's configuration diagnostics of the workspace after the run, with
    /// `files` keyed by layer id (T24).
    #[serde(default)]
    pub config_diagnostics: Option<Value>,
    /// Workspace files of JSON lines (hook fixtures' records): each line a field subset (T25).
    #[serde(default)]
    pub json_lines: BTreeMap<String, Vec<Value>>,
}

/// One request assertion; every field present must hold.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestExpect {
    /// The endpoint; the only one when absent.
    #[serde(default)]
    pub provider: Option<String>,
    /// Request number of the endpoint, from 0.
    pub index: usize,
    /// Message roles in order.
    #[serde(default)]
    pub roles: Option<Vec<String>>,
    /// Exactly these tool names, any order.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// These tool names among others.
    #[serde(default)]
    pub tools_include: Option<Vec<String>>,
    /// None of these tool names.
    #[serde(default)]
    pub tools_exclude: Option<Vec<String>>,
    /// The text of every user message, in order.
    #[serde(default)]
    pub user_texts: Option<Vec<String>>,
    /// The text of the last user message.
    #[serde(default)]
    pub last_user_text: Option<String>,
    /// Substrings of the raw body.
    #[serde(default)]
    pub contains: Option<Vec<String>>,
    /// Strings the raw body must not contain.
    #[serde(default)]
    pub not_contains: Option<Vec<String>>,
    /// Number of occurrences of each literal substring in the raw request body.
    #[serde(default)]
    pub occurrences: BTreeMap<String, usize>,
    /// One user message must contain all these literal strings.
    #[serde(default)]
    pub user_message_contains: Option<Vec<String>>,
    /// Compare the complete system content with an earlier request on the same endpoint.
    #[serde(default)]
    pub same_system_as: Option<usize>,
    /// Compare the tool definitions byte for byte with an earlier request (T26).
    #[serde(default)]
    pub same_tools_as: Option<usize>,
    /// Every tool result, in order.
    #[serde(default)]
    pub tool_results: Option<Vec<ToolResultExpect>>,
    /// Field subset of the body.
    #[serde(default)]
    pub body: Option<Value>,
}

/// One expected tool result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultExpect {
    /// The tool call it answers.
    pub id: String,
    /// Whether it is an error (Anthropic only).
    #[serde(default)]
    pub is_error: Option<bool>,
    /// A substring of its text.
    #[serde(default)]
    pub contains: Option<String>,
}

/// Core answered a request with `method` for tool call `call`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreIoExpect {
    /// The tool call id.
    pub call: String,
    /// The AHP method, such as `fs/read`.
    pub method: String,
}

/// The label of the session a scenario without `sessions` gets.
pub const DEFAULT_SESSION: &str = "main";

impl ScenarioSpec {
    /// Sessions by label: the declared ones, or `main` on the only provider.
    #[must_use]
    pub fn sessions(&self) -> BTreeMap<String, SessionSpec> {
        if let Some(sessions) = &self.declared_sessions {
            return sessions.clone();
        }
        let provider = self.providers.keys().next().cloned().unwrap_or_default();
        BTreeMap::from([(
            DEFAULT_SESSION.to_owned(),
            SessionSpec {
                provider,
                mode: None,
                deferred: false,
                cwd: None,
                settings_model: false,
            },
        )])
    }

    /// The platforms the scenario runs on.
    #[must_use]
    pub fn platforms(&self) -> Vec<Platform> {
        self.platforms
            .clone()
            .unwrap_or_else(|| Platform::ALL.to_vec())
    }

    /// Resolves an optional session reference: the named one, or the only one.
    ///
    /// # Errors
    ///
    /// A description when the name is unknown or there are several sessions to choose from.
    pub fn session_label(&self, session: Option<&str>) -> Result<String, String> {
        let sessions = self.sessions();
        match session {
            Some(name) if sessions.contains_key(name) => Ok(name.to_owned()),
            Some(name) => Err(format!("no session `{name}`")),
            None if sessions.len() == 1 => Ok(sessions.keys().next().cloned().unwrap_or_default()),
            None => Err("several sessions are declared; name one with `session`".to_owned()),
        }
    }

    /// Resolves an optional endpoint reference.
    ///
    /// # Errors
    ///
    /// As [`Self::session_label`].
    pub fn provider_label(&self, provider: Option<&str>) -> Result<String, String> {
        match provider {
            Some(name) if self.providers.contains_key(name) => Ok(name.to_owned()),
            Some(name) => Err(format!("no provider `{name}`")),
            None if self.providers.len() == 1 => {
                Ok(self.providers.keys().next().cloned().unwrap_or_default())
            }
            None => Err("several providers are declared; name one with `provider`".to_owned()),
        }
    }

    /// The mock scenario id of endpoint `provider`.
    #[must_use]
    pub fn mock_scenario_id(&self, provider: &str) -> String {
        if self
            .providers
            .get(provider)
            .is_some_and(|p| p.configure_as.is_some())
        {
            // A managed endpoint uses the first-message marker, which survives a provider switch.
            return self.id.clone();
        }
        format!("{}.{provider}", self.id)
    }
}

fn schema_validator() -> &'static Result<jsonschema::Validator, String> {
    static VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(SCHEMA).map_err(|e| format!("schema.json is not JSON: {e}"))?;
        jsonschema::validator_for(&schema).map_err(|e| format!("schema.json is invalid: {e}"))
    })
}

/// Loads and checks one scenario file.
///
/// # Errors
///
/// [`FormatError`] with every problem found and the field it concerns.
pub fn load(file: &Path) -> Result<ScenarioSpec, FormatError> {
    let fail = |problems: Vec<String>| FormatError {
        file: file.to_path_buf(),
        problems,
    };
    let text =
        std::fs::read_to_string(file).map_err(|e| fail(vec![format!("cannot read: {e}")]))?;
    let value: Value =
        serde_saphyr::from_str(&text).map_err(|e| fail(vec![format!("not valid YAML: {e}")]))?;
    let validator = schema_validator()
        .as_ref()
        .map_err(|e| fail(vec![e.clone()]))?;
    let mut problems: Vec<String> = validator
        .iter_errors(&value)
        .map(|error| {
            let field = error.instance_path().to_string();
            format!("{}: {error}", if field.is_empty() { "/" } else { &field })
        })
        .collect();
    if !problems.is_empty() {
        problems.sort();
        problems.dedup();
        return Err(fail(problems));
    }
    let mut spec: ScenarioSpec =
        serde_json::from_value(value).map_err(|e| fail(vec![format!("/: {e}")]))?;
    spec.fixture_dir = file
        .parent()
        .map_or_else(|| PathBuf::from("fixtures"), |dir| dir.join("fixtures"));
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let problems = check(&spec, stem);
    if problems.is_empty() {
        Ok(spec)
    } else {
        Err(fail(problems))
    }
}

/// The scenario files of a directory (`*.yaml`, `*.yml`, sorted), or the file itself.
///
/// # Errors
///
/// A description when the directory cannot be read.
pub fn scenario_files(path: &Path) -> Result<Vec<PathBuf>, String> {
    if !path.is_dir() {
        return Ok(vec![path.to_path_buf()]);
    }
    let entries =
        std::fs::read_dir(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut files = Vec::new();
    for entry in entries {
        let file = entry
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?
            .path();
        let yaml = file
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e == "yaml" || e == "yml");
        if file.is_file() && yaml {
            files.push(file);
        }
    }
    files.sort();
    Ok(files)
}

mod refs;
use refs::check;
