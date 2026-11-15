//! The operating system's random number generator.

use crate::error::{Error, Result};

/// Fills `buffer` with random bytes.
///
/// # Errors
///
/// [`Error::Random`] when the generator fails.
pub fn fill(buffer: &mut [u8]) -> Result<()> {
    getrandom::fill(buffer).map_err(|e| Error::Random(e.to_string()))
}

/// `len` random bytes as lowercase hex.
///
/// # Errors
///
/// [`Error::Random`] when the generator fails.
pub fn hex_id(len: usize) -> Result<String> {
    let mut bytes = vec![0u8; len];
    fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
