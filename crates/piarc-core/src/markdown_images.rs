//! Local Markdown image preferences. Only the native folder picker may establish a directory
//! capability. The editor's other settings cannot supply or replace that persisted identity.
use crate::{Error, Result, client_settings};
use piarc_fs::project::images::{self, Directory, LinkStyle, Location, Preferences};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
const KEY: &str = "/markdownImages";
static EDIT: Mutex<()> = Mutex::new(());

fn invalid(reason: &str) -> Error {
    Error::InvalidArgument {
        field: "markdownImages",
        reason: reason.into(),
    }
}
pub(crate) fn read(data: &Path) -> Result<Preferences> {
    client_settings::read(data)?
        .pointer(KEY)
        .map(|v| {
            serde_json::from_value(v.clone())
                .map_err(|_| invalid("invalid local image preferences"))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Read,
    Set {
        mode: Location,
        folder: String,
        link: LinkStyle,
    },
    Grant {
        path: PathBuf,
    },
    Forget,
}
pub(crate) fn update(
    data: &Path,
    managed: &crate::managed::ManagedSettings,
    raw: &str,
) -> Result<Value> {
    let request: Request =
        serde_json::from_str(raw).map_err(|_| invalid("invalid settings request"))?;
    let _guard = EDIT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut prefs = read(data)?;
    let writing = !matches!(request, Request::Read);
    match request {
        Request::Read => {}
        Request::Grant { path } => {
            prefs.directory =
                Some(Directory::selected(&path).map_err(|e| Error::feature(&e.to_error_object()))?);
            prefs.mode = Location::Selected;
        }
        Request::Forget => {
            prefs.directory = None;
            if prefs.mode == Location::Selected {
                prefs.mode = Location::Assets;
            }
        }
        Request::Set { mode, folder, link } => {
            if !folder.is_empty() || mode == Location::Relative {
                images::folder(&folder, "document")
                    .map_err(|e| Error::feature(&e.to_error_object()))?;
            }
            if mode == Location::Selected && prefs.directory.is_none() {
                return Err(invalid("choose a local image directory first"));
            }
            prefs.mode = mode;
            prefs.folder = folder;
            prefs.link = link;
        }
    }
    if writing {
        client_settings::write_user_value(data, managed, KEY, Some(json!(prefs)))?;
    }
    Ok(
        json!({"mode":prefs.mode,"folder":prefs.folder,"link":prefs.link,"directory":prefs.directory.as_ref().map(Directory::display)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn setting_changes_retain_only_a_native_grant_and_forget_revokes_it() {
        let dir = std::env::temp_dir().join(format!("piarc-md-settings-{}", std::process::id()));
        let pictures = dir.join("pictures");
        std::fs::create_dir_all(&pictures).unwrap();
        let policy = crate::managed::ManagedSettings::none();
        let use_request = |req: Value| update(&dir, &policy, &req.to_string());
        assert_eq!(
            use_request(json!({"op":"read"})).unwrap()["link"],
            "relativeDot"
        );
        assert!(use_request(json!({"op":"set","mode":"selected","folder":"","link":"absolute","directory":{"path":"a","identity":"b"}})).is_err());
        assert!(
            use_request(json!({"op":"set","mode":"selected","folder":"","link":"absolute"}))
                .is_err()
        );
        use_request(json!({"op":"grant","path":pictures})).unwrap();
        use_request(json!({"op":"set","mode":"selected","folder":"","link":"absolute"})).unwrap();
        let read = use_request(json!({"op":"read"})).unwrap();
        assert!(read["directory"].is_string());
        assert_eq!(read["link"], "absolute");
        assert_eq!(
            use_request(json!({"op":"forget"})).unwrap()["mode"],
            "assets"
        );
        assert!(super::read(&dir).unwrap().directory.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
