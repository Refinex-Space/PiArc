//! Speech assets: where the bundled runtime and models are, what their files must hash to,
//! and the enhanced model's install, verification and removal (ADR-0094, ADR-0097).
//!
//! The bundled manifest is `third-party/speech-assets.lock.json`, compiled in; the enhanced
//! manifest is `models/qwen3-asr-0.6b-int8.json`, compiled in. Nothing is ever loaded before
//! its files match the manifest (size and SHA-256), once per process.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use piarc_protocol::dictation::{SpeechModel, SpeechModelKind, SpeechModelState};

use crate::error::SpeechError;

const BUNDLED_LOCK: &str = include_str!("../../../third-party/speech-assets.lock.json");
const ENHANCED_MANIFEST: &str = include_str!("../models/qwen3-asr-0.6b-int8.json");

/// Id of the bundled streaming model.
pub const BASE_MODEL_ID: &str = "x-asr-zh-en-480ms-int8";
/// Id of the bundled VAD model.
const VAD_MODEL_ID: &str = "silero-vad";
/// Id of the enhanced model.
pub const ENHANCED_MODEL_ID: &str = "qwen3-asr-0.6b-int8";

/// One file a manifest expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedFile {
    /// Path relative to the asset directory, `/`-separated.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

impl ExpectedFile {
    fn on_disk(&self, root: &Path) -> PathBuf {
        self.path
            .split('/')
            .fold(root.to_path_buf(), |p, part| p.join(part))
    }
}

#[derive(Deserialize)]
struct LockFile {
    to: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct LockRuntimeArtefact {
    files: std::collections::BTreeMap<String, LockFile>,
}

#[derive(Deserialize)]
struct LockRuntime {
    version: String,
    artefacts: std::collections::BTreeMap<String, LockRuntimeArtefact>,
}

#[derive(Deserialize)]
struct LockModel {
    version: String,
    #[serde(default)]
    files: std::collections::BTreeMap<String, LockFile>,
    #[serde(default)]
    derived: std::collections::BTreeMap<String, LockFile>,
    #[serde(default)]
    file: Option<LockFile>,
}

#[derive(Deserialize)]
struct Lock {
    runtime: LockRuntime,
    models: std::collections::BTreeMap<String, LockModel>,
}

/// The target key of this build in the lock file (`darwin-arm64`, `win32-x64`, …).
#[must_use]
pub fn target_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("linux", "x86_64") => "linux-x64",
        _ => "unsupported",
    }
}

/// The bundled assets this build expects, parsed once.
#[derive(Debug, Clone)]
pub struct BundledManifest {
    /// sherpa-onnx version of the runtime.
    pub runtime_version: String,
    /// The base model's version.
    pub model_version: String,
    /// Runtime files for this target (may be empty on an unsupported target).
    pub runtime: Vec<ExpectedFile>,
    /// Base model files including the derived `bpe.vocab`.
    pub model: Vec<ExpectedFile>,
    /// The VAD model.
    pub vad: ExpectedFile,
}

fn expected(file: &LockFile) -> ExpectedFile {
    ExpectedFile {
        path: file.to.clone(),
        size: file.size,
        sha256: file.sha256.clone(),
    }
}

/// The bundled manifest compiled into this build.
///
/// # Panics
///
/// Never at run time: `bundled_manifest_parses` checks the compiled-in lock file.
#[must_use]
pub fn bundled_manifest() -> &'static BundledManifest {
    static MANIFEST: OnceLock<BundledManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let lock: Lock = serde_json::from_str(BUNDLED_LOCK).unwrap_or_else(|error| {
            unreachable!("third-party/speech-assets.lock.json is checked by tests: {error}")
        });
        let runtime = lock
            .runtime
            .artefacts
            .get(target_key())
            .map(|a| a.files.values().map(expected).collect())
            .unwrap_or_default();
        let base = lock.models.get(BASE_MODEL_ID);
        let model = base
            .map(|m| {
                m.files
                    .values()
                    .chain(m.derived.values())
                    .map(expected)
                    .collect()
            })
            .unwrap_or_default();
        let vad = lock
            .models
            .get(VAD_MODEL_ID)
            .and_then(|m| m.file.as_ref())
            .map_or_else(
                || ExpectedFile {
                    path: String::new(),
                    size: 0,
                    sha256: String::new(),
                },
                expected,
            );
        BundledManifest {
            runtime_version: lock.runtime.version,
            model_version: base.map(|m| m.version.clone()).unwrap_or_default(),
            runtime,
            model,
            vad,
        }
    })
}

/// One file of the enhanced manifest.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct EnhancedFile {
    /// Path inside the model directory, `/`-separated.
    pub path: String,
    /// Where to download it (pinned revision).
    pub url: String,
    /// Size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256.
    pub sha256: String,
}

