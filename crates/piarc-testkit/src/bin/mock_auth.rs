//! `piarc-mock-auth`: the mock OAuth authorization server as a standalone process (T29, L4).
//!
//! ```text
//! piarc-mock-auth [--port <port>] [--behavior approve|deny|expire]
//! ```
//!
//! Binds `127.0.0.1:<port>` (default 0, a free port) and prints the bound port as the first
//! line of stdout. Each line on stdin (`approve`, `deny`, `expire`) changes the user's decision
//! for the next sign-in; end of file on stdin ends the process.

use std::process::ExitCode;

use piarc_testkit::auth_server::{AuthBehavior, MockAuthServer};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<(u16, AuthBehavior), String> {
    let (mut port, mut behavior) = (0, AuthBehavior::Approve);
    while let Some(arg) = args.next() {
        let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--port" => port = value.parse().map_err(|_| format!("--port: {value:?}"))?,
            "--behavior" => {
                behavior =
                    AuthBehavior::parse(&value).ok_or_else(|| format!("--behavior: {value:?}"))?;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok((port, behavior))
}

async fn run(port: u16, behavior: AuthBehavior) -> Result<(), String> {
    let server = MockAuthServer::start(behavior, port)
        .await
        .map_err(|e| format!("cannot bind: {e}"))?;
    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(format!("{}\n", server.port()).as_bytes())
        .await
        .and(stdout.flush().await)
        .map_err(|e| format!("cannot write the port to stdout: {e}"))?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(next) = AuthBehavior::parse(line.trim()) {
            server.set_behavior(next);
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let (port, behavior) = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("piarc-mock-auth: {message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("piarc-mock-auth: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(port, behavior)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("piarc-mock-auth: {message}");
            ExitCode::FAILURE
        }
    }
}
