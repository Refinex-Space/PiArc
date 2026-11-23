use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::layers::{LayerTable, Scope};
use crate::settings::Settings;
use crate::trust::TrustState;

fn text(family: Family, channel: Channel, location: &str, value: &Value) -> RawSource {
    RawSource {
        family,
        channel,
        location: PathBuf::from(location),
        body: RawBody::Text(serde_json::to_vec(value).unwrap()),
    }
}

fn raw_text(location: &str, text: &str) -> RawSource {
    RawSource {
        family: Family::Piarc,
        channel: Channel::File,
        location: PathBuf::from(location),
        body: RawBody::Text(text.as_bytes().to_vec()),
    }
}

#[test]
fn higher_documents_win_scalars_lists_concatenate_and_locks_take_the_strictest() {
    let managed = Managed::build(
        vec![
            text(
                Family::Piarc,
                Channel::Policy,
                "policy",
                &json!({
                    "permissions": { "defaultMode": "plan", "deny": ["Bash(rm *)"] },
                    "allowManagedHooksOnly": false,
                    "mcpServers": { "a": { "type": "http", "url": "https://policy.example" } },
                }),
            ),
            text(
                Family::Piarc,
                Channel::File,
                "file",
                &json!({
                    "permissions": { "defaultMode": "acceptEdits", "deny": ["Read(.env)"] },
                    "allowManagedHooksOnly": true,
                    "mcpServers": { "a": { "type": "stdio", "command": "x" }, "b": { "command": "y" } },
                }),
            ),
            text(
                Family::ClaudeCode,
                Channel::File,
                "claude",
                &json!({
                    "permissions": { "disableBypassPermissionsMode": "disable", "deny": ["WebFetch"] },
                    "allowManagedMcpServersOnly": true,
                    "allowedMcpServers": [{ "serverName": "low" }],
                    "theme": "dark",
                }),
            ),
        ],
        None,
    );
    assert_eq!(managed.errors().count(), 0);
    let v = &managed.value;
    assert_eq!(v["permissions"]["defaultMode"], "plan");
    assert_eq!(
        v["permissions"]["deny"],
        json!(["WebFetch", "Read(.env)", "Bash(rm *)"])
    );
    // The file turned the lock on; the policy's `false` does not undo it.
    assert_eq!(v["allowManagedHooksOnly"], true);
    assert_eq!(v["permissions"]["enableBypassPermissions"], false);
    // An MCP server of the same name is the highest document's whole definition.
    assert_eq!(
        v["mcpServers"]["a"],
        json!({ "type": "http", "url": "https://policy.example" })
    );
    assert_eq!(v["mcpServers"]["b"], json!({ "command": "y" }));
    assert_eq!(v["allowedMcpServers"], json!([{ "serverName": "low" }]));
    // Claude Code keys PiArc does not use are reported, not merged.
    let claude = &managed.sources[2];
    assert!(claude.ignored.iter().any(|i| i.pointer == "/theme"));
    assert!(v.get("theme").is_none());
}

#[test]
fn an_allowlist_under_its_lock_is_the_highest_documents_whole_list() {
    let managed = Managed::build(
        vec![
            text(
                Family::Piarc,
                Channel::Policy,
                "high",
                &json!({ "sandbox": { "network": { "allowedDomains": ["a.example"], "allowManagedDomainsOnly": true } } }),
            ),
            text(
                Family::Piarc,
                Channel::File,
                "low",
                &json!({ "sandbox": { "network": { "allowedDomains": ["b.example"] } }, "allowedMcpServers": [{ "serverName": "x" }] }),
            ),
        ],
        None,
    );
    assert_eq!(
        managed.value["sandbox"]["network"]["allowedDomains"],
        json!(["a.example"])
    );
    // Without its lock, an allowlist merges like any list.
    assert_eq!(
        managed.value["allowedMcpServers"],
        json!([{ "serverName": "x" }])
    );
}

