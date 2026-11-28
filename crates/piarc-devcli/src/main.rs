//! piarc-devcli: headless development driver running Core and the Agent Host without UI.
//!
//! # Responsibilities
//!
//! - Runs L2 scenarios (`tests/scenarios/*.yaml`) without the UI: Core's headless runtime
//!   (directly, not through NAPI), the esbuild bundle of the Agent Host on Node, and the strict
//!   mock provider of `piarc-testkit`, through the runner in `piarc_testkit::l2`.
//! - One scenario file or every file of a directory; a JSON report for the capability list
//!   (`scripts/ci/check-capabilities.mjs`).
//! - The PiArc side of L3 (`l3`, T30): runs scenarios with the mocks in L3 mode and writes
//!   each run's structure-only capture for `scripts/l3/run.mjs`.
//!
//! # Not responsible for
//!
//! - Shipping in the app: release artefacts must not contain it
//!   (`scripts/ci/check-app-layout.mjs` checks).
//! - The scenario logic: format, runner and assertions live in `piarc-testkit`.
//!
//! # Allowed workspace dependencies
//!
//! `piarc-core`, `piarc-testkit` and the foundation crates `piarc-protocol` and `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use piarc_testkit::l2::{self, RunnerConfig, SuiteOptions};

const USAGE: &str = "\
usage: piarc-devcli run <scenario file or directory>... [options]
       piarc-devcli list <scenario file or directory>...
       piarc-devcli l3 <scenario file or directory>... --out <dir>

Runs L2 scenarios headlessly: Core + the real Agent Host bundle + the strict mock provider.

options:
  --json <file>       write the JSON report (statuses, failures, capabilities) to <file>
  --filter <text>     run only scenarios whose id contains <text> (repeatable)
  --exact             --filter matches whole ids
  --threads <n>       scenarios run at once (default: half the cores, at most 4)
  --repo <dir>        repository root holding scripts/dev/build-agent-host.mjs
                      (default: the checkout this binary was built from)
  --out <dir>         l3: write <dir>/<id>.json per scenario (failures and capture)
";

struct Args {
    command: String,
    paths: Vec<PathBuf>,
    json: Option<PathBuf>,
    out: Option<PathBuf>,
    options: SuiteOptions,
    repo: PathBuf,
}

fn parse(args: Vec<String>) -> Result<Args, String> {
    let mut iter = args.into_iter();
    let command = iter.next().ok_or("missing command")?;
    if !["run", "list", "l3"].contains(&command.as_str()) {
        return Err(format!("unknown command `{command}`"));
    }
    let mut parsed = Args {
        command,
        paths: Vec::new(),
        json: None,
        out: None,
        options: SuiteOptions {
            threads: l2::default_threads(),
            ..SuiteOptions::default()
        },
        repo: Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .map(Path::to_path_buf)
            .unwrap_or_default(),
    };
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| iter.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--json" => parsed.json = Some(PathBuf::from(value("--json")?)),
            "--out" => parsed.out = Some(PathBuf::from(value("--out")?)),
            "--filter" => parsed.options.filters.push(value("--filter")?),
            "--exact" => parsed.options.exact = true,
            "--threads" => {
                parsed.options.threads = value("--threads")?
                    .parse()
                    .map_err(|e| format!("--threads: {e}"))?;
            }
            "--repo" => parsed.repo = PathBuf::from(value("--repo")?),
            other if other.starts_with('-') => return Err(format!("unknown option `{other}`")),
            path => parsed.paths.push(PathBuf::from(path)),
        }
    }
    if parsed.command == "l3" && parsed.out.is_none() {
        return Err("l3 needs --out <dir>".into());
    }
    if parsed.paths.is_empty() {
        return Err("give at least one scenario file or directory".into());
    }
    parsed.options.list = parsed.command == "list";
    Ok(parsed)
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

/// Runs the command; `Ok(false)` when a scenario failed.
fn run(args: &Args) -> Result<bool, String> {
    let entries = l2::load_all(&args.paths)?;
    if entries.is_empty() {
        return Err("no scenario files found".into());
    }
    if args.command == "l3" {
        return run_l3(entries, args);
    }
    let config = if args.options.list {
        RunnerConfig {
            node: PathBuf::new(),
            bundle: PathBuf::new(),
            pi_assets: PathBuf::new(),
        }
    } else {
        RunnerConfig::build(&args.repo)?
    };
    let report = l2::run_suite(entries, &config, &args.repo, &args.options);
    if let Some(path) = &args.json {
        l2::write_report(&report, path)?;
        println!("JSON report: {}", path.display());
    }
    Ok(report.passed())
}

/// `l3`: runs every scenario in L3 mode, one after another, and writes `<out>/<id>.json` as
/// `{"id", "failures": [{kind, message}], "cleaned", "capture"}`. `Ok(false)` when a scenario
/// did not load; run failures are data for the comparison, not a command failure.
fn run_l3(entries: Vec<l2::suite::Entry>, args: &Args) -> Result<bool, String> {
    let out = args.out.as_deref().ok_or("l3 needs --out <dir>")?;
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let config = RunnerConfig::build(&args.repo)?;
    let mut loaded = true;
    for entry in entries {
        let spec = match entry.spec {
            Ok(spec) => spec,
            Err(e) => {
                eprintln!("{e}");
                loaded = false;
                continue;
            }
        };
        if !args.options.filters.is_empty()
            && !args.options.filters.iter().any(|f| {
                if args.options.exact {
                    spec.id == *f
                } else {
                    spec.id.contains(f.as_str())
                }
            })
        {
            continue;
        }
        let (outcome, capture) = l2::run_l3(&spec, &config);
        let report = serde_json::json!({
            "id": spec.id,
            "failures": outcome.failures,
            "cleaned": outcome.cleaned,
            "capture": capture,
        });
        let file = out.join(format!("{}.json", spec.id));
        let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        std::fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))?;
        println!(
            "l3 {}: {} failure(s) -> {}",
            spec.id,
            outcome.failures.len(),
            file.display()
        );
    }
    Ok(loaded)
}
