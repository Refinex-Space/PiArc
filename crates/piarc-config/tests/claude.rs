//! T24: Claude Code's settings files in the merge (A01–A05), the injected home directory
//! (A06) and the configuration diagnostics, on real files in a temporary root. Nothing here
//! reads the machine's own `~/.claude`.

use std::path::PathBuf;

use piarc_config::diagnostics::{IgnoreReason, KeyReport};
use piarc_config::{
    FileReport, FileStatus, LayerTable, Settings, TrustState, claude_state_report, ids,
};
use serde_json::{Value, json};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    home: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc-config claude {name} 中文 {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let fixture = Self {
            data: root.join("data dir"),
            home: root.join("home 家"),
            workspace: root.join("工作 区"),
            root,
        };
        for dir in [
            fixture.data.clone(),
            fixture.home.join(".claude"),
            fixture.workspace.join(".claude"),
            fixture.workspace.join(".piarc"),
        ] {
            std::fs::create_dir_all(dir).expect("fixture directory");
        }
        fixture
    }

    fn table(&self) -> LayerTable {
        LayerTable::workspace(&self.data, &self.workspace, Some(&self.home))
    }

    fn file(&self, layer: &str) -> PathBuf {
        match layer {
            ids::CLAUDE_USER => self.home.join(".claude/settings.json"),
            ids::USER => self.data.join("settings.json"),
            ids::CLAUDE_PROJECT => self.workspace.join(".claude/settings.json"),
            ids::CLAUDE_PROJECT_LOCAL => self.workspace.join(".claude/settings.local.json"),
            ids::PROJECT => self.workspace.join(".piarc/settings.json"),
            ids::PROJECT_LOCAL => self.workspace.join(".piarc/settings.local.json"),
            other => panic!("no file for {other}"),
        }
    }

    fn write(&self, layer: &str, text: &str) {
        std::fs::write(self.file(layer), text).expect("write settings");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn report<'a>(reports: &'a [FileReport], layer: &str) -> &'a FileReport {
    reports
        .iter()
        .find(|r| r.layer == layer)
        .unwrap_or_else(|| panic!("no report for {layer}"))
}

fn key<'a>(keys: &'a [KeyReport], pointer: &str) -> &'a KeyReport {
    keys.iter()
        .find(|k| k.pointer == pointer)
        .unwrap_or_else(|| panic!("no key {pointer} in {keys:?}"))
}

fn ignored(report: &FileReport) -> Vec<(&str, IgnoreReason, Option<&str>)> {
    report
        .ignored
        .iter()
        .map(|k| (k.pointer.as_str(), k.reason, k.task))
        .collect()
}

/// Every layer sets `defaultMode` and adds an allow rule; the files carry a BOM, CRLF line
/// ends and keys PiArc ignores.
fn write_all_layers(f: &Fixture) {
    f.write(
        ids::CLAUDE_USER,
        "\u{feff}{\"permissions\":{\"allow\":[\"Bash(claude-user)\"],\"deny\":[\"Bash(rm *)\"],\"defaultMode\":\"plan\"},\"theme\":\"dark\"}",
    );
    f.write(
        ids::USER,
        r#"{"permissions":{"allow":["Bash(piarc-user)"],"defaultMode":"acceptEdits"}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT,
        "{\r\n  \"permissions\": {\r\n    \"allow\": [\"Bash(claude-project)\", \"Bash(claude-user)\"],\r\n    \"ask\": [\"Bash(git push *)\"],\r\n    \"defaultMode\": \"default\"\r\n  },\r\n  \"hooks\": {}\r\n}\r\n",
    );
    f.write(
        ids::CLAUDE_PROJECT_LOCAL,
        r#"{"permissions":{"allow":["Bash(claude-local)"],"defaultMode":"acceptEdits"}}"#,
    );
    f.write(
        ids::PROJECT,
        r#"{"permissions":{"allow":["Bash(piarc-project)"],"deny":["Read(.env)"]}}"#,
    );
    f.write(
        ids::PROJECT_LOCAL,
        r#"{"permissions":{"allow":["Bash(piarc-local)"]}}"#,
    );
}

