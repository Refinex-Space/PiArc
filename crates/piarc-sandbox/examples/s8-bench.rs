//! S8 measurements (T11-A11): what `sandbox-exec` adds to each command, and what the proxy
//! adds to each request.
//!
//! `cargo run -p piarc-sandbox --release --example s8-bench [-- --iterations N]`
//!
//! - Command: `/bin/bash -c true` started directly vs. through `sandbox-exec` with a profile
//!   generated for that command (generation included), alternating, `N` times each.
//! - Proxy: one request per new TCP connection to a local HTTP server, directly vs. through the
//!   proxy as an absolute-form request vs. through a `CONNECT` tunnel; the proxy resolves the
//!   name with an injected resolver, so no external network is involved. Then one 64 MiB
//!   download each way, for throughput.
//!
//! macOS only: elsewhere there is no sandbox to measure.

#[cfg(target_os = "macos")]
mod bench {
    use std::convert::Infallible;
    use std::io;
    use std::net::{IpAddr, SocketAddr};
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    use piarc_ports::BoxFuture;
    use piarc_sandbox::proxy::{Allowlist, Network};
    use piarc_sandbox::{SandboxPolicy, SessionSandbox};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const HOST: &str = "bench.example.org";
    const FAKE_IP: [u8; 4] = [203, 0, 113, 1];
    /// Size of the bulk download.
    const BULK: usize = 64 * 1024 * 1024;

    struct LocalNetwork(u16);

