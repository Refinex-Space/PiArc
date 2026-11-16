//! [`ProcessSpawner`] on tokio's process API.

use std::io;
use std::process::Stdio;

use piarc_ports::{
    BoxFuture, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};
use tokio::process::{Child, Command};

/// Starts processes with tokio. Must be used inside a tokio runtime.
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioProcessSpawner;

impl ProcessSpawner for TokioProcessSpawner {
    fn spawn(&self, spec: SpawnSpec) -> io::Result<SpawnedProcess> {
        let mut child = command(&spec).spawn()?;
        let (stdin, stdout, stderr) = take_stdio(&mut child)?;
        Ok(SpawnedProcess {
            stdin,
            stdout,
            stderr,
            control: Box::new(TokioChild(child)),
        })
    }
}

/// `spec` as a tokio command: exactly the given environment, piped stdio, killed on drop.
pub(crate) fn command(spec: &SpawnSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// The three piped stdio handles of a freshly started child.
pub(crate) type Stdio3 = (
    std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
    std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>,
);

/// Takes the piped stdio handles out of `child`.
pub(crate) fn take_stdio(child: &mut Child) -> io::Result<Stdio3> {
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(io::Error::other("a piped stdio handle is missing"));
    };
    Ok((Box::pin(stdin), Box::pin(stdout), Box::pin(stderr)))
}

/// How `child` ended, as [`ExitStatus`].
pub(crate) async fn wait_child(child: &mut Child) -> io::Result<ExitStatus> {
    let status = child.wait().await?;
    Ok(ExitStatus {
        code: status.code(),
        signal: signal_of(status),
    })
}

struct TokioChild(Child);

impl ProcessControl for TokioChild {
    fn pid(&self) -> Option<u32> {
        self.0.id()
    }

    fn kill(&mut self) -> io::Result<()> {
        self.0.start_kill()
    }

    fn wait(&mut self) -> BoxFuture<'_, io::Result<ExitStatus>> {
        Box::pin(wait_child(&mut self.0))
    }
}

#[cfg(unix)]
fn signal_of(status: std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// `rustc` from the toolchain running the tests: on PATH wherever `cargo test` runs, with
    /// no shell involved. The environment carries only what the rustup proxy needs.
    fn rustc(args: &[&str]) -> SpawnSpec {
        const PASS: [&str; 7] = [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SystemRoot",
            "RUSTUP_HOME",
            "CARGO_HOME",
            "RUSTUP_TOOLCHAIN",
        ];
        SpawnSpec {
            program: "rustc".into(),
            args: args.iter().map(OsString::from).collect(),
            cwd: std::env::temp_dir(),
            env: std::env::vars_os()
                .filter(|(key, _)| PASS.iter().any(|name| key == name))
                .collect(),
        }
    }

    #[tokio::test]
    async fn pipes_stdout_and_reports_a_clean_exit() {
        let mut process = TokioProcessSpawner
            .spawn(rustc(&["--version"]))
            .expect("rustc starts");
        let mut out = String::new();
        process
            .stdout
            .read_to_string(&mut out)
            .await
            .expect("stdout reads");
        let status = process.control.wait().await.expect("waits");
        assert!(out.starts_with("rustc "), "{out}");
        assert!(status.success(), "{status:?}");
    }

    #[tokio::test]
    async fn kills_a_process_that_is_still_running() {
        // `rustc -` reads a program from stdin and does nothing until stdin closes.
        let mut process = TokioProcessSpawner
            .spawn(rustc(&["-"]))
            .expect("rustc starts");
        assert!(process.control.pid().is_some());
        process
            .stdin
            .write_all(b"fn main() {}")
            .await
            .expect("stdin writes");
        process.control.kill().expect("kill is sent");
        let status = process.control.wait().await.expect("waits");
        assert!(!status.success(), "{status:?}");
        #[cfg(unix)]
        assert_eq!(status.signal, Some(9), "{status:?}");
    }

    #[test]
    fn fails_to_start_a_missing_program() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let _guard = runtime.enter();
        let mut spec = rustc(&[]);
        spec.program = std::env::temp_dir().join("piarc-no-such-program");
        assert!(TokioProcessSpawner.spawn(spec).is_err());
    }
}
