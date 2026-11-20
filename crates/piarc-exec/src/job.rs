//! Safe wrapper over the Windows Job Object calls [`crate::ProcessTreeSpawner`] needs. This
//! module is the crate's only unsafe code (coding standards section 2.8).
//!
//! A [`Job`] has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway flag: closing its
//! handle ends every process in it, and a process in it cannot create a child outside it
//! (`CREATE_BREAKAWAY_FROM_JOB` fails with access denied).

use std::io;
use std::os::windows::io::RawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE, ResumeThread,
    THREAD_SUSPEND_RESUME,
};

pub(crate) use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

/// Exit code of processes ended by [`Job::terminate`].
const TERMINATED_EXIT_CODE: u32 = 1;

/// An owned handle, closed on drop.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful Win32 call, is owned by this value
        // alone and is closed exactly once, here.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A Job Object that ends all its processes when dropped.
pub(crate) struct Job(OwnedHandle);

// SAFETY: a job handle is a kernel object reference; Job Object calls are thread-safe and
// this type never hands the raw handle out.
unsafe impl Send for Job {}
// SAFETY: as above; every method takes `&self` and only passes the handle to thread-safe
// Win32 calls.
unsafe impl Sync for Job {}

impl Job {
    /// An unnamed job with `KILL_ON_JOB_CLOSE` and no breakaway permission.
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security attributes and a null name are documented as valid.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(OwnedHandle(handle));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(io::Error::other)?;
        // SAFETY: the pointer and size describe a live JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        // the structure this information class expects; the handle is valid.
        let ok = unsafe {
            SetInformationJobObject(
                job.0.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Puts `process` into the job.
    pub(crate) fn assign(&self, process: RawHandle) -> io::Result<()> {
        // SAFETY: both handles are valid: the job is owned by `self`, the process handle
        // belongs to a child the caller still holds.
        let ok = unsafe { AssignProcessToJobObject(self.0.0, process) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Puts the running process `pid` into the job (a terminal's shell, started by the PTY
    /// library); what it starts from then on joins the job too.
    pub(crate) fn assign_pid(&self, pid: u32) -> io::Result<()> {
        // SAFETY: OpenProcess takes no pointers; a null result is checked below.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let process = OwnedHandle(process);
        self.assign(process.0)
    }

    /// Ends every process in the job.
    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: the job handle is valid while `self` lives.
        let ok = unsafe { TerminateJobObject(self.0.0, TERMINATED_EXIT_CODE) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The job's limit flags, to check that no breakaway flag is set.
    #[cfg(test)]
    pub(crate) fn limit_flags(&self) -> io::Result<u32> {
        use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(io::Error::other)?;
        // SAFETY: the pointer and size describe a writable structure of the type this
        // information class returns; the returned-length pointer may be null.
        let ok = unsafe {
            QueryInformationJobObject(
                self.0.0,
                JobObjectExtendedLimitInformation,
                (&raw mut limits).cast(),
                size,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(limits.BasicLimitInformation.LimitFlags)
    }
}

/// Resumes every thread of process `pid`: a process created with `CREATE_SUSPENDED` has
/// exactly one, its main thread.
pub(crate) fn resume_process(pid: u32) -> io::Result<()> {
    let snapshot = snapshot(TH32CS_SNAPTHREAD)?;
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(size_of::<THREADENTRY32>()).map_err(io::Error::other)?,
        ..THREADENTRY32::default()
    };
    let mut resumed = 0_usize;
    // SAFETY: the snapshot handle is valid and `entry.dwSize` is set as the call requires.
    let mut more = unsafe { Thread32First(snapshot.0, &raw mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            resume_thread(entry.th32ThreadID)?;
            resumed += 1;
        }
        // SAFETY: as for Thread32First.
        more = unsafe { Thread32Next(snapshot.0, &raw mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(io::Error::other(format!(
            "process {pid} has no thread to resume"
        )));
    }
    Ok(())
}

fn resume_thread(thread_id: u32) -> io::Result<()> {
    // SAFETY: OpenThread accepts any id and returns null when it cannot open it.
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let thread = OwnedHandle(thread);
    // SAFETY: the handle was opened with THREAD_SUSPEND_RESUME and is valid.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn snapshot(flags: u32) -> io::Result<OwnedHandle> {
    // SAFETY: a snapshot of all processes or threads (process id 0) takes no pointers.
    let handle = unsafe { CreateToolhelp32Snapshot(flags, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnedHandle(handle))
}

/// One running process, for tests that follow a process tree.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProcessEntry {
    pub(crate) pid: u32,
    pub(crate) parent: u32,
}

/// Every running process with its parent's pid.
#[cfg(test)]
pub(crate) fn process_table() -> io::Result<Vec<ProcessEntry>> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let snapshot = snapshot(TH32CS_SNAPPROCESS)?;
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).map_err(io::Error::other)?,
        ..PROCESSENTRY32W::default()
    };
    let mut table = Vec::new();
    // SAFETY: the snapshot handle is valid and `entry.dwSize` is set as the call requires.
    let mut more = unsafe { Process32FirstW(snapshot.0, &raw mut entry) } != 0;
    while more {
        table.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
        });
        // SAFETY: as for Process32FirstW.
        more = unsafe { Process32NextW(snapshot.0, &raw mut entry) } != 0;
    }
    Ok(table)
}

/// Detaches the test process from its console, so children start the way they do from a GUI
/// process such as PiArc (which has no console).
#[cfg(test)]
pub(crate) fn detach_from_console() {
    // SAFETY: FreeConsole takes no arguments and only ends this process's console attachment;
    // standard handles already opened stay valid.
    unsafe {
        windows_sys::Win32::System::Console::FreeConsole();
    }
}

/// Whether no running process has `pid`.
#[cfg(test)]
pub(crate) fn terminated(pid: u32) -> bool {
    process_table().is_ok_and(|table| table.iter().all(|p| p.pid != pid))
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    use super::*;

    #[test]
    fn a_new_job_kills_on_close_and_allows_no_breakaway() {
        let job = Job::new().expect("job");
        let flags = job.limit_flags().expect("limits");
        assert_eq!(
            flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        );
        assert_eq!(flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK, 0);
        assert_eq!(flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, 0);
    }
}
