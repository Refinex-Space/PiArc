//! The client's preferences in the user's settings file (`<data>/settings.json`, T18):
//! language, appearance, keyboard shortcut overrides and notifications. The desktop client
//! reads the whole file and writes these keys only; writes go through
//! [`piarc_config::write_value`] (temporary file and rename), so Core stays the one writer of
//! settings files.

use std::path::Path;

use piarc_config::{LayerSpec, LayerTable, Scope, Source, ids, precedence};
use serde_json::Value;

use crate::error::{Error, Result};

/// Top-level keys of the user's settings the client may write.
pub const CLIENT_KEYS: &[&str] = &["language", "appearance", "keybindings", "notifications"];

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

/// Sets (`Some`) or removes (`None`) the value at `pointer`, which must lie under one of
/// [`CLIENT_KEYS`]. Returns the file's new content.
///
/// # Errors
///
/// `invalidParams` for another pointer or a file that is not a JSON object (left as it is);
/// `ioError` when the file cannot be written.
pub fn write(data_dir: &Path, pointer: &str, value: Option<Value>) -> Result<Value> {
    let top = pointer
        .strip_prefix('/')
        .and_then(|rest| rest.split('/').next());
    if !top.is_some_and(|key| CLIENT_KEYS.contains(&key)) {
        return Err(Error::InvalidArgument {
            field: "pointer",
            reason: format!("must start with one of /{}", CLIENT_KEYS.join(", /")),
        });
    }
    let mut table = LayerTable::default();
    table.insert(LayerSpec {
        id: ids::USER,
        precedence: precedence::USER,
        scope: Scope::User,
        source: Source::File(data_dir.join("settings.json")),
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
        other => io_error(&other.to_string()),
    })?;
    read(data_dir)
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
        for refused in ["/shell/gitBashPath", "/permissions/allow", "", "language"] {
            assert!(write(&dir, refused, Some(json!("x"))).is_err(), "{refused}");
        }
        std::fs::remove_dir_all(&dir).expect("cleanup");
        assert_eq!(read(&dir).expect("missing file"), json!({}));
    }
}
