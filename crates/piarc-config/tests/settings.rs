//! T13-A07 and the reload half of T13-A08: four layers merge by precedence; an invalid file is
//! skipped with its path and JSON Pointer while the others apply; after a reload an invalid
//! file keeps its last valid content.

use std::path::{Path, PathBuf};

use piarc_config::schema::Severity;
use piarc_config::{
    IgnoreReason, LayerSpec, LayerStatus, LayerTable, Scope, Settings, Source, TrustState, ids,
    precedence, write_value,
};
use serde_json::json;

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc-config {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data dir");
        let workspace = root.join("工作 区");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::create_dir_all(workspace.join(".piarc")).expect("workspace");
        Self {
            root,
            data,
            workspace,
        }
    }

    fn user(&self) -> PathBuf {
        self.data.join("settings.json")
    }

    fn project(&self) -> PathBuf {
        self.workspace.join(".piarc").join("settings.json")
    }

    fn local(&self) -> PathBuf {
        self.workspace.join(".piarc").join("settings.local.json")
    }

    fn table(&self) -> LayerTable {
        LayerTable::piarc(&self.data, &self.workspace)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).expect("write settings");
}

#[test]
fn four_layers_merge_by_precedence() {
    let f = Fixture::new("merge");
    write(
        &f.user(),
        r#"{ "model": "user-model", "permissions": { "allow": ["Read"], "deny": ["Bash(rm *)"], "defaultMode": "acceptEdits" } }"#,
    );
    write(
        &f.project(),
        "{ \"model\": \"project-model\", \"permissions\": { \"allow\": [\"Bash(npm test)\", \"Read\"] } }\r\n",
    );
    write(
        &f.local(),
        r#"{ "permissions": { "allow": ["Edit"], "defaultMode": "plan" } }"#,
    );

    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert!(settings.issues().is_empty(), "{:?}", settings.issues());
    assert_eq!(
        settings.merged(),
        &json!({
            "model": "project-model",
            "permissions": {
                "allow": ["Read", "Bash(npm test)", "Edit"],
                "deny": ["Bash(rm *)"],
                "defaultMode": "plan"
            }
        })
    );
    assert_eq!(
        settings.statuses(),
        [
            (ids::DEFAULTS, LayerStatus::Loaded),
            (ids::USER, LayerStatus::Loaded),
            (ids::PROJECT, LayerStatus::Loaded),
            (ids::PROJECT_LOCAL, LayerStatus::Loaded),
        ]
    );

    // Without the files only the built-in defaults apply.
    let empty = Fixture::new("defaults");
    let settings = Settings::load(empty.table(), TrustState::Trusted);
    assert_eq!(
        settings.merged(),
        &json!({ "permissions": { "defaultMode": "default" } })
    );
    assert_eq!(settings.statuses()[1], (ids::USER, LayerStatus::Missing));
}

