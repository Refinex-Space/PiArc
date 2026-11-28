//! `piarc-mock-provider`: the strict mock provider as a standalone process.
//!
//! ```text
//! piarc-mock-provider [--port <port>] [--l3] --scenarios <file-or-dir> [--scenarios ...]
//! ```
//!
//! Binds `127.0.0.1:<port>` (default 0, a free port), prints the bound port as the first
//! line of stdout, and serves until stdin reaches end of file. A termination signal
//! (SIGTERM, SIGINT, Ctrl+C) ends the process through the default signal disposition.
//! `--l3` serves in L3 mode (`piarc_testkit::Mode::L3`): protocol rules only, auxiliary
//! requests answered without a step, and the request log holds structures, never bodies.

use std::path::PathBuf;
use std::process::ExitCode;

use piarc_testkit::{MockProvider, Mode, ScenarioLibrary};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

struct Options {
    port: u16,
    mode: Mode,
    scenarios: Vec<PathBuf>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        port: 0,
        mode: Mode::Strict,
        scenarios: Vec::new(),
    };
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--port" => {
                let port = value()?;
                options.port = port
                    .parse()
                    .map_err(|_| format!("--port: {port:?} is not a port number"))?;
            }
            "--scenarios" => options.scenarios.push(PathBuf::from(value()?)),
            "--l3" => options.mode = Mode::L3,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if options.scenarios.is_empty() {
        return Err("at least one --scenarios <file-or-dir> is required".to_owned());
    }
    Ok(options)
}

async fn run(options: Options) -> Result<(), String> {
    let library =
        ScenarioLibrary::load_paths(&options.scenarios).map_err(|error| error.to_string())?;
    let provider = MockProvider::start_with(library, options.port, options.mode)
        .await
        .map_err(|error| error.to_string())?;
    let mut stdout = tokio::io::stdout();
    let line = format!("{}\n", provider.port());
    let announce = async {
        stdout.write_all(line.as_bytes()).await?;
        stdout.flush().await
    };
    announce
        .await
        .map_err(|error| format!("cannot write the port to stdout: {error}"))?;
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0_u8; 1024];
    loop {
        match stdin.read(&mut buffer).await {
            // End of file: the parent closed our stdin and wants us gone. A read error
            // means stdin is unusable, which the parent can no longer use to stop us
            // either, so it ends the process too.
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    provider.shutdown().await;
    Ok(())
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("piarc-mock-provider: {message}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("piarc-mock-provider: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("piarc-mock-provider: {message}");
            ExitCode::FAILURE
        }
    }
}
