//! The administrator's places (design addendum section 6.1), behind
//! [`piarc_ports::PolicyStore`]:
//!
//! | | macOS | Windows |
//! |---|---|---|
//! | policy documents | `/Library/Managed Preferences/<user>/<domain>.plist`, then `/Library/Managed Preferences/<domain>.plist` | `HKLM\SOFTWARE\Policies\<product>`, value `Settings` |
//! | managed files | `/Library/Application Support/<product>/` | `<Program Files>\<product>\` |
//!
//! `<domain>` is `cn.piarc.desktop` (D2) or `com.anthropic.claudecode`; `<product>` is `PiArc`
//! or `ClaudeCode`. The login user's name comes from the account database and Program Files
//! from `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\ProgramFilesDir`, never from the
//! environment (`USER`, `ProgramFiles`), which the user controls. `HKCU`, the user's own
//! preferences and anything under the home or data directory are not administrator places and
//! are never read (section 6.2).
//!
//! [`FixedPolicy`] uses the same layouts under directories a test chooses (and, on Windows, a
//! key under `HKCU` standing in for `HKLM`).

use std::io;
use std::path::{Path, PathBuf};

use piarc_ports::{PolicyBody, PolicyDocument, PolicyProduct, PolicyStore};

/// The value under the policy key that holds the JSON document.
pub const POLICY_VALUE: &str = "Settings";

/// The macOS directory of managed preferences.
pub const MANAGED_PREFERENCES: &str = "/Library/Managed Preferences";

/// The product's directory name (managed files, policy key).
#[must_use]
pub fn product_dir(product: PolicyProduct) -> &'static str {
    match product {
        PolicyProduct::Piarc => "PiArc",
        PolicyProduct::ClaudeCode => "ClaudeCode",
    }
}

/// The product's preference domain on macOS.
#[must_use]
pub fn preference_domain(product: PolicyProduct) -> &'static str {
    match product {
        PolicyProduct::Piarc => crate::identity::APP_IDENTIFIER,
        PolicyProduct::ClaudeCode => "com.anthropic.claudecode",
    }
}

/// The product's policy key below `HKLM` (or a test's stand-in root).
#[must_use]
pub fn policy_key(product: PolicyProduct) -> String {
    format!("SOFTWARE\\Policies\\{}", product_dir(product))
}

/// macOS: `<root>/Library/Application Support/<product>`.
#[must_use]
pub fn macos_files_dir(root: &Path, product: PolicyProduct) -> PathBuf {
    root.join("Library")
        .join("Application Support")
        .join(product_dir(product))
}

/// Windows: `<Program Files>\<product>`.
#[must_use]
pub fn windows_files_dir(program_files: &Path, product: PolicyProduct) -> PathBuf {
    program_files.join(product_dir(product))
}

/// macOS: the user channel's and the device channel's property lists of `product` in
/// `preferences` (highest first), those that exist.
#[must_use]
pub fn preference_documents(
    preferences: &Path,
    user: Option<&str>,
    product: PolicyProduct,
) -> Vec<PolicyDocument> {
    let file = format!("{}.plist", preference_domain(product));
    let mut paths = Vec::new();
    // A user name cannot name a directory above the preferences: no separators, no dots only.
    if let Some(user) =
        user.filter(|u| !u.is_empty() && !u.contains(['/', '\\']) && u.chars().any(|c| c != '.'))
    {
        paths.push(preferences.join(user).join(&file));
    }
    paths.push(preferences.join(&file));
    paths
        .into_iter()
        .filter_map(|location| {
            let body = match std::fs::read(&location) {
                Ok(bytes) => PolicyBody::PropertyList(bytes),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
                Err(error) => PolicyBody::Unreadable(error.to_string()),
            };
            Some(PolicyDocument { location, body })
        })
        .collect()
}

/// The system's places for this platform.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemPolicy;

impl PolicyStore for SystemPolicy {
    fn files_dir(&self, product: PolicyProduct) -> Option<PathBuf> {
        system_files_dir(product)
    }

    fn documents(&self, product: PolicyProduct) -> Vec<PolicyDocument> {
        system_documents(product)
    }
}

