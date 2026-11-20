//! The processes whose controlling terminal is a given terminal device (macOS
//! `proc_listpids(PROC_TTY_ONLY, …)`, libproc.h). A safe wrapper over one call; with `job`
//! the crate's only unsafe code (coding standards section 2.8).

use std::io;

/// `PROC_TTY_ONLY` of libproc.h: list processes by controlling terminal (`typeinfo` is the
/// terminal's device number).
const PROC_TTY_ONLY: u32 = 3;

/// The pids of every process whose controlling terminal is device `device` (`st_rdev` of the
/// terminal's path).
pub(crate) fn processes_of_tty(device: u64) -> io::Result<Vec<i32>> {
    let device = u32::try_from(device).map_err(io::Error::other)?;
    let pid_size = size_of::<libc::pid_t>();
    // SAFETY: a null buffer with size 0 asks for the size needed; nothing is written.
    let needed = unsafe { libc::proc_listpids(PROC_TTY_ONLY, device, std::ptr::null_mut(), 0) };
    if needed < 0 {
        return Err(io::Error::last_os_error());
    }
    // Room for processes started between the two calls.
    let capacity = usize::try_from(needed).unwrap_or(0) / pid_size + 64;
    let mut pids: Vec<libc::pid_t> = vec![0; capacity];
    let bytes = i32::try_from(capacity * pid_size).map_err(io::Error::other)?;
    // SAFETY: the buffer is writable for `bytes` bytes of pid_t values.
    let filled =
        unsafe { libc::proc_listpids(PROC_TTY_ONLY, device, pids.as_mut_ptr().cast(), bytes) };
    if filled < 0 {
        return Err(io::Error::last_os_error());
    }
    pids.truncate(usize::try_from(filled).unwrap_or(0) / pid_size);
    pids.retain(|pid| *pid > 0);
    Ok(pids)
}