#[test]
fn a_document_that_is_not_an_object_is_an_error_and_later_keeps_its_last_content() {
    let first = Managed::build(vec![raw_text("f", "{\"model\": \"a/b\"")], None);
    let errors: Vec<_> = first.errors().collect();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].issues[0].line, Some(1));
    for broken in ["[1, 2]", "\"text\""] {
        assert_eq!(
            Managed::build(vec![raw_text("f", broken)], None)
                .errors()
                .count(),
            1
        );
    }
    // Absent, empty and unreadable documents are not errors.
    let empty = Managed::build(
        vec![
            raw_text("e", "  \n"),
            RawSource {
                family: Family::Piarc,
                channel: Channel::Policy,
                location: PathBuf::from("denied"),
                body: RawBody::Unreadable("permission denied".into()),
            },
        ],
        None,
    );
    assert_eq!(empty.errors().count(), 0);
    assert!(empty.is_empty());
    assert_eq!(empty.sources[1].status, SourceStatus::Unreadable);

    let good = Managed::build(vec![raw_text("f", "{\"model\": \"a/b\"}")], None);
    let later = Managed::build(vec![raw_text("f", "{oops")], Some(&good));
    assert_eq!(later.errors().count(), 0);
    assert_eq!(later.sources[0].status, SourceStatus::Stale);
    assert_eq!(later.value["model"], "a/b");
    assert!(!later.sources[0].issues.is_empty());
}

