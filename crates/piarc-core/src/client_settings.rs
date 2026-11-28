//! The client's preferences in the user's settings file (`<data>/settings.json`, T18):
//! language, appearance, keyboard shortcut overrides, notifications, the memory file choice
//! and whether the mode menu offers Bypass permissions (T23). The desktop client
//! reads the whole file and writes these keys only; writes go through
//! [`piarc_config::write_value`] (temporary file and rename), so Core stays the one writer of
//! settings files.

use std::path::Path;

use piarc_config::{LayerSpec, LayerTable, Scope, Source, ids, precedence};
use serde_json::Value;

use crate::error::{Error, Result};

/// Top-level keys of the user's settings the client may write.
/// `autoMode` (T46): the reviewer model and the user's review policy, user-level only.
/// `proxy` (ADR-0082): the Agent Hosts' proxy, checked by `network::check_setting`.
/// `git` (ADR-0085): the Git panel's settings, read by `git::settings_of`.
/// `browser` (B5.5): the built-in browser's settings, user-level only (`tool_io::browser`
/// reads `agentEnabled` and `approvalTimeout`, the main process the rest).
/// `voiceDictation` (ADR-0094): voice input, user-level only (`dictation::VoicePreferences`).
/// `power` (ADR-0109): `keepAwake`, read by the main process's keep-awake controller.
pub const CLIENT_KEYS: &[&str] = &[
    "language",
    "appearance",
    "keybindings",
    "notifications",
    "autoMode",
    "proxy",
    "git",
    "browser",
    "voiceDictation",
    "power",
];

/// The user's settings file as a JSON object; `{}` when it does not exist.
///
/// # Errors
///
/// `ioError` when the file cannot be read; `invalidParams` when it is not a JSON object.
pub fn read(data_dir: &Path) -> Result<Value> {
    let path = data_dir.join("settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        Err(error) => {
            return Err(io_error(&format!(
                "cannot read {}: {error}",
                path.display()
            )));
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(Error::InvalidArgument {
            field: "settings.json",
            reason: format!("{} is not a JSON object", path.display()),
        }),
    }
}

/// Boolean preferences outside [`CLIENT_KEYS`] the client may set.
/// `/permissions/enableAutoMode` (T46): the main process confirms natively before it asks.
pub const CLIENT_SWITCHES: &[&str] = &[
    "/memory/readBoth",
    "/permissions/enableBypassPermissions",
    "/permissions/enableAutoMode",
];

/// Sets (`Some`) or removes (`None`) the value at `pointer`, which must lie under one of
/// [`CLIENT_KEYS`] or be one of [`CLIENT_SWITCHES`]. Returns the file's new content.
///
/// # Errors
///
/// `invalidParams` for another pointer or a file that is not a JSON object (left as it is);
/// `ioError` when the file cannot be written.
pub fn write(
    data_dir: &Path,
    managed: &crate::managed::ManagedSettings,
    pointer: &str,
    value: Option<Value>,
) -> Result<Value> {
    let top = pointer
        .strip_prefix('/')
        .and_then(|rest| rest.split('/').next());
    if CLIENT_SWITCHES.contains(&pointer) {
        if value.as_ref().is_some_and(|v| !v.is_boolean()) {
            return Err(Error::InvalidArgument {
                field: "value",
                reason: format!("{pointer} requires a boolean"),
            });
        }
    } else if !top.is_some_and(|key| CLIENT_KEYS.contains(&key)) {
        return Err(Error::InvalidArgument {
            field: "pointer",
            reason: format!(
                "must be one of {} or start with one of /{}",
                CLIENT_SWITCHES.join(", "),
                CLIENT_KEYS.join(", /")
            ),
        });
    }
    if top == Some("proxy") {
        crate::network::check_setting(pointer, value.as_ref()).map_err(|reason| {
            Error::InvalidArgument {
                field: "value",
                reason,
            }
        })?;
    }
    write_user_value(data_dir, managed, pointer, value)?;
    read(data_dir)
}

/// Applies a validated setting from a Core feature (not a renderer-supplied pointer). A setting
/// the managed settings lock is refused (T47).
pub(crate) fn write_user_value(
    data_dir: &Path,
    managed: &crate::managed::ManagedSettings,
    pointer: &str,
    value: Option<Value>,
) -> Result<()> {
    let mut table = LayerTable::default();
    if let Some(layer) = managed.snapshot().layer() {
        table.insert(layer);
    }
    table.insert(LayerSpec {
        id: ids::USER,
        precedence: precedence::USER,
        scope: Scope::User,
        source: Source::File(data_dir.join("settings.json")),
        format: piarc_config::Format::Piarc,
        schema: &piarc_config::schema::PIARC_SETTINGS,
        writable: true,
        executable: piarc_config::layers::PIARC_EXECUTABLE,
    });
    piarc_config::write_value(&table, ids::USER, pointer, value).map_err(|error| match error {
        piarc_config::WriteError::InvalidPointer(_)
        | piarc_config::WriteError::NotAnObject { .. } => Error::InvalidArgument {
            field: "pointer",
            reason: error.to_string(),
        },
        managed @ piarc_config::WriteError::Managed { .. } => Error::from(managed),
        other => io_error(&other.to_string()),
    })?;
    Ok(())
}

