//! A child in a session of its own (`setsid(2)` between `fork` and `exec`), with no controlling
//! terminal. std's `CommandExt::setsid` is not stable yet (rust-lang/rust#105376), so this is
//! the crate's safe wrapper over the one `pre_exec` hook it needs (coding standards
//! section 2.8).

use tokio::process::Command;

/// Makes the child of `command` the leader of a new session and of a new process group (its
/// pid is the group id) with no controlling terminal.
pub(crate) fn new_session(command: &mut Command) {
    // SAFETY: the hook runs in the child between `fork` and `exec`, where only
    // async-signal-safe work is allowed. It makes one `setsid(2)` call, which is
    // async-signal-safe, and turns its errno into an `io::Error` by value without allocating;
    // it touches no lock and no memory shared with the parent.
    unsafe {
        command.pre_exec(|| {
            nix::unistd::setsid()
                .map(drop)
                .map_err(std::io::Error::from)
        });
    }
}
