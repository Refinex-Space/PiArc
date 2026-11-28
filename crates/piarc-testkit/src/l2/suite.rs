//! Runs many scenarios: one independent test each, in parallel, with libtest-style output
//! and a JSON report (the input of the capability coverage check and of
//! `docs/product/capabilities.md`).

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use serde::Serialize;

use super::format::{self, FormatError, Platform, ScenarioSpec};
use super::runner::{self, Failure, RunnerConfig};

/// How a scenario ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Every assertion held.
    Passed,
    /// It did not load, an action failed, or an assertion did not hold.
    Failed,
    /// Not run on this platform (`platforms`).
    Skipped,
}

/// The result of one scenario file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenarioResult {
    /// The scenario id (the file name when the file did not load).
    pub id: String,
    /// The file, relative to the repository root, forward slashes.
    pub file: String,
    /// What it proves (empty when the file did not load).
    pub description: String,
    /// The capabilities it covers (empty when the file did not load).
    pub capabilities: Vec<String>,
    /// The platforms it runs on.
    pub platforms: Vec<Platform>,
    /// How it ended here.
    pub status: Status,
    /// Why it was skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// What failed.
    pub failures: Vec<Failure>,
    /// Wall time in milliseconds.
    pub duration_ms: u64,
}

/// The JSON report of a suite run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    /// Report format version.
    pub version: u32,
    /// The platform it ran on.
    pub platform: Option<Platform>,
    /// A name filter left scenarios out: the report does not cover every scenario.
    pub filtered: bool,
    /// One entry per scenario file, sorted by id.
    pub scenarios: Vec<ScenarioResult>,
}

impl Report {
    /// Scenarios with `status`.
    #[must_use]
    pub fn count(&self, status: Status) -> usize {
        self.scenarios.iter().filter(|s| s.status == status).count()
    }

    /// No scenario failed.
    #[must_use]
    pub fn passed(&self) -> bool {
        self.count(Status::Failed) == 0
    }
}

/// Options of a suite run.
#[derive(Debug, Clone, Default)]
pub struct SuiteOptions {
    /// Run only scenarios whose id contains one of these (or equals it with `exact`).
    pub filters: Vec<String>,
    /// Filters match whole ids.
    pub exact: bool,
    /// Scenarios run at once; at least 1.
    pub threads: usize,
    /// Print the names and stop.
    pub list: bool,
}

/// A loaded (or unloadable) scenario file.
#[derive(Debug, Clone)]
pub struct Entry {
    /// The file.
    pub file: PathBuf,
    /// Its content, or why it could not be used.
    pub spec: Result<ScenarioSpec, FormatError>,
}

impl Entry {
    /// The scenario id, or the file name when it did not load.
    #[must_use]
    pub fn id(&self) -> String {
        match &self.spec {
            Ok(spec) => spec.id.clone(),
            Err(_) => self
                .file
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }
}

/// Loads every scenario file of `paths` (files or directories).
///
/// # Errors
///
/// A description when a directory cannot be read or two files share an id.
pub fn load_all(paths: &[PathBuf]) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for path in paths {
        if !path.exists() {
            return Err(format!("{} does not exist", path.display()));
        }
        for file in format::scenario_files(path)? {
            let spec = format::load(&file);
            entries.push(Entry { file, spec });
        }
    }
    let mut ids: Vec<String> = entries.iter().map(Entry::id).collect();
    ids.sort();
    if let Some(pair) = ids.windows(2).find(|pair| pair[0] == pair[1]) {
        return Err(format!("two scenario files have the id `{}`", pair[0]));
    }
    entries.sort_by_key(Entry::id);
    Ok(entries)
}

/// Runs `entries` and prints one line per scenario, then the failures and a summary.
#[must_use]
pub fn run_suite(
    entries: Vec<Entry>,
    config: &RunnerConfig,
    repo: &Path,
    options: &SuiteOptions,
) -> Report {
    let total = entries.len();
    let selected: Vec<Entry> = entries
        .into_iter()
        .filter(|e| selected(&e.id(), options))
        .collect();
    let filtered = selected.len() < total;
    if options.list {
        for entry in &selected {
            println!("{}: test", entry.id());
        }
        return report(Vec::new(), filtered);
    }
    println!("\nrunning {} L2 scenarios", selected.len());
    let queue = Arc::new(Mutex::new(selected.into_iter().collect::<VecDeque<_>>()));
    let results = Arc::new(Mutex::new(Vec::new()));
    std::thread::scope(|scope| {
        for _ in 0..options.threads.max(1) {
            let (queue, results) = (Arc::clone(&queue), Arc::clone(&results));
            scope.spawn(move || {
                loop {
                    let next = queue
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .pop_front();
                    let Some(entry) = next else { break };
                    let result = run_entry(&entry, config, repo);
                    print_line(&result);
                    results
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(result);
                }
            });
        }
    });
    let results = Arc::try_unwrap(results)
        .map(|m| m.into_inner().unwrap_or_else(PoisonError::into_inner))
        .unwrap_or_default();
    let report = report(results, filtered);
    print_summary(&report);
    report
}