#[test]
fn an_invalid_file_is_skipped_and_reported_with_path_and_pointer() {
    let f = Fixture::new("invalid");
    write(&f.user(), r#"{ "model": "user-model", "theme": "dark" }"#);
    write(
        &f.project(),
        r#"{ "model": "project-model", "permissions": { "allow": ["Read", 42] } }"#,
    );
    write(&f.local(), "{ \"permissions\": ");

    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert_eq!(
        settings.get("/model"),
        Some(&json!("user-model")),
        "the invalid project file is skipped"
    );
    assert_eq!(settings.get("/permissions/allow"), None);
    let issues: Vec<(String, Option<PathBuf>, String, Severity)> = settings
        .issues()
        .iter()
        .map(|i| {
            (
                i.layer.to_owned(),
                i.file.clone(),
                i.pointer.clone(),
                i.severity,
            )
        })
        .collect();
    assert_eq!(
        issues,
        [
            (
                "user".to_owned(),
                Some(f.user()),
                "/theme".to_owned(),
                Severity::Warning
            ),
            (
                "project".to_owned(),
                Some(f.project()),
                "/permissions/allow/1".to_owned(),
                Severity::Error
            ),
            (
                "projectLocal".to_owned(),
                Some(f.local()),
                String::new(),
                Severity::Error
            ),
        ]
    );
    assert_eq!(
        settings.issues()[1].message,
        "expected a string, found a number"
    );
    assert!(
        settings.issues()[2].message.starts_with("not valid JSON"),
        "{}",
        settings.issues()[2].message
    );
    assert_eq!(
        settings.statuses()[2..],
        [
            (ids::PROJECT, LayerStatus::Invalid),
            (ids::PROJECT_LOCAL, LayerStatus::Invalid)
        ]
    );
}

#[test]
fn a_reload_reports_changed_keys_and_keeps_the_last_valid_file() {
    let f = Fixture::new("reload");
    write(
        &f.project(),
        r#"{ "model": "a", "permissions": { "deny": ["Bash(rm *)"] } }"#,
    );
    let mut settings = Settings::load(f.table(), TrustState::Trusted);

    write(
        &f.project(),
        r#"{ "model": "b", "permissions": { "deny": ["Bash(rm *)"], "allow": ["Read"] } }"#,
    );
    let change = settings.reload();
    assert_eq!(change.changed, ["/model", "/permissions/allow"]);
    assert!(change.issues.is_empty());

    write(&f.project(), r#"{ "model": "c", "permissions": "oops" }"#);
    let change = settings.reload();
    assert!(
        change.changed.is_empty(),
        "the last valid content stays: {:?}",
        change.changed
    );
    assert_eq!(change.issues.len(), 1);
    assert_eq!(change.issues[0].pointer, "/permissions");
    assert_eq!(settings.get("/model"), Some(&json!("b")));
    assert_eq!(settings.statuses()[2], (ids::PROJECT, LayerStatus::Stale));

    std::fs::remove_file(f.project()).expect("delete");
    let change = settings.reload();
    assert_eq!(
        change.changed,
        ["/model", "/permissions/allow", "/permissions/deny"]
    );
}

#[test]
fn project_executables_wait_for_trust_and_deny_rules_do_not() {
    let f = Fixture::new("trust");
    write(&f.user(), r#"{ "permissions": { "allow": ["Read"] } }"#);
    write(
        &f.project(),
        r#"{ "permissions": { "allow": ["Bash(curl *)"], "deny": ["Bash(rm *)"] },
             "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./audit.sh" }] }] } }"#,
    );
    let mut settings = Settings::load(f.table(), TrustState::Untrusted);
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!(["Read"])),
        "user rules still apply"
    );
    assert_eq!(
        settings.get("/permissions/deny"),
        Some(&json!(["Bash(rm *)"]))
    );
    assert_eq!(settings.get("/hooks"), None);

    let change = settings.set_trust(TrustState::Trusted);
    assert_eq!(change.changed, ["/hooks", "/permissions/allow"]);
    assert_eq!(
        settings.get("/permissions/allow"),
        Some(&json!(["Read", "Bash(curl *)"]))
    );
}

