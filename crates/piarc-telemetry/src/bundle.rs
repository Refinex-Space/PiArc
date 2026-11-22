//! The diagnostic bundle (T45, architecture section 10.5): what the user exports by hand to
//! attach to a bug report, assembled in memory so the client can show the file list and the
//! redaction summary before anything is written.
//!
//! Contents: the log files (`logs/`), version information (`versions.json`), the user's settings
//! files and the configuration diagnostics of a workspace (`settings/`, `config-diagnostics.json`),
//! and `manifest.json` (the list, the redaction counts, what is left out). Every file goes through
//! [`crate::redact`] and the user's home directory becomes `~`; in settings and diagnostics the
//! values of secret-named keys and of every `env` and `headers` map are replaced as well.
//! Never included: the vault, the database, session transcripts and attachments, checkpoints,
//! terminal snapshots ([`EXCLUDED`]).

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Map, Value, json};

use crate::redact::{Kind, redact, redact_home};
use crate::subscriber::{AGENT_HOST_PREFIX, CORE_PREFIX};

/// What the bundle never carries, as the client lists it.
pub const EXCLUDED: &[&str] = &[
    "secrets.vault",
    "core.sqlite",
    "sessions/",
    "pi/sessions/",
    "checkpoints/",
    "agent-host/",
];

/// What to put in a bundle.
#[derive(Debug, Clone, Default)]
pub struct BundleInput {
    /// `<data>/logs`.
    pub logs_dir: PathBuf,
    /// The user's home directory, replaced by `~`.
    pub home: Option<PathBuf>,
    /// Application, runtime and platform versions.
    pub versions: Value,
    /// Settings files as (name in the bundle, path); missing files are left out.
    pub settings: Vec<(String, PathBuf)>,
    /// A workspace's configuration diagnostics report.
    pub diagnostics: Option<Value>,
}

/// One file of the bundle, redacted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFile {
    /// Path inside the archive, with `/`.
    pub name: String,
    /// Contents.
    pub bytes: Vec<u8>,
}

/// An assembled bundle: its files and how much was redacted.
#[derive(Debug, Clone, Default)]
pub struct Bundle {
    /// The files, in archive order (without `manifest.json`).
    pub files: Vec<BundleFile>,
    /// Replacements by kind over every file.
    pub redactions: BTreeMap<Kind, usize>,
}

impl Bundle {
    /// The list, the redaction counts by kind label and [`EXCLUDED`], for the client and as
    /// `manifest.json`.
    #[must_use]
    pub fn manifest(&self) -> Value {
        let mut redactions = Map::new();
        for (kind, count) in &self.redactions {
            let entry = redactions.entry(kind.label()).or_insert(json!(0));
            *entry = json!(entry.as_u64().unwrap_or(0) + *count as u64);
        }
        json!({
            "files": self.files.iter().map(|f| json!({"name": f.name, "bytes": f.bytes.len()})).collect::<Vec<_>>(),
            "redactions": redactions,
            "excluded": EXCLUDED,
        })
    }

