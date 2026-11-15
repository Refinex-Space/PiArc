//! The vault's plaintext: credential key → value and metadata, as JSON.
//!
//! ```json
//! { "nextRevision": 4,
//!   "entries": { "oauth/example": { "revision": 3, "updatedAt": 1763200000000, "value": "{…}" } } }
//! ```
//!
//! `value` holds the credential's JSON text. Revisions come from one counter per vault, so a
//! key that is deleted and written again never reuses a revision.
//!
//! Plaintext lives in [`Zeroizing`] buffers that are zeroed when dropped; serialization
//! writes into a buffer that zeroes every allocation it outgrows. Scratch buffers inside
//! `serde_json` while parsing are outside this control.

use std::collections::BTreeMap;
use std::io;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

/// One stored credential.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredEntry {
    pub(crate) revision: u64,
    /// Unix milliseconds of the last write.
    pub(crate) updated_at: u64,
    /// The credential's JSON text.
    pub(crate) value: Zeroizing<String>,
}

/// The whole plaintext.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub(crate) next_revision: u64,
    pub(crate) entries: BTreeMap<String, StoredEntry>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            next_revision: 1,
            entries: BTreeMap::new(),
        }
    }
}

impl Document {
    /// Serializes into a buffer that is zeroed when dropped.
    pub(crate) fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        let mut writer = ZeroizingWriter::with_capacity(
            256 + self
                .entries
                .iter()
                .map(|(k, e)| k.len() + e.value.len() * 2 + 64)
                .sum::<usize>(),
        );
        // Serializing plain structs and strings into memory cannot fail.
        let _ = serde_json::to_writer(&mut writer, self);
        writer.into_inner()
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(bytes)
    }
}

/// Serializes `value` into a zeroing buffer and returns it as text.
pub(crate) fn json_text(value: &serde_json::Value) -> Zeroizing<String> {
    let mut writer = ZeroizingWriter::with_capacity(256);
    let _ = serde_json::to_writer(&mut writer, value);
    let mut bytes = writer.into_inner();
    // The buffer moves into the String without a copy; serde_json only writes UTF-8.
    match String::from_utf8(std::mem::take(&mut *bytes)) {
        Ok(text) => Zeroizing::new(text),
        Err(error) => {
            error.into_bytes().zeroize();
            Zeroizing::new(String::new())
        }
    }
}

/// A `Vec<u8>` writer that zeroes the old allocation whenever it has to grow.
pub(crate) struct ZeroizingWriter {
    buffer: Zeroizing<Vec<u8>>,
}

impl ZeroizingWriter {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            buffer: Zeroizing::new(Vec::with_capacity(capacity)),
        }
    }

    pub(crate) fn into_inner(self) -> Zeroizing<Vec<u8>> {
        self.buffer
    }
}

impl io::Write for ZeroizingWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let needed = self.buffer.len() + data.len();
        if needed > self.buffer.capacity() {
            let mut grown =
                Zeroizing::new(Vec::with_capacity(needed.max(self.buffer.capacity() * 2)));
            grown.extend_from_slice(&self.buffer);
            // The old allocation is zeroed when `grown` replaces it.
            std::mem::swap(&mut self.buffer, &mut grown);
            grown.zeroize();
        }
        self.buffer.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