#[test]
fn seven_layers_merge_in_adr_0005_order_and_lists_combine() {
    let f = Fixture::new("order");
    write_all_layers(&f);
    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert!(settings.issues().is_empty(), "{:?}", settings.issues());
    // Lists: every file's entries, from the lowest layer up, without duplicates.
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!([
            "Bash(claude-user)",
            "Bash(piarc-user)",
            "Bash(claude-project)",
            "Bash(claude-local)",
            "Bash(piarc-project)",
            "Bash(piarc-local)"
        ]))
    );
    assert_eq!(
        settings.get("/permissions/deny"),
        Some(&json!(["Bash(rm *)", "Read(.env)"]))
    );
    assert_eq!(
        settings.get("/permissions/ask"),
        Some(&json!(["Bash(git push *)"]))
    );
    // Scalars: the highest layer that sets the key (`.claude/settings.local.json` here).
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("acceptEdits"))
    );
    // Ignored keys never reach the merge; hooks apply since T25 (the project is trusted).
    assert_eq!(settings.get("/theme"), None);
    assert_eq!(settings.get("/hooks"), Some(&json!({})));
    // Policy evaluates deny before allow per layer, highest first (T23): the deny of the
    // lowest layer is still there next to every allow.
    let lists = settings.permission_lists();
    let order: Vec<&str> = lists.iter().map(|l| l.layer).collect();
    assert_eq!(
        order,
        [
            ids::PROJECT_LOCAL,
            ids::PROJECT,
            ids::CLAUDE_PROJECT_LOCAL,
            ids::CLAUDE_PROJECT,
            ids::USER,
            ids::CLAUDE_USER,
            ids::DEFAULTS
        ]
    );
    let claude_user = lists
        .iter()
        .find(|l| l.layer == ids::CLAUDE_USER)
        .expect("layer");
    assert_eq!(claude_user.deny, ["Bash(rm *)"]);
    assert!(!claude_user.writable);
}

#[test]
fn diagnostics_name_the_file_that_overrides_each_key() {
    let f = Fixture::new("diagnostics");
    write_all_layers(&f);
    let settings = Settings::load(f.table(), TrustState::Trusted);
    let reports = settings.diagnostics();
    let layers: Vec<&str> = reports.iter().map(|r| r.layer).collect();
    assert_eq!(
        layers,
        [
            ids::PROJECT_LOCAL,
            ids::PROJECT,
            ids::CLAUDE_PROJECT_LOCAL,
            ids::CLAUDE_PROJECT,
            ids::USER,
            ids::CLAUDE_USER
        ]
    );
    let local = report(&reports, ids::CLAUDE_PROJECT_LOCAL);
    assert_eq!(local.status, FileStatus::Loaded);
    let mode = key(&local.effective, "/permissions/defaultMode");
    assert_eq!(mode.source, Some(ids::CLAUDE_PROJECT_LOCAL));
    assert_eq!(mode.final_value, json!("acceptEdits"));
    let user = report(&reports, ids::CLAUDE_USER);
    let overridden = key(&user.overridden, "/permissions/defaultMode");
    assert_eq!(overridden.value, json!("plan"));
    assert_eq!(overridden.final_value, json!("acceptEdits"));
    assert_eq!(overridden.source, Some(ids::CLAUDE_PROJECT_LOCAL));
    assert_eq!(
        overridden.source_file.as_deref(),
        Some(f.file(ids::CLAUDE_PROJECT_LOCAL).as_path())
    );
    // A list is applied in every file that sets it, with the merged value.
    let allow = key(&user.effective, "/permissions/allow");
    assert_eq!(allow.source, None);
    assert_eq!(allow.final_value.as_array().map(Vec::len), Some(6));
    assert_eq!(ignored(user), [("/theme", IgnoreReason::Ignored, None)]);
    // Hooks apply since T25 (an empty object has no leaf to list as effective).
    assert!(ignored(report(&reports, ids::CLAUDE_PROJECT)).is_empty());
    assert!(!report(&reports, ids::CLAUDE_PROJECT).writable);
    assert!(report(&reports, ids::PROJECT).writable);
}

