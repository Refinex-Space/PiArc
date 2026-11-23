//! Auto mode's settings (T46, design addendum `docs/architecture/addenda/T46-auto-mode.md`
//! section 7).
//!
//! - `permissions.enableAutoMode` makes the mode available; only PiArc's user file counts
//!   (Claude Code has no such switch).
//! - `autoMode.model` (`provider/model`, no alias) is read from PiArc's user file only.
//! - `autoMode.environment`, `allow`, `soft_deny`, `hard_deny` come from PiArc's user file and
//!   `~/.claude/settings.json`, joined in that order without duplicates; `"$defaults"` is
//!   accepted and skipped (the default categories always apply).
//! - `disableAutoMode: "disable"` in any layer turns the mode off: it only tightens.
//! - A project file's `permissions.enableAutoMode` and `autoMode` never apply ([`USER_ONLY`],
//!   removed before the merge and reported as `projectAutoMode`); its `defaultMode: "auto"`
//!   is left out like `bypassPermissions`.
//! - Managed settings (T47) decide before the user's file: their `permissions.enableAutoMode`
//!   and `autoMode.model` replace the user's ([`Settings::user_value`]), their lists come
//!   first, and their `disableAutoMode` or `enableAutoMode: false` locks the mode off.

use serde_json::Value;

use crate::{Settings, ids};

/// The pointers a project layer cannot set.
pub const USER_ONLY: &[&str] = &["/permissions/enableAutoMode", "/autoMode"];

/// The longest policy entry kept, in characters.
pub const ENTRY_CHARS: usize = 500;

/// The most characters of all four lists together; later entries are left out.
pub const POLICY_CHARS: usize = 8_000;

/// What Auto mode reads from the settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoModeSettings {
    /// The user turned the mode on in PiArc's user file (or managed settings did).
    pub enabled: bool,
    /// Managed settings decide the switch (T47): the user cannot change it.
    pub managed: bool,
    /// Some layer sets `disableAutoMode: "disable"`.
    pub disabled: bool,
    /// The reviewer model, `provider/model`, from PiArc's user file.
    pub model: Option<String>,
    /// Trusted infrastructure.
    pub environment: Vec<String>,
    /// Exceptions to the soft blocks.
    pub allow: Vec<String>,
    /// Added soft blocks.
    pub soft_deny: Vec<String>,
    /// Added hard blocks.
    pub hard_deny: Vec<String>,
}

impl AutoModeSettings {
    /// Whether a session may be in Auto mode.
    #[must_use]
    pub fn available(&self) -> bool {
        self.enabled && !self.disabled
    }
}