#[test]
fn layers_can_be_inserted_without_changing_the_merge() {
    let f = Fixture::new("insert");
    write(&f.user(), r#"{ "model": "user" }"#);
    write(&f.project(), r#"{ "model": "project" }"#);
    let mut table = f.table();
    // What T24 does for `.claude/settings.json`, and a session layer above everything.
    let claude = f.workspace.join(".claude").join("settings.json");
    std::fs::create_dir_all(claude.parent().expect("dir")).expect("dir");
    write(
        &claude,
        r#"{ "model": "claude", "permissions": { "ask": ["WebFetch"] } }"#,
    );
    table.insert(LayerSpec {
        id: "claudeProject",
        precedence: precedence::CLAUDE_PROJECT,
        scope: Scope::Project,
        source: Source::File(claude),
        format: piarc_config::Format::Piarc,
        schema: &piarc_config::schema::PIARC_SETTINGS,
        writable: false,
        executable: piarc_config::layers::PIARC_EXECUTABLE,
    });
    let order: Vec<&str> = table.layers().iter().map(|l| l.id).collect();
    assert_eq!(
        order,
        [
            "defaults",
            "user",
            "claudeProject",
            "project",
            "projectLocal"
        ]
    );
    let settings = Settings::load(table, TrustState::Trusted);
    assert_eq!(settings.get("/model"), Some(&json!("project")));
    assert_eq!(settings.get("/permissions/ask"), Some(&json!(["WebFetch"])));

    let mut table = f.table();
    table.insert(LayerSpec {
        id: ids::SESSION,
        precedence: precedence::SESSION,
        scope: Scope::Session,
        source: Source::Value(json!({ "model": "session" })),
        format: piarc_config::Format::Piarc,
        schema: &piarc_config::schema::PIARC_SETTINGS,
        writable: false,
        executable: &[],
    });
    assert_eq!(
        Settings::load(table, TrustState::Trusted).get("/model"),
        Some(&json!("session"))
    );
}

#[test]
fn writes_go_only_to_writable_layers_and_replace_the_file_whole() {
    let f = Fixture::new("write");
    let mut table = f.table();
    let path = write_value(
        &table,
        ids::PROJECT_LOCAL,
        "/permissions/allow",
        Some(json!(["Bash(ls)"])),
    )
    .expect("write");
    assert_eq!(path, f.local());
    let written: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(written, json!({ "permissions": { "allow": ["Bash(ls)"] } }));
    write_value(&table, ids::PROJECT_LOCAL, "/model", Some(json!("m"))).expect("write");
    write_value(&table, ids::PROJECT_LOCAL, "/permissions", None).expect("remove");
    let written: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(written, json!({ "model": "m" }));
    let user = write_value(&table, ids::USER, "/model", Some(json!("u"))).expect("user file");
    assert_eq!(user, f.user());

    // No temporary files are left next to the target.
    let leftovers: Vec<String> = std::fs::read_dir(f.workspace.join(".piarc"))
        .expect("list")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // `.claude/` and the defaults are read-only; a file that is not an object is left alone.
    table.insert(LayerSpec {
        id: "claudeProject",
        precedence: precedence::CLAUDE_PROJECT,
        scope: Scope::Project,
        source: Source::File(f.workspace.join(".claude").join("settings.json")),
        format: piarc_config::Format::ClaudeCode,
        schema: &piarc_config::schema::PIARC_SETTINGS,
        writable: false,
        executable: &[],
    });
    let error =
        write_value(&table, "claudeProject", "/model", Some(json!("x"))).expect_err("read-only");
    assert!(
        error.to_string().contains("PiArc does not write it"),
        "{error}"
    );
    let error =
        write_value(&table, ids::DEFAULTS, "/model", Some(json!("x"))).expect_err("defaults");
    assert!(error.to_string().contains("not writable"), "{error}");
    write(&f.project(), "[1, 2]");
    let error =
        write_value(&table, ids::PROJECT, "/model", Some(json!("x"))).expect_err("not an object");
    assert!(error.to_string().contains("not a JSON object"), "{error}");
    assert_eq!(
        std::fs::read_to_string(f.project()).expect("read"),
        "[1, 2]"
    );
}

#[test]
fn project_mode_and_directories_require_confirmation_and_preserve_lower_layers() {
    let f = Fixture::new("permission-trust");
    write(
        &f.user(),
        r#"{"permissions":{"additionalDirectories":["user-directory"]}}"#,
    );
    write(
        &f.project(),
        r#"{"permissions":{"defaultMode":"acceptEdits","additionalDirectories":["project-directory"]}}"#,
    );
    let mut settings = Settings::load(f.table(), TrustState::Untrusted);
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("default"))
    );
    assert_eq!(
        settings.get("/permissions/additionalDirectories"),
        Some(&json!(["user-directory"]))
    );
    let items = piarc_config::enumerate(&f.workspace).items;
    assert_eq!(
        items
            .iter()
            .map(|i| i.name.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        ["acceptEdits", "project-directory"].into()
    );
    settings.set_trust(TrustState::Trusted);
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("acceptEdits"))
    );
    assert_eq!(
        settings.get("/permissions/additionalDirectories"),
        Some(&json!(["user-directory", "project-directory"]))
    );
    for mode in ["auto", "bypassPermissions"] {
        write(
            &f.local(),
            &json!({"permissions":{"defaultMode":mode}}).to_string(),
        );
        settings.reload();
        assert_eq!(
            settings.get("/permissions/defaultMode"),
            Some(&json!("acceptEdits"))
        );
    }
    write(
        &f.user(),
        r#"{"permissions":{"defaultMode":"acceptEdits"}}"#,
    );
    settings.reload();
    settings.set_trust(TrustState::Untrusted);
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("acceptEdits"))
    );
}

