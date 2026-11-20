//! `piarc-mock-auth`: the mock OAuth authorization server as a standalone process (T29, L4).
//!
//! ```text
//! piarc-mock-auth [--port <port>] [--behavior approve|deny|expire] [--pending-polls <n>]
//! ```
//!
//! Binds `127.0.0.1:<port>` (default 0, a free port) and prints the bound port as the first
//! line of stdout. Each line on stdin (`approve`, `deny`, `expire`) changes the user's decision
//! for the next sign-in; end of file on stdin ends the process.

use std::process::ExitCode;

use piarc_testkit::auth_server::{AuthBehavior, MockAuthServer};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

struct Options {
    port: u16,
    behavior: AuthBehavior,
    pending_polls: Option<usize>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let (mut port, mut behavior, mut pending_polls) = (0, AuthBehavior::Approve, None);
    while let Some(arg) = args.next() {
        let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--port" => port = value.parse().map_err(|_| format!("--port: {value:?}"))?,
            "--behavior" => {
                behavior =
                    AuthBehavior::parse(&value).ok_or_else(|| format!("--behavior: {value:?}"))?;
            }
            "--pending-polls" => {
                pending_polls = Some(
                    value
                        .parse()
                        .map_err(|_| format!("--pending-polls: {value:?}"))?,
                );
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Options {
        port,
        behavior,
        pending_polls,
    })
}

async fn run(options: Options) -> Result<(), String> {
    let server = MockAuthServer::start(options.behavior, options.port)
        .await
        .map_err(|e| format!("cannot bind: {e}"))?;
    if let Some(polls) = options.pending_polls {
        server.set_pending_polls(polls);
    }
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
    let options = match parse_args(std::env::args().skip(1)) {
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
    match runtime.block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("piarc-mock-auth: {message}");
            ExitCode::FAILURE
        }
    }
}
