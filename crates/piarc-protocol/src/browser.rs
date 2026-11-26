//! The built-in browser's agent tool (ADR-0089, design addendum
//! `docs/architecture/addenda/browser.md` B2), needing the handshake capability `browser`.
//!
//! - `browser/run` (Agent Host → Core): run the script of an allowed `Browser` call in the
//!   session's browser. Core checks that the call was approved for this script (`origin`),
//!   hands the run to the desktop client and answers with what the script printed, the images
//!   it attached and the hosts the browser kept the page from reaching.
//! - Core API (`core/browser`): [`BrowserClientEvent`] tells the desktop client to start or
//!   cancel a run; the client answers a run with [`BrowserRunAnswer`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::request;
use crate::session::SessionId;
use crate::tool_call::ToolOrigin;

/// Parameters of `browser/run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRunParams {
    /// The session of the call.
    pub session_id: SessionId,
    /// The approved `Browser` call; its input's `script` must equal `script`.
    pub origin: ToolOrigin,
    /// The JavaScript to run with the browser SDK's helpers in scope.
    pub script: String,
    /// How long the script may run, in milliseconds (default 120,000, at most 600,000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// An image the script attached (`page.screenshot()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImage {
    /// `image/png` or `image/jpeg`.
    pub media_type: String,
    /// Base64 of the image bytes.
    pub data: String,
    /// Width in pixels.
    pub width: u64,
    /// Height in pixels.
    pub height: u64,
    /// SHA-256 of the image bytes once Core kept them in the session's blobs (ADR-0093), so
    /// the transcript can show what the model saw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// The error the script ended with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScriptError {
    /// The error's name (`TypeError`, `SyntaxError`, `EgoError`).
    pub name: String,
    /// Its message.
    pub message: String,
    /// The SDK's stable code (`EGO_TASK_SPACE_USER_IN_CONTROL`, `PIARC_SITE_REFUSED`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Result of `browser/run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRunResult {
    /// What the script printed, cut to the inline budget.
    pub output: String,
    /// The output was longer than the budget; the whole text is in `spill`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// The file with the whole output (home-relative paths start with `~`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spill: Option<String>,
    /// Images attached by the script, in order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<BrowserImage>>,
    /// The error the script ended with, when it did not finish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserScriptError>,
    /// Hosts the page tried to reach that the agent may not (the user can allow them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_hosts: Option<Vec<String>>,
}

request!(
    /// Method marker for `browser/run` (Agent Host → Core).
    BrowserRun, "browser/run", BrowserRunParams, BrowserRunResult
);

/// What Core tells the desktop client on `core/browser` (Core API).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserClientEvent {
    /// Run a script in the session's browser and answer with `answerBrowserRun`.
    #[serde(rename_all = "camelCase")]
    Run {
        /// The run's id, to answer with.
        run_id: String,
        /// The session of the call (a subagent's own id for a subagent).
        session_id: SessionId,
        /// The main session: its Spaces show the run (a subagent's runs show under it).
        main_session_id: SessionId,
        /// The subagent's type when a subagent made the call.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_type: Option<String>,
        /// The workspace (main checkout path); it picks the browser partition.
        workspace: String,
        /// The `Browser` call.
        tool_call_id: String,
        /// The script.
        script: String,
        /// How long it may run, in milliseconds.
        timeout_ms: u64,
    },
    /// Stop a run (the turn was interrupted, the session closed or the run timed out).
    #[serde(rename_all = "camelCase")]
    Cancel {
        /// The run's id.
        run_id: String,
    },
    /// The TCP ports a session's background tasks, terminals and development servers listen
    /// on, and the ports its launch configurations declare (ADR-0092 rule 5): the agent's
    /// pages may reach them (B2.6.2) and the start page lists them (B4.4). A complete
    /// snapshot, sent when it changes.
    #[serde(rename_all = "camelCase")]
    Ports {
        /// The main session.
        session_id: SessionId,
        /// Its workspace (main checkout path).
        workspace: String,
        /// Listening ports, by port.
        ports: Vec<crate::dev_server::ListeningPort>,
        /// Ports the project's launch configurations declare.
        #[schemars(with = "Vec<u64>")]
        declared: Vec<u16>,
    },
    /// The development servers a session started and where they stand (ADR-0092). A
    /// complete snapshot, sent when it changes.
    #[serde(rename_all = "camelCase")]
    Servers {
        /// The main session.
        session_id: SessionId,
        /// Its workspace (main checkout path).
        workspace: String,
        /// The servers, in start order.
        servers: Vec<crate::dev_server::DevServerState>,
    },
}

