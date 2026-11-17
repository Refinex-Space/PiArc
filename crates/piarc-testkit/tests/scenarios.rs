//! L2 scenarios (T15): every `tests/scenarios/*.yaml` file is one test, run by the suite of
//! `piarc_testkit::l2` (custom harness: `harness = false`).
//!
//! ```text
//! cargo test -p piarc-testkit --test scenarios                       # all
//! cargo test -p piarc-testkit --test scenarios -- turn-steer --exact # one
//! cargo test -p piarc-testkit --test scenarios -- --results target/l2/results.json  # relative to the repository root
//! ```

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use piarc_testkit::l2::{self, RunnerConfig};

fn main() -> ExitCode {
    let repo: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let (options, results) = l2::parse_test_args(std::env::args().skip(1));
    let entries = match l2::load_all(&[repo.join("tests").join("scenarios")]) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    if entries.is_empty() {
        eprintln!("error: no scenario files in tests/scenarios");
        return ExitCode::FAILURE;
    }
    let config = if options.list {
        RunnerConfig {
            node: PathBuf::new(),
            bundle: PathBuf::new(),
            pi_assets: PathBuf::new(),
        }
    } else {
        match RunnerConfig::build(&repo) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
        }
    };
    let report = l2::run_suite(entries, &config, &repo, &options);
    // Cargo runs test binaries in the crate directory: a relative path means the repository's.
    if let Some(path) = results.map(|p| if p.is_relative() { repo.join(p) } else { p }) {
        if let Err(e) = l2::write_report(&report, &path) {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
        println!("L2 report: {}", path.display());
    }
    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
