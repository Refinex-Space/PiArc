//! piarc-testkit: test support: strict mock provider, scenario runner and event assertions.
//!
//! # Responsibilities
//!
//! - Test-only support. Today: the strict mock provider (architecture section 12.2). The
//!   L2 scenario runner and event assertions arrive with T15.
//!
//! # Not responsible for
//!
//! - Anything shipped in the app: production crates must never depend on it.
//! - Running Core or the Agent Host; it only stands in for the model services.
//!
//! # Allowed workspace dependencies
//!
//! `piarc-core` and the foundation crates `piarc-protocol` and `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1). Being test support, the
//! crate binds sockets and reads scenario files directly instead of going through
//! `piarc-ports`.
//!
//! # Strict mock provider
//!
//! [`MockProvider`] serves two streaming wire formats on `127.0.0.1`:
//!
//! | Endpoint | Wire format |
//! |---|---|
//! | `POST /v1/messages` | Anthropic Messages, SSE events |
//! | `POST /v1/chat/completions` | OpenAI-compatible Chat Completions, `data:` chunks |
//! | `GET /_piarc/requests` | The request log as a JSON array of [`RequestRecord`] |
//!
//! Every model request is parsed into a wire-neutral [`Request`] and checked by
//! [`validate`] before a step is used. Anything that breaks a rule gets HTTP 400 with the
//! service's official error shape plus `error.code` (the first [`Rule`] id) and
//! `error.violations` (all of them, each with `rule`, `message` and `location`).
//! Non-streaming requests get 400 `streaming_required`.
//!
//! Two run modes:
//!
//! - Library: `MockProvider::start(library).await` inside a tokio runtime returns the
//!   bound port, base URLs and the [`RequestLog`].
//! - Process: the `piarc-mock-provider` binary (`--port 0 --scenarios <path>...`) prints
//!   the port as the first stdout line, serves the same endpoints, and exits when stdin
//!   closes or it receives a termination signal.
//!
//! # Scenario selection
//!
//! The `x-piarc-scenario` header, or else a `[[piarc-scenario:<selector>]]` marker in the
//! first user message, selects the scenario. A selector is `<id>` or `<id>#<instance>`;
//! each distinct selector counts its own steps, so concurrent sessions sharing one script
//! do not interfere. No selector, or an unknown id, is a 400 (`scenario_not_selected`,
//! `scenario_not_found`). The N-th accepted request of a selector gets step N; requests
//! rejected by validation consume no step; one more request than there are steps is a 400
//! `scenario_exhausted`.
//!
//! # Script format
//!
//! A scenario file (`.json`, `.yaml` or `.yml`) holds one scenario. Unknown fields are
//! errors. Scenario files of T15 embed the [`Script`] part (`validation` and `steps`).
//!
//! ```yaml
//! id: read-then-answer            # ASCII letters, digits, '.', '_', '-'
//! validation:                     # optional; every rule is on by default
//!   rules:                        # switch rules off one by one
//!     cache_breakpoint_position: false
//!   required_system_sections:     # substrings the system prompt must contain
//!     - "<environment>"
//!   cache_breakpoints:            # Anthropic only
//!     max_message_level: 1        # default 1 (architecture section 6.15)
//!     last_message_only: false    # message-level breakpoints only in the last message
//! steps:                          # request N gets steps[N-1]
//!   - text: "Reading the file."   # streamed in 3 deltas
//!     tool_calls:
//!       - id: toolu_read_1        # optional; default <toolu|call>_mock_<step>_<n>
//!         name: read_file
//!         input: { path: "a b/中文.txt" }   # a JSON object
//!         fragments: 4            # optional, default 3; or split_at: [char offsets]
//!     usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 100 }
//!     stop_reason: tool_use       # optional: end_turn | tool_use | max_tokens
//!   - text: "Done."
//!     disconnect_after_events: 3  # optional: send 3 wire events, then drop the connection
//!   - error:
//!       kind: rate_limit          # rate_limit 429 | overloaded 529 | server_error 500 | unavailable 503
//!       retry_after_secs: 2       # rate_limit only, default 1
//!       message: "slow down"      # optional
//! ```
//!
//! # Rule ids
//!
//! `tool_pairing`, `role_order`, `tool_schema`, `system_sections`,
//! `cache_breakpoint_count`, `cache_breakpoint_position` (switchable; see [`Rule`]), and
//! `malformed_request`, `streaming_required`, `scenario_not_selected`,
//! `scenario_not_found`, `scenario_exhausted`, `not_found`.

mod anthropic;
mod body;
mod error;
mod fragment;
mod openai;
mod record;
mod request;
mod rules;
mod scenario;
mod server;

pub use error::{Error, ErrorKind, Result};
pub use fragment::{split_at_offsets, split_even};
pub use record::{Outcome, REDACTED, RequestLog, RequestRecord};
pub use request::{
    CacheBreakpoint, CacheSection, Message, Request, Role, Tool, ToolKind, WireFormat,
};
pub use rules::{MAX_CACHE_BREAKPOINTS, Rule, Violation, validate};
pub use scenario::{
    CachePlacement, DEFAULT_ARGUMENT_FRAGMENTS, InjectedError, InjectedErrorKind, RuleSwitches,
    Scenario, ScenarioLibrary, Script, Step, StopReason, TEXT_FRAGMENTS, ToolCall, Usage,
    ValidationConfig, is_valid_scenario_id,
};
pub use server::{
    MockProvider, REQUESTS_PATH, SCENARIO_HEADER, SCENARIO_MARKER_CLOSE, SCENARIO_MARKER_OPEN,
};

/// Parses a request body of the given wire format into a [`Request`], the structure
/// [`validate`] checks.
///
/// # Errors
///
/// A [`Rule::MalformedRequest`] violation when the body lacks the wire format's structure.
pub fn parse_request(
    format: WireFormat,
    body: &serde_json::Value,
) -> std::result::Result<Request, Violation> {
    match format {
        WireFormat::AnthropicMessages => anthropic::parse(body),
        WireFormat::OpenaiChatCompletions => openai::parse(body),
    }
}