/// The enhanced model's manifest.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnhancedManifest {
    /// Model id.
    pub id: String,
    /// Model version.
    pub version: String,
    /// Hosts every download hop may use.
    pub hosts: Vec<String>,
    /// Suffixes (`.modelscope.cn`) of further hosts every hop may use.
    pub host_suffixes: Vec<String>,
    /// Files to download.
    pub files: Vec<EnhancedFile>,
}

impl EnhancedManifest {
    /// Total bytes to download.
    #[must_use]
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    fn expected(&self) -> Vec<ExpectedFile> {
        self.files
            .iter()
            .map(|f| ExpectedFile {
                path: f.path.clone(),
                size: f.size,
                sha256: f.sha256.clone(),
            })
            .collect()
    }

    /// Whether `host` may serve a hop of this model's downloads.
    #[must_use]
    pub fn allows_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.hosts.contains(&host)
            || self
                .host_suffixes
                .iter()
                .any(|s| host.ends_with(s.as_str()) && host.len() > s.len())
    }
}

/// The enhanced manifest compiled into this build.
#[must_use]
pub fn enhanced_manifest() -> &'static EnhancedManifest {
    static MANIFEST: OnceLock<EnhancedManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(ENHANCED_MANIFEST).unwrap_or_else(|error| {
            unreachable!("models/qwen3-asr-0.6b-int8.json is checked by tests: {error}")
        })
    })
}

/// Lowercase hex SHA-256 of a file, streamed.
///
/// # Errors
///
/// The I/O error reading it.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Present-and-sized check (no hashing): `Ready`, `Missing` or `Corrupt`.
#[must_use]
pub fn quick_state(root: &Path, files: &[ExpectedFile]) -> SpeechModelState {
    if files.is_empty() {
        return SpeechModelState::Missing;
    }
    let mut missing = false;
    for file in files {
        match fs::metadata(file.on_disk(root)) {
            Ok(meta) if meta.is_file() && meta.len() == file.size => {}
            Ok(_) => return SpeechModelState::Corrupt,
            Err(_) => missing = true,
        }
    }
    if missing {
        SpeechModelState::Missing
    } else {
        SpeechModelState::Ready
    }
}

/// Full check: every file exists, has its size and SHA-256.
///
/// # Errors
///
/// [`SpeechError::ModelMissing`] when a file is absent, [`SpeechError::ModelCorrupt`] when
/// one differs.
pub fn verify(root: &Path, files: &[ExpectedFile]) -> Result<(), SpeechError> {
    if files.is_empty() {
        return Err(SpeechError::ModelMissing);
    }
    for file in files {
        let path = file.on_disk(root);
        let meta = fs::metadata(&path).map_err(|_| SpeechError::ModelMissing)?;
        if !meta.is_file() || meta.len() != file.size {
            return Err(SpeechError::ModelCorrupt);
        }
        let digest = sha256_file(&path).map_err(|_| SpeechError::ModelMissing)?;
        if digest != file.sha256 {
            return Err(SpeechError::ModelCorrupt);
        }
    }
    Ok(())
}

/// Paths of the bundled assets under one speech directory (`Resources/speech/`).
#[derive(Debug, Clone)]
pub struct BundledAssets {
    root: PathBuf,
}

/// The base model's files as paths for the recognizer.
#[derive(Debug, Clone)]
pub struct BaseModelPaths {
    /// Encoder.
    pub encoder: PathBuf,
    /// Decoder.
    pub decoder: PathBuf,
    /// Joiner.
    pub joiner: PathBuf,
    /// tokens.txt.
    pub tokens: PathBuf,
    /// bpe.vocab (hotword encoding).
    pub bpe_vocab: PathBuf,
    /// Silero VAD.
    pub vad: PathBuf,
}

impl BundledAssets {
    /// The assets under `root`.
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The runtime library directory.
    #[must_use]
    pub fn runtime_dir(&self) -> PathBuf {
        self.root.join("runtime")
    }

    fn all_files(&self) -> Vec<ExpectedFile> {
        let manifest = bundled_manifest();
        let mut files = manifest.runtime.clone();
        files.extend(manifest.model.iter().cloned());
        files.push(manifest.vad.clone());
        files
    }

    /// Cheap state (sizes only), for status reports.
    #[must_use]
    pub fn quick_state(&self) -> SpeechModelState {
        quick_state(&self.root, &self.all_files())
    }

    /// Full verification of runtime, model and VAD.
    ///
    /// # Errors
    ///
    /// See [`verify`].
    pub fn verify(&self) -> Result<(), SpeechError> {
        verify(&self.root, &self.all_files())
    }

