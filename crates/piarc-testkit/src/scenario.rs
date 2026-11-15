//! Scenario scripts: the data that drives the mock provider.
//!
//! A scenario is an `id` plus a [`Script`]. The N-th request that selects a scenario
//! instance is answered by step N of its script. Scripts are plain data loaded from JSON
//! or YAML; the field names below are the stable file format documented in the crate
//! documentation and in `docs/engineering/testing.md`. Unknown fields are rejected so a
//! typo in a scenario fails loudly instead of being ignored.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::fragment;
use crate::rules::Rule;

/// Number of argument fragments used when a tool call sets neither `fragments` nor
/// `split_at`.
pub const DEFAULT_ARGUMENT_FRAGMENTS: usize = 3;

/// Number of deltas a step's text is split into.
pub const TEXT_FRAGMENTS: usize = 3;

/// A named script.
#[derive(Debug, Clone, PartialEq)]
pub struct Scenario {
    /// Scenario id: ASCII letters, digits, `.`, `_` and `-`.
    pub id: String,
    /// The responses and validation settings.
    pub script: Script,
}

/// The responses of a scenario and the validation settings applied to its requests.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Script {
    /// Validation settings; every rule is on by default.
    #[serde(default)]
    pub validation: ValidationConfig,
    /// One entry per request, in order.
    pub steps: Vec<Step>,
}

/// One scripted response.
///
/// A step is either a response (`text`, `tool_calls` or both, optionally cut short with
/// `disconnect_after_events`) or an injected `error`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    /// Assistant text, streamed before any tool call.
    #[serde(default)]
    pub text: Option<String>,
    /// Tool calls, streamed in order after the text.
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// Token usage reported for this response.
    #[serde(default)]
    pub usage: Usage,
    /// Stop reason; defaults to `tool_use` when the step has tool calls, else `end_turn`.
    #[serde(default)]
    pub stop_reason: Option<StopReason>,
    /// Send only this many wire events of the response, then close the connection
    /// without finishing the stream.
    #[serde(default)]
    pub disconnect_after_events: Option<usize>,
    /// Answer with an HTTP error instead of a response.
    #[serde(default)]
    pub error: Option<InjectedError>,
}

/// A scripted tool call.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    /// Tool call id; generated from the step and call position when absent.
    #[serde(default)]
    pub id: Option<String>,
    /// Tool name.
    pub name: String,
    /// Arguments; must be a JSON object. Streamed as its compact serialization.
    pub input: Value,
    /// Split the serialized arguments into this many fragments of near-equal length.
    #[serde(default)]
    pub fragments: Option<usize>,
    /// Split the serialized arguments at these character offsets instead (strictly
    /// increasing, each inside the string). Use it to cut inside a string value or an
    /// escape sequence.
    #[serde(default)]
    pub split_at: Option<Vec<usize>>,
}

/// Token usage of one response. Every field defaults to 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    /// Uncached input tokens.
    #[serde(default)]
    pub input_tokens: u64,
    /// Output tokens.
    #[serde(default)]
    pub output_tokens: u64,
    /// Input tokens read from the prompt cache.
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Input tokens written to the prompt cache.
    #[serde(default)]
    pub cache_write_tokens: u64,
}

/// Why the scripted response stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// Natural end (`end_turn` / `stop`).
    EndTurn,
    /// The response ends with tool calls (`tool_use` / `tool_calls`).
    ToolUse,
    /// The output was truncated (`max_tokens` / `length`).
    MaxTokens,
}

/// An injected HTTP error.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InjectedError {
    /// Which error to return.
    pub kind: InjectedErrorKind,
    /// `retry-after` header in seconds; only for `rate_limit`, default 1.
    #[serde(default)]
    pub retry_after_secs: Option<u64>,
    /// Error message; a fixed default per kind when absent.
    #[serde(default)]
    pub message: Option<String>,
}

/// The injectable HTTP errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectedErrorKind {
    /// 429 with a `retry-after` header.
    RateLimit,
    /// 529 overloaded.
    Overloaded,
    /// 500 internal server error.
    ServerError,
    /// 503 service unavailable.
    Unavailable,
}

