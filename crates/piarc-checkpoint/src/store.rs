//! The content-addressed object store under `<data dir>/checkpoints/objects/` (architecture
//! section 9.1, ADR-0044 rule 2).
//!
//! An object is named by the SHA-256 of its bytes and lives at `<root>/<first two hex
//! digits>/<64 hex digits>`, so equal contents are stored once. Objects are written to a
//! temporary file in their bucket and renamed into place; reads verify the hash.
//!
//! Pins keep objects alive while something still needs them: a write between storing the old
//! bytes and recording them in the index, a rewind reading its targets. [`ObjectStore::put`]
//! pins before it checks whether the object exists, and [`ObjectStore::collect_garbage`] checks
//! the pins and removes a file under the same lock, so an object being stored or used is never
//! removed underneath it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// A SHA-256 digest: the name of an object.
pub type Hash = [u8; 32];

/// Temporary files older than this are leftovers of an interrupted write.
const STALE_TEMP: Duration = Duration::from_secs(60 * 60);

const TEMP_PREFIX: &str = ".tmp-";

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// The SHA-256 of `bytes`.
#[must_use]
pub fn hash_of(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

/// `hash` as 64 lowercase hex digits.
#[must_use]
pub fn to_hex(hash: &Hash) -> String {
    use std::fmt::Write as _;
    hash.iter().fold(String::with_capacity(64), |mut text, b| {
        let _ = write!(text, "{b:02x}");
        text
    })
}

/// Parses 64 hex digits (either case).
#[must_use]
pub fn from_hex(text: &str) -> Option<Hash> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut hash = [0_u8; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(hash)
}

type Pins = Arc<Mutex<HashMap<Hash, usize>>>;

/// The object store. Cheap to clone; clones share the pins.
#[derive(Debug, Clone)]
pub struct ObjectStore {
    root: PathBuf,
    pins: Pins,
}

/// Keeps one object from being collected until dropped.
#[derive(Debug)]
pub struct Pin {
    hash: Hash,
    pins: Pins,
}

impl Pin {
    /// The pinned object's hash.
    #[must_use]
    pub fn hash(&self) -> Hash {
        self.hash
    }
}

impl Drop for Pin {
    fn drop(&mut self) {
        let mut pins = lock(&self.pins);
        if let Some(count) = pins.get_mut(&self.hash) {
            *count -= 1;
            if *count == 0 {
                pins.remove(&self.hash);
            }
        }
    }
}

/// What a collection removed and kept.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Collected {
    /// Objects removed: neither referenced nor pinned.
    pub removed: usize,
    /// Objects kept.
    pub kept: usize,
    /// Leftover temporary files removed.
    pub temporary: usize,
}