#[test]
fn an_untrusted_project_keeps_deny_and_ask_but_not_its_allow_rules_or_directories() {
    let f = Fixture::new("untrusted");
    f.write(
        ids::CLAUDE_USER,
        r#"{"permissions":{"allow":["Bash(user-allowed)"],"additionalDirectories":["../user-dir"]}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT,
        r#"{"permissions":{"allow":["Bash(project-allowed)"],"deny":["Bash(curl *)"],"ask":["Bash(git push *)"],"additionalDirectories":["../outside"]}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT_LOCAL,
        r#"{"permissions":{"allow":["Bash(local-allowed)"],"defaultMode":"acceptEdits"}}"#,
    );
    let mut settings = Settings::load(f.table(), TrustState::Untrusted);
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!(["Bash(user-allowed)"]))
    );
    assert_eq!(
        settings.get("/permissions/additionalDirectories"),
        Some(&json!(["../user-dir"]))
    );
    assert_eq!(
        settings.get("/permissions/deny"),
        Some(&json!(["Bash(curl *)"]))
    );
    assert_eq!(
        settings.get("/permissions/ask"),
        Some(&json!(["Bash(git push *)"]))
    );
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("default"))
    );
    let reports = settings.diagnostics();
    let project = report(&reports, ids::CLAUDE_PROJECT);
    assert_eq!(project.status, FileStatus::Untrusted);
    assert_eq!(
        ignored(project),
        [
            (
                "/permissions/additionalDirectories",
                IgnoreReason::Untrusted,
                None
            ),
            ("/permissions/allow", IgnoreReason::Untrusted, None),
        ]
    );
    let effective: Vec<&str> = project
        .effective
        .iter()
        .map(|k| k.pointer.as_str())
        .collect();
    assert_eq!(effective, ["/permissions/ask", "/permissions/deny"]);
    assert_eq!(
        report(&reports, ids::CLAUDE_USER).status,
        FileStatus::Loaded
    );

    let change = settings.set_trust(TrustState::Trusted);
    assert!(change.changed.contains(&"/permissions/allow".to_owned()));
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!([
            "Bash(user-allowed)",
            "Bash(project-allowed)",
            "Bash(local-allowed)"
        ]))
    );
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("acceptEdits"))
    );
}

#[test]
fn project_files_cannot_select_bypass_or_auto_and_the_diagnostics_say_why() {
    let f = Fixture::new("modes");
    f.write(
        ids::CLAUDE_USER,
        r#"{"permissions":{"defaultMode":"plan"}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT,
        r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT_LOCAL,
        r#"{"permissions":{"defaultMode":"auto"}}"#,
    );
    for trust in [TrustState::Trusted, TrustState::Untrusted] {
        let settings = Settings::load(f.table(), trust);
        assert_eq!(
            settings.get("/permissions/defaultMode"),
            Some(&json!("plan")),
            "{trust:?}"
        );
        let mut modes = settings.ignored_modes().to_vec();
        modes.sort();
        assert_eq!(
            modes,
            [
                (ids::CLAUDE_PROJECT, "bypassPermissions".to_owned()),
                (ids::CLAUDE_PROJECT_LOCAL, "auto".to_owned()),
            ]
        );
        let reports = settings.diagnostics();
        for layer in [ids::CLAUDE_PROJECT, ids::CLAUDE_PROJECT_LOCAL] {
            let report = report(&reports, layer);
            assert_eq!(
                ignored(report),
                [("/permissions/defaultMode", IgnoreReason::ProjectMode, None)],
                "{layer}"
            );
            // A mode is not an executable value: the file itself stays fully loaded.
            assert_eq!(report.status, FileStatus::Loaded, "{layer}");
        }
    }
}