impl InjectedErrorKind {
    /// The HTTP status code of the error.
    #[must_use]
    pub fn status(self) -> u16 {
        match self {
            Self::RateLimit => 429,
            Self::Overloaded => 529,
            Self::ServerError => 500,
            Self::Unavailable => 503,
        }
    }
}

/// Request validation settings of a scenario.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidationConfig {
    /// Rule switches; every rule is on unless set to `false`.
    #[serde(default)]
    pub rules: RuleSwitches,
    /// Text that must appear in the system prompt (for example a section heading or a
    /// marker), checked by the `system_sections` rule.
    #[serde(default)]
    pub required_system_sections: Vec<String>,
    /// Where Anthropic cache breakpoints may sit, checked by `cache_breakpoint_position`.
    #[serde(default)]
    pub cache_breakpoints: CachePlacement,
}

/// On/off switches of the six validation rules, all `true` by default.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "one switch per validation rule, by design"
)]
pub struct RuleSwitches {
    /// `tool_pairing`.
    #[serde(default = "enabled")]
    pub tool_pairing: bool,
    /// `role_order`.
    #[serde(default = "enabled")]
    pub role_order: bool,
    /// `tool_schema`.
    #[serde(default = "enabled")]
    pub tool_schema: bool,
    /// `system_sections`.
    #[serde(default = "enabled")]
    pub system_sections: bool,
    /// `cache_breakpoint_count`.
    #[serde(default = "enabled")]
    pub cache_breakpoint_count: bool,
    /// `cache_breakpoint_position`.
    #[serde(default = "enabled")]
    pub cache_breakpoint_position: bool,
}

impl Default for RuleSwitches {
    fn default() -> Self {
        Self {
            tool_pairing: true,
            role_order: true,
            tool_schema: true,
            system_sections: true,
            cache_breakpoint_count: true,
            cache_breakpoint_position: true,
        }
    }
}

impl RuleSwitches {
    /// Whether a validation rule is on. Rules outside the six switchable ones are
    /// always on.
    #[must_use]
    pub fn is_enabled(&self, rule: Rule) -> bool {
        match rule {
            Rule::ToolPairing => self.tool_pairing,
            Rule::RoleOrder => self.role_order,
            Rule::ToolSchema => self.tool_schema,
            Rule::SystemSections => self.system_sections,
            Rule::CacheBreakpointCount => self.cache_breakpoint_count,
            Rule::CacheBreakpointPosition => self.cache_breakpoint_position,
            _ => true,
        }
    }
}

/// Allowed placement of Anthropic cache breakpoints inside `messages`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachePlacement {
    /// Most breakpoints allowed inside `messages`; default 1 (architecture section 6.15).
    #[serde(default = "one")]
    pub max_message_level: usize,
    /// Message-level breakpoints must sit in the last message.
    #[serde(default)]
    pub last_message_only: bool,
}

impl Default for CachePlacement {
    fn default() -> Self {
        Self {
            max_message_level: 1,
            last_message_only: false,
        }
    }
}

fn enabled() -> bool {
    true
}

fn one() -> usize {
    1
}

impl Step {
    /// The effective stop reason.
    #[must_use]
    pub fn effective_stop_reason(&self) -> StopReason {
        self.stop_reason.unwrap_or(if self.tool_calls.is_empty() {
            StopReason::EndTurn
        } else {
            StopReason::ToolUse
        })
    }

