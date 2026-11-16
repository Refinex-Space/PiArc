//! [`ProcessTreeSpawner`]: a [`ProcessSpawner`] whose kill ends the whole process tree.
//!
//! - Unix: the child leads a new process group (`process_group(0)`, set between `fork` and
//!   `exec`, so nothing it starts runs outside the group); kill and drop send `SIGKILL` to the
//!   group. A descendant that leaves the group on purpose (`setsid`, `setpgid`) is not reached;
//!   process groups are a cleanup tool, not a boundary (T17 decides whether more is needed).
//! - Windows: the child is created suspended, put into a new Job Object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway permission, and only then resumed,
//!   so it cannot start anything outside the job. Kill terminates the job; drop closes its
//!   handle, which ends every process still in it.
//!
//! Drop ends the tree on both platforms, also after the direct child exited normally:
//! background processes a command left behind end with it.

use std::io;

use piarc_ports::{
    BoxFuture, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};
use tokio::process::Child;

use crate::spawner::{take_stdio, wait_child};

/// Starts processes whose [`ProcessControl::kill`] and drop end the whole process tree.
/// Must be used inside a tokio runtime.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessTreeSpawner;

impl ProcessSpawner for ProcessTreeSpawner {
    fn spawn(&self, spec: SpawnSpec) -> io::Result<SpawnedProcess> {
        let (mut child, tree) = platform::spawn(&spec)?;
        let (stdin, stdout, stderr) = take_stdio(&mut child)?;
        Ok(SpawnedProcess {
            stdin,
            stdout,
            stderr,
            control: Box::new(TreeChild { child, tree }),
        })
    }
}

struct TreeChild {
    child: Child,
    tree: platform::Tree,
}

impl ProcessControl for TreeChild {
    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    fn kill(&mut self) -> io::Result<()> {
        self.tree.kill()
    }

    fn wait(&mut self) -> BoxFuture<'_, io::Result<ExitStatus>> {
        Box::pin(wait_child(&mut self.child))
    }
}

#[cfg(unix)]
mod platform {
    use std::io;

    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    use piarc_ports::SpawnSpec;
    use tokio::process::Child;

    use crate::spawner::command;

    /// The process group the child leads.
    pub(super) struct Tree(Pid);

    pub(super) fn spawn(spec: &SpawnSpec) -> io::Result<(Child, Tree)> {
        let child = command(spec).process_group(0).spawn()?;
        let pid = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .ok_or_else(|| io::Error::other("the new process has no usable pid"))?;
        Ok((child, Tree(Pid::from_raw(pid))))
    }