/// How the desktop client answers a run (Core API).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRunAnswer {
    /// What the script printed, whole.
    pub output: String,
    /// Images the script attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<BrowserImage>>,
    /// The error the script ended with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BrowserScriptError>,
    /// Hosts the browser kept the page from reaching during the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_hosts: Option<Vec<String>>,
    /// Hosts the run's pages reached (for the audit row only, B2.7.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visited_hosts: Option<Vec<String>>,
    /// DevTools methods the CDP proxy refused during the run (for the audit row only, B2.6.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_methods: Option<Vec<String>>,
}

/// A screenshot of a run as the transcript shows it (ADR-0093): a session blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserItemImage {
    /// SHA-256 of the image, lowercase hex: its name in the session's blobs.
    pub blob: String,
    /// `image/png` or `image/jpeg`.
    pub media_type: String,
    /// Width in pixels.
    pub width: u64,
    /// Height in pixels.
    pub height: u64,
}

/// A site card's subject (ADR-0089, design addendum B2.6.3): the address a page the agent
/// drives asks for, and the other hosts its run is waiting on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteCard {
    /// The full address the page asks for.
    pub url: String,
    /// Other hosts the same run was kept from reaching, which the answer covers too.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
}

/// What the desktop client asks Core about one host an agent's page wants to reach (Core API,
/// `browserSite`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteRequest {
    /// The session of the running `Browser` call (a subagent's own id for a subagent).
    pub session_id: SessionId,
    /// The running `Browser` call; the card goes away with it.
    pub tool_call_id: String,
    /// The full address.
    pub url: String,
    /// The host the answer covers: `host` for a site, `host:port` for a local address.
    pub host: String,
    /// A loopback or local development address.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local: bool,
    /// A private network address or a site with imported sign-ins: every mode asks and the
    /// answer is never saved as a rule.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
    /// Other hosts the run was kept from reaching, shown on the card and covered by its answer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending: Vec<String>,
}

/// How long an allowing answer holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BrowserSiteScope {
    /// For the rest of this run.
    Run,
    /// For the rest of the session.
    Session,
}

/// Core's answer to a [`BrowserSiteRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteDecision {
    /// Whether the page may reach the host (and the card's other hosts).
    pub allowed: bool,
    /// How long an allowing answer holds; absent when refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<BrowserSiteScope>,
}

/// A file request of the agent's browser (Core API, `browserFiles`, design addendum B2.6.6):
/// stage files for a page's file input, or save a finished download.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum BrowserFilesRequest {
    /// Copy `paths` (absolute, or relative to the session's working directory) for an upload.
    #[serde(rename_all = "camelCase")]
    Stage {
        /// The session of the running `Browser` call.
        session_id: SessionId,
        /// The running `Browser` call.
        tool_call_id: String,
        /// 1 to 20 files.
        paths: Vec<String>,
    },
    /// Save the finished download `source` (in the session's downloads) to `path`.
    #[serde(rename_all = "camelCase")]
    Save {
        /// The session of the running `Browser` call.
        session_id: SessionId,
        /// The running `Browser` call.
        tool_call_id: String,
        /// The download's file.
        source: String,
        /// Where to save it (absolute, or relative to the working directory); must not exist.
        path: String,
    },
}

/// Core's answer to a [`BrowserFilesRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFilesResult {
    /// The staged copies, in order (`stage`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub staged: Vec<String>,
    /// Where the download was saved (`save`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<String>,
}

/// The browser of a main session as the agent should know it before its next request (Core
/// API, `browserState`, design addendum B2.7.3): the desktop client sends it when the user
/// changed something between the agent's calls; Core keeps the newest as one `browserState`
/// reminder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateUpdate {
    /// The main session.
    pub session_id: SessionId,
    /// What the reminder says.
    #[serde(flatten)]
    pub summary: BrowserStateSummary,
}

/// The text of a `browserState` reminder (JSON): the session's task spaces and how many tabs
/// the user has of their own. Titles come from pages and are data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateSummary {
    /// At most 4.
    pub spaces: Vec<BrowserStateSpace>,
    /// Tabs of the user's own Space (only counted).
    pub user_tabs: u64,
}

/// One task space in a [`BrowserStateSummary`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateSpace {
    /// The task space's number (`taskSpace(id)`).
    pub id: u64,
    /// Its name, at most 64 characters.
    pub name: String,
    /// Who controls it now.
    pub controlled_by: BrowserStateController,
    /// Its tabs while the agent controls it (at most 20, titles cut to 80 characters); empty
    /// while the user does.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tabs: Vec<BrowserStateTab>,
    /// How many tabs it has.
    pub tab_count: u64,
}

/// Who controls a task space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BrowserStateController {
    /// The agent (ego's `agent`).
    Agent,
    /// The user took it over or the agent handed it to them (`agentDelegatedToUser`, `user`).
    User,
}

/// One tab of a [`BrowserStateSpace`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateTab {
    pub title: String,
    pub url: String,
}