    /// The text deltas of the step (empty pieces dropped).
    #[must_use]
    pub fn text_fragments(&self) -> Vec<String> {
        self.text
            .as_deref()
            .map(|text| {
                fragment::split_even(text, TEXT_FRAGMENTS)
                    .into_iter()
                    .filter(|piece| !piece.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl ToolCall {
    /// The compact JSON serialization of the arguments, as streamed.
    #[must_use]
    pub fn arguments_json(&self) -> String {
        self.input.to_string()
    }

    /// The argument fragments in streaming order; their concatenation is
    /// [`Self::arguments_json`].
    ///
    /// # Errors
    ///
    /// A description of the problem when `split_at` is not strictly increasing or points
    /// outside the serialized arguments.
    pub fn argument_fragments(&self) -> Result<Vec<String>, String> {
        let json = self.arguments_json();
        match &self.split_at {
            Some(offsets) => fragment::split_at_offsets(&json, offsets),
            None => Ok(fragment::split_even(
                &json,
                self.fragments.unwrap_or(DEFAULT_ARGUMENT_FRAGMENTS),
            )),
        }
    }

    /// The id used on the wire: the scripted one, or one derived from the position.
    #[must_use]
    pub fn wire_id(&self, prefix: &str, step_index: usize, call_index: usize) -> String {
        self.id
            .clone()
            .unwrap_or_else(|| format!("{prefix}_mock_{step_index}_{call_index}"))
    }
}

impl Script {
    /// Checks the rules a script must follow beyond its shape.
    ///
    /// # Errors
    ///
    /// A description of the first problem found.
    pub fn check(&self) -> Result<(), String> {
        if self.steps.is_empty() {
            return Err("a script needs at least one step".to_owned());
        }
        for (index, step) in self.steps.iter().enumerate() {
            check_step(step).map_err(|reason| format!("steps[{index}]: {reason}"))?;
        }
        if self
            .validation
            .required_system_sections
            .iter()
            .any(String::is_empty)
        {
            return Err("required_system_sections must not contain empty strings".to_owned());
        }
        Ok(())
    }
}

fn check_step(step: &Step) -> Result<(), String> {
    if let Some(error) = &step.error {
        let has_response = step.text.is_some()
            || !step.tool_calls.is_empty()
            || step.stop_reason.is_some()
            || step.disconnect_after_events.is_some()
            || step.usage != Usage::default();
        if has_response {
            return Err("an error step cannot also carry a response".to_owned());
        }
        if error.retry_after_secs.is_some() && error.kind != InjectedErrorKind::RateLimit {
            return Err("retry_after_secs applies to rate_limit only".to_owned());
        }
        return Ok(());
    }
    if step.text.is_none() && step.tool_calls.is_empty() {
        return Err("a step needs text, tool_calls or error".to_owned());
    }
    if step.disconnect_after_events == Some(0) {
        return Err("disconnect_after_events must be at least 1".to_owned());
    }
    for (index, call) in step.tool_calls.iter().enumerate() {
        check_tool_call(call).map_err(|reason| format!("tool_calls[{index}]: {reason}"))?;
    }
    Ok(())
}

fn check_tool_call(call: &ToolCall) -> Result<(), String> {
    if !call.input.is_object() {
        return Err("input must be a JSON object".to_owned());
    }
    if call.name.is_empty() {
        return Err("name must not be empty".to_owned());
    }
    if let Some(id) = &call.id
        && (id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        return Err(format!(
            "id {id:?} must be non-empty ASCII letters, digits, _ or -"
        ));
    }
    match (call.fragments, &call.split_at) {
        (Some(_), Some(_)) => Err("set fragments or split_at, not both".to_owned()),
        (Some(0), None) => Err("fragments must be at least 1".to_owned()),
        _ => call.argument_fragments().map(drop),
    }
}

/// Whether `id` is a valid scenario id.
#[must_use]
pub fn is_valid_scenario_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The on-disk shape of a standalone scenario file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScenarioFile {
    id: String,
    #[serde(default)]
    validation: ValidationConfig,
    steps: Vec<Step>,
}

impl Scenario {
    /// Builds a scenario from an id and a script, checking both.
    ///
    /// # Errors
    ///
    /// [`Error::Scenario`] when the id or the script is invalid.
    pub fn new(id: impl Into<String>, script: Script) -> Result<Self> {
        let id = id.into();
        if !is_valid_scenario_id(&id) {
            return Err(Error::scenario(
                &id,
                "id must be non-empty ASCII letters, digits, '.', '_' or '-'",
            ));
        }
        script
            .check()
            .map_err(|reason| Error::scenario(&id, reason))?;
        Ok(Self { id, script })
    }

    /// Parses a standalone scenario from JSON.
    ///
    /// # Errors
    ///
    /// [`Error::Scenario`] when the text is not a valid scenario.
    pub fn from_json_str(source_name: &str, text: &str) -> Result<Self> {
        let file: ScenarioFile = serde_json::from_str(text)
            .map_err(|error| Error::scenario(source_name, error.to_string()))?;
        Self::from_file(source_name, file)
    }

    /// Parses a standalone scenario from YAML.
    ///
    /// # Errors
    ///
    /// [`Error::Scenario`] when the text is not a valid scenario.
    pub fn from_yaml_str(source_name: &str, text: &str) -> Result<Self> {
        let file: ScenarioFile = serde_saphyr::from_str(text)
            .map_err(|error| Error::scenario(source_name, error.to_string()))?;
        Self::from_file(source_name, file)
    }

    /// Loads a scenario file; `.json` is parsed as JSON, `.yaml` and `.yml` as YAML.
    ///
    /// # Errors
    ///
    /// [`Error::Read`] when the file cannot be read, [`Error::Scenario`] when its
    /// extension is not supported or its content is invalid.
    pub fn load(path: &Path) -> Result<Self> {
        let name = path.display().to_string();
        let format = ScenarioFormat::of(path)
            .ok_or_else(|| Error::scenario(&name, "expected a .json, .yaml or .yml file"))?;
        let text = std::fs::read_to_string(path).map_err(|source| Error::Read {
            path: path.to_path_buf(),
            source,
        })?;
        match format {
            ScenarioFormat::Json => Self::from_json_str(&name, &text),
            ScenarioFormat::Yaml => Self::from_yaml_str(&name, &text),
        }
    }

    fn from_file(source_name: &str, file: ScenarioFile) -> Result<Self> {
        let script = Script {
            validation: file.validation,
            steps: file.steps,
        };
        Self::new(file.id, script).map_err(|error| match error {
            Error::Scenario { reason, .. } => Error::scenario(source_name, reason),
            other => other,
        })
    }
}

#[derive(Clone, Copy)]
enum ScenarioFormat {
    Json,
    Yaml,
}

impl ScenarioFormat {
    fn of(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "json" => Some(Self::Json),
            "yaml" | "yml" => Some(Self::Yaml),
            _ => None,
        }
    }
}

/// The scenarios a mock provider can serve, keyed by id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScenarioLibrary {
    scripts: BTreeMap<String, Script>,
}

impl ScenarioLibrary {
    /// An empty library.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a scenario.
    ///
    /// # Errors
    ///
    /// [`Error::Scenario`] when the script breaks a script rule,
    /// [`Error::DuplicateScenario`] when the id is already present.
    pub fn insert(&mut self, scenario: Scenario) -> Result<()> {
        // `Scenario` has public fields, so re-check what `Scenario::new` checked.
        scenario
            .script
            .check()
            .map_err(|reason| Error::scenario(&scenario.id, reason))?;
        if self.scripts.contains_key(&scenario.id) {
            return Err(Error::DuplicateScenario { id: scenario.id });
        }
        self.scripts.insert(scenario.id, scenario.script);
        Ok(())
    }

    /// Adds a scenario and returns the library, for building a library in one expression.
    ///
    /// # Errors
    ///
    /// As [`Self::insert`].
    pub fn with(mut self, scenario: Scenario) -> Result<Self> {
        self.insert(scenario)?;
        Ok(self)
    }

    /// Loads scenario files. A directory contributes every `.json`, `.yaml` and `.yml`
    /// file directly inside it, in file-name order.
    ///
    /// # Errors
    ///
    /// The first [`Error`] met while reading or parsing, or a duplicate id.
    pub fn load_paths<P: AsRef<Path>>(paths: &[P]) -> Result<Self> {
        let mut library = Self::new();
        for path in paths {
            for file in scenario_files(path.as_ref())? {
                library.insert(Scenario::load(&file)?)?;
            }
        }
        Ok(library)
    }

    /// The script of a scenario.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Script> {
        self.scripts.get(id)
    }

    /// The ids of all scenarios, sorted.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.scripts.keys().map(String::as_str)
    }
}

fn scenario_files(path: &Path) -> Result<Vec<PathBuf>> {
    let read_error = |source| Error::Read {
        path: path.to_path_buf(),
        source,
    };
    if !path.is_dir() {
        return Ok(vec![path.to_path_buf()]);
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(path).map_err(read_error)? {
        let file = entry.map_err(read_error)?.path();
        if file.is_file() && ScenarioFormat::of(&file).is_some() {
            files.push(file);
        }
    }
    files.sort();
    Ok(files)
}