    impl Tree {
        pub(super) fn kill(&self) -> io::Result<()> {
            match killpg(self.0, Signal::SIGKILL) {
                // The whole group is gone already.
                Ok(()) | Err(Errno::ESRCH) => Ok(()),
                Err(errno) => Err(io::Error::from(errno)),
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            // Nothing to report from a destructor; an empty group answers ESRCH.
            let _ = self.kill();
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::io;

    use piarc_ports::SpawnSpec;
    use tokio::process::Child;

    use crate::job::{CREATE_SUSPENDED, Job, resume_process};
    use crate::spawner::command;

    /// The Job Object holding the child and everything it starts.
    pub(super) struct Tree(pub(super) Job);

    pub(super) fn spawn(spec: &SpawnSpec) -> io::Result<(Child, Tree)> {
        let job = Job::new()?;
        // Suspended: the child runs no instruction before it is in the job.
        let child = command(spec).creation_flags(CREATE_SUSPENDED).spawn()?;
        let joined = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("the new process has no handle"))
            .and_then(|handle| job.assign(handle))
            .and_then(|()| {
                let pid = child
                    .id()
                    .ok_or_else(|| io::Error::other("the new process has no pid"))?;
                resume_process(pid)
            });
        // On failure the child is dropped, and `kill_on_drop` terminates it while suspended.
        joined.map(|()| (child, Tree(job)))
    }

    impl Tree {
        pub(super) fn kill(&self) -> io::Result<()> {
            self.0.terminate()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use tokio::io::AsyncReadExt;

    use super::*;

    #[cfg(unix)]
    fn spec(script: &str) -> SpawnSpec {
        SpawnSpec {
            program: "/bin/sh".into(),
            args: vec![OsString::from("-c"), OsString::from(script)],
            cwd: std::env::temp_dir(),
            env: std::env::vars_os().filter(|(k, _)| k == "PATH").collect(),
        }
    }

    /// Whether a process with `pid` exists (zombies count: `kill -0` succeeds on them).
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits"));
        nix::sys::signal::kill(pid, None).is_ok()
    }

    /// Reads the `child grandchild` pids the script prints, then returns them.
    #[cfg(unix)]
    async fn descendant_pids(process: &mut SpawnedProcess) -> Vec<u32> {
        let mut out = String::new();
        let mut buf = [0_u8; 256];
        while !out.contains('\n') {
            let n = process.stdout.read(&mut buf).await.expect("reads");
            assert!(n > 0, "the script ended early: {out:?}");
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        out.split_whitespace()
            .map(|pid| pid.parse().expect("a pid"))
            .collect()
    }

    /// Parent sh → child sh → grandchild sleep; the parent prints the two descendants' pids.
    #[cfg(unix)]
    const TREE: &str = "sh -c 'sleep 60 & echo $!; wait' > \"$TMPFILE\" & \
                        CHILD=$!; while [ ! -s \"$TMPFILE\" ]; do sleep 0.01; done; \
                        echo $CHILD $(cat \"$TMPFILE\"); wait";

    #[cfg(unix)]
    async fn wait_gone(pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while pids.iter().any(|&pid| alive(pid)) {
            assert!(Instant::now() < deadline, "still running: {pids:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    fn tree_spec(name: &str) -> SpawnSpec {
        let file =
            std::env::temp_dir().join(format!("piarc-exec-tree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let mut spec = spec(TREE);
        spec.env.push(("TMPFILE".into(), file.into_os_string()));
        spec
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_ends_child_and_grandchild() {
        let mut process = ProcessTreeSpawner.spawn(tree_spec("kill")).expect("starts");
        let leader = process.control.pid().expect("pid");
        let pids = descendant_pids(&mut process).await;
        assert_eq!(pids.len(), 2, "{pids:?}");
        assert!(pids.iter().all(|&pid| alive(pid)));
        process.control.kill().expect("kill is sent");
        let status = process.control.wait().await.expect("waits");
        assert_eq!(status.signal, Some(9), "{status:?}");
        wait_gone(&pids).await;
        assert!(!alive(leader));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_handle_ends_the_tree() {
        let mut process = ProcessTreeSpawner.spawn(tree_spec("drop")).expect("starts");
        let pids = descendant_pids(&mut process).await;
        drop(process);
        wait_gone(&pids).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_after_a_normal_exit_is_not_an_error() {
        let mut process = ProcessTreeSpawner.spawn(spec("exit 4")).expect("starts");
        let status = process.control.wait().await.expect("waits");
        assert_eq!(status.code, Some(4));
        process.control.kill().expect("an empty group is fine");
    }

    /// Windows: parent cmd → child cmd → grandchild ping, all three in the job; closing the job
    /// (dropping the handle) or killing it ends all of them (S8, T11-A10).
    #[cfg(windows)]
    mod windows {
        use super::*;
        use crate::job::{process_table, terminated};

        fn tree_spec() -> SpawnSpec {
            let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
            let cmd = std::path::Path::new(&system_root)
                .join("System32")
                .join("cmd.exe");
            SpawnSpec {
                program: cmd,
                args: [
                    "/d",
                    "/c",
                    "start /b cmd /d /c ping -n 60 127.0.0.1 & ping -n 60 127.0.0.1",
                ]
                .iter()
                .map(OsString::from)
                .collect(),
                cwd: std::env::temp_dir(),
                env: std::env::vars_os()
                    .filter(|(k, _)| {
                        ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR"]
                            .iter()
                            .any(|name| k.eq_ignore_ascii_case(name))
                    })
                    .collect(),
            }
        }

        /// Waits until the job holds parent → child → grandchild; returns the three pids.
        async fn three_levels(process: &SpawnedProcess) -> [u32; 3] {
            let parent = process.control.pid().expect("pid");
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let table = process_table().expect("process snapshot");
                let children = |pid: u32| {
                    table
                        .iter()
                        .filter(move |p| p.parent == pid)
                        .map(|p| p.pid)
                        .collect::<Vec<_>>()
                };
                for child in children(parent) {
                    if let Some(&grandchild) = children(child).first() {
                        println!("parent {parent} -> child {child} -> grandchild {grandchild}");
                        return [parent, child, grandchild];
                    }
                }
                assert!(Instant::now() < deadline, "no three-level tree: {table:?}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        async fn wait_gone(pids: &[u32]) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !pids.iter().all(|&pid| terminated(pid)) {
                assert!(Instant::now() < deadline, "still running: {pids:?}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            println!("all exited: {pids:?}");
        }

        #[tokio::test]
        async fn closing_the_job_ends_three_levels() {
            let process = ProcessTreeSpawner.spawn(tree_spec()).expect("starts");
            let pids = three_levels(&process).await;
            drop(process);
            wait_gone(&pids).await;
        }

        #[tokio::test]
        async fn kill_ends_three_levels() {
            let mut process = ProcessTreeSpawner.spawn(tree_spec()).expect("starts");
            let pids = three_levels(&process).await;
            process.control.kill().expect("job terminated");
            let status = process.control.wait().await.expect("waits");
            assert_eq!(status.code, Some(1), "{status:?}");
            wait_gone(&pids).await;
        }
    }
}
