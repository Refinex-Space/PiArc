//! The built-in browser's fake desktop client (design addendum `browser.md` section 5.2): what
//! the app's main process does with Core's browser API, scripted by the scenario's `browser`
//! section. Core attached the client when it started (`Env::start_core`). Here the client reads
//! the `run` and `cancel` events of `core/browser` and plays each run's script: site requests
//! (`browser_site`), upload staging (`browser_files`), the answer (`answer_browser_run`, maybe
//! late) or none, waiting for Core's cancel. The driver's wait loop polls it (`browser_tick`);
//! Core's callbacks and answer delays wake that loop. A check that fails stops the scenario
//! with what differed.
//!
//! Two invariants hold in every browser scenario: Core never has two runs of one session open
//! at once (B2.1.3), and no `browser` audit row holds a run's script (B2.7.2).

use tokio::sync::oneshot::error::TryRecvError;

use super::*;
use crate::l2::browser_spec::{AnswerStep, ClientStep, RunScript, SiteStep, StageStep};

/// The client's state across one run of the scenario.
#[derive(Default)]
pub(super) struct BrowserClient {
    /// How many delivered events it has read.
    cursor: usize,
    /// The runs Core started, in order.
    runs: Vec<Run>,
}

struct Run {
    id: String,
    session: String,
    call: String,
    script: String,
    /// The next step of its script.
    step: usize,
    /// What the current step waits for.
    waiting: Option<Waiting>,
    /// Core waits for its answer (neither answered nor cancelled).
    open: bool,
    cancelled: bool,
    /// Every copy Core staged for the run and what it holds: a page may read it until the run
    /// ends, so a later staging must leave it alone.
    staged: Vec<(PathBuf, String)>,
}

enum Waiting {
    /// A Core call's answer.
    Core(oneshot::Receiver<piarc_core::Result<Value>>),
    /// The answer's delay.
    Until(tokio::time::Instant),
}

type Done = Box<dyn FnOnce(piarc_core::Result<Value>) + Send>;

