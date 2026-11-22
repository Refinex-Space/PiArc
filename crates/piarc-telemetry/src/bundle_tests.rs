use std::path::PathBuf;

use serde_json::json;

use super::{BundleInput, EXCLUDED, assemble};
use crate::redact::{Kind, remember_secret};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piarc bundle {name} 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Logs, settings and diagnostics with credentials and home paths in them.
fn fixture(root: &std::path::Path) -> (BundleInput, PathBuf) {
    let home = root.join("home 家");
    let logs = root.join("logs");
    std::fs::create_dir_all(&logs).expect("logs");
    remember_secret("bundle-vault-value-9e8d7c");
    std::fs::write(
        logs.join("core-2026-11-21.log"),
        format!(
            "INFO opened {}/project\nWARN key bundle-vault-value-9e8d7c rejected\n",
            home.display()
        ),
    )
    .expect("core log");
    std::fs::write(
        logs.join("agent-host-2026-11-21.log"),
        "INFO Authorization: Bearer abcdefgh12345678\n",
    )
    .expect("host log");
    std::fs::write(logs.join("unrelated.txt"), "not a log").expect("other");
    let settings = root.join("settings.json");
    std::fs::write(
        &settings,
        json!({
            "permissions": {"allow": ["Bash(npm test)"]},
            "mcpServers": {"x": {"command": "node", "env": {"TOKEN": "env-secret-value", "HOME_DIR": "${HOME}"},
                "headers": {"Authorization": "Bearer hdr-secret-value-1"}}},
            "modelProviders": {"relay": {"apiKey": "plain-api-key"}},
            "cwd": format!("{}/project", home.display())
        })
        .to_string(),
    )
    .expect("settings");
    let input = BundleInput {
        logs_dir: logs,
        home: Some(home.clone()),
        versions: json!({"app": "0.1.0", "resources": format!("{}/Applications", home.display())}),
        settings: vec![
            ("settings.json".into(), settings),
            ("missing.json".into(), root.join("missing.json")),
        ],
        diagnostics: Some(
            json!({"files": [{"path": format!("{}/.claude/settings.json", home.display()),
            "effective": {"env": {"OPENAI_API_KEY": "sk-proj-AbCdEf0123456789xyz"}}}]}),
        ),
    };
    (input, home)
}

#[test]
fn thr04_the_bundle_carries_no_credential_and_no_home_path() {
    let root = temp("redacted");
    let (input, home) = fixture(&root);
    let bundle = assemble(&input).expect("assembled");
    let names: Vec<&str> = bundle.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "logs/agent-host-2026-11-21.log",
            "logs/core-2026-11-21.log",
            "versions.json",
            "settings/settings.json",
            "config-diagnostics.json"
        ]
    );
    let all: String = bundle
        .files
        .iter()
        .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
        .collect();
    for needle in [
        "bundle-vault-value-9e8d7c",
        "abcdefgh12345678",
        "env-secret-value",
        "hdr-secret-value-1",
        "plain-api-key",
        "sk-proj-AbCdEf0123456789xyz",
        home.to_string_lossy().as_ref(),
    ] {
        assert!(!all.contains(needle), "{needle} is in the bundle");
    }
    assert!(all.contains("~/project"), "{all}");
    assert!(
        all.contains("\"${HOME}\""),
        "a variable reference stays: {all}"
    );
    assert!(
        all.contains("Bash(npm test)"),
        "the rest of the settings stays"
    );
    assert!(bundle.redactions[&Kind::HomePath] >= 4);
    assert!(bundle.redactions[&Kind::SecretField] >= 4);
    let manifest = bundle.manifest();
    assert_eq!(manifest["files"].as_array().map(Vec::len), Some(5));
    assert_eq!(manifest["excluded"], json!(EXCLUDED));

    let zip = root.join("out 包.zip");
    bundle.write_zip(&zip).expect("written");
    let bytes = std::fs::read(&zip).expect("zip");
    assert!(bytes.windows(13).any(|w| w == b"manifest.json"));
    assert!(!bytes.windows(25).any(|w| w == b"bundle-vault-value-9e8d7c"));
    assert!(!root.join(".out 包.zip.partial").exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_missing_log_directory_gives_a_bundle_without_logs() {
    let root = temp("nologs");
    let bundle = assemble(&BundleInput {
        logs_dir: root.join("absent"),
        versions: json!({"app": "0.1.0"}),
        ..BundleInput::default()
    })
    .expect("assembled");
    assert_eq!(bundle.files.len(), 1);
    assert_eq!(bundle.files[0].name, "versions.json");
    let _ = std::fs::remove_dir_all(&root);
}
