//! The checks after a run: every expectation of the scenario at once, and the context printed
//! for a failed action.

use super::*;

impl Driver<'_> {
    /// The last events and the requests so far, for a failed action.
    pub(super) fn context(&self) -> String {
        let events = self.observed();
        let from = events.len().saturating_sub(12);
        let mut out = format!("  last delivered events ({} in all):\n", events.len());
        for (i, e) in events.iter().enumerate().skip(from) {
            out.push_str(&format!(
                "    #{i} [{}] {} {}\n",
                e.session,
                e.method,
                compact(&without_noise(&e.params), 160)
            ));
        }
        for (name, records) in self.env.records() {
            for (n, r) in records.iter().enumerate() {
                let rules: Vec<&str> = r.violations.iter().map(|v| v.rule.id()).collect();
                out.push_str(&format!(
                    "  request {name}#{n}: {:?} {rules:?}\n",
                    r.outcome
                ));
            }
        }
        out
    }

    /// Hooks that run in the background (`Notification`) may still be writing their records:
    /// waits until every `expect.json_lines` file has its lines (30 s safety net).
    pub(super) async fn json_lines_written(&self) {
        let want = &self.spec.expect.json_lines;
        let ready = || {
            // A missing file has no lines, as `check_json_lines` reads it (T36: "never started").
            want.iter().all(|(path, lines)| {
                std::fs::read_to_string(resolve(&self.env.workspace, path))
                    .map_or(0, |text| text.lines().count())
                    >= lines.len()
            })
        };
        let deadline = tokio::time::Instant::now() + WAIT;
        while !ready() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub(super) fn assert_all(&self) -> Vec<Failure> {
        let mut failures = Vec::new();
        let events = self.observed();
        let session_of = |s: Option<&str>| self.label(s).unwrap_or_default();
        if let Err(report) =
            check_events(&self.spec.expect.events, &events, &self.turns, session_of)
        {
            failures.push(failure("events", report));
        }
        for f in check_files(&self.spec.expect.files, &self.env.workspace) {
            failures.push(failure("files", f));
        }
        for f in check_fixture_files(self.spec, &self.env.workspace) {
            failures.push(failure("files", f));
        }
        for f in check_json_lines(&self.spec.expect.json_lines, &self.env.workspace) {
            failures.push(failure("json_lines", f));
        }
        if !self.spec.expect.absent_on_disk.is_empty() {
            let needles: Vec<&[u8]> = self
                .spec
                .expect
                .absent_on_disk
                .iter()
                .map(|s| s.as_bytes())
                .collect();
            let roots = [
                self.env.data.as_path(),
                self.env.workspace.as_path(),
                self.env.home.as_path(),
                self.env.cache.as_path(),
            ];
            let report = crate::plaintext::scan(&roots, &needles, None);
            if report.files == 0 {
                failures.push(failure("absent_on_disk", "the scan read no file"));
            }
            for found in &report.findings {
                failures.push(failure("absent_on_disk", format!("found in {found:?}")));
            }
        }
        for f in check_requests(self.spec, &self.env.records()) {
            failures.push(failure("requests", f));
        }
        for f in self.env.gate.failures() {
            failures.push(failure("tool_batches", f));
        }
        let calls = self.env.gate.calls();
        for expected in &self.spec.expect.core_io {
            let seen: BTreeSet<&str> = calls
                .iter()
                .filter(|(call, _)| call.as_deref() == Some(expected.call.as_str()))
                .map(|(_, method)| method.as_str())
                .collect();
            if !seen.contains(expected.method.as_str()) {
                failures.push(failure(
                    "core_io",
                    format!(
                        "core_io: no `{}` request for tool call `{}`; Core saw {seen:?}",
                        expected.method, expected.call
                    ),
                ));
            }
        }
        if self.mode == Mode::Strict && self.spec.approvals.len() != self.answered.len() {
            failures.push(failure(
                "approvals",
                format!(
                    "approvals: {} answer(s) declared, but Core issued {} approval requests",
                    self.spec.approvals.len(),
                    self.answered.len()
                ),
            ));
        }
        failures
    }
}
