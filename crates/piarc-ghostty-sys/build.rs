//! Fetches, verifies and links the official libghostty-vt prebuilt artefact for the target
//! (ADR-0017). The steps, in order:
//!
//! 1. Read `ghostty-vt.lock.json`: version, URLs, SHA-256 digests and the minisign key live
//!    there and nowhere else.
//! 2. Take `<file>` and `<file>.minisig` from the cache directory, downloading them with `curl`
//!    when missing (never when `PIARC_GHOSTTY_VT_OFFLINE` is set). The cache defaults to
//!    `<repo>/.tools/cache/ghostty-vt/<version>/`; `PIARC_GHOSTTY_VT_CACHE` overrides it, which
//!    is what CI caches.
//! 3. Verify the SHA-256 and the minisign signature (`build/artifact.rs`). Either failure stops
//!    the build with the reason; a corrupt cached copy is never replaced silently.
//! 4. Unpack the archive into `OUT_DIR` with `tar` and emit the link directives: the static
//!    library on macOS, the import library of the DLL on Windows MSVC (the DLL ships next to
//!    the `.node`, see `crates/piarc-term/CLAUDE.md`).

#[path = "build/artifact.rs"]
mod artifact;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use artifact::{Artifact, Link, Lock};

const CACHE_ENV: &str = "PIARC_GHOSTTY_VT_CACHE";
const OFFLINE_ENV: &str = "PIARC_GHOSTTY_VT_OFFLINE";

fn main() {
    if let Err(message) = run() {
        eprintln!("error: piarc-ghostty-sys: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let manifest_dir = PathBuf::from(var("CARGO_MANIFEST_DIR")?);
    let lock_path = manifest_dir.join("ghostty-vt.lock.json");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build/artifact.rs");
    println!("cargo:rerun-if-env-changed={CACHE_ENV}");
    println!("cargo:rerun-if-env-changed={OFFLINE_ENV}");

    let lock = Lock::parse(&read_text(&lock_path)?)?;
    let target = var("TARGET")?;
    let artifact = lock.artifact_for(&target).ok_or_else(|| {
        format!(
            "no libghostty-vt artefact is locked for target {target}; locked targets: {}",
            lock.targets().join(", ")
        )
    })?;

    let cache = cache_dir(&manifest_dir, &lock);
    let data_path = cache.join(&artifact.file);
    let signature_path = cache.join(format!("{}.minisig", artifact.file));
    for path in [&data_path, &signature_path] {
        ensure_cached(&lock, path)?;
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let data = fs::read(&data_path)
        .map_err(|error| format!("cannot read {}: {error}", data_path.display()))?;
    let signature = read_text(&signature_path)?;
    artifact::verify(&lock, artifact, &data, &signature).map_err(|error| {
        format!(
            "{} failed verification: {error}. It was not used. If the cached copy in {} is \
             corrupt, delete {} and its .minisig to download them again; if the lock file was \
             edited, check the change against the official SHA256SUMS.",
            artifact.file,
            cache.display(),
            artifact.file
        )
    })?;

    let out = PathBuf::from(var("OUT_DIR")?).join("ghostty-vt");
    unpack(&data_path, &out)?;
    link(artifact, &out)?;
    println!(
        "cargo:include={}",
        out.join(&artifact.include_dir).display()
    );
    println!("cargo:root={}", out.display());
    Ok(())
}

fn var(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("cargo did not set {name}"))
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("cannot read {}: {error}", path.display()))
}

/// `PIARC_GHOSTTY_VT_CACHE`, or `<repo>/.tools/cache/ghostty-vt/<version>`.
fn cache_dir(manifest_dir: &Path, lock: &Lock) -> PathBuf {
    match env::var_os(CACHE_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(&lock.version),
        _ => {
            // crates/piarc-ghostty-sys → repository root.
            let repo = manifest_dir
                .parent()
                .and_then(Path::parent)
                .unwrap_or(manifest_dir);
            repo.join(".tools")
                .join("cache")
                .join("ghostty-vt")
                .join(&lock.version)
        }
    }
}

/// Downloads `path`'s file name from the release directory unless it is already cached.
fn ensure_cached(lock: &Lock, path: &Path) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("bad cache path {}", path.display()))?;
    if env::var_os(OFFLINE_ENV).is_some_and(|value| !value.is_empty()) {
        return Err(format!(
            "{} is not cached and {OFFLINE_ENV} forbids downloading it",
            path.display()
        ));
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    let partial = path.with_file_name(format!("{name}.partial"));
    let url = format!("{}{name}", lock.base_url);
    let status = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" })
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--tlsv1.2",
            "--retry",
            "3",
            "--output",
        ])
        .arg(&partial)
        .arg(&url)
        .status()
        .map_err(|error| format!("cannot run curl to download {url}: {error}"))?;
    if !status.success() {
        // A partial download is useless; the next build starts over.
        let _ = fs::remove_file(&partial);
        return Err(format!("downloading {url} failed ({status})"));
    }
    fs::rename(&partial, path).map_err(|error| {
        format!(
            "cannot move {} to {}: {error}",
            partial.display(),
            path.display()
        )
    })
}

/// Unpacks the zip archive into a fresh `out` with the system `tar` (bsdtar on macOS and on
/// Windows 10 and later, both of which read zip).
fn unpack(archive: &Path, out: &Path) -> Result<(), String> {
    if out.exists() {
        fs::remove_dir_all(out)
            .map_err(|error| format!("cannot clear {}: {error}", out.display()))?;
    }
    fs::create_dir_all(out).map_err(|error| format!("cannot create {}: {error}", out.display()))?;
    let status = Command::new(system_tar())
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(out)
        .status()
        .map_err(|error| format!("cannot run tar to unpack {}: {error}", archive.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "tar could not unpack {} ({status})",
            archive.display()
        ))
    }
}

/// Windows: the bsdtar in System32. Git for Windows puts a GNU tar on PATH that cannot read zip.
fn system_tar() -> PathBuf {
    if cfg!(windows)
        && let Some(root) = env::var_os("SystemRoot")
    {
        let tar = PathBuf::from(root).join("System32").join("tar.exe");
        if tar.is_file() {
            return tar;
        }
    }
    PathBuf::from("tar")
}

fn link(artifact: &Artifact, out: &Path) -> Result<(), String> {
    let lib_dir = out.join(&artifact.lib_dir);
    if !lib_dir.is_dir() {
        return Err(format!("the archive has no {} directory", artifact.lib_dir));
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    match artifact.link {
        Link::Static => {
            println!("cargo:rustc-link-lib=static=ghostty-vt");
        }
        Link::Dll => {
            let dll = artifact
                .dll
                .as_deref()
                .map(|dll| out.join(dll))
                .ok_or("a DLL artefact names no DLL")?;
            if !dll.is_file() {
                return Err(format!("the archive has no {}", dll.display()));
            }
            // `ghostty-vt.lib` in lib/ is the import library of the DLL.
            println!("cargo:rustc-link-lib=dylib=ghostty-vt");
            // Cargo puts link-search directories inside the target directory on PATH for
            // `cargo test` and `cargo run`, so test binaries find the DLL.
            if let Some(bin) = dll.parent() {
                println!("cargo:rustc-link-search=native={}", bin.display());
            }
            println!("cargo:dll={}", dll.display());
        }
    }
    Ok(())
}
