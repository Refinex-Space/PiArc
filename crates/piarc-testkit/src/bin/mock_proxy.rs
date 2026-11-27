//! `piarc-mock-proxy`: the CONNECT-only test proxy as a standalone process (ADR-0102, L4).
//!
//! ```text
//! piarc-mock-proxy [--port <port>]
//! ```
//!
//! Prints the bound port as the first line of stdout. Each stdin line is a control
//! (`route <host> <port>`, `tunnel`, `refuse <status>`, `drop`, `connects`); end of file on
//! stdin ends the process.

use std::process::ExitCode;

use piarc_testkit::connect_proxy::MockProxy;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut port = 0;
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next().map(|v| v.parse::<u16>())) {
            ("--port", Some(Ok(value))) => port = value,
            _ => {
                eprintln!("piarc-mock-proxy: usage: piarc-mock-proxy [--port <port>]");
                return ExitCode::from(2);
            }
        }
    }
    let proxy = match MockProxy::start(port).await {
        Ok(proxy) => proxy,
        Err(error) => {
            eprintln!("piarc-mock-proxy: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = tokio::io::stdout();
    let _ = stdout
        .write_all(format!("{}\n", proxy.port()).as_bytes())
        .await;
    let _ = stdout.flush().await;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let answer = if line.trim() == "connects" {
            serde_json::to_string(&proxy.connects()).unwrap_or_default()
        } else {
            match proxy.control(&line) {
                Ok(()) => "ok".to_owned(),
                Err(message) => format!("error {message}"),
            }
        };
        let _ = stdout.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = stdout.flush().await;
    }
    ExitCode::SUCCESS
}
