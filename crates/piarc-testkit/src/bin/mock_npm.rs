//! `piarc-mock-npm`: the mock npm registry as a standalone process (ADR-0102, L4).
//!
//! ```text
//! piarc-mock-npm --fixtures <packages.json> --work <dir> [--host <name>] [--port <port>]
//! ```
//!
//! Serves the packages of `packages.json` (an array of `NpmPackage`) over HTTPS with the test
//! certificate on `127.0.0.1:<port>` (default 0, a free port), answers URLs on `--host`
//! (default `registry.npmjs.test`), and prints the bound port as the first line of stdout.
//! Each stdin line is a control (`offline`, `online`, `status <path> <code>`, `hold <path>`,
//! `release`, `requests`, `violations`); end of file on stdin ends the process.

use std::path::PathBuf;
use std::process::ExitCode;

use piarc_testkit::npm_registry::{MockNpm, NpmPackage, REGISTRY_HOST};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

struct Options {
    fixtures: PathBuf,
    work: PathBuf,
    host: String,
    port: u16,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let (mut fixtures, mut work, mut host, mut port) = (None, None, REGISTRY_HOST.to_owned(), 0);
    while let Some(arg) = args.next() {
        let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--fixtures" => fixtures = Some(PathBuf::from(value)),
            "--work" => work = Some(PathBuf::from(value)),
            "--host" => host = value,
            "--port" => port = value.parse().map_err(|_| format!("--port: {value:?}"))?,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Options {
        fixtures: fixtures.ok_or("--fixtures is required")?,
        work: work.ok_or("--work is required")?,
        host,
        port,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("piarc-mock-npm: {message}");
            return ExitCode::from(2);
        }
    };
    let packages: Vec<NpmPackage> = match std::fs::read(&options.fixtures)
        .map_err(|e| e.to_string())
        .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
    {
        Ok(packages) => packages,
        Err(message) => {
            eprintln!("piarc-mock-npm: {}: {message}", options.fixtures.display());
            return ExitCode::from(2);
        }
    };
    let npm = match MockNpm::start(packages, &options.work, &options.host, options.port).await {
        Ok(npm) => npm,
        Err(error) => {
            eprintln!("piarc-mock-npm: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = tokio::io::stdout();
    let _ = stdout
        .write_all(format!("{}\n", npm.port()).as_bytes())
        .await;
    let _ = stdout.flush().await;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let answer = match line.trim() {
            "requests" => serde_json::to_string(&npm.requests()).unwrap_or_default(),
            "violations" => serde_json::to_string(&npm.violations()).unwrap_or_default(),
            control => match npm.control(control) {
                Ok(()) => "ok".to_owned(),
                Err(message) => format!("error {message}"),
            },
        };
        let _ = stdout.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = stdout.flush().await;
    }
    ExitCode::SUCCESS
}
