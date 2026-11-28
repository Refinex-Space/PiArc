use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_config::IgnoreReason;
use piarc_config::managed::SourceStatus;
use serde_json::json;

use super::store::{FixedPolicy, Layout};
use super::*;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/managed")
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "piarc-managed-core-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn config(policy: FixedPolicy) -> ManagedConfig {
    ManagedConfig {
        store: Some(Arc::new(policy)),
        poll: Duration::from_millis(50),
    }
}

fn fixed(layout: Option<Layout>) -> FixedPolicy {
    FixedPolicy {
        layout,
        preferences: None,
        user: None,
        registry: None,
    }
}

/// T47-A10: Claude Code's managed files in the macOS and the Windows layout are read; the keys
/// PiArc supports apply, the others are reported as ignored.
#[test]
fn claude_codes_managed_files_load_in_both_layouts() {
    for layout in [
        Layout::MacOs(fixtures().join("macos")),
        Layout::Windows(fixtures().join("windows").join("Program Files")),
    ] {
        let managed = ManagedSettings::load(&config(fixed(Some(layout.clone())))).unwrap();
        let snapshot = managed.snapshot();
        let v = &snapshot.managed.value;
        // PiArc's own file is higher than Claude Code's: its `plan` wins.
        assert_eq!(v["permissions"]["defaultMode"], "plan", "{layout:?}");
        assert_eq!(v["autoMemoryEnabled"], false);
        assert_eq!(v["model"], "anthropic/claude-sonnet-5-5");
        let deny = v["permissions"]["deny"].as_array().unwrap();
        for rule in [
            "Bash(curl *)",
            "WebFetch(domain:paste.example.com)",
            "Read(./.env)",
        ] {
            assert!(deny.contains(&json!(rule)), "{rule}");
        }
        assert_eq!(v["permissions"]["ask"], json!(["Bash(git push *)"]));
        assert_eq!(v["permissions"]["enableBypassPermissions"], false);
        assert_eq!(v["allowManagedHooksOnly"], true);
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        assert_eq!(
            v["deniedMcpServers"],
            json!([{ "serverName": "untrusted-db" }])
        );
        assert_eq!(v["sandbox"]["network"]["allowManagedDomainsOnly"], true);
        for ignored in [
            "cleanupPeriodDays",
            "forceLoginMethod",
            "companyAnnouncements",
            "policyHelper",
        ] {
            assert!(v.get(ignored).is_none(), "{ignored}");
        }
        let reports = snapshot.managed.reports();
        let claude: Vec<_> = reports
            .iter()
            .filter(|r| r.format == piarc_config::Format::ClaudeCode)
            .collect();
        // The drop-in first (it is higher), then managed-settings.json.
        assert_eq!(claude.len(), 2);
        assert!(claude[0].file.ends_with("10-model.json"));
        assert!(claude[1].file.ends_with("managed-settings.json"));
        let ignored: Vec<_> = claude[1]
            .ignored
            .iter()
            .map(|i| (i.pointer.as_str(), i.reason))
            .collect();
        for (pointer, reason) in [
            ("/cleanupPeriodDays", IgnoreReason::Ignored),
            ("/forceLoginMethod", IgnoreReason::Ignored),
            ("/companyAnnouncements", IgnoreReason::Ignored),
            ("/strictKnownMarketplaces", IgnoreReason::Ignored),
        ] {
            assert!(
                ignored.contains(&(pointer, reason)),
                "{pointer} in {ignored:?}"
            );
        }
        assert!(
            claude[0]
                .ignored
                .iter()
                .any(|i| i.pointer == "/policyHelper")
        );
        // `defaultMode` of Claude Code's file is overridden by PiArc's.
        assert!(
            claude[1]
                .overridden
                .iter()
                .any(|k| k.pointer == "/permissions/defaultMode")
        );
        assert_eq!(snapshot.memory.len(), 1);
        assert!(snapshot.memory[0].ends_with(Path::new("ClaudeCode").join("CLAUDE.md")));
        let mcp = snapshot.mcp.as_ref().unwrap();
        assert!(mcp.servers.as_ref().unwrap().get("corp-docs").is_some());
        assert!(mcp.problem.is_none());
    }
}

