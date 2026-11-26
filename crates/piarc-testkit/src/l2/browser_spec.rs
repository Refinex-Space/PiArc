//! Scenario format of the built-in browser's fake desktop client (design addendum
//! `docs/architecture/addenda/browser.md` section 5.2): with a `browser` section the runner
//! attaches a client the way the app's main process does and answers each `run` Core sends on
//! `core/browser` with the next script of `runs`. The schema is in
//! `tests/scenarios/schema.json`; the client is `runner/browser.rs`.

use serde::Deserialize;
use serde_json::Value;

/// The fake client: one script per run, in the order Core starts them.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserSpec {
    /// The scripts of the runs, in order; a run beyond them fails the scenario.
    #[serde(default)]
    pub runs: Vec<RunScript>,
}

/// What the client does with one run.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunScript {
    /// A field subset of the `run` event (`toolCallId`, `timeoutMs`, `script`, …).
    #[serde(default)]
    pub run: Option<Value>,
    /// The steps, in order. Without an `answer` the client never answers the run.
    #[serde(default)]
    pub steps: Vec<ClientStep>,
}

/// One thing the client does for a run.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientStep {
    /// Asks Core whether a page of the run may reach a host (`browserSite`), as the request
    /// gate does, and checks the decision.
    Site(SiteStep),
    /// Asks Core to stage files for a page's file input (`browserFiles` `stage`).
    Stage(StageStep),
    /// Answers the run (`answerBrowserRun`).
    Answer(AnswerStep),
    /// Waits until Core cancels the run (`cancel` on `core/browser`).
    WaitCancel {},
}

/// A `browserSite` request and the decision it must get.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteStep {
    /// The full address.
    pub url: String,
    /// `host`, or `host:port` for a local address.
    pub host: String,
    /// A loopback or local development address.
    #[serde(default)]
    pub local: bool,
    /// A private address or a site with imported sign-ins.
    #[serde(default)]
    pub sensitive: bool,
    /// The run's other waiting hosts.
    #[serde(default)]
    pub pending: Vec<String>,
    /// The decision Core must answer.
    pub decision: SiteDecisionSpec,
}

/// A site decision: allowed or not, and for how long.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteDecisionSpec {
    pub allowed: bool,
    /// Checked when present.
    #[serde(default)]
    pub scope: Option<piarc_protocol::browser::BrowserSiteScope>,
}

/// A `browserFiles` stage request and its outcome.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageStep {
    /// The paths the page's file input gets (absolute, or relative to the session's working
    /// directory).
    pub paths: Vec<String>,
    /// Core stages one copy per path, each below the session's `browser/uploads/` with this
    /// content, in order.
    #[serde(default)]
    pub staged: Option<Vec<String>>,
    /// Core refuses with an error containing this text.
    #[serde(default)]
    pub refused: Option<String>,
}

/// The client's answer to a run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerStep {
    /// What the script printed (`repeat` times), then `output_end`.
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub repeat: Option<usize>,
    #[serde(default)]
    pub output_end: Option<String>,
    /// Screenshots the script attached.
    #[serde(default)]
    pub images: Vec<ImageSpec>,
    /// The error the script ended with.
    #[serde(default)]
    pub error: Option<ScriptErrorSpec>,
    /// Hosts the browser kept the page from reaching.
    #[serde(default)]
    pub blocked_hosts: Option<Vec<String>>,
    /// Answer this long after the step is reached.
    #[serde(default)]
    pub delay_ms: Option<u64>,
    /// Whether Core still waits for the answer; true when absent.
    #[serde(default)]
    pub accepted: Option<bool>,
}

impl AnswerStep {
    /// The answer as Core takes it (`BrowserRunAnswer`).
    #[must_use]
    pub fn answer(&self) -> piarc_protocol::browser::BrowserRunAnswer {
        use piarc_protocol::browser::{BrowserImage, BrowserRunAnswer, BrowserScriptError};
        let mut output = self.output.repeat(self.repeat.unwrap_or(1));
        output.push_str(self.output_end.as_deref().unwrap_or_default());
        BrowserRunAnswer {
            output,
            images: (!self.images.is_empty()).then(|| {
                self.images
                    .iter()
                    .map(|image| BrowserImage {
                        media_type: image.media_type.clone(),
                        data: image.data.clone(),
                        width: image.width,
                        height: image.height,
                        blob: None,
                    })
                    .collect()
            }),
            error: self.error.as_ref().map(|e| BrowserScriptError {
                name: e.name.clone(),
                message: e.message.clone(),
                code: e.code.clone(),
            }),
            blocked_hosts: self.blocked_hosts.clone(),
            visited_hosts: None,
            refused_methods: None,
        }
    }
}

/// One attached image.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageSpec {
    pub media_type: String,
    /// Base64 of the bytes.
    pub data: String,
    pub width: u64,
    pub height: u64,
}

/// The error a script ended with.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptErrorSpec {
    pub name: String,
    pub message: String,
    #[serde(default)]
    pub code: Option<String>,
}