#[test]
fn unknown_planned_and_ignored_keys_are_each_listed() {
    let f = Fixture::new("ignored");
    f.write(
        ids::CLAUDE_PROJECT,
        &json!({
            "$schema": "https://json.schemastore.org/claude-code-settings.json",
            "permissions": { "allow": ["Read"], "disableBypassPermissionsMode": "disable", "futureKey": true },
            "env": { "A": "1" },
            "sandbox": { "enabled": true, "network": { "allowedDomains": ["example.com"] } },
            "enabledPlugins": { "x@y": true },
            "statusLine": { "type": "command", "command": "x" },
            "madeUpKey": 1,
            "model": "claude-opus"
        })
        .to_string(),
    );
    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert!(settings.issues().is_empty(), "{:?}", settings.issues());
    assert_eq!(settings.get("/model"), None);
    let reports = settings.diagnostics();
    assert_eq!(
        ignored(report(&reports, ids::CLAUDE_PROJECT)),
        [
            ("/$schema", IgnoreReason::Ignored, None),
            ("/enabledPlugins", IgnoreReason::Planned, Some("T40")),
            ("/env", IgnoreReason::Ignored, None),
            ("/madeUpKey", IgnoreReason::Unknown, None),
            ("/model", IgnoreReason::Planned, Some("T29")),
            (
                "/permissions/disableBypassPermissionsMode",
                IgnoreReason::Ignored,
                None
            ),
            ("/permissions/futureKey", IgnoreReason::Unknown, None),
            ("/sandbox", IgnoreReason::Planned, Some("T39")),
            ("/statusLine", IgnoreReason::Ignored, None),
        ]
    );
    let notes: Vec<Option<&str>> = report(&reports, ids::CLAUDE_PROJECT)
        .ignored
        .iter()
        .map(|k| k.note)
        .collect();
    assert_eq!(notes[3], None, "unknown keys have no table note");
    assert!(notes[2].is_some_and(|n| n.contains("ADR-0035")));
    // PiArc's own files report their unknown keys the same way.
    f.write(ids::PROJECT, r#"{"colour":"blue"}"#);
    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert_eq!(
        ignored(report(&settings.diagnostics(), ids::PROJECT)),
        [("/colour", IgnoreReason::Unknown, None)]
    );
}

#[test]
fn a_broken_file_reports_line_and_column_while_the_others_load() {
    let f = Fixture::new("broken");
    f.write(
        ids::CLAUDE_USER,
        r#"{"permissions":{"allow":["Bash(user)"]}}"#,
    );
    f.write(
        ids::CLAUDE_PROJECT,
        "{\n  \"permissions\": {\n    \"allow\": [\"Bash(x)\",]\n  }\n}\n",
    );
    f.write(
        ids::CLAUDE_PROJECT_LOCAL,
        r#"{"permissions":{"deny":["Bash(rm *)"]}}"#,
    );
    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!(["Bash(user)"]))
    );
    assert_eq!(
        settings.get("/permissions/deny"),
        Some(&json!(["Bash(rm *)"]))
    );
    let reports = settings.diagnostics();
    let broken = report(&reports, ids::CLAUDE_PROJECT);
    assert_eq!(broken.status, FileStatus::Invalid);
    assert_eq!(broken.file, f.file(ids::CLAUDE_PROJECT));
    let issue = &broken.issues[0];
    assert_eq!((issue.line, issue.column), (Some(3), Some(25)));
    assert!(
        issue.message.starts_with("not valid JSON"),
        "{}",
        issue.message
    );
    assert_eq!(
        issue.file.as_deref(),
        Some(f.file(ids::CLAUDE_PROJECT).as_path())
    );
    assert_eq!(
        report(&reports, ids::CLAUDE_PROJECT_LOCAL).status,
        FileStatus::Loaded
    );
    // A wrongly typed active key skips the file as in PiArc's own files; the pointer says
    // where.
    f.write(
        ids::CLAUDE_PROJECT,
        r#"{"permissions":{"deny":"Bash(curl *)"},"theme":3}"#,
    );
    let settings = Settings::load(f.table(), TrustState::Trusted);
    let broken = report(&settings.diagnostics(), ids::CLAUDE_PROJECT).clone();
    assert_eq!(broken.status, FileStatus::Invalid);
    assert_eq!(broken.issues[0].pointer, "/permissions/deny");
    assert_eq!(broken.issues.len(), 1, "ignored keys are not validated");
}