#[cfg(target_os = "macos")]
fn system_files_dir(product: PolicyProduct) -> Option<PathBuf> {
    Some(macos_files_dir(Path::new("/"), product))
}

#[cfg(target_os = "macos")]
fn system_documents(product: PolicyProduct) -> Vec<PolicyDocument> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.name);
    preference_documents(Path::new(MANAGED_PREFERENCES), user.as_deref(), product)
}

#[cfg(windows)]
fn system_files_dir(product: PolicyProduct) -> Option<PathBuf> {
    let program_files = windows_registry::LOCAL_MACHINE
        .open("SOFTWARE\\Microsoft\\Windows\\CurrentVersion")
        .and_then(|key| key.get_string("ProgramFilesDir"))
        .ok()
        .filter(|dir| !dir.is_empty())?;
    Some(windows_files_dir(Path::new(&program_files), product))
}

#[cfg(windows)]
fn system_documents(product: PolicyProduct) -> Vec<PolicyDocument> {
    registry_document(
        windows_registry::LOCAL_MACHINE,
        "HKLM",
        &policy_key(product),
    )
    .into_iter()
    .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_files_dir(_product: PolicyProduct) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_documents(_product: PolicyProduct) -> Vec<PolicyDocument> {
    Vec::new()
}

/// The `Settings` value of `root\path`, when the key and value exist. A 64-bit process reads
/// the registry's 64-bit view without redirection.
#[cfg(windows)]
pub fn registry_document(
    root: &windows_registry::Key,
    root_name: &str,
    path: &str,
) -> Option<PolicyDocument> {
    // HRESULT_FROM_WIN32 of ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND.
    const NOT_FOUND: [u32; 2] = [0x8007_0002, 0x8007_0003];
    let absent = |code: i32| NOT_FOUND.contains(&code.cast_unsigned());
    let location = PathBuf::from(format!("{root_name}\\{path}\\{POLICY_VALUE}"));
    let key = match root.options().read().open(path) {
        Ok(key) => key,
        Err(error) if absent(error.code().0) => return None,
        Err(error) => {
            return Some(PolicyDocument {
                location,
                body: PolicyBody::Unreadable(error.message()),
            });
        }
    };
    let body = match key.get_string(POLICY_VALUE) {
        Ok(text) => PolicyBody::Json(text.into_bytes()),
        Err(error) if absent(error.code().0) => return None,
        // A value of another type (not REG_SZ or REG_EXPAND_SZ) is not a JSON document.
        Err(error) => PolicyBody::Unreadable(error.message()),
    };
    Some(PolicyDocument { location, body })
}

/// Where a [`FixedPolicy`] keeps the managed files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layout {
    /// macOS: `<root>/Library/Application Support/<product>/`.
    MacOs(PathBuf),
    /// Windows: `<program files>\<product>\`.
    Windows(PathBuf),
}

/// The administrator's places under directories a test chooses: same layouts, no system
/// directory, no `HKLM` (`createForTests`, L2, L4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixedPolicy {
    /// The managed files' layout.
    pub layout: Option<Layout>,
    /// A directory standing in for `/Library/Managed Preferences`.
    pub preferences: Option<PathBuf>,
    /// The login user's name in `preferences`.
    pub user: Option<String>,
    /// Windows only: a key below `HKCU` standing in for `HKLM` (its `SOFTWARE\Policies\…`
    /// subkeys hold the documents).
    pub registry: Option<String>,
}

impl PolicyStore for FixedPolicy {
    fn files_dir(&self, product: PolicyProduct) -> Option<PathBuf> {
        match self.layout.as_ref()? {
            Layout::MacOs(root) => Some(macos_files_dir(root, product)),
            Layout::Windows(program_files) => Some(windows_files_dir(program_files, product)),
        }
    }

    fn documents(&self, product: PolicyProduct) -> Vec<PolicyDocument> {
        let mut out = Vec::new();
        if let Some(preferences) = &self.preferences {
            out.extend(preference_documents(
                preferences,
                self.user.as_deref(),
                product,
            ));
        }
        #[cfg(windows)]
        if let Some(base) = &self.registry {
            out.extend(registry_document(
                windows_registry::CURRENT_USER,
                "HKCU",
                &format!("{base}\\{}", policy_key(product)),
            ));
        }
        out
    }
}