    /// Writes the bundle as a ZIP archive to `path` (a temporary file beside it, then renamed).
    ///
    /// # Errors
    ///
    /// The I/O error; nothing is left at `path` then.
    pub fn write_zip(&self, path: &Path) -> io::Result<()> {
        let manifest = serde_json::to_vec_pretty(&self.manifest()).map_err(io::Error::other)?;
        let mut entries: Vec<(&str, &[u8])> = self
            .files
            .iter()
            .map(|f| (f.name.as_str(), f.bytes.as_slice()))
            .collect();
        entries.push(("manifest.json", &manifest));
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::other("the bundle path has no file name"))?;
        let temp = path.with_file_name(format!(".{}.partial", name.to_string_lossy()));
        let result = (|| {
            let mut file = std::fs::File::create(&temp)?;
            crate::zip::write_archive(&mut file, &entries, SystemTime::now())?;
            file.sync_all()?;
            std::fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }
}

/// Assembles the bundle of `input`.
///
/// # Errors
///
/// The I/O error of listing the log directory (a missing directory is an empty list).
pub fn assemble(input: &BundleInput) -> io::Result<Bundle> {
    let mut bundle = Bundle::default();
    let home = input
        .home
        .as_ref()
        .map(|h| h.to_string_lossy().into_owned());
    let mut add = |name: String, text: &str, counts: &mut BTreeMap<Kind, usize>| {
        let redacted = redact(text);
        for (kind, n) in &redacted.counts {
            *counts.entry(*kind).or_default() += n;
        }
        let text = match &home {
            Some(home) => redact_home(&redacted.text, home, counts).into_owned(),
            None => redacted.text.into_owned(),
        };
        bundle.files.push(BundleFile {
            name,
            bytes: text.into_bytes(),
        });
    };
    let mut counts = BTreeMap::new();
    for (name, path) in log_files(&input.logs_dir)? {
        let bytes = std::fs::read(&path)?;
        add(
            format!("logs/{name}"),
            &String::from_utf8_lossy(&bytes),
            &mut counts,
        );
    }
    add(
        "versions.json".into(),
        &pretty(&input.versions),
        &mut counts,
    );
    for (name, path) in &input.settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let text = match serde_json::from_str::<Value>(&text) {
            Ok(mut value) => {
                redact_json(&mut value, false, &mut counts);
                pretty(&value)
            }
            Err(_) => text,
        };
        add(format!("settings/{name}"), &text, &mut counts);
    }
    if let Some(diagnostics) = &input.diagnostics {
        let mut value = diagnostics.clone();
        redact_json(&mut value, false, &mut counts);
        add(
            "config-diagnostics.json".into(),
            &pretty(&value),
            &mut counts,
        );
    }
    bundle.redactions = counts;
    Ok(bundle)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// The Core and Agent Host log files of `dir`, by name.
fn log_files(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ours = [CORE_PREFIX, AGENT_HOST_PREFIX]
                .iter()
                .any(|p| name.starts_with(&format!("{p}-")));
            (ours && name.ends_with(".log")).then(|| (name, e.path()))
        })
        .collect();
    files.sort();
    Ok(files)
}

/// Whether a settings key names a secret: `apiKey`, `x-api-key`, `token`, `clientSecret`,
/// `password`, `authorization`, `cookie`, `credentials`.
fn secret_key(key: &str) -> bool {
    let k: String = key
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    ["key", "token", "secret", "password", "passwd"]
        .iter()
        .any(|s| k.ends_with(s))
        || ["authorization", "cookie", "credentials", "credential"].contains(&k.as_str())
}

/// Replaces the string values of secret-named keys, and every string value inside an `env` or
/// `headers` map (`all`), except `${NAME}` references; counts them as [`Kind::SecretField`].
fn redact_json(value: &mut Value, all: bool, counts: &mut BTreeMap<Kind, usize>) {
    match value {
        Value::String(text) if all => hide(text, counts),
        Value::Array(items) => items.iter_mut().for_each(|v| redact_json(v, all, counts)),
        Value::Object(map) => {
            for (key, entry) in map.iter_mut() {
                let maps_of_secrets = matches!(key.as_str(), "env" | "headers");
                match entry {
                    Value::String(text) if all || secret_key(key) => hide(text, counts),
                    _ => redact_json(entry, all || maps_of_secrets, counts),
                }
            }
        }
        _ => {}
    }
}

fn hide(text: &mut String, counts: &mut BTreeMap<Kind, usize>) {
    let reference = text.starts_with("${") && text.ends_with('}');
    if text.is_empty() || reference || text.starts_with("[REDACTED") {
        return;
    }
    *text = Kind::SecretField.placeholder();
    *counts.entry(Kind::SecretField).or_default() += 1;
}

#[cfg(test)]
#[path = "bundle_tests.rs"]
mod tests;
