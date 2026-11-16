//! Windows console state that programs in a ConPTY inherit from this process.

use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

/// Lets programs started from now on receive Ctrl+C.
///
/// Ignoring Ctrl+C (`SetConsoleCtrlHandler(NULL, TRUE)`, or being started in a new process
/// group) is inherited by child processes. A process that started PiArc that way would pass it
/// on to every program in a terminal, and Ctrl+C typed there would not interrupt anything. The
/// call changes only that inherited flag: handlers this process registered stay, and a process
/// without a console is not affected otherwise.
pub fn let_children_handle_ctrl_c() {
    // SAFETY: a null handler with `add = FALSE` only clears the process's ignore-Ctrl+C flag;
    // no pointer is passed and nothing is retained.
    let _ = unsafe { SetConsoleCtrlHandler(None, 0) };
}