fn io_error(message: &str) -> Error {
    Error::Feature {
        kind: piarc_protocol::ErrorKind::IoError,
        retryable: true,
        message: message.to_owned(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// [`super::write`] without managed settings.
    fn write(dir: &Path, pointer: &str, value: Option<Value>) -> Result<Value> {
        super::write(
            dir,
            &crate::managed::ManagedSettings::none(),
            pointer,
            value,
        )
    }

    #[test]
    fn writes_client_keys_only_and_keeps_the_rest_of_the_file() {
        let dir =
            std::env::temp_dir().join(format!("piarc client settings 设置 {}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(
            dir.join("settings.json"),
            r#"{ "shell": { "gitBashPath": "C:\\bash.exe" } }"#,
        )
        .expect("seed");
        assert_eq!(
            read(&dir).expect("read")["shell"]["gitBashPath"],
            "C:\\bash.exe"
        );
        let after =
            write(&dir, "/keybindings/session.new", Some(json!("Mod+Shift+N"))).expect("write");
        assert_eq!(after["keybindings"]["session.new"], "Mod+Shift+N");
        assert_eq!(after["shell"]["gitBashPath"], "C:\\bash.exe");
        let after = write(&dir, "/keybindings/session.new", None).expect("remove");
        assert_eq!(after["keybindings"], json!({}));
        let after = write(&dir, "/memory/readBoth", Some(json!(true))).expect("set memory choice");
        assert_eq!(after["memory"]["readBoth"], true);
        assert!(write(&dir, "/memory/readBoth", Some(json!("true"))).is_err());
        let after = write(
            &dir,
            "/permissions/enableBypassPermissions",
            Some(json!(true)),
        )
        .expect("enable bypass in the mode menu");
        assert_eq!(after["permissions"]["enableBypassPermissions"], true);
        assert!(write(&dir, "/permissions/enableBypassPermissions", Some(json!(1))).is_err());
        for refused in [
            "/permissions/defaultMode",
            "/memory",
            "/memory/readBoth/other",
            "/memory/other",
            "/shell/gitBashPath",
            "/permissions/allow",
            "",
            "language",
        ] {
            assert!(write(&dir, refused, Some(json!("x"))).is_err(), "{refused}");
        }
        let after = write(&dir, "/memory/readBoth", None).expect("restore default");
        assert_eq!(after["memory"], json!({}));
        assert_eq!(after["shell"]["gitBashPath"], "C:\\bash.exe");
        std::fs::remove_dir_all(&dir).expect("cleanup");
        assert_eq!(read(&dir).expect("missing file"), json!({}));
    }

    /// T47-A12's Core side: a setting the managed settings lock is refused, the others are
    /// written.
    #[test]
    fn a_locked_setting_is_refused() {
        let root = std::env::temp_dir().join(format!(
            "piarc-client-managed-{}-{}",
            std::process::id(),
            crate::storage::now_ms()
        ));
        let admin =
            crate::managed::store::macos_files_dir(&root, piarc_ports::PolicyProduct::Piarc);
        std::fs::create_dir_all(&admin).expect("admin dir");
        std::fs::write(
            admin.join(crate::managed::SETTINGS_FILE),
            r#"{ "appearance": { "theme": "dark" }, "permissions": { "enableBypassPermissions": false } }"#,
        )
        .expect("managed file");
        let managed = crate::managed::ManagedSettings::load(&crate::managed::ManagedConfig {
            store: Some(std::sync::Arc::new(crate::managed::store::FixedPolicy {
                layout: Some(crate::managed::store::Layout::MacOs(root.clone())),
                preferences: None,
                user: None,
                registry: None,
            })),
            poll: crate::managed::DEFAULT_POLL,
        })
        .expect("managed settings");
        let data = root.join("data");
        std::fs::create_dir_all(&data).expect("data");
        for pointer in ["/appearance/theme", "/permissions/enableBypassPermissions"] {
            let value = if pointer.ends_with("theme") {
                json!("light")
            } else {
                json!(true)
            };
            let refused = super::write(&data, &managed, pointer, Some(value)).expect_err(pointer);
            let object = refused.to_error_object();
            assert_eq!(
                object.data.kind,
                piarc_protocol::ErrorKind::PermissionDenied
            );
            assert_eq!(object.data.details.expect("details")["reason"], "managed");
        }
        let written = super::write(
            &data,
            &managed,
            "/appearance/density",
            Some(json!("compact")),
        )
        .expect("an unlocked key");
        assert_eq!(written["appearance"]["density"], "compact");
        assert!(written["appearance"].get("theme").is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