#[test]
fn an_invalid_document_stops_core_and_a_later_one_keeps_the_last_content() {
    let root = temp("invalid");
    let dir = store::macos_files_dir(&root, PolicyProduct::Piarc);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(SETTINGS_FILE);
    std::fs::write(&file, "{ \"model\": ").unwrap();
    let policy = fixed(Some(Layout::MacOs(root.clone())));
    match ManagedSettings::load(&config(policy.clone())) {
        Err(Error::ManagedSettings { location, line, .. }) => {
            assert_eq!(location, file.display().to_string());
            assert_eq!(line, Some(1));
        }
        other => panic!("expected the managed settings error, got {other:?}"),
    }
    std::fs::write(&file, r#"{ "model": "a/one" }"#).unwrap();
    let managed = ManagedSettings::load(&config(policy)).unwrap();
    let mut changes = managed.changes();
    assert!(!managed.refresh(), "nothing changed yet");
    std::fs::write(&file, r#"{ "model": "a/two" }"#).unwrap();
    assert!(managed.refresh());
    assert!(changes.has_changed().unwrap());
    changes.mark_unchanged();
    assert_eq!(managed.snapshot().managed.value["model"], "a/two");
    std::fs::write(&file, "[]").unwrap();
    assert!(managed.refresh());
    let snapshot = managed.snapshot();
    assert_eq!(snapshot.managed.sources[0].status, SourceStatus::Stale);
    assert_eq!(snapshot.managed.value["model"], "a/two");
    std::fs::remove_file(&file).unwrap();
    assert!(managed.refresh());
    assert!(managed.snapshot().layer().is_none());
    let _ = std::fs::remove_dir_all(root);
}

/// T47-A09: configuration in places that are not the administrator's gets no managed
/// precedence: a managed-settings.json in the data or home directory, user preferences,
/// `C:\ProgramData`.
#[test]
fn places_the_user_can_write_are_not_read() {
    let root = temp("places");
    let home = root.join("home");
    let data = home.join("Library/Application Support/PiArc");
    for dir in [
        data.clone(),
        home.join("Library/Preferences"),
        root.join("ProgramData/PiArc"),
        root.join("admin"),
    ] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let deny = r#"{ "permissions": { "deny": ["Bash"] }, "allowManagedHooksOnly": true }"#;
    std::fs::write(data.join(SETTINGS_FILE), deny).unwrap();
    std::fs::write(home.join(SETTINGS_FILE), deny).unwrap();
    std::fs::write(root.join("ProgramData/PiArc").join(SETTINGS_FILE), deny).unwrap();
    std::fs::write(
        home.join("Library/Preferences/cn.piarc.desktop.plist"),
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<plist version="1.0"><dict><key>allowManagedHooksOnly</key><true/></dict></plist>"#
        ),
    )
    .unwrap();
    // The administrator's places are elsewhere and empty.
    let managed = ManagedSettings::load(&config(FixedPolicy {
        layout: Some(Layout::MacOs(root.join("admin"))),
        preferences: Some(root.join("admin/Managed Preferences")),
        user: Some("someone".into()),
        registry: None,
    }))
    .unwrap();
    assert!(!managed.snapshot().configured());
    // The system store's places are the administrator's only.
    let product = PolicyProduct::Piarc;
    assert_eq!(
        store::macos_files_dir(Path::new("/"), product),
        Path::new("/Library/Application Support/PiArc")
    );
    assert_eq!(
        store::windows_files_dir(Path::new(r"C:\Program Files"), product),
        Path::new(r"C:\Program Files").join("PiArc")
    );
    assert_eq!(store::policy_key(product), r"SOFTWARE\Policies\PiArc");
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "macos")]
#[test]
fn managed_preferences_read_the_user_channel_before_the_device_channel() {
    use piarc_config::managed::{Channel, Family};
    let root = temp("prefs");
    let prefs = root.join("Managed Preferences");
    std::fs::create_dir_all(prefs.join("ana")).unwrap();
    let write = |path: PathBuf, model: &str, binary: bool| {
        let value = plist::Value::Dictionary(
            [
                ("model".to_owned(), plist::Value::String(model.into())),
                (
                    "permissions".to_owned(),
                    plist::Value::Dictionary(
                        [(
                            "deny".to_owned(),
                            plist::Value::Array(vec![plist::Value::String(format!(
                                "Bash({model})"
                            ))]),
                        )]
                        .into_iter()
                        .collect(),
                    ),
                ),
                (
                    "autoCompactWindow".to_owned(),
                    plist::Value::Integer(200_000.into()),
                ),
                (
                    "when".to_owned(),
                    plist::Value::Date(std::time::SystemTime::UNIX_EPOCH.into()),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let mut bytes = Vec::new();
        if binary {
            value.to_writer_binary(&mut bytes).unwrap();
        } else {
            value.to_writer_xml(&mut bytes).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    };
    write(prefs.join("cn.piarc.desktop.plist"), "a/device", true);
    write(prefs.join("ana/cn.piarc.desktop.plist"), "a/user", false);
    let managed = ManagedSettings::load(&config(FixedPolicy {
        layout: None,
        preferences: Some(prefs.clone()),
        user: Some("ana".into()),
        registry: None,
    }))
    .unwrap();
    let snapshot = managed.snapshot();
    let v = &snapshot.managed.value;
    assert_eq!(v["model"], "a/user");
    assert_eq!(v["autoCompactWindow"], 200_000);
    assert_eq!(
        v["permissions"]["deny"],
        json!(["Bash(a/device)", "Bash(a/user)"])
    );
    let sources = &snapshot.managed.sources;
    assert_eq!(sources.len(), 2);
    assert!(
        sources
            .iter()
            .all(|s| s.family == Family::Piarc && s.channel == Channel::Policy)
    );
    assert!(sources[0].location.ends_with("ana/cn.piarc.desktop.plist"));
    // A date is not a setting: the unknown key is reported, nothing else breaks.
    assert!(sources[0].ignored.iter().any(|i| i.pointer == "/when"));
    // A user name cannot leave the preferences directory.
    let escaped = store::preference_documents(&prefs, Some(".."), PolicyProduct::Piarc);
    assert_eq!(escaped.len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn polling_applies_a_change_within_the_interval() {
    let root = temp("poll");
    let dir = store::windows_files_dir(&root, PolicyProduct::Piarc);
    std::fs::create_dir_all(dir.join(DROP_INS)).unwrap();
    let managed =
        ManagedSettings::load(&config(fixed(Some(Layout::Windows(root.clone()))))).unwrap();
    assert!(managed.snapshot().layer().is_none());
    let cancel = CancellationToken::new();
    managed.spawn_poll(&Handle::current(), cancel.clone());
    let mut changes = managed.changes();
    std::fs::write(
        dir.join(DROP_INS).join("20-x.json"),
        r#"{ "disableAutoMode": "disable" }"#,
    )
    .unwrap();
    // Hidden and non-JSON drop-ins are not documents.
    std::fs::write(
        dir.join(DROP_INS).join(".hidden.json"),
        r#"{ "model": "a/hidden" }"#,
    )
    .unwrap();
    std::fs::write(dir.join(DROP_INS).join("notes.txt"), "{}").unwrap();
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .expect("the poll saw the change")
        .unwrap();
    let v = managed.snapshot().managed.value.clone();
    assert_eq!(v["disableAutoMode"], "disable");
    assert!(v.get("model").is_none());
    cancel.cancel();
    let _ = std::fs::remove_dir_all(root);
}

/// T47-A09 on Windows: a policy value under `HKCU` (user-writable) is not read; the system
/// store reads `HKLM` only.
#[cfg(windows)]
#[test]
fn the_current_users_policy_key_is_not_read() {
    let key = "SOFTWARE\\Policies\\PiArc";
    let existed = windows_registry::CURRENT_USER.open(key).is_ok();
    if existed {
        // Never touch a key the machine already has.
        return;
    }
    let created = windows_registry::CURRENT_USER.create(key).unwrap();
    created
        .set_string(store::POLICY_VALUE, r#"{ "allowManagedHooksOnly": true }"#)
        .unwrap();
    let documents = store::SystemPolicy.documents(PolicyProduct::Piarc);
    let _ = windows_registry::CURRENT_USER.remove_tree(key);
    assert!(documents.iter().all(|d| d.location.starts_with("HKLM")));
    assert!(
        documents
            .iter()
            .all(|d| !matches!(&d.body, PolicyBody::Json(b) if b.windows(21).any(|w| w == b"allowManagedHooksOnly")))
    );
}

/// The registry stand-in of the tests reads the same `Settings` value as `HKLM` would.
#[cfg(windows)]
#[test]
fn the_policy_value_is_read_from_the_registry() {
    let base = format!("Software\\PiArcTest-{}", std::process::id());
    let key = windows_registry::CURRENT_USER
        .create(format!(
            "{base}\\{}",
            store::policy_key(PolicyProduct::Piarc)
        ))
        .unwrap();
    key.set_string(store::POLICY_VALUE, r#"{ "model": "a/registry" }"#)
        .unwrap();
    let managed = ManagedSettings::load(&config(FixedPolicy {
        layout: None,
        preferences: None,
        user: None,
        registry: Some(base.clone()),
    }));
    let _ = windows_registry::CURRENT_USER.remove_tree(&base);
    let snapshot = managed.unwrap().snapshot();
    assert_eq!(snapshot.managed.value["model"], "a/registry");
    assert!(
        snapshot.managed.sources[0]
            .location
            .display()
            .to_string()
            .ends_with(r"SOFTWARE\Policies\PiArc\Settings")
    );
}