impl Driver<'_> {
    /// Reads Core's new browser events and moves every run's script as far as it goes.
    pub(super) fn browser_tick(&mut self) -> Result<(), String> {
        let spec = self.spec;
        let Some(browser) = &spec.browser else {
            return Ok(());
        };
        let fresh: Vec<Value> = {
            let all = self
                .events
                .all
                .lock()
                .map_err(|_| "event log unavailable")?;
            let fresh = all[self.browser.cursor..]
                .iter()
                .filter(|(route, _)| route == "core/browser")
                .map(|(_, event)| event.clone())
                .collect();
            self.browser.cursor = all.len();
            fresh
        };
        for event in &fresh {
            self.browser_event(&browser.runs, event)?;
        }
        for n in 0..self.browser.runs.len() {
            self.advance_run(n, &browser.runs[n].steps)?;
        }
        Ok(())
    }

    /// After every turn ended: each scripted run came and played its whole script, and no
    /// `browser` audit row holds a script.
    pub(super) async fn browser_settled(&mut self) -> Result<(), String> {
        let spec = self.spec;
        let Some(browser) = &spec.browser else {
            return Ok(());
        };
        // A step's Core answer can land just after the turn ended (Windows runners are slower):
        // keep playing the scripts until they finish or a short bound passes.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            self.browser_tick()?;
            let finished = self.browser.runs.len() == browser.runs.len()
                && self
                    .browser
                    .runs
                    .iter()
                    .zip(&browser.runs)
                    .all(|(run, script)| run.step >= script.steps.len());
            if finished || std::time::Instant::now() >= deadline {
                break;
            }
            let notified = self.events.arrived.notified();
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), notified).await;
        }
        if self.browser.runs.len() != browser.runs.len() {
            return Err(format!(
                "browser: the scenario scripts {} run(s), Core started {}",
                browser.runs.len(),
                self.browser.runs.len()
            ));
        }
        for (n, (run, script)) in self.browser.runs.iter().zip(&browser.runs).enumerate() {
            if run.step < script.steps.len() {
                return Err(format!(
                    "browser run #{n} ({}) stopped before step {} of {}",
                    run.call,
                    run.step,
                    script.steps.len()
                ));
            }
        }
        let rows = self.audit_rows("browser").await?;
        for run in &self.browser.runs {
            // The script as it reads inside a JSON string.
            let quoted = Value::String(run.script.clone()).to_string();
            let needle = &quoted[1..quoted.len() - 1];
            if run.script.chars().count() >= 8
                && rows.iter().any(|r| r.to_string().contains(needle))
            {
                return Err(format!(
                    "browser: an audit row holds the script of run {}",
                    run.call
                ));
            }
        }
        Ok(())
    }

    fn browser_event(&mut self, scripts: &[RunScript], event: &Value) -> Result<(), String> {
        let field = |key: &str| event[key].as_str().unwrap_or_default().to_owned();
        match event["type"].as_str() {
            Some("run") => {
                let n = self.browser.runs.len();
                let script = scripts.get(n).ok_or_else(|| {
                    format!(
                        "browser: Core started run #{n} ({}), the scenario scripts {}",
                        compact(event, 200),
                        scripts.len()
                    )
                })?;
                let session = field("sessionId");
                if let Some(open) = self
                    .browser
                    .runs
                    .iter()
                    .find(|r| r.open && r.session == session)
                {
                    return Err(format!(
                        "browser: run {} started while run {} of the same session was open",
                        field("toolCallId"),
                        open.call
                    ));
                }
                if let Some(why) = script
                    .run
                    .as_ref()
                    .and_then(|want| subset_mismatch(want, event, &format!("browser run #{n}")))
                {
                    return Err(why);
                }
                self.browser.runs.push(Run {
                    id: field("runId"),
                    session,
                    call: field("toolCallId"),
                    script: field("script"),
                    step: 0,
                    waiting: None,
                    open: true,
                    cancelled: false,
                    staged: Vec::new(),
                });
            }
            Some("cancel") => {
                let id = field("runId");
                if let Some(run) = self.browser.runs.iter_mut().find(|r| r.id == id) {
                    run.open = false;
                    run.cancelled = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn advance_run(&mut self, n: usize, steps: &[ClientStep]) -> Result<(), String> {
        while let Some(step) = steps.get(self.browser.runs[n].step) {
            let label = format!("browser run #{n} step {}", self.browser.runs[n].step);
            let done = match step {
                ClientStep::Site(site) => {
                    let request = site_request(site, &self.browser.runs[n]);
                    match self
                        .core_step(n, &label, |core, done| core.browser_site(request, done))?
                    {
                        Some(result) => check_site(site, result, &label)?,
                        None => false,
                    }
                }
                ClientStep::Stage(stage) => {
                    let run = &self.browser.runs[n];
                    let request = json!({
                        "op": "stage", "sessionId": run.session, "toolCallId": run.call,
                        "paths": stage.paths,
                    })
                    .to_string();
                    let uploads = self.uploads_dir(&run.session)?;
                    match self
                        .core_step(n, &label, |core, done| core.browser_files(request, done))?
                    {
                        Some(result) => {
                            let copies = check_stage(stage, result, &uploads, &label)?;
                            self.keep_copies(n, copies, &label)?;
                            true
                        }
                        None => false,
                    }
                }
                ClientStep::Answer(answer) => self.answer_step(n, answer, &label)?,
                ClientStep::WaitCancel {} => self.browser.runs[n].cancelled,
            };
            if !done {
                return Ok(());
            }
            self.browser.runs[n].step += 1;
        }
        Ok(())
    }

    /// Starts the step's Core call, or answers its result once Core gave it.
    fn core_step(
        &mut self,
        n: usize,
        label: &str,
        start: impl FnOnce(&CoreRuntime, Done) -> piarc_core::Result<()>,
    ) -> Result<Option<piarc_core::Result<Value>>, String> {
        match self.browser.runs[n].waiting.take() {
            Some(Waiting::Core(mut rx)) => match rx.try_recv() {
                Ok(result) => Ok(Some(result)),
                Err(TryRecvError::Empty) => {
                    self.browser.runs[n].waiting = Some(Waiting::Core(rx));
                    Ok(None)
                }
                Err(TryRecvError::Closed) => Err(format!("{label}: Core dropped the answer")),
            },
            _ => {
                let (tx, rx) = oneshot::channel();
                let events = Arc::clone(self.events);
                start(
                    &self.core,
                    Box::new(move |result| {
                        // The receiver is gone only when the scenario already failed.
                        let _ = tx.send(result);
                        events.arrived.notify_waiters();
                    }),
                )
                .map_err(|e| format!("{label}: {e}"))?;
                self.browser.runs[n].waiting = Some(Waiting::Core(rx));
                Ok(None)
            }
        }
    }

    /// Answers the run once its delay passed; whether the step is done.
    fn answer_step(&mut self, n: usize, step: &AnswerStep, label: &str) -> Result<bool, String> {
        let run = &mut self.browser.runs[n];
        match (run.waiting.take(), step.delay_ms) {
            (None, Some(ms)) => {
                let at = tokio::time::Instant::now() + Duration::from_millis(ms);
                run.waiting = Some(Waiting::Until(at));
                let events = Arc::clone(self.events);
                tokio::spawn(async move {
                    tokio::time::sleep_until(at).await;
                    events.arrived.notify_waiters();
                });
                return Ok(false);
            }
            (Some(Waiting::Until(at)), _) if tokio::time::Instant::now() < at => {
                run.waiting = Some(Waiting::Until(at));
                return Ok(false);
            }
            _ => {}
        }
        let answer = serde_json::to_string(&step.answer()).map_err(|e| e.to_string())?;
        let accepted = self
            .core
            .answer_browser_run(&self.browser.runs[n].id, &answer)
            .map_err(|e| format!("{label}: answer_browser_run: {e}"))?;
        if accepted != step.accepted.unwrap_or(true) {
            return Err(format!(
                "{label}: Core {} the answer",
                if accepted { "took" } else { "refused" }
            ));
        }
        if accepted {
            self.browser.runs[n].open = false;
        }
        Ok(true)
    }

    /// Checks that the run's earlier staged copies still hold what they held (a page may read
    /// them until the run ends), then adds `copies` to them.
    fn keep_copies(
        &mut self,
        n: usize,
        copies: Vec<(PathBuf, String)>,
        label: &str,
    ) -> Result<(), String> {
        let run = &mut self.browser.runs[n];
        for (copy, want) in &run.staged {
            let text =
                std::fs::read_to_string(copy).unwrap_or_else(|e| format!("<cannot read: {e}>"));
            if &text != want {
                return Err(format!(
                    "{label}: the earlier staged copy {} now holds {text:?}, not {want:?}",
                    copy.display()
                ));
            }
        }
        run.staged.extend(copies);
        Ok(())
    }

    /// `<session tmp>/browser/uploads`: next to the downloads Core names.
    fn uploads_dir(&self, session: &str) -> Result<PathBuf, String> {
        let downloads = self
            .core
            .browser_downloads_dir(session)
            .map_err(|e| format!("browser_downloads_dir: {e}"))?;
        Path::new(&downloads)
            .parent()
            .map(|browser| browser.join("uploads"))
            .ok_or_else(|| format!("no browser directory above {downloads}"))
    }
}

fn site_request(site: &SiteStep, run: &Run) -> String {
    json!({
        "sessionId": run.session, "toolCallId": run.call, "url": site.url, "host": site.host,
        "local": site.local, "sensitive": site.sensitive, "pending": site.pending,
    })
    .to_string()
}

fn check_site(
    site: &SiteStep,
    result: piarc_core::Result<Value>,
    label: &str,
) -> Result<bool, String> {
    let decision = result.map_err(|e| format!("{label}: browser_site failed: {e}"))?;
    let scope_ok = site.decision.scope.is_none_or(|scope| {
        serde_json::to_value(scope).is_ok_and(|scope| decision["scope"] == scope)
    });
    if decision["allowed"].as_bool() == Some(site.decision.allowed) && scope_ok {
        Ok(true)
    } else {
        Err(format!(
            "{label}: {} got {decision}, expected {:?}",
            site.host, site.decision
        ))
    }
}

/// Checks a stage step's outcome; answers the copies Core staged with what each holds.
fn check_stage(
    stage: &StageStep,
    result: piarc_core::Result<Value>,
    uploads: &Path,
    label: &str,
) -> Result<Vec<(PathBuf, String)>, String> {
    match (result, &stage.refused, &stage.staged) {
        (Err(e), Some(text), _) if e.to_string().contains(text.as_str()) => Ok(Vec::new()),
        (Ok(value), None, Some(contents)) => {
            let staged: Vec<&str> = value["staged"]
                .as_array()
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if staged.len() != contents.len() {
                return Err(format!("{label}: staged {value}, expected {contents:?}"));
            }
            let root = std::fs::canonicalize(uploads).map_err(|e| format!("{label}: {e}"))?;
            let mut copies = Vec::with_capacity(staged.len());
            for (path, want) in staged.iter().zip(contents) {
                let copy = std::fs::canonicalize(path).map_err(|e| format!("{label}: {e}"))?;
                if !copy.starts_with(&root) {
                    return Err(format!("{label}: {path} is not below {}", root.display()));
                }
                let text = std::fs::read_to_string(&copy).map_err(|e| format!("{label}: {e}"))?;
                if &text != want {
                    return Err(format!("{label}: {path} holds {text:?}, expected {want:?}"));
                }
                copies.push((copy, text));
            }
            Ok(copies)
        }
        (other, _, _) => Err(format!(
            "{label}: stage {:?} answered {other:?}, expected {}",
            stage.paths,
            stage.refused.as_ref().map_or_else(
                || format!("copies {:?}", stage.staged),
                |text| format!("a refusal containing {text:?}")
            )
        )),
    }
}
