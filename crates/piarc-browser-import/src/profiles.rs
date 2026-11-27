//! Chrome's profiles under its user data folder: `Local State`'s `profile.info_cache` names
//! them (directory → display name, in `profile.profiles_order` when present); a profile counts
//! when it has a cookies database (`<profile>/Network/Cookies`, or `<profile>/Cookies` before
//! Chrome 96).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// One Chrome profile: its directory name (the id the import takes) and display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
}

/// Chrome's user data folder for a user whose home is `home`: macOS
/// `~/Library/Application Support/Google/Chrome`, Windows `%LOCALAPPDATA%\Google\Chrome\User
/// Data`. `None` on other platforms.
#[must_use]
pub fn default_root(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(
            home.join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome"),
        )
    } else if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        Some(local.join("Google").join("Chrome").join("User Data"))
    } else {
        None
    }
}

/// Whether `id` names a profile directory directly under the root (no separators, not `.`
/// or `..`, no control characters).
#[must_use]
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

/// The cookies database of profile `id`.
///
/// # Errors
///
/// [`Error::Invalid`] for a malformed id, [`Error::NoProfile`], [`Error::NoCookies`].
pub fn cookies_file(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(Error::Invalid(format!("{id:?} is not a profile name")));
    }
    let dir = root.join(id);
    if !dir.is_dir() {
        return Err(Error::NoProfile(id.to_owned()));
    }
    [dir.join("Network").join("Cookies"), dir.join("Cookies")]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| Error::NoCookies(id.to_owned()))
}

/// The profiles under `root` that have a cookies database, in Chrome's order.
///
/// # Errors
///
/// [`Error::NoChrome`] when `root` is not a folder.
pub fn list(root: &Path) -> Result<Vec<Profile>> {
    if !root.is_dir() {
        return Err(Error::NoChrome(root.display().to_string()));
    }
    let state = std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let cache = state
        .as_ref()
        .and_then(|s| s.pointer("/profile/info_cache"))
        .and_then(Value::as_object);
    let mut ids: Vec<String> = Vec::new();
    if let Some(order) = state
        .as_ref()
        .and_then(|s| s.pointer("/profile/profiles_order"))
        .and_then(Value::as_array)
    {
        ids.extend(order.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(cache) = cache {
        let mut rest: Vec<&String> = cache.keys().filter(|k| !ids.contains(k)).collect();
        rest.sort();
        ids.extend(rest.into_iter().cloned());
    }
    if ids.is_empty() {
        // No `Local State`: Chrome's own directory names.
        let mut found: Vec<String> = std::fs::read_dir(root)
            .map_err(|e| Error::io("read Chrome's data folder", &e))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name == "Default" || name.starts_with("Profile "))
            .collect();
        found.sort();
        ids = found;
    }
    Ok(ids
        .into_iter()
        .filter(|id| valid_id(id) && cookies_file(root, id).is_ok())
        .map(|id| {
            let name = cache
                .and_then(|c| c.get(&id))
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .filter(|n| !n.trim().is_empty())
                .map_or_else(|| id.clone(), str::to_owned);
            Profile { id, name }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-chrome-profiles-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("root");
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        std::fs::write(path, b"").expect("file");
    }

    #[test]
    fn profiles_come_from_local_state_in_chrome_order() {
        let root = root().join("用户 数据");
        touch(&root.join("Default").join("Network").join("Cookies"));
        touch(&root.join("Profile 1").join("Cookies"));
        // Listed but without cookies: left out.
        std::fs::create_dir_all(root.join("Profile 2")).expect("dir");
        std::fs::write(
            root.join("Local State"),
            serde_json::json!({
                "profile": {
                    "info_cache": {
                        "Default": { "name": "个人" },
                        "Profile 1": { "name": "Work" },
                        "Profile 2": { "name": "Empty" },
                        "../escape": { "name": "Bad" }
                    },
                    "profiles_order": ["Profile 1", "Default"]
                }
            })
            .to_string(),
        )
        .expect("local state");
        let profiles = list(&root).expect("list");
        assert_eq!(
            profiles,
            vec![
                Profile {
                    id: "Profile 1".into(),
                    name: "Work".into()
                },
                Profile {
                    id: "Default".into(),
                    name: "个人".into()
                },
            ]
        );
        assert_eq!(
            cookies_file(&root, "Default").expect("cookies"),
            root.join("Default").join("Network").join("Cookies")
        );
        assert_eq!(
            cookies_file(&root, "Profile 1").expect("cookies"),
            root.join("Profile 1").join("Cookies")
        );
        assert!(matches!(
            cookies_file(&root, "Profile 2"),
            Err(Error::NoCookies(_))
        ));
        assert!(matches!(
            cookies_file(&root, "../escape"),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            cookies_file(&root, "Profile 9"),
            Err(Error::NoProfile(_))
        ));
        std::fs::remove_dir_all(root.parent().expect("parent")).ok();
    }

    #[test]
    fn without_local_state_the_directories_are_scanned() {
        let root = root();
        touch(&root.join("Profile 3").join("Network").join("Cookies"));
        touch(&root.join("Default").join("Network").join("Cookies"));
        touch(&root.join("System Profile").join("Network").join("Cookies"));
        let ids: Vec<String> = list(&root)
            .expect("list")
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, ["Default", "Profile 3"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_root_is_no_chrome() {
        let missing = root().join("missing");
        assert!(matches!(list(&missing), Err(Error::NoChrome(_))));
    }

    #[test]
    fn ids_must_be_one_directory_name() {
        for bad in ["", ".", "..", "a/b", "a\\b", "C:x", "a\u{0}b"] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(valid_id("Profile 1"));
        assert!(valid_id("个人资料"));
    }
}