fn selected(id: &str, options: &SuiteOptions) -> bool {
    options.filters.is_empty()
        || options.filters.iter().any(|f| {
            if options.exact {
                id == f
            } else {
                id.contains(f.as_str())
            }
        })
}

fn report(mut scenarios: Vec<ScenarioResult>, filtered: bool) -> Report {
    scenarios.sort_by(|a, b| a.id.cmp(&b.id));
    Report {
        version: 1,
        platform: Platform::current(),
        filtered,
        scenarios,
    }
}

/// Runs one entry: skips it on a platform it excludes, else runs it.
#[must_use]
pub fn run_entry(entry: &Entry, config: &RunnerConfig, repo: &Path) -> ScenarioResult {
    let file = entry
        .file
        .strip_prefix(repo)
        .unwrap_or(&entry.file)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let started = Instant::now();
    let spec = match &entry.spec {
        Ok(spec) => spec,
        Err(e) => {
            return ScenarioResult {
                id: entry.id(),
                file,
                description: String::new(),
                capabilities: Vec::new(),
                platforms: Platform::ALL.to_vec(),
                status: Status::Failed,
                skip_reason: None,
                failures: vec![Failure {
                    kind: "load",
                    message: e.to_string(),
                }],
                duration_ms: 0,
            };
        }
    };
    let platforms = spec.platforms();
    let mut result = ScenarioResult {
        id: spec.id.clone(),
        file,
        description: spec.description.clone(),
        capabilities: spec.capabilities.clone(),
        platforms: platforms.clone(),
        status: Status::Passed,
        skip_reason: None,
        failures: Vec::new(),
        duration_ms: 0,
    };
    if Platform::current().is_none_or(|p| !platforms.contains(&p)) {
        result.status = Status::Skipped;
        result.skip_reason = Some(format!(
            "platform: {}",
            spec.platform_reason.clone().unwrap_or_default()
        ));
        return result;
    }
    let outcome = runner::run(spec, config);
    result.duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    if !outcome.failures.is_empty() {
        result.status = Status::Failed;
        result.failures = outcome.failures;
    }
    result
}

fn print_line(result: &ScenarioResult) {
    let status = match result.status {
        Status::Passed => format!("ok ({} ms)", result.duration_ms),
        Status::Failed => "FAILED".to_owned(),
        Status::Skipped => format!(
            "ignored, 跳过（平台）: {}",
            result.skip_reason.as_deref().unwrap_or_default()
        ),
    };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "test {} ... {status}", result.id);
}

fn print_summary(report: &Report) {
    let failed: Vec<&ScenarioResult> = report
        .scenarios
        .iter()
        .filter(|s| s.status == Status::Failed)
        .collect();
    if !failed.is_empty() {
        println!("\nfailures:\n");
        for scenario in &failed {
            println!("---- {} ({}) ----", scenario.id, scenario.file);
            for f in &scenario.failures {
                println!("[{}] {}", f.kind, f.message.trim_end());
            }
            println!();
        }
        println!("failures:");
        for scenario in &failed {
            println!("    {}", scenario.id);
        }
    }
    let skipped: Vec<&ScenarioResult> = report
        .scenarios
        .iter()
        .filter(|s| s.status == Status::Skipped)
        .collect();
    if !skipped.is_empty() {
        println!("\n跳过（平台）:");
        for scenario in skipped {
            println!(
                "    {}: {}",
                scenario.id,
                scenario.skip_reason.as_deref().unwrap_or_default()
            );
        }
    }
    println!(
        "\nL2 result: {}. {} passed; {} failed; {} skipped (platform); {} scenarios",
        if report.passed() { "ok" } else { "FAILED" },
        report.count(Status::Passed),
        report.count(Status::Failed),
        report.count(Status::Skipped),
        report.scenarios.len()
    );
}

/// Writes `report` as pretty JSON, creating the parent directory.
///
/// # Errors
///
/// A description when the file cannot be written.
pub fn write_report(report: &Report, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("{}: {e}", path.display()))
}
