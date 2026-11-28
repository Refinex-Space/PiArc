//! A test HTTP proxy that only tunnels (`CONNECT`), for proving that a client went through the
//! user's proxy (ADR-0102): every `CONNECT host:port` is recorded; host names map to loopback
//! ports through a table (a `.test` name resolves only here, so a request that reached the
//! server proves it went through the proxy). Modes: tunnel, answer a status (`407`), or close
//! the connection without answering.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// What the proxy does with a `CONNECT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyMode {
    /// `200` and a tunnel to the mapped port.
    Tunnel,
    /// This status and nothing else.
    Refuse(u16),
    /// Close without answering.
    Drop,
}

struct State {
    mode: Mutex<ProxyMode>,
    /// `host` → loopback port; unmapped hosts are refused with `502`.
    routes: Mutex<HashMap<String, u16>>,
    connects: Mutex<Vec<String>>,
}

/// The running proxy. Dropping it stops it.
pub struct MockProxy {
    port: u16,
    state: Arc<State>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl MockProxy {
    /// Listens on `127.0.0.1:<port>` (0: free).
    ///
    /// # Errors
    ///
    /// The port cannot be bound.
    pub async fn start(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(State {
            mode: Mutex::new(ProxyMode::Tunnel),
            routes: Mutex::default(),
            connects: Mutex::default(),
        });
        let task = tokio::spawn(accept(listener, Arc::clone(&state)));
        Ok(Self { port, state, task })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `http://127.0.0.1:<port>`.
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Sends `CONNECT host:<any port>` to `127.0.0.1:<port>`.
    pub fn route(&self, host: &str, port: u16) {
        lock(&self.state.routes).insert(host.to_ascii_lowercase(), port);
    }

    pub fn set_mode(&self, mode: ProxyMode) {
        *lock(&self.state.mode) = mode;
    }

    /// The `host:port` of every `CONNECT`, in order.
    #[must_use]
    pub fn connects(&self) -> Vec<String> {
        lock(&self.state.connects).clone()
    }

    /// Applies one control line: `tunnel`, `refuse <status>`, `drop`, `route <host> <port>`.
    ///
    /// # Errors
    ///
    /// An unknown line.
    pub fn control(&self, line: &str) -> Result<(), String> {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["tunnel"] => self.set_mode(ProxyMode::Tunnel),
            ["drop"] => self.set_mode(ProxyMode::Drop),
            ["refuse", code] => self.set_mode(ProxyMode::Refuse(
                code.parse().map_err(|_| format!("bad status {code:?}"))?,
            )),
            ["route", host, port] => {
                self.route(
                    host,
                    port.parse().map_err(|_| format!("bad port {port:?}"))?,
                );
            }
            _ => return Err(format!("unknown control {line:?}")),
        }
        Ok(())
    }
}

async fn accept(listener: TcpListener, state: Arc<State>) {
    loop {
        let Ok((client, _)) = listener.accept().await else {
            return;
        };
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _ = serve(client, &state).await;
        });
    }
}

async fn serve(mut client: TcpStream, state: &State) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 || client.read(&mut byte).await? == 0 {
            return Ok(());
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let mut first = text.lines().next().unwrap_or_default().split_whitespace();
    let (method, target) = (
        first.next().unwrap_or_default(),
        first.next().unwrap_or_default(),
    );
    if method != "CONNECT" {
        client
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }
    lock(&state.connects).push(target.to_owned());
    let mode = *lock(&state.mode);
    match mode {
        ProxyMode::Drop => Ok(()),
        ProxyMode::Refuse(status) => {
            client
                .write_all(
                    format!("HTTP/1.1 {status} Refused\r\nConnection: close\r\n\r\n").as_bytes(),
                )
                .await
        }
        ProxyMode::Tunnel => {
            let host = target
                .rsplit_once(':')
                .map_or(target, |(h, _)| h)
                .trim_matches(['[', ']'])
                .to_ascii_lowercase();
            let port = lock(&state.routes).get(&host).copied();
            let Some(port) = port else {
                return client
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                    .await;
            };
            let mut server = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
            client
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await?;
            tokio::io::copy_bidirectional(&mut client, &mut server).await?;
            Ok(())
        }
    }
}