#[test]
fn a_wrong_type_drops_the_key_and_locks_read_as_restrictive() {
    let managed = Managed::build(
        vec![raw_text(
            "f",
            r#"{
                "allowManagedHooksOnly": "yes",
                "permissions": { "enableBypassPermissions": 1, "defaultMode": 3, "deny": ["Bash"] },
                "disableAutoMode": "maybe",
                "allowedMcpServers": [{ "serverName": "ok" }, { "serverName": 4 }, { "serverName": "a", "serverUrl": "b" }],
                "deniedMcpServers": "nope",
                "autoCompactWindow": "big"
            }"#,
        )],
        None,
    );
    assert_eq!(managed.errors().count(), 0);
    let v = &managed.value;
    assert_eq!(v["allowManagedHooksOnly"], true);
    assert_eq!(v["permissions"]["enableBypassPermissions"], false);
    assert_eq!(v["disableAutoMode"], "disable");
    assert!(v["permissions"].get("defaultMode").is_none());
    assert_eq!(v["permissions"]["deny"], json!(["Bash"]));
    assert_eq!(v["allowedMcpServers"], json!([{ "serverName": "ok" }]));
    assert!(v.get("deniedMcpServers").is_none());
    assert!(v.get("autoCompactWindow").is_none());
    assert!(managed.sources[0].issues.len() >= 6);

    let list = Managed::build(vec![raw_text("f", r#"{"allowedMcpServers": {}}"#)], None);
    assert_eq!(list.value["allowedMcpServers"], json!([]));
}

#[test]
fn property_list_values_are_checked_like_json() {
    let managed = Managed::build(
        vec![RawSource {
            family: Family::ClaudeCode,
            channel: Channel::Policy,
            location: PathBuf::from("/Library/Managed Preferences/com.anthropic.claudecode.plist"),
            body: RawBody::Value(
                json!({ "permissions": { "deny": ["Bash(curl *)"] }, "cleanupPeriodDays": null }),
            ),
        }],
        None,
    );
    assert_eq!(
        managed.value["permissions"]["deny"],
        json!(["Bash(curl *)"])
    );
    let broken = Managed::build(
        vec![RawSource {
            family: Family::Piarc,
            channel: Channel::Policy,
            location: PathBuf::from("p"),
            body: RawBody::Invalid("bad header".into()),
        }],
        None,
    );
    assert_eq!(broken.errors().count(), 1);
}

#[test]
fn locked_covers_set_values_their_parents_and_the_lists_a_lock_takes_over() {
    let managed = json!({
        "permissions": { "defaultMode": "plan", "allow": ["Read"] },
        "sandbox": { "enabled": true },
        "allowManagedHooksOnly": true,
    });
    let m = Some(&managed);
    assert!(locked(m, "/permissions/defaultMode"));
    assert!(locked(m, "/sandbox"));
    assert!(locked(m, "/sandbox/enabled"));
    assert!(locked(m, "/hooks"));
    assert!(locked(m, "/hooks/PreToolUse"));
    // A list the managed settings only contribute to stays editable.
    assert!(!locked(m, "/permissions/allow"));
    assert!(!locked(m, "/permissions/ask"));
    assert!(!locked(m, "/sandbox/autoAllowBashIfSandboxed"));
    assert!(!locked(m, "/model"));
    assert!(!locked(None, "/permissions/defaultMode"));
    let rules = json!({ "allowManagedPermissionRulesOnly": true });
    assert!(locked(Some(&rules), "/permissions/allow"));
    assert!(locked(Some(&rules), "/permissions/deny"));
    assert!(!locked(Some(&rules), "/permissions/defaultMode"));
}

struct Dirs {
    root: PathBuf,
}

impl Dirs {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc-managed-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("ws/.piarc")).unwrap();
        std::fs::create_dir_all(root.join("ws/.claude")).unwrap();
        std::fs::create_dir_all(root.join("home/.claude")).unwrap();
        Self { root }
    }

    fn write(&self, relative: &str, value: &Value) {
        std::fs::write(self.root.join(relative), serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn table(&self, managed: &Managed, session: Value) -> LayerTable {
        let mut table = LayerTable::workspace(
            &self.root.join("data"),
            &self.root.join("ws"),
            Some(&self.root.join("home")),
        );
        table.insert(crate::layers::LayerSpec {
            id: crate::layers::ids::SESSION,
            precedence: crate::layers::precedence::SESSION,
            scope: Scope::Session,
            source: crate::layers::Source::Value(session),
            format: crate::layers::Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: false,
            executable: crate::layers::PIARC_EXECUTABLE,
        });
        table.insert(managed.layer());
        table
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn path(p: &Path) -> String {
    p.display().to_string()
}

/// T47-A07: the same key in the session, project, user and managed layers; the managed value
/// wins; lists merge and the managed deny is in the lists.
#[test]
fn the_managed_layer_wins_over_session_project_and_user_and_lists_merge() {
    let dirs = Dirs::new("matrix");
    let each = |mode: &str, deny: &str| json!({ "permissions": { "defaultMode": mode, "deny": [deny] }, "model": format!("p/{mode}") });
    dirs.write("data/settings.json", &each("acceptEdits", "Read(user)"));
    dirs.write(
        "home/.claude/settings.json",
        &each("acceptEdits", "Read(claude-user)"),
    );
    dirs.write("ws/.piarc/settings.json", &each("default", "Read(project)"));
    dirs.write(
        "ws/.piarc/settings.local.json",
        &each("default", "Read(local)"),
    );
    dirs.write(
        "ws/.claude/settings.json",
        &each("default", "Read(claude-project)"),
    );
    let managed = Managed::build(
        vec![text(
            Family::Piarc,
            Channel::File,
            "managed",
            &each("plan", "Bash(curl *)"),
        )],
        None,
    );
    for trust in [TrustState::Trusted, TrustState::Untrusted] {
        let settings = Settings::load(
            dirs.table(&managed, each("acceptEdits", "Read(session)")),
            trust,
        );
        assert_eq!(
            settings.get("/permissions/defaultMode"),
            Some(&json!("plan")),
            "{trust:?}"
        );
        assert_eq!(settings.get("/model"), Some(&json!("p/plan")));
        let deny = settings
            .get("/permissions/deny")
            .unwrap()
            .as_array()
            .unwrap();
        for rule in [
            "Bash(curl *)",
            "Read(session)",
            "Read(local)",
            "Read(project)",
            "Read(user)",
        ] {
            assert!(deny.contains(&json!(rule)), "{rule} in {deny:?}");
        }
        let lists = settings.permission_lists();
        assert_eq!(lists[0].layer, "enterprise");
        assert_eq!(lists[0].scope, Scope::Enterprise);
        assert_eq!(lists[0].deny, vec!["Bash(curl *)".to_owned()]);
        assert!(settings.is_locked("/permissions/defaultMode"));
        assert!(settings.is_locked("/model"));
        assert!(!settings.is_locked("/permissions/deny"));
    }
    let _ = path(&dirs.root);
}

#[test]
fn only_managed_settings_set_the_locks_and_a_project_only_turns_memory_off() {
    let dirs = Dirs::new("only");
    dirs.write(
        "data/settings.json",
        &json!({ "allowManagedHooksOnly": true, "autoMemoryEnabled": false, "permissions": { "enableBypassPermissions": true } }),
    );
    dirs.write(
        "ws/.piarc/settings.json",
        &json!({ "autoMemoryEnabled": true }),
    );
    dirs.write(
        "ws/.claude/settings.json",
        &json!({ "allowManagedPermissionRulesOnly": true, "sandbox": { "network": { "allowManagedDomainsOnly": true } } }),
    );
    let none = Managed::default();
    let settings = Settings::load(dirs.table(&none, json!({})), TrustState::Trusted);
    assert_eq!(settings.get("/allowManagedHooksOnly"), None);
    assert_eq!(settings.get("/allowManagedPermissionRulesOnly"), None);
    assert_eq!(
        settings.get("/sandbox/network/allowManagedDomainsOnly"),
        None
    );
    // The project's `true` does not undo the user's `false`.
    assert_eq!(settings.get("/autoMemoryEnabled"), Some(&json!(false)));
    let reports = settings.diagnostics();
    let reason = |layer: &str, pointer: &str| {
        reports
            .iter()
            .find(|r| r.layer == layer)
            .and_then(|r| r.ignored.iter().find(|i| i.pointer == pointer))
            .map(|i| i.reason)
    };
    assert_eq!(
        reason("user", "/allowManagedHooksOnly"),
        Some(IgnoreReason::ManagedOnly)
    );
    assert_eq!(
        reason("project", "/autoMemoryEnabled"),
        Some(IgnoreReason::ProjectMemory)
    );
    assert_eq!(
        reason("claudeProject", "/allowManagedPermissionRulesOnly"),
        Some(IgnoreReason::ManagedOnly)
    );
    assert_eq!(
        settings.user_value("/permissions/enableBypassPermissions"),
        Some(&json!(true))
    );

    let managed = Managed::build(
        vec![text(
            Family::Piarc,
            Channel::Policy,
            "policy",
            &json!({ "allowManagedPermissionRulesOnly": true, "permissions": { "allow": ["Read"], "enableBypassPermissions": false } }),
        )],
        None,
    );
    dirs.write(
        "data/settings.json",
        &json!({ "permissions": { "allow": ["Bash(ls)"], "enableBypassPermissions": true } }),
    );
    let settings = Settings::load(
        dirs.table(&managed, json!({ "permissions": { "allow": ["Edit"] } })),
        TrustState::Trusted,
    );
    let lists = settings.permission_lists();
    assert_eq!(lists.len(), 1);
    assert_eq!(lists[0].allow, vec!["Read".to_owned()]);
    assert!(settings.managed_rules_only());
    assert!(settings.is_locked("/permissions/allow"));
    assert_eq!(
        settings.user_value("/permissions/enableBypassPermissions"),
        Some(&json!(false))
    );
}

#[test]
fn the_reports_name_each_document_and_who_decides_a_key() {
    let managed = Managed::build(
        vec![
            text(
                Family::Piarc,
                Channel::Policy,
                "high",
                &json!({ "model": "a/high" }),
            ),
            text(
                Family::ClaudeCode,
                Channel::File,
                "low",
                &json!({ "model": "a/low", "permissions": { "ask": ["Bash"] }, "spinnerTipsEnabled": false }),
            ),
        ],
        None,
    );
    let reports = managed.reports();
    assert_eq!(reports.len(), 2);
    assert!(
        reports
            .iter()
            .all(|r| r.kind == SourceKind::Enterprise && r.scope == Scope::Enterprise)
    );
    assert_eq!(reports[0].effective[0].pointer, "/model");
    let low = &reports[1];
    assert_eq!(low.overridden[0].pointer, "/model");
    assert_eq!(
        low.overridden[0].source_file.as_deref(),
        Some(Path::new("high"))
    );
    assert!(
        low.effective
            .iter()
            .any(|k| k.pointer == "/permissions/ask")
    );
    assert!(
        low.ignored
            .iter()
            .any(|i| i.pointer == "/spinnerTipsEnabled")
    );
    assert_eq!(
        managed.pointers(),
        vec!["/model".to_owned(), "/permissions/ask".to_owned()]
    );
}