    /// The model's paths.
    #[must_use]
    pub fn paths(&self) -> BaseModelPaths {
        let dir = self.root.join("models").join(BASE_MODEL_ID);
        BaseModelPaths {
            encoder: dir.join("encoder.int8.onnx"),
            decoder: dir.join("decoder.onnx"),
            joiner: dir.join("joiner.int8.onnx"),
            tokens: dir.join("tokens.txt"),
            bpe_vocab: dir.join("bpe.vocab"),
            vad: self
                .root
                .join("models")
                .join("silero-vad")
                .join("silero_vad.onnx"),
        }
    }

    /// Bytes the bundled assets take.
    #[must_use]
    pub fn installed_bytes(&self) -> u64 {
        self.all_files().iter().map(|f| f.size).sum()
    }

    /// Status for `core/speech`.
    #[must_use]
    pub fn status(&self, active: bool) -> SpeechModel {
        SpeechModel {
            id: BASE_MODEL_ID.to_owned(),
            kind: SpeechModelKind::Base,
            version: bundled_manifest().model_version.clone(),
            state: self.quick_state(),
            installed_bytes: self.installed_bytes(),
            download_bytes: 0,
            received_bytes: None,
            error: None,
            active,
        }
    }
}

/// The enhanced model's directories under the speech cache (`<cache>/speech/`).
#[derive(Debug, Clone)]
pub struct EnhancedStore {
    root: PathBuf,
}

/// The enhanced model's files as paths for the recognizer.
#[derive(Debug, Clone)]
pub struct EnhancedModelPaths {
    /// conv_frontend.onnx.
    pub conv_frontend: PathBuf,
    /// encoder.int8.onnx.
    pub encoder: PathBuf,
    /// decoder.int8.onnx.
    pub decoder: PathBuf,
    /// tokenizer directory.
    pub tokenizer: PathBuf,
}

impl EnhancedStore {
    /// The store under `root` (`<cache>/speech`).
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The installed model directory.
    #[must_use]
    pub fn installed_dir(&self) -> PathBuf {
        self.root.join(ENHANCED_MODEL_ID)
    }

    /// The staging directory of a download (same file system as the installed one).
    #[must_use]
    pub fn staging_dir(&self) -> PathBuf {
        self.root.join(".staging").join(ENHANCED_MODEL_ID)
    }

