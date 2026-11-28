//! `piarc-mock-releases`: the mock of GitHub's release downloads as a standalone process
//! (ADR-0111, L4).
//!
//! ```text
//! piarc-mock-releases --dir <dir> --latest <version> [--port <port>]
//! ```
//!
//! Serves `<dir>/<version>/<name>` over HTTPS with the test certificate on `127.0.0.1:<port>`
//! (default 0, a free port) and prints the bound port as the first line of stdout. The feed is
//! `https://localhost:<port>/releases`. Each stdin line is a control (`latest <version>`,
//! `offline`, `online`, `status <path prefix> <code>`, `slow <bytes per 50 ms>`, `requests`);
//! end of file on stdin ends the process.

use std::path::PathBuf;
use std::process::ExitCode;

use piarc_testkit::release_feed::MockReleases;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<(PathBuf, String, u16), String> {
    let (mut dir, mut latest, mut port) = (None, None, 0);
    while let Some(arg) = args.next() {
        let value = args.next().ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--dir" => dir = Some(PathBuf::from(value)),
            "--latest" => latest = Some(value),
            "--port" => port = value.parse().map_err(|_| format!("--port: {value:?}"))?,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok((
        dir.ok_or("--dir is required")?,
        latest.ok_or("--latest is required")?,
        port,
    ))
}

#[tokio::main]
async fn main() -> ExitCode {
    let (dir, latest, port) = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("piarc-mock-releases: {message}");
            return ExitCode::from(2);
        }
    };
    let releases = match MockReleases::start(&dir, &latest, port).await {
        Ok(releases) => releases,
        Err(error) => {
            eprintln!("piarc-mock-releases: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = tokio::io::stdout();
    let _ = stdout
        .write_all(format!("{}\n", releases.port()).as_bytes())
        .await;
    let _ = stdout.flush().await;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let answer = releases
            .control(line.trim())
            .unwrap_or_else(|message| format!("error {message}"));
        let _ = stdout.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = stdout.flush().await;
    }
    ExitCode::SUCCESS
}