#[test]
fn simultaneous_native_confirmations_append_atomically_without_acknowledging_other_entries() {
    use piarc_config::{Category, append_local_permissions};

    let f = Fixture::new("confirm-local");
    write(
        &f.local(),
        r#"{"model":"m","permissions":{"ask":["some rule"]}}"#,
    );
    let table = f.table();
    std::thread::scope(|scope| {
        let mut writers = Vec::new();
        for name in ["Read(a)", "Edit(b)", "Bash(npm test)"] {
            let table = &table;
            writers.push(scope.spawn(move || {
                let confirmed = append_local_permissions(
                    table,
                    &[
                        (Category::AllowRule, name),
                        (Category::AdditionalDirectory, "extra"),
                    ],
                )
                .expect("saved");
                assert_eq!(confirmed.len(), 2);
                assert_eq!(confirmed[0].name, name);
                assert_eq!(confirmed[1].name, "extra");
            }));
        }
        for writer in writers {
            writer.join().expect("writer");
        }
    });
    let settings = Settings::load(table, TrustState::Trusted);
    assert_eq!(
        settings.get("/permissions/additionalDirectories"),
        Some(&json!(["extra"]))
    );
    let rules = settings
        .get("/permissions/allow")
        .expect("rules")
        .as_array()
        .expect("list");
    assert_eq!(rules.len(), 3);
    for rule in ["Read(a)", "Edit(b)", "Bash(npm test)"] {
        assert!(rules.contains(&json!(rule)));
    }
    assert_eq!(settings.get("/model"), Some(&json!("m")));
    assert_eq!(
        settings.get("/permissions/ask"),
        Some(&json!(["some rule"]))
    );
    let original = std::fs::read(f.local()).expect("original");
    let result = append_local_permissions(
        &f.table(),
        &[(Category::AllowRule, "Bash(no)"), (Category::Hook, "hook")],
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read(f.local()).expect("after failure"), original);
}

#[cfg(unix)]
#[test]
fn a_linked_settings_directory_cannot_redirect_persistent_permissions() {
    use piarc_config::{Category, append_local_permissions};

    let f = Fixture::new("local-link");
    let project_dir = f.workspace.join(".piarc");
    std::fs::remove_dir(&project_dir).expect("remove empty fixture directory");
    std::os::unix::fs::symlink(&f.data, &project_dir).expect("create fixture link");
    assert!(append_local_permissions(&f.table(), &[(Category::AllowRule, "Bash(x)")]).is_err());
    assert!(!f.data.join("settings.local.json").exists());
}

