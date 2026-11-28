//! Which hooks run under the managed settings (T47, design addendum section 5.3).

use std::path::PathBuf;

use piarc_config::managed::{Channel, Family, Managed, RawBody, RawSource};
use piarc_config::{LayerTable, Settings, TrustState};
use piarc_hooks::HookEvent;
use serde_json::{Value, json};

use super::{Scoped, config_with};

fn hook(command: &str) -> Value {
    json!({ "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": command }] }] })
}

fn settings(managed: &Value, user: &Value) -> (Settings, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "piarc-hooks-managed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("data")).unwrap();
    std::fs::create_dir_all(root.join("ws/.piarc")).unwrap();
    std::fs::write(root.join("data/settings.json"), user.to_string()).unwrap();
    std::fs::write(
        root.join("ws/.piarc/settings.json"),
        json!({ "hooks": hook("echo project") }).to_string(),
    )
    .unwrap();
    let managed = Managed::build(
        vec![RawSource {
            family: Family::Piarc,
            channel: Channel::File,
            location: PathBuf::from("managed-settings.json"),
            body: RawBody::Text(managed.to_string().into_bytes()),
        }],
        None,
    );
    let mut table = LayerTable::workspace(&root.join("data"), &root.join("ws"), None);
    table.insert(managed.layer());
    (Settings::load(table, TrustState::Trusted), root)
}

fn commands(config: &piarc_hooks::HookConfig) -> Vec<String> {
    config
        .select(HookEvent::PreToolUse, Some("Bash"))
        .iter()
        .map(|h| match &h.action {
            piarc_hooks::Action::Command(c) => c.command.clone(),
            _ => String::new(),
        })
        .collect()
}

fn skill() -> Scoped {
    Scoped {
        key: "skill:deploy".into(),
        layer: "skill",
        file: None,
        hooks: hook("echo skill"),
    }
}

/// T47-A08's configuration: with `allowManagedHooksOnly` the managed hooks run; the user's,
/// the project's and a skill's are left for the audit.
#[test]
fn managed_only_runs_the_managed_hooks_and_lists_the_others() {
    let (s, root) = settings(
        &json!({ "allowManagedHooksOnly": true, "hooks": hook("echo managed") }),
        &json!({ "hooks": hook("echo user") }),
    );
    let configs = config_with(&s, &[skill()]);
    assert_eq!(commands(&configs.run), vec!["echo managed"]);
    let mut skipped = commands(configs.skipped.as_ref().unwrap());
    skipped.sort();
    assert_eq!(skipped, vec!["echo project", "echo skill", "echo user"]);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn disable_all_hooks_outside_managed_settings_keeps_the_managed_hooks() {
    let (s, root) = settings(
        &json!({ "hooks": hook("echo managed") }),
        &json!({ "hooks": hook("echo user"), "disableAllHooks": true }),
    );
    let configs = config_with(&s, &[]);
    assert_eq!(commands(&configs.run), vec!["echo managed"]);
    assert!(configs.skipped.is_none());
    let _ = std::fs::remove_dir_all(root);

    let (s, root) = settings(
        &json!({ "hooks": hook("echo managed"), "disableAllHooks": true }),
        &json!({ "hooks": hook("echo user") }),
    );
    assert!(commands(&config_with(&s, &[]).run).is_empty());
    let _ = std::fs::remove_dir_all(root);

    // Without managed settings, everything runs as before.
    let (s, root) = settings(&json!({}), &json!({ "hooks": hook("echo user") }));
    let mut all = commands(&config_with(&s, &[skill()]).run);
    all.sort();
    assert_eq!(all, vec!["echo project", "echo skill", "echo user"]);
    let _ = std::fs::remove_dir_all(root);
}
