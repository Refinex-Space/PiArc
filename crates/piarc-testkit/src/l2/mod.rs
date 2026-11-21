//! L2 scenarios (architecture section 12.3, T15): data files that run Core's headless runtime
//! with the real Agent Host and the strict mock provider, then assert events, file side
//! effects and the requests the model received.
//!
//! - [`format`](mod@format): the file format and its checks (schema: `tests/scenarios/schema.json`);
//! - [`runner`]: runs one scenario in its own temporary root;
//! - [`matcher`]: field-subset matching and ordered event subsequences;
//! - [`checks`]: request and file assertions;
//! - [`gate`]: the tool-batch observer;
//! - [`suite`]: many scenarios in parallel, libtest-style output and the JSON report.
//!
//! Used by the `scenarios` test target of this crate (one test per scenario) and by
//! `piarc-devcli`. Field reference and matching rules: `docs/engineering/testing.md`
//! section 12.

pub mod checkpoint_spec;
pub mod checks;
pub mod context_spec;
mod fixtures;
pub mod format;
pub mod gate;
pub mod harness_spec;
pub mod login_spec;
pub mod matcher;
pub mod runner;
pub mod suite;
pub mod web;
pub mod worktree_spec;

use std::path::PathBuf;

pub use format::{FormatError, Platform, ScenarioSpec, load};
pub use runner::{RunOutcome, RunnerConfig, run, run_l3};
pub use suite::{Report, ScenarioResult, Status, SuiteOptions, load_all, run_suite, write_report};

/// Scenarios run at once by default: half the cores, at most 4 (each runs an Agent Host).
#[must_use]
pub fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(1, |n| n.get() / 2)
        .clamp(1, 4)
}

/// Options of the `scenarios` test target, parsed from libtest-style arguments: name
/// filters, `--exact`, `--list`, `--test-threads <n>`, and `--results <file>` for the JSON
/// report. Other libtest flags (`--nocapture`, `--quiet`, `--format <f>`, ...) are accepted
/// and have no effect.
#[must_use]
pub fn parse_test_args(args: impl IntoIterator<Item = String>) -> (SuiteOptions, Option<PathBuf>) {
    let mut options = SuiteOptions {
        threads: default_threads(),
        ..SuiteOptions::default()
    };
    let mut results = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if arg.starts_with("--") => {
                (flag.to_owned(), Some(value.to_owned()))
            }
            _ => (arg.clone(), None),
        };
        let mut value = || inline.clone().or_else(|| args.next());
        match flag.as_str() {
            "--exact" => options.exact = true,
            "--list" => options.list = true,
            "--test-threads" => {
                if let Some(n) = value().and_then(|v| v.parse().ok()) {
                    options.threads = n;
                }
            }
            "--results" => results = value().map(PathBuf::from),
            "--format" | "--color" | "--logfile" | "--skip" | "-Z" => {
                let _ = value();
            }
            other if other.starts_with('-') => {}
            _ => options.filters.push(arg),
        }
    }
    (options, results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn libtest_arguments_select_scenarios_and_the_report() {
        let args = [
            "tools",
            "--exact",
            "--test-threads=2",
            "--format",
            "pretty",
            "--nocapture",
            "--results",
            "out.json",
        ];
        let (options, results) = parse_test_args(args.iter().map(|s| (*s).to_owned()));
        assert_eq!(options.filters, ["tools"]);
        assert!(options.exact);
        assert_eq!(options.threads, 2);
        assert_eq!(results, Some(PathBuf::from("out.json")));
    }
}