/// T23-A07: rule lists come per source in ADR-0005 order; an untrusted project's allow rules
/// are left out while its deny and ask rules stay; project `bypassPermissions`/`auto` never
/// apply and are reported for the audit.
#[test]
fn permission_lists_follow_precedence_and_trust() {
    let f = Fixture::new("permission lists");
    write(
        &f.user(),
        r#"{"permissions":{"allow":["Bash(npm *)"],"deny":["Bash(rm *)"]}}"#,
    );
    write(
        &f.project(),
        r#"{"permissions":{"allow":["Bash(make *)"],"ask":["Bash(git push *)"],"defaultMode":"bypassPermissions"}}"#,
    );
    write(
        &f.local(),
        r#"{"permissions":{"allow":["Read(//etc/**)"],"deny":["Read(.env)"],"defaultMode":"auto"}}"#,
    );
    type Lists = (&'static str, Vec<String>, Vec<String>, Vec<String>);
    let summary = |s: &Settings| -> Vec<Lists> {
        s.permission_lists()
            .into_iter()
            .map(|l| (l.layer, l.deny, l.ask, l.allow))
            .collect()
    };
    let mut settings = Settings::load(f.table(), TrustState::Untrusted);
    let untrusted = summary(&settings);
    let ids: Vec<&str> = untrusted.iter().map(|l| l.0).collect();
    assert_eq!(
        ids,
        [ids::PROJECT_LOCAL, ids::PROJECT, ids::USER, ids::DEFAULTS]
    );
    assert_eq!(untrusted[0].1, ["Read(.env)"]);
    assert!(untrusted[0].3.is_empty() && untrusted[1].3.is_empty());
    assert_eq!(untrusted[1].2, ["Bash(git push *)"]);
    assert_eq!(untrusted[2].3, ["Bash(npm *)"]);
    settings.set_trust(TrustState::Trusted);
    let trusted = summary(&settings);
    assert_eq!(trusted[0].3, ["Read(//etc/**)"]);
    assert_eq!(trusted[1].3, ["Bash(make *)"]);
    // The merged lists keep every source; deny wins at evaluation (piarc-policy).
    assert_eq!(
        settings.get("/permissions/deny"),
        Some(&json!(["Bash(rm *)", "Read(.env)"]))
    );
    assert_eq!(
        settings.get("/permissions/defaultMode"),
        Some(&json!("default"))
    );
    let mut ignored = settings.ignored_modes().to_vec();
    ignored.sort();
    assert_eq!(
        ignored,
        [
            (ids::PROJECT, "bypassPermissions".to_owned()),
            (ids::PROJECT_LOCAL, "auto".to_owned())
        ]
    );
}

/// The Git panel's settings (ADR-0085) come from the user's file only: a project file's `git`
/// object neither applies nor merges, and diagnostics say why.
#[test]
fn git_settings_apply_from_the_user_file_only() {
    let f = Fixture::new("git-settings");
    write(
        &f.user(),
        r#"{"git": {"branchPrefix": "me/", "protectedBranches": ["main"], "pullMode": "rebase",
            "alwaysForcePush": false, "commitInstructions": "Use imperative mood."}}"#,
    );
    write(
        &f.project(),
        r#"{"git": {"protectedBranches": [], "alwaysForcePush": true}}"#,
    );
    let settings = Settings::load(f.table(), TrustState::Trusted);
    assert!(settings.issues().is_empty(), "{:?}", settings.issues());
    assert_eq!(
        settings.user_value("/git/alwaysForcePush"),
        Some(&json!(false))
    );
    assert_eq!(settings.get("/git/alwaysForcePush"), Some(&json!(false)));
    assert_eq!(
        settings.get("/git/protectedBranches"),
        Some(&json!(["main"]))
    );
    let report = settings.diagnostics();
    let project = report
        .iter()
        .find(|r| r.layer == ids::PROJECT)
        .expect("project report");
    for pointer in ["/git/protectedBranches", "/git/alwaysForcePush"] {
        assert!(
            project
                .ignored
                .iter()
                .any(|k| k.pointer == pointer && k.reason == IgnoreReason::ProjectGit),
            "{pointer}: {:?}",
            project.ignored
        );
    }
}