/// Reads Auto mode's settings.
#[must_use]
pub fn read(settings: &Settings) -> AutoModeSettings {
    let user = settings.layer(ids::USER);
    let claude = settings.layer(ids::CLAUDE_USER);
    let managed = settings.managed();
    let enabled = settings
        .user_value("/permissions/enableAutoMode")
        .and_then(Value::as_bool)
        == Some(true);
    let disabled = settings.get("/disableAutoMode").and_then(Value::as_str) == Some("disable");
    let locked = managed.is_some_and(|m| {
        m.pointer("/permissions/enableAutoMode").is_some() || m.get("disableAutoMode").is_some()
    });
    let model = settings
        .user_value("/autoMode/model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let mut budget = POLICY_CHARS;
    let mut list = |key: &str| {
        let mut out: Vec<String> = Vec::new();
        for layer in [managed, user, claude].into_iter().flatten() {
            let entries = layer
                .pointer(&format!("/autoMode/{key}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            for entry in entries {
                let entry: String = entry.trim().chars().take(ENTRY_CHARS).collect();
                let size = entry.chars().count();
                if entry.is_empty() || entry == "$defaults" || out.contains(&entry) {
                    continue;
                }
                if size > budget {
                    budget = 0;
                    continue;
                }
                budget -= size;
                out.push(entry);
            }
        }
        out
    };
    AutoModeSettings {
        enabled,
        managed: locked,
        disabled,
        model,
        environment: list("environment"),
        allow: list("allow"),
        soft_deny: list("soft_deny"),
        hard_deny: list("hard_deny"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayerTable, TrustState};
    use serde_json::json;
    use std::path::Path;

    fn write(path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, value.to_string()).expect("write");
    }

    struct Files {
        root: std::path::PathBuf,
        data: std::path::PathBuf,
        workspace: std::path::PathBuf,
        home: std::path::PathBuf,
    }

    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn files(name: &str) -> Files {
        let root = std::env::temp_dir().join(format!(
            "piarc-config auto 自动 {name} {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let files = Files {
            data: root.join("data"),
            workspace: root.join("work space"),
            home: root.join("home"),
            root,
        };
        std::fs::create_dir_all(&files.workspace).expect("workspace");
        files
    }

    fn load(f: &Files, trust: TrustState) -> Settings {
        let table = LayerTable::workspace(&f.data, &f.workspace, Some(&f.home));
        Settings::load(table, trust)
    }

    #[test]
    fn only_the_user_files_enable_and_configure_it() {
        let f = files("user");
        let project = json!({
            "permissions": {"enableAutoMode": true, "defaultMode": "auto"},
            "autoMode": {"model": "lax/any", "allow": ["anything goes"], "environment": ["evil.example"]}
        });
        for file in [
            ".piarc/settings.json",
            ".piarc/settings.local.json",
            ".claude/settings.json",
            ".claude/settings.local.json",
        ] {
            write(&f.workspace.join(file), &project);
        }
        let settings = load(&f, TrustState::Trusted);
        assert_eq!(read(&settings), AutoModeSettings::default());
        // The built-in default stays; no project file selects `auto`.
        assert_eq!(
            settings.get("/permissions/defaultMode"),
            Some(&json!("default"))
        );
        project_keys_are_reported(&settings);

        write(
            &f.data.join("settings.json"),
            &json!({"permissions": {"enableAutoMode": true},
                "autoMode": {"model": " rev/model ", "environment": ["github.com/acme", "$defaults"],
                    "allow": ["npm publish of @acme packages"]}}),
        );
        write(
            &f.home.join(".claude/settings.json"),
            &json!({"permissions": {"enableAutoMode": true},
                "autoMode": {"model": "other/model", "environment": ["$defaults", "github.com/acme", "s3://acme-logs"],
                    "hard_deny": ["Deleting cloud buckets"], "classifyAllShell": true}}),
        );
        let settings = load(&f, TrustState::Trusted);
        let auto = read(&settings);
        assert!(auto.enabled && !auto.disabled && auto.available() && !auto.managed);
        assert_eq!(auto.model.as_deref(), Some("rev/model"));
        assert_eq!(auto.environment, ["github.com/acme", "s3://acme-logs"]);
        assert_eq!(auto.allow, ["npm publish of @acme packages"]);
        assert_eq!(auto.hard_deny, ["Deleting cloud buckets"]);
        assert!(auto.soft_deny.is_empty());

        // Managed settings (T47) lock the switch off and add their policy first.
        let managed = crate::managed::Managed::build(
            vec![crate::managed::RawSource {
                family: crate::managed::Family::Piarc,
                channel: crate::managed::Channel::Policy,
                location: "policy".into(),
                body: crate::managed::RawBody::Value(json!({
                    "permissions": {"enableAutoMode": false},
                    "autoMode": {"hard_deny": ["Organization rule"]}
                })),
            }],
            None,
        );
        let mut table = LayerTable::workspace(&f.data, &f.workspace, Some(&f.home));
        table.insert(managed.layer());
        let auto = read(&Settings::load(table, TrustState::Trusted));
        assert!(!auto.enabled && auto.managed && !auto.available());
        assert_eq!(
            auto.hard_deny,
            ["Organization rule", "Deleting cloud buckets"]
        );
    }

    /// Every project file's keys are reported as ignored for this reason.
    fn project_keys_are_reported(settings: &Settings) {
        let report = settings.diagnostics();
        for layer in [
            ids::PROJECT,
            ids::PROJECT_LOCAL,
            ids::CLAUDE_PROJECT,
            ids::CLAUDE_PROJECT_LOCAL,
        ] {
            let file = report
                .iter()
                .find(|r| r.layer == layer)
                .expect("project file");
            let reasons: Vec<_> = file
                .ignored
                .iter()
                .map(|k| (k.pointer.as_str(), k.reason))
                .collect();
            assert!(
                reasons.contains(&(
                    "/autoMode/model",
                    crate::diagnostics::IgnoreReason::ProjectAutoMode
                )) || layer.starts_with("claude"),
                "{layer}: {reasons:?}"
            );
            assert!(
                reasons.contains(&(
                    "/autoMode/allow",
                    crate::diagnostics::IgnoreReason::ProjectAutoMode
                )),
                "{layer}: {reasons:?}"
            );
            assert!(
                reasons.contains(&(
                    "/permissions/defaultMode",
                    crate::diagnostics::IgnoreReason::ProjectMode
                )),
                "{layer}: {reasons:?}"
            );
        }
        let piarc = report
            .iter()
            .find(|r| r.layer == ids::PROJECT)
            .expect("project");
        assert!(
            piarc
                .ignored
                .iter()
                .any(|k| k.pointer == "/permissions/enableAutoMode"
                    && k.reason == crate::diagnostics::IgnoreReason::ProjectAutoMode)
        );
    }

    #[test]
    fn any_layer_turns_it_off_and_entries_are_bounded() {
        let f = files("bounds");
        let long = "x".repeat(ENTRY_CHARS + 50);
        let many: Vec<String> = (0..40)
            .map(|n| format!("{n:03}{}", "y".repeat(400)))
            .collect();
        write(
            &f.data.join("settings.json"),
            &json!({"permissions": {"enableAutoMode": true},
                "autoMode": {"allow": [long], "soft_deny": many}}),
        );
        write(
            &f.workspace.join(".claude/settings.json"),
            &json!({"disableAutoMode": "disable"}),
        );
        let auto = read(&load(&f, TrustState::Untrusted));
        assert!(auto.enabled && auto.disabled && !auto.available());
        assert_eq!(auto.allow[0].chars().count(), ENTRY_CHARS);
        let total: usize = [&auto.allow, &auto.soft_deny]
            .iter()
            .flat_map(|l| l.iter())
            .map(|e| e.chars().count())
            .sum();
        assert!(total <= POLICY_CHARS, "{total}");
        assert!(auto.soft_deny.len() < 40);
    }
}
