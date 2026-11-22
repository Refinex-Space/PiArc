//! T45-A07 (THR-04): what Core and the Agent Host log reaches the files with credentials
//! replaced: remembered vault values, common key formats and Bearer tokens.

use std::path::PathBuf;

use piarc_telemetry::{AGENT_HOST_TARGET, Installed, install, remember_secret};

fn temp_dir() -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("piarc-logs redaction 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn read_all(dir: &std::path::Path, prefix: &str) -> String {
    let mut text = String::new();
    for entry in std::fs::read_dir(dir).expect("logs").flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(prefix) {
            text.push_str(&std::fs::read_to_string(entry.path()).expect("log file"));
        }
    }
    text
}

#[test]
fn thr04_credentials_in_core_and_agent_host_lines_reach_the_files_redacted() {
    let dir = temp_dir();
    assert_eq!(install(&dir).expect("install"), Installed::Files);
    let vault_value = "vault-provider-key-c0ffee-424242";
    remember_secret(vault_value);
    let formats = [
        "sk-ant-api03-ZyXwVuTsRqPoNmLkJiHg",
        "AKIAIOSFODNN7EXAMPLE",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0NDUifQ.c2lnbmF0dXJlLXZhbHVl",
    ];
    let bearer = "opaque-bearer-token-998877";
    tracing::info!(
        target: "piarc_core",
        "provider error: invalid key {vault_value}; retry with {} or {}",
        formats[0],
        formats[1]
    );
    tracing::warn!(target: "piarc_core", "request headers: Authorization: Bearer {bearer}");
    // The Agent Host's stderr arrives as events of this target (piarc-host, one per line).
    tracing::info!(
        target: AGENT_HOST_TARGET,
        workspace = "/w",
        "[session s1] 401 from relay: {vault_value} token={} jwt {}",
        "plain-token-value-1234",
        formats[2]
    );

    let core = read_all(&dir, "core-");
    let host = read_all(&dir, "agent-host-");
    for needle in [vault_value, bearer, "plain-token-value-1234"]
        .iter()
        .chain(&formats)
    {
        assert!(
            !core.contains(needle) && !host.contains(needle),
            "{needle} reached a log file"
        );
    }
    assert!(core.contains("invalid key [REDACTED:secret]"), "{core}");
    assert!(
        core.contains("[REDACTED:api-key] or [REDACTED:access-key]"),
        "{core}"
    );
    assert!(
        core.contains("Authorization: Bearer [REDACTED:token]"),
        "{core}"
    );
    assert!(host.contains("401 from relay: [REDACTED:secret]"), "{host}");
    assert!(
        host.contains("token=[REDACTED:secret] jwt [REDACTED:jwt]"),
        "{host}"
    );
    piarc_telemetry::detach();
    let _ = std::fs::remove_dir_all(&dir);
}