#[test]
fn the_home_directory_is_injected_and_only_the_injected_one_is_read() {
    let f = Fixture::new("home");
    let with = f.table();
    let user = with
        .get(ids::CLAUDE_USER)
        .and_then(|l| l.file())
        .expect("file");
    assert_eq!(user, f.home.join(".claude").join("settings.json"));
    let without = LayerTable::workspace(&f.data, &f.workspace, None);
    assert!(without.get(ids::CLAUDE_USER).is_none());
    // No layer file of an injected table is under the machine's home directory unless the
    // fixture itself is.
    if let Some(real) = std::env::home_dir()
        && !f.root.starts_with(&real)
    {
        for table in [&with, &without] {
            assert!(table.files().all(|p| !p.starts_with(&real)));
        }
    }
    let report = claude_state_report(&f.home, &f.workspace);
    assert_eq!(report.file, f.home.join(".claude.json"));
    assert_eq!(report.status, FileStatus::Missing);
}

#[test]
fn the_claude_state_file_lists_key_names_and_its_mcp_sections() {
    let f = Fixture::new("state");
    let workspace = f.workspace.to_string_lossy().into_owned();
    let mut projects = serde_json::Map::new();
    projects.insert(
        workspace,
        json!({ "mcpServers": { "local": { "command": "x" } }, "allowedTools": [] }),
    );
    projects.insert("/elsewhere".into(), json!({ "mcpServers": {} }));
    let state = json!({
        "numStartups": 12,
        "oauthAccount": { "emailAddress": "test@example.invalid" },
        "mcpServers": { "global": { "command": "y" } },
        "projects": Value::Object(projects),
        "autoConnectIde": true
    });
    std::fs::write(f.home.join(".claude.json"), state.to_string()).expect("state");
    let report = claude_state_report(&f.home, &f.workspace);
    assert_eq!(report.status, FileStatus::Loaded);
    let mut expected_mcp = "/projects/".to_owned();
    expected_mcp.push_str(
        &f.workspace
            .to_string_lossy()
            .replace('~', "~0")
            .replace('/', "~1"),
    );
    expected_mcp.push_str("/mcpServers");
    let mut want = vec![
        ("/autoConnectIde".to_owned(), IgnoreReason::Ignored, None),
        ("/mcpServers".to_owned(), IgnoreReason::Planned, Some("T36")),
        ("/numStartups".to_owned(), IgnoreReason::Ignored, None),
        ("/oauthAccount".to_owned(), IgnoreReason::Ignored, None),
        ("/projects".to_owned(), IgnoreReason::Ignored, None),
        (expected_mcp, IgnoreReason::Planned, Some("T36")),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    let got: Vec<(String, IgnoreReason, Option<&str>)> = report
        .ignored
        .iter()
        .map(|k| (k.pointer.clone(), k.reason, k.task))
        .collect();
    assert_eq!(got, want);
    // No value of the file is in the report.
    let text = serde_json::to_string(&report).expect("json");
    assert!(!text.contains("example.invalid") && !text.contains("\"command\""));

    std::fs::write(f.home.join(".claude.json"), "{\"a\": 1,\n\"b\" 2}").expect("state");
    let report = claude_state_report(&f.home, &f.workspace);
    assert_eq!(report.status, FileStatus::Invalid);
    assert_eq!(
        (report.issues[0].line, report.issues[0].column),
        (Some(2), Some(5))
    );
}

#[test]
fn a_claude_file_change_is_picked_up_by_reload() {
    let f = Fixture::new("reload");
    f.write(
        ids::CLAUDE_PROJECT,
        r#"{"permissions":{"deny":["Bash(a)"]}}"#,
    );
    let mut settings = Settings::load(f.table(), TrustState::Trusted);
    f.write(
        ids::CLAUDE_PROJECT,
        r#"{"permissions":{"deny":["Bash(a)","Bash(b)"]},"verbose":true}"#,
    );
    let change = settings.reload();
    assert_eq!(change.changed, ["/permissions/deny"]);
    let reports = settings.diagnostics();
    let project = report(&reports, ids::CLAUDE_PROJECT);
    assert_eq!(
        key(&project.effective, "/permissions/deny").value,
        json!(["Bash(a)", "Bash(b)"])
    );
    assert_eq!(
        ignored(project),
        [("/verbose", IgnoreReason::Ignored, None)]
    );
}
