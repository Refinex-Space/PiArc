//! The listening TCP sockets with their owning processes (Windows `GetExtendedTcpTable` with
//! `TCP_TABLE_OWNER_PID_LISTENER`, iphlpapi.h). A safe wrapper over one call per address
//! family; the bytes are read by `listeners::parse_tcp_table` without unsafe code (coding
//! standards section 2.8).

use std::io;

use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
};

/// `AF_INET` and `AF_INET6` of ws2def.h.
const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
/// Tries when the table grows between asking for its size and reading it.
const ATTEMPTS: usize = 4;

/// The raw listener table of IPv6 (`v6`) or IPv4: a `u32` count, then the rows.
pub(crate) fn listeners(v6: bool) -> io::Result<Vec<u8>> {
    let family = if v6 { AF_INET6 } else { AF_INET };
    let mut size: u32 = 0;
    // SAFETY: a null table with a size of 0 asks for the size needed; only `size` is written.
    let first = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &raw mut size,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != NO_ERROR && first != ERROR_INSUFFICIENT_BUFFER {
        return Err(os_error(first));
    }
    for _ in 0..ATTEMPTS {
        // Room for sockets opened between the calls; u32 words keep the rows aligned.
        let words = usize::try_from(size).map_err(io::Error::other)? / 4 + 64;
        let mut buffer = vec![0u32; words];
        let mut capacity = u32::try_from(words * 4).map_err(io::Error::other)?;
        // SAFETY: the buffer is writable for `capacity` bytes and aligned for the table's
        // u32 fields; the call writes at most `capacity` bytes and sets the size it needs.
        let result = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &raw mut capacity,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == NO_ERROR {
            return Ok(buffer.iter().flat_map(|w| w.to_ne_bytes()).collect());
        }
        if result != ERROR_INSUFFICIENT_BUFFER {
            return Err(os_error(result));
        }
        size = capacity;
    }
    Err(io::Error::other("the TCP table kept growing"))
}

fn os_error(code: u32) -> io::Error {
    i32::try_from(code).map_or_else(
        |_| io::Error::other(format!("error {code}")),
        io::Error::from_raw_os_error,
    )
}
