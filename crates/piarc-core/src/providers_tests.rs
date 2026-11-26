//! Tests of the provider settings (T21, T29, T31, ADR-0083).
use super::*;
use piarc_protocol::models::CredentialStatusResult;

fn dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "piarc-provider-{}",
        crate::sessions::new_session_id().unwrap()
    ));
    for child in ["pi", "agent-host"] {
        std::fs::create_dir_all(dir.join(child)).unwrap();
    }
    dir
}
fn relay(url: &str) -> Value {
    json!({"kind":"custom","id":"relay","api":"anthropic-messages","baseUrl":url,"models":["one"]})
}
fn save(config: Value, key: Option<&str>) -> Operation {
    Operation::save(
        &config.to_string(),
        key.map(|s| json!({"key":s}).to_string()).as_deref(),
    )
    .unwrap()
}

#[test]
fn recovery_keeps_the_matching_credential_and_reverts_an_uncommitted_edit() {
    let dir = dir();
    let mut s = Settings::read(&dir, true).unwrap();
    let first = relay("https://first.example/v1");
    let req = s
        .prepare(save(first.clone(), Some("fake-first")), &[])
        .unwrap();
    s.write_pending(&dir).unwrap();
    s.project(&dir, true).unwrap();
    let status = CredentialStatusResult {
        has_credential: true,
        change_id: req
            .credential
            .unwrap()
            .env
            .unwrap()
            .remove("PIARC_CHANGE_ID"),
    };
    let mut restarted = Settings::read(&dir, true).unwrap();
    assert!(restarted.committed(&status));
    restarted.finish(true);
    restarted
        .persist(&dir, &crate::managed::ManagedSettings::none())
        .unwrap();
    let second = relay("https://other.example/v1");
    assert!(restarted.prepare(save(second.clone(), None), &[]).is_err());
    restarted
        .prepare(save(second, Some("fake-second")), &[])
        .unwrap();
    restarted.write_pending(&dir).unwrap();
    restarted.project(&dir, true).unwrap();
    let mut interrupted = Settings::read(&dir, true).unwrap();
    assert!(!interrupted.committed(&status));
    interrupted.project(&dir, false).unwrap();
    interrupted.finish(false);
    interrupted
        .persist(&dir, &crate::managed::ManagedSettings::none())
        .unwrap();
    assert_eq!(
        read_models(&dir).unwrap()["providers"]["relay"]["baseUrl"],
        first["baseUrl"]
    );
    assert!(!Settings::journal(&dir).exists());
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn imported_id_conflict_never_changes_existing_configuration() {
    let dir = dir();
    let existing = json!({"providers":{"relay":{"models":[{"id":"existing"}],"api":"openai-responses","baseUrl":"https://original.example/"}}});
    let path = dir.join("pi/models.json");
    std::fs::write(&path, existing.to_string()).unwrap();
    let mut s = Settings::read(&dir, true).unwrap();
    s.prepare(save(relay("https://other.example"), Some("example")), &[])
        .unwrap();
    assert!(matches!(
        s.write_pending(&dir),
        Err(Error::InvalidArgument { field: "id", .. })
    ));
    assert!(!Settings::journal(&dir).exists());
    assert_eq!(std::fs::read_to_string(path).unwrap(), existing.to_string());
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn authenticated_remote_urls_reject_userinfo_plaintext_and_lookalike_hosts() {
    for url in [
        "http://127.example.org/v1",
        "http://localhost.example",
        "http://[::2]",
        "https://localhost@somewhere.example",
        "https://host.example?token=hidden",
        "https://host.example:wrong/v1",
    ] {
        let result = Operation::save(&relay(url).to_string(), Some(r#"{"key":"example"}"#))
            .and_then(|op| Settings::default().prepare(op, &[]));
        assert!(
            matches!(
                result,
                Err(Error::InvalidArgument {
                    field: "baseUrl",
                    ..
                })
            ),
            "{url}"
        );
    }
    for url in [
        "http://127.0.0.2",
        "http://[::1]:12345/v1",
        "https://example.org",
    ] {
        Settings::default()
            .prepare(save(relay(url), Some("example")), &[])
            .expect("valid endpoint");
    }
}
#[test]
fn paid_cache_warming_is_opt_in_and_existing_preferences_are_preserved() {
    let dir = dir();
    ensure_pi_defaults(&dir).unwrap();
    let path = dir.join("pi/settings.json");
    let data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        data,
        json!({"cacheWarming":"off","images":{"autoResize":true}})
    );
    let settings =
        json!({"cacheWarming":"idle","images":{"autoResize":false},"retry":{"enabled":false}});
    std::fs::write(&path, settings.to_string()).unwrap();
    ensure_pi_defaults(&dir).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), settings.to_string());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn model_preferences_are_validated_and_local_models_graded_low() {
    let ok = Operation::preferences(
        &json!({"models":{"relay/one":{"displayName":"One","contextWindow":200000,"vision":false,"defaultEffort":"high","toolProfile":"default"}},"auxiliary":{"provider":"relay","id":"one"}}).to_string(),
    )
    .unwrap();
    let Operation::Preferences(prefs) = ok else {
        panic!("preferences")
    };
    assert_eq!(prefs.models["relay/one"].context_window, Some(200_000));
    for bad in [
        json!({"models":{"noslash":{}}}),
        json!({"models":{"a/b":{"contextWindow":10}}}),
        json!({"models":{"a/b":{"displayName":""}}}),
        json!({"models":{"a/b":{"toolReliability":"low"}}}),
        json!({"models":{"a/b":{"toolProfile":"strict"}}}),
    ] {
        assert!(Operation::preferences(&bad.to_string()).is_err(), "{bad}");
    }
    let mut settings = Settings {
        models: prefs.models.clone(),
        auxiliary: prefs.auxiliary.clone(),
        ..Settings::default()
    };
    let local: Provider = serde_json::from_value(json!({"kind":"local","id":"lan","api":"openai-completions","baseUrl":"http://127.0.0.1:11434/v1","models":["qwen","coder"]})).unwrap();
    settings.providers.push(Stored {
        provider: local,
        has_credential: false,
    });
    let out = settings.preferences();
    assert_eq!(
        out.models["lan/qwen"].tool_reliability,
        Some(ToolReliability::Low)
    );
    assert_eq!(
        out.models["lan/coder"].tool_reliability,
        Some(ToolReliability::Low)
    );
    assert_eq!(out.models["relay/one"].tool_reliability, None);
    assert_eq!(out.auxiliary.as_ref().map(|m| m.id.as_str()), Some("one"));
    assert!(settings.view(&[])["models"]["relay/one"].is_object());
}

/// T31: the alias table is saved as the user's `modelAliases`, read back with the provider
/// settings, and an auxiliary alias reaches the Agent Host as the model it names.
#[test]
fn aliases_are_saved_and_an_auxiliary_alias_resolves() {
    let dir = dir();
    let ok = Operation::preferences(
        &json!({"auxiliaryAlias":"haiku","aliases":{"fast":"relay/one","strong":"cloud/big"}})
            .to_string(),
    )
    .unwrap();
    let Operation::Preferences(prefs) = ok else {
        panic!("preferences")
    };
    let settings = Settings {
        auxiliary_alias: prefs.auxiliary_alias,
        aliases: prefs.aliases.clone(),
        ..Settings::default()
    };
    settings
        .persist(&dir, &crate::managed::ManagedSettings::none())
        .unwrap();
    let file = crate::client_settings::read(&dir).unwrap();
    assert_eq!(
        file["modelAliases"],
        json!({"fast":"relay/one","strong":"cloud/big"})
    );
    let read = Settings::read(&dir, true).unwrap();
    assert_eq!(read.aliases, prefs.aliases);
    assert_eq!(read.view(&[])["auxiliaryAlias"], "haiku");
    // haiku follows fast, which is set.
    let out = read.preferences();
    assert_eq!(
        out.auxiliary,
        Some(ModelRef {
            provider: "relay".into(),
            id: "one".into()
        })
    );
    assert!(out.aliases.is_empty() && out.auxiliary_alias.is_none());
    // sonnet follows balanced, which is not set: the session's model.
    let unset = Settings {
        auxiliary_alias: Some(ModelAlias::Sonnet),
        ..read
    };
    assert_eq!(unset.preferences().auxiliary, None);
    for bad in [
        json!({"aliases":{"fast":"noslash"}}),
        json!({"aliases":{"fast":""}}),
        json!({"aliases":{"fable":"a/b"}}),
    ] {
        assert!(Operation::preferences(&bad.to_string()).is_err(), "{bad}");
    }
    let _ = std::fs::remove_dir_all(dir);
}