    /// Where a manifest file goes under `dir`, refusing anything but plain relative paths.
    ///
    /// # Errors
    ///
    /// [`SpeechError::ModelCorrupt`] for a path with `..`, a root or a prefix.
    pub fn file_path(dir: &Path, relative: &str) -> Result<PathBuf, SpeechError> {
        let candidate = Path::new(relative);
        if relative.is_empty()
            || relative.contains('\\')
            || !candidate
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err(SpeechError::ModelCorrupt);
        }
        Ok(relative
            .split('/')
            .fold(dir.to_path_buf(), |p, part| p.join(part)))
    }

    /// Cheap state of the installed copy.
    #[must_use]
    pub fn quick_state(&self) -> SpeechModelState {
        quick_state(&self.installed_dir(), &enhanced_manifest().expected())
    }

    /// Full verification of the installed copy.
    ///
    /// # Errors
    ///
    /// See [`verify`].
    pub fn verify(&self) -> Result<(), SpeechError> {
        verify(&self.installed_dir(), &enhanced_manifest().expected())
    }

    /// Verifies the staged download and moves it into place atomically (rename of the whole
    /// directory on the same file system). An existing installed copy is replaced.
    ///
    /// # Errors
    ///
    /// The verification error (the staging directory is then removed), or
    /// [`SpeechError::ModelMissing`] when the rename fails.
    pub fn activate_staged(&self) -> Result<(), SpeechError> {
        let staged = self.staging_dir();
        if let Err(error) = verify(&staged, &enhanced_manifest().expected()) {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
        let installed = self.installed_dir();
        let old = self
            .root
            .join(".staging")
            .join(format!("{ENHANCED_MODEL_ID}.old"));
        let _ = fs::remove_dir_all(&old);
        if installed.exists() {
            fs::rename(&installed, &old).map_err(|_| SpeechError::ModelMissing)?;
        }
        if fs::rename(&staged, &installed).is_err() {
            let _ = fs::rename(&old, &installed);
            return Err(SpeechError::ModelMissing);
        }
        let _ = fs::remove_dir_all(&old);
        Ok(())
    }

    /// Removes the installed copy and any staging leftovers.
    ///
    /// # Errors
    ///
    /// [`SpeechError::ModelMissing`] when the directory exists but cannot be removed.
    pub fn remove(&self) -> Result<(), SpeechError> {
        let _ = fs::remove_dir_all(self.root.join(".staging"));
        match fs::remove_dir_all(self.installed_dir()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(SpeechError::ModelMissing),
        }
    }

    /// Removes leftovers of an interrupted download.
    pub fn clean_staging(&self) {
        let _ = fs::remove_dir_all(self.root.join(".staging"));
    }

    /// The model's paths.
    #[must_use]
    pub fn paths(&self) -> EnhancedModelPaths {
        let dir = self.installed_dir();
        EnhancedModelPaths {
            conv_frontend: dir.join("conv_frontend.onnx"),
            encoder: dir.join("encoder.int8.onnx"),
            decoder: dir.join("decoder.int8.onnx"),
            tokenizer: dir.join("tokenizer"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_manifest_parses() {
        let manifest = bundled_manifest();
        assert_eq!(manifest.runtime_version, "2.0.1");
        assert_eq!(manifest.model.len(), 6, "five model files and bpe.vocab");
        assert!(manifest.vad.path.ends_with("silero_vad.onnx"));
        if target_key() != "unsupported" && target_key() != "linux-x64" {
            assert!(!manifest.runtime.is_empty());
        }
        for file in manifest.model.iter().chain(&manifest.runtime) {
            assert_eq!(file.sha256.len(), 64);
            assert!(!file.path.contains(".."));
        }
    }

    #[test]
    fn enhanced_manifest_parses_and_pins_revisions() {
        let manifest = enhanced_manifest();
        assert_eq!(manifest.id, ENHANCED_MODEL_ID);
        assert_eq!(manifest.files.len(), 6);
        assert!(manifest.total_bytes() > 900_000_000);
        for file in &manifest.files {
            assert!(
                file.url.starts_with("https://modelscope.cn/"),
                "{}",
                file.url
            );
            assert!(file.url.contains("/resolve/"));
            assert!(EnhancedStore::file_path(Path::new("/x"), &file.path).is_ok());
        }
        assert!(manifest.allows_host("modelscope.cn"));
        assert!(manifest.allows_host("cdn-lfs-cn-1.modelscope.cn"));
        assert!(!manifest.allows_host("modelscope.cn.evil.example"));
        assert!(!manifest.allows_host("evilmodelscope.cn"));
        assert!(!manifest.allows_host(".modelscope.cn"));
    }

    #[test]
    fn manifest_paths_must_stay_inside() {
        let dir = Path::new("/models");
        for bad in ["../x", "/etc/passwd", "a/../../b", "", "a\\b"] {
            assert!(EnhancedStore::file_path(dir, bad).is_err(), "{bad}");
        }
        assert_eq!(
            EnhancedStore::file_path(dir, "tokenizer/vocab.json").ok(),
            Some(dir.join("tokenizer").join("vocab.json"))
        );
    }

    #[test]
    fn verification_reports_missing_and_damaged_files() {
        let dir = std::env::temp_dir().join(format!("piarc-speech-verify-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("a")).expect("dir");
        fs::write(dir.join("a").join("f.bin"), b"hello").expect("write");
        let good = ExpectedFile {
            path: "a/f.bin".into(),
            size: 5,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
        };
        assert_eq!(verify(&dir, std::slice::from_ref(&good)), Ok(()));
        assert_eq!(
            quick_state(&dir, std::slice::from_ref(&good)),
            SpeechModelState::Ready
        );
        let wrong_hash = ExpectedFile {
            sha256: "0".repeat(64),
            ..good.clone()
        };
        assert_eq!(verify(&dir, &[wrong_hash]), Err(SpeechError::ModelCorrupt));
        let wrong_size = ExpectedFile {
            size: 6,
            ..good.clone()
        };
        assert_eq!(
            quick_state(&dir, std::slice::from_ref(&wrong_size)),
            SpeechModelState::Corrupt
        );
        let absent = ExpectedFile {
            path: "a/none.bin".into(),
            ..good
        };
        assert_eq!(
            verify(&dir, std::slice::from_ref(&absent)),
            Err(SpeechError::ModelMissing)
        );
        assert_eq!(quick_state(&dir, &[absent]), SpeechModelState::Missing);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_download_that_fails_verification_is_removed() {
        let root = std::env::temp_dir().join(format!("piarc-speech-stage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = EnhancedStore::new(root.clone());
        fs::create_dir_all(store.staging_dir()).expect("staging");
        fs::write(store.staging_dir().join("conv_frontend.onnx"), b"truncated").expect("write");
        assert!(store.activate_staged().is_err());
        assert!(!store.staging_dir().exists());
        assert_eq!(store.quick_state(), SpeechModelState::Missing);
        assert_eq!(store.remove(), Ok(()));
        let _ = fs::remove_dir_all(&root);
    }
}
