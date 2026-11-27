//! Loads the sherpa-onnx C API library at run time (ADR-0094). Not generated.
//!
//! The libraries are opened by absolute path from the directory the caller names, ONNX Runtime
//! first and then the C API that depends on it, so neither is looked up by name (Windows ships
//! an unrelated `onnxruntime.dll` in System32). A loaded library stays loaded for the rest of
//! the process: ONNX Runtime does not support being unloaded, and the function table points
//! into it.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::table::Table;

/// The libraries and the function table resolved from them; never dropped.
struct Loaded {
    _runtime: libloading::Library,
    _api: libloading::Library,
    table: Table,
}

static LOADED: OnceLock<Loaded> = OnceLock::new();
static LOADING: Mutex<()> = Mutex::new(());

/// File names of the runtime libraries in load order: ONNX Runtime, then the C API.
#[must_use]
pub fn runtime_files() -> &'static [&'static str] {
    if cfg!(windows) {
        &["onnxruntime.dll", "sherpa-onnx-c-api.dll"]
    } else if cfg!(target_os = "macos") {
        &["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"]
    } else {
        &["libonnxruntime.so", "libsherpa-onnx-c-api.so"]
    }
}

/// Why the C API could not be loaded.
#[derive(Debug)]
pub enum LoadError {
    /// A library file is not in the directory.
    Missing(PathBuf),
    /// The system loader refused a library (wrong architecture, damaged file, missing
    /// dependency); the message is the loader's.
    Open {
        /// The library that failed.
        file: PathBuf,
        /// The system loader's message.
        message: String,
    },
    /// The library loaded but lacks a function every recognizer needs.
    Incomplete(&'static str),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(file) => write!(f, "speech runtime file missing: {}", file.display()),
            Self::Open { file, message } => {
                write!(
                    f,
                    "cannot load speech runtime {}: {message}",
                    file.display()
                )
            }
            Self::Incomplete(name) => write!(f, "speech runtime lacks {name}"),
        }
    }
}

impl std::error::Error for LoadError {}

/// Functions the speech engine cannot work without; a library missing one is rejected.
const REQUIRED: &[&str] = &[
    "SherpaOnnxGetVersionStr",
    "SherpaOnnxCreateOnlineRecognizer",
    "SherpaOnnxCreateOnlineStream",
    "SherpaOnnxOnlineStreamAcceptWaveform",
    "SherpaOnnxDecodeOnlineStream",
    "SherpaOnnxGetOnlineStreamResultAsJson",
    "SherpaOnnxCreateOfflineRecognizer",
    "SherpaOnnxCreateVoiceActivityDetector",
];

/// Loads the runtime from `dir` once; later calls return `Ok(())` without touching `dir`.
///
/// # Errors
///
/// [`LoadError`] when a file is missing, the system loader refuses it, or a required function
/// is absent. A failed load leaves nothing loaded and can be retried.
pub fn load(dir: &Path) -> Result<(), LoadError> {
    if LOADED.get().is_some() {
        return Ok(());
    }
    let _guard = LOADING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if LOADED.get().is_some() {
        return Ok(());
    }
    let [runtime_name, api_name] = runtime_files() else {
        return Err(LoadError::Incomplete("runtime file list"));
    };
    let runtime = open(&dir.join(runtime_name))?;
    let api = open(&dir.join(api_name))?;
    let table = Table::resolve(&api);
    for name in REQUIRED {
        if !table.has(name) {
            return Err(LoadError::Incomplete(name));
        }
    }
    // Another caller cannot have set it: we hold LOADING.
    let _ = LOADED.set(Loaded {
        _runtime: runtime,
        _api: api,
        table,
    });
    Ok(())
}

/// Whether [`load`] has succeeded in this process.
#[must_use]
pub fn is_loaded() -> bool {
    LOADED.get().is_some()
}

/// The function table, once loaded.
pub(crate) fn table() -> Option<&'static Table> {
    LOADED.get().map(|loaded| &loaded.table)
}

fn open(file: &Path) -> Result<libloading::Library, LoadError> {
    if !file.is_file() {
        return Err(LoadError::Missing(file.to_path_buf()));
    }
    open_library(file).map_err(|error| LoadError::Open {
        file: file.to_path_buf(),
        message: error.to_string(),
    })
}

#[cfg(windows)]
fn open_library(file: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::windows::{LOAD_WITH_ALTERED_SEARCH_PATH, Library};
    // SAFETY: the file is one of the verified runtime libraries (piarc-speech checks size and
    // SHA-256 before calling `load`); its initialisers are ONNX Runtime's and sherpa-onnx's.
    // LOAD_WITH_ALTERED_SEARCH_PATH resolves its dependencies next to it, not by search order.
    unsafe { Library::load_with_flags(file, LOAD_WITH_ALTERED_SEARCH_PATH) }.map(Into::into)
}

#[cfg(not(windows))]
fn open_library(file: &Path) -> Result<libloading::Library, libloading::Error> {
    // SAFETY: the file is one of the verified runtime libraries (piarc-speech checks size and
    // SHA-256 before calling `load`); its initialisers are ONNX Runtime's and sherpa-onnx's. The
    // C API finds ONNX Runtime through its `@loader_path` rpath, the image opened just before.
    unsafe { libloading::Library::new(file) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn functions_return_null_or_zero_before_loading() {
        assert!(table().is_none() || is_loaded());
        if !is_loaded() {
            // SAFETY: with nothing loaded the wrapper does not call into C; a null config is
            // never dereferenced.
            let recognizer = unsafe { crate::SherpaOnnxCreateOnlineRecognizer(std::ptr::null()) };
            assert!(recognizer.is_null());
            // SAFETY: as above.
            assert_eq!(unsafe { crate::SherpaOnnxFileExists(std::ptr::null()) }, 0);
        }
    }

    #[test]
    fn a_missing_directory_is_reported_without_loading() {
        let dir = std::env::temp_dir().join("piarc-sherpa-sys-missing-runtime");
        match load(&dir) {
            Err(LoadError::Missing(file)) => assert!(file.starts_with(&dir)),
            other => assert!(is_loaded(), "unexpected {other:?}"),
        }
    }
}
