use std::collections::BTreeMap;

use super::{Kind, redact, redact_home, remember_secret, remember_secrets_in};

fn red(text: &str) -> String {
    redact(text).text.into_owned()
}

#[test]
fn thr04_remembered_credentials_are_replaced_wherever_they_appear() {
    remember_secret("vault-only-credential-7f3a91");
    let out = redact(
        "relay said: vault-only-credential-7f3a91 is invalid (vault-only-credential-7f3a91)",
    );
    assert_eq!(
        out.text,
        "relay said: [REDACTED:secret] is invalid ([REDACTED:secret])"
    );
    assert_eq!(out.counts.get(&Kind::KnownSecret), Some(&2));
}

#[test]
fn every_string_of_a_vault_value_is_remembered_but_short_words_are_not() {
    remember_secrets_in(&serde_json::json!({
        "type": "oauth",
        "access": "opaque-access-value-55aa11",
        "refresh": { "nested": ["opaque-refresh-value-66bb22"] },
        "expires": 1_900_000_000_000_u64
    }));
    assert_eq!(
        red("a=opaque-access-value-55aa11 r=opaque-refresh-value-66bb22 type oauth"),
        "a=[REDACTED:secret] r=[REDACTED:secret] type oauth"
    );
    remember_secret("short1");
    remember_secret("has some spaces in it");
    assert_eq!(
        red("short1 has some spaces in it"),
        "short1 has some spaces in it"
    );
}

#[test]
fn thr04_provider_key_formats_are_replaced() {
    for key in [
        "sk-proj-AbCdEf0123456789xyzXYZ",
        "sk-ant-api03-AbCdEf0123456789_xyz",
        "AIzaSyA1234567890abcdefghijklmnopqrstuv",
        "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        "xoxb-1234567890-abcdefghij",
        "hf_abcdefghijklmnopqrstuvwxyz012345",
    ] {
        let line = format!("key {key} rejected");
        let out = redact(&line);
        assert_eq!(out.text, "key [REDACTED:api-key] rejected", "{key}");
        assert_eq!(out.counts.get(&Kind::ApiKey), Some(&1), "{key}");
    }
}

#[test]
fn thr04_cloud_access_keys_are_replaced() {
    assert_eq!(
        red("id=AKIAIOSFODNN7EXAMPLE then LTAI5tAbCdEfGhIjKlMn"),
        "id=[REDACTED:access-key] then [REDACTED:access-key]"
    );
}

#[test]
fn thr04_bearer_tokens_and_jwts_are_replaced_keeping_the_scheme() {
    assert_eq!(
        red("Authorization: Bearer abc.def-ghi_jkl~012"),
        "Authorization: Bearer [REDACTED:token]"
    );
    assert_eq!(red("basic dXNlcjpwYXNzd29yZA=="), "basic [REDACTED:token]");
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    assert_eq!(red(&format!("got {jwt}")), "got [REDACTED:jwt]");
}

#[test]
fn secret_named_fields_and_url_passwords_are_replaced() {
    assert_eq!(
        red(r#"{"apiKey":"plain-value-123","model":"gpt"}"#),
        r#"{"apiKey":"[REDACTED:secret]","model":"gpt"}"#
    );
    assert_eq!(
        red("GET /v1?access_token=qwertyuiop&page=2"),
        "GET /v1?access_token=[REDACTED:secret]&page=2"
    );
    assert_eq!(
        red("proxy https://user:hunter22@proxy.example:8080/"),
        "proxy https://user:[REDACTED:secret]@proxy.example:8080/"
    );
    assert_eq!(
        red("remote https://0123456789abcdefTOKEN@github.com/a/b.git rejected"),
        "remote https://[REDACTED:secret]@github.com/a/b.git rejected"
    );
    assert_eq!(
        red("fetch ssh://git@github.com/a/b.git"),
        "fetch ssh://git@github.com/a/b.git"
    );
    assert_eq!(red("password = s3cr3t-pw"), "password = [REDACTED:secret]");
}

#[test]
fn thr04_environment_style_secret_names_are_replaced() {
    // R5: a name joined by underscores (`AWS_SECRET_ACCESS_KEY`) has no word boundary before
    // `SECRET`, so the field rule did not see it.
    assert_eq!(
        red("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY"),
        "AWS_SECRET_ACCESS_KEY=[REDACTED:secret]"
    );
    assert_eq!(
        red("DB_PASSWORD=hunter2hunter"),
        "DB_PASSWORD=[REDACTED:secret]"
    );
    assert_eq!(
        red(r#"{"MY_SERVICE_API_KEY":"abcdef123456"}"#),
        r#"{"MY_SERVICE_API_KEY":"[REDACTED:secret]"}"#
    );
    assert_eq!(
        red("export SLACK_TOKEN=abcdefgh"),
        "export SLACK_TOKEN=[REDACTED:secret]"
    );
}

#[test]
fn ordinary_log_lines_are_left_alone() {
    for line in [
        "Agent Host connected workspace=/tmp/work space epoch=1 pid=Some(42) pi=1.5.2",
        "max_tokens: 4096, tokens=1200, cache read 300",
        "opened in /Users/someone/project (trusted: true, model: mock-main/mock-model)",
        "skipped: risk-assessment and desk-check finished",
        "MAX_TOKENS=4096 KEY_COUNT=3 TOKEN_LIMIT=900",
    ] {
        let out = redact(line);
        assert_eq!(out.text, line);
        assert!(out.counts.is_empty(), "{line}");
    }
}

#[test]
fn the_home_directory_becomes_a_tilde_in_paths_but_not_in_longer_names() {
    let mut counts = BTreeMap::new();
    let text = "log /Users/alex/Library/x and /Users/alexander/y and \"/Users/alex\"";
    assert_eq!(
        redact_home(text, "/Users/alex", &mut counts),
        "log ~/Library/x and /Users/alexander/y and \"~\""
    );
    assert_eq!(counts.get(&Kind::HomePath), Some(&2));
    let mut counts = BTreeMap::new();
    assert_eq!(
        redact_home(
            r#"{"cwd":"C:\\Users\\Alex\\proj","b":"c:/users/alex/q"}"#,
            r"C:\Users\Alex",
            &mut counts
        ),
        r#"{"cwd":"~\\proj","b":"~/q"}"#
    );
}
