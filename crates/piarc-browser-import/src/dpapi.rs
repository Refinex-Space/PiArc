//! A safe wrapper over DPAPI (`CryptUnprotectData`, Windows): Chrome protects its cookie key
//! with the current user's DPAPI key. The system allocates the output with `LocalAlloc`; the
//! bytes are copied into a zeroizing buffer, cleared and freed.

use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
};
use zeroize::{Zeroize, Zeroizing};

/// Copies a system-allocated blob out, clears it and frees it.
fn take(blob: &CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
    if blob.pbData.is_null() {
        return Zeroizing::new(Vec::new());
    }
    let len = usize::try_from(blob.cbData).unwrap_or(0);
    // SAFETY: on success the system set `pbData` to a `LocalAlloc` block of `cbData` bytes
    // that this function owns until `LocalFree`.
    let bytes = unsafe { std::slice::from_raw_parts_mut(blob.pbData, len) };
    let copy = Zeroizing::new(bytes.to_vec());
    bytes.zeroize();
    // SAFETY: the block came from `LocalAlloc` (DPAPI's contract) and is freed once.
    unsafe { LocalFree(blob.pbData.cast()) };
    copy
}

/// Decrypts `data` with the current user's DPAPI key, without UI. The error is the system's
/// error code.
pub(crate) fn unprotect(data: &[u8]) -> Result<Zeroizing<Vec<u8>>, i32> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| -1)?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: `input` points at `data`, which outlives the call and is only read; every
    // optional pointer is null; `output` is written by the call.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1));
    }
    Ok(take(&output))
}

/// Encrypts `data` with the current user's DPAPI key (tests build Chrome-shaped keys with it).
#[cfg(test)]
pub(crate) fn protect(data: &[u8]) -> Result<Vec<u8>, i32> {
    use windows_sys::Win32::Security::Cryptography::CryptProtectData;
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| -1)?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: as in `unprotect`; the description pointer is null.
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1));
    }
    Ok(take(&output).to_vec())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dpapi_round_trip() {
        let protected = super::protect(b"chrome key bytes").expect("protect");
        assert_ne!(protected, b"chrome key bytes");
        assert_eq!(
            super::unprotect(&protected).expect("unprotect").as_slice(),
            b"chrome key bytes"
        );
        assert!(super::unprotect(b"not a dpapi blob").is_err());
    }
}