impl ObjectStore {
    /// The store rooted at `root`, created when missing.
    ///
    /// # Errors
    ///
    /// The directory cannot be created.
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root).map_err(Error::io("creating", root))?;
        Ok(Self {
            root: root.to_owned(),
            pins: Arc::default(),
        })
    }

    /// The store's directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path_of(&self, hash: &Hash) -> PathBuf {
        let hex = to_hex(hash);
        self.root.join(&hex[..2]).join(hex)
    }

    /// Pins `hash` (whether or not the object exists yet).
    #[must_use]
    pub fn pin(&self, hash: Hash) -> Pin {
        *lock(&self.pins).entry(hash).or_insert(0) += 1;
        Pin {
            hash,
            pins: Arc::clone(&self.pins),
        }
    }

    /// Stores `bytes` (once per content) and returns its pin.
    ///
    /// # Errors
    ///
    /// The object cannot be written.
    pub fn put(&self, bytes: &[u8]) -> Result<Pin> {
        let pin = self.pin(hash_of(bytes));
        let path = self.path_of(&pin.hash);
        if !path.is_file() {
            write_object(&path, bytes)?;
        }
        Ok(pin)
    }

    /// Whether the object exists.
    #[must_use]
    pub fn contains(&self, hash: &Hash) -> bool {
        self.path_of(hash).is_file()
    }

    /// The bytes of the object `hash`, verified.
    ///
    /// # Errors
    ///
    /// [`Error::Missing`], [`Error::Corrupt`], or an I/O error.
    pub fn get(&self, hash: &Hash) -> Result<Vec<u8>> {
        let path = self.path_of(hash);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(Error::Missing { hash: to_hex(hash) });
            }
            Err(e) => return Err(Error::io("reading", &path)(e)),
        };
        if &hash_of(&bytes) != hash {
            return Err(Error::Corrupt { hash: to_hex(hash) });
        }
        Ok(bytes)
    }

    /// How many objects the store holds.
    ///
    /// # Errors
    ///
    /// The directory cannot be listed.
    pub fn count(&self) -> Result<usize> {
        let mut count = 0;
        self.for_each_entry(|entry| {
            if entry.hash.is_some() {
                count += 1;
            }
            Ok(())
        })?;
        Ok(count)
    }

    /// Removes every object that is neither in `referenced` nor pinned, and temporary files
    /// left by interrupted writes.
    ///
    /// # Errors
    ///
    /// The directory cannot be listed or a file cannot be removed.
    pub fn collect_garbage(&self, referenced: &HashSet<Hash>) -> Result<Collected> {
        let mut collected = Collected::default();
        let now = SystemTime::now();
        self.for_each_entry(|entry| {
            match entry.hash {
                Some(hash) => {
                    if referenced.contains(&hash) {
                        collected.kept += 1;
                        return Ok(());
                    }
                    // Checked and removed under the pins' lock: a `put` of the same content
                    // either pinned first (kept) or checks for the file after it is gone.
                    let pins = lock(&self.pins);
                    if pins.contains_key(&hash) {
                        collected.kept += 1;
                    } else {
                        remove(&entry.path)?;
                        collected.removed += 1;
                    }
                    drop(pins);
                }
                None if entry.temporary => {
                    let old = fs::metadata(&entry.path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|m| now.duration_since(m).ok())
                        .is_some_and(|age| age > STALE_TEMP);
                    if old {
                        remove(&entry.path)?;
                        collected.temporary += 1;
                    }
                }
                None => {}
            }
            Ok(())
        })?;
        Ok(collected)
    }

    fn for_each_entry(&self, mut f: impl FnMut(Entry) -> Result<()>) -> Result<()> {
        let buckets = match fs::read_dir(&self.root) {
            Ok(buckets) => buckets,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(Error::io("listing", &self.root)(e)),
        };
        for bucket in buckets {
            let bucket = bucket.map_err(Error::io("listing", &self.root))?;
            let dir = bucket.path();
            if !dir.is_dir() {
                continue;
            }
            for file in fs::read_dir(&dir).map_err(Error::io("listing", &dir))? {
                let file = file.map_err(Error::io("listing", &dir))?;
                let name = file.file_name();
                let name = name.to_string_lossy();
                let hash = from_hex(&name).filter(|h| to_hex(h)[..2] == *bucket.file_name());
                f(Entry {
                    temporary: hash.is_none() && name.starts_with(TEMP_PREFIX),
                    hash,
                    path: file.path(),
                })?;
            }
        }
        Ok(())
    }
}

struct Entry {
    hash: Option<Hash>,
    temporary: bool,
    path: PathBuf,
}

fn write_object(path: &Path, bytes: &[u8]) -> Result<()> {
    let bucket = path
        .parent()
        .ok_or_else(|| Error::io("writing", path)(io::Error::other("no bucket")))?;
    fs::create_dir_all(bucket).map_err(Error::io("creating", bucket))?;
    let temp = bucket.join(format!(
        "{TEMP_PREFIX}{}-{}",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = fs::File::create(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temp, path));
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        // Another writer stored the same content first (Windows refuses to rename over a file
        // that is open for reading).
        if path.is_file() {
            return Ok(());
        }
        return Err(Error::io("writing", path)(error));
    }
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::io("removing", path)(e)),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