    impl Network for LocalNetwork {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            port: u16,
        ) -> BoxFuture<'a, io::Result<Vec<SocketAddr>>> {
            Box::pin(async move { Ok(vec![SocketAddr::new(IpAddr::from(FAKE_IP), port)]) })
        }

        fn connect(&self, _addr: SocketAddr) -> BoxFuture<'_, io::Result<TcpStream>> {
            let port = self.0;
            Box::pin(TcpStream::connect(("127.0.0.1", port)))
        }
    }

    pub async fn run(iterations: usize) {
        let dir = std::env::temp_dir().join(format!("piarc-s8-bench-{}", std::process::id()));
        let (ws, tmp) = (dir.join("ws"), dir.join("tmp"));
        std::fs::create_dir_all(&ws).expect("workspace");
        std::fs::create_dir_all(&tmp).expect("tmp");
        let upstream = upstream().await;
        let sandbox = SessionSandbox::start(
            &SandboxPolicy::new(ws.clone(), tmp),
            Allowlist::new([HOST]).expect("allowlist"),
            Arc::new(LocalNetwork(upstream)),
        )
        .await
        .expect("sandbox starts");
        println!("macOS {}, {iterations} iterations each\n", os_version());
        commands(&sandbox, &ws, iterations);
        proxy(sandbox.proxy_port(), upstream, iterations).await;
        throughput(sandbox.proxy_port(), upstream).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    fn os_version() -> String {
        Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default()
    }

    fn commands(sandbox: &SessionSandbox, ws: &std::path::Path, iterations: usize) {
        let (mut direct, mut wrapped, mut generate) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..iterations + 10 {
            let started = Instant::now();
            let status = Command::new("/bin/bash")
                .args(["-c", "true"])
                .current_dir(ws)
                .stdout(Stdio::null())
                .status()
                .expect("bash runs");
            let plain = started.elapsed();
            assert!(status.success());
            let started = Instant::now();
            let launch = sandbox.launch().expect("profile");
            let generated = started.elapsed();
            let status = Command::new(&launch.program)
                .args(&launch.args)
                .args(["/bin/bash", "-c", "true"])
                .envs(launch.env.iter().map(|(k, v)| (k, v)))
                .current_dir(ws)
                .stdout(Stdio::null())
                .status()
                .expect("sandbox-exec runs");
            let sandboxed = started.elapsed();
            assert!(status.success());
            if i >= 10 {
                direct.push(plain);
                wrapped.push(sandboxed);
                generate.push(generated);
            }
        }
        let extra: Vec<Duration> = {
            let (mut d, mut w) = (direct.clone(), wrapped.clone());
            d.sort();
            w.sort();
            d.iter()
                .zip(&w)
                .map(|(d, w)| w.saturating_sub(*d))
                .collect()
        };
        println!("| command `/bin/bash -c true` | p50 | p95 |\n|---|---|---|");
        row("direct", &direct);
        row("sandbox-exec (profile generated per command)", &wrapped);
        row("of which profile generation", &generate);
        row("extra (sandboxed − direct, by rank)", &extra);
        println!();
    }

    async fn proxy(proxy_port: u16, upstream: u16, iterations: usize) {
        let (mut direct, mut forwarded, mut tunneled) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..iterations + 20 {
            let a = timed(request(upstream, None)).await;
            let b = timed(request(proxy_port, Some(false))).await;
            let c = timed(request(proxy_port, Some(true))).await;
            if i >= 20 {
                direct.push(a);
                forwarded.push(b);
                tunneled.push(c);
            }
        }
        println!("| one request on a new connection | p50 | p95 |\n|---|---|---|");
        row("direct to the local server", &direct);
        row("through the proxy (absolute-form HTTP)", &forwarded);
        row("through the proxy (CONNECT tunnel)", &tunneled);
        println!();
    }

    async fn throughput(proxy_port: u16, upstream: u16) {
        println!(
            "| download of {} MiB | time | MiB/s |\n|---|---|---|",
            BULK >> 20
        );
        for (label, port, via) in [
            ("direct to the local server", upstream, None),
            (
                "through the proxy (absolute-form HTTP)",
                proxy_port,
                Some(false),
            ),
            ("through the proxy (CONNECT tunnel)", proxy_port, Some(true)),
        ] {
            let started = Instant::now();
            let bytes = download(port, via).await;
            let elapsed = started.elapsed().as_secs_f64();
            assert!(bytes >= BULK);
            println!(
                "| {label} | {:.0} ms | {:.0} |",
                elapsed * 1000.0,
                (BULK >> 20) as f64 / elapsed
            );
        }
        println!();
    }

    async fn download(port: u16, via: Option<bool>) -> usize {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connects");
        let target = match via {
            Some(false) => format!("http://{HOST}/bulk"),
            _ => "/bulk".to_owned(),
        };
        if via == Some(true) {
            let connect = format!("CONNECT {HOST}:80 HTTP/1.1\r\nHost: {HOST}:80\r\n\r\n");
            stream.write_all(connect.as_bytes()).await.expect("writes");
            read_until_blank(&mut stream).await;
        }
        let get = format!("GET {target} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
        stream.write_all(get.as_bytes()).await.expect("writes");
        let mut total = 0;
        let mut buf = vec![0_u8; 256 * 1024];
        loop {
            let n = stream.read(&mut buf).await.expect("reads");
            if n == 0 {
                return total;
            }
            total += n;
        }
    }

    async fn timed(work: impl Future<Output = ()>) -> Duration {
        let started = Instant::now();
        work.await;
        started.elapsed()
    }

    /// One `GET` on a new connection: `via` is `None` (direct), `Some(false)` (proxy, absolute
    /// form) or `Some(true)` (proxy, `CONNECT` first).
    async fn request(port: u16, via: Option<bool>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connects");
        let target = match via {
            Some(false) => format!("http://{HOST}/ping"),
            _ => "/ping".to_owned(),
        };
        if via == Some(true) {
            let connect = format!("CONNECT {HOST}:80 HTTP/1.1\r\nHost: {HOST}:80\r\n\r\n");
            stream.write_all(connect.as_bytes()).await.expect("writes");
            let head = read_until_blank(&mut stream).await;
            assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        }
        let get = format!("GET {target} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
        stream.write_all(get.as_bytes()).await.expect("writes");
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.expect("reads");
        assert!(
            reply.ends_with(b"pong"),
            "{}",
            String::from_utf8_lossy(&reply)
        );
    }

    async fn read_until_blank(stream: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.expect("reads");
            head.push(byte[0]);
        }
        String::from_utf8_lossy(&head).into_owned()
    }

    async fn upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.expect("accepts");
                tokio::spawn(async move {
                    let service =
                        hyper::service::service_fn(|request: hyper::Request<_>| async move {
                            let body = if request.uri().path() == "/bulk" {
                                Bytes::from(vec![b'x'; BULK])
                            } else {
                                Bytes::from("pong")
                            };
                            Ok::<_, Infallible>(hyper::Response::new(Full::new(body)))
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        port
    }

    fn row(label: &str, samples: &[Duration]) {
        let mut sorted = samples.to_vec();
        sorted.sort();
        let at = |q: f64| {
            let index = ((sorted.len() as f64 - 1.0) * q).round() as usize;
            sorted[index].as_secs_f64() * 1000.0
        };
        println!("| {label} | {:.2} ms | {:.2} ms |", at(0.5), at(0.95));
    }
}

#[cfg(target_os = "macos")]
fn main() {
    let iterations = std::env::args()
        .skip_while(|arg| arg != "--iterations")
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(200);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(bench::run(iterations));
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("s8-bench measures Seatbelt and runs on macOS only");
    std::process::exit(2);
}
