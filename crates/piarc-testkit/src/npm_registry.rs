//! A strict mock npm registry over HTTPS (ADR-0102): the parts of the registry the Pi package
//! market and npm itself use. Packages come from [`NpmPackage`] fixtures; their tarballs are
//! built at start (`tar`, which macOS and Windows 10+ ship) and served with the `sha512`
//! integrity npm checks. Unknown paths answer 404 and are recorded as violations so a test
//! notices traffic it did not expect.
//!
//! Routes: `/-/v1/search?text=&size=&from=` (only `keywords:pi-package` packages; extra words
//! must all appear in the name, description or keywords; `from` past [`SEARCH_OFFSET_CAP`]
//! answers the first page again, like the real registry), `/<name>/latest`, `/<name>` (the
//! packument; `@scope%2fname` and `@scope/name` both work) and `/<name>/-/<file>.tgz`.
//!
//! Controls (tests call them directly; the `piarc-mock-npm` binary reads them from stdin):
//! `offline` refuses connections' requests with a closed connection, `status <path> <code>`
//! answers that path with a status, `hold <path>` keeps that request open until `release`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// The real registry answers the first page again past this `from`.
pub const SEARCH_OFFSET_CAP: usize = 5000;

/// The test CA's certificate (PEM), for clients that must trust the mock.
pub const TEST_CA_PEM: &[u8] = include_bytes!("../fixtures/tls/ca.test.crt");
const SERVER_CERT: &[u8] = include_bytes!("../fixtures/tls/server.test.crt");
const SERVER_KEY: &[u8] = include_bytes!("../fixtures/tls/server.test.key");

/// The host name the server certificate is for (besides `127.0.0.1`).
pub const REGISTRY_HOST: &str = "registry.npmjs.test";

/// One published version.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmVersion {
    pub version: String,
    /// More `package.json` fields (`pi`, `dependencies`, `scripts`…).
    #[serde(default)]
    pub manifest: serde_json::Map<String, Value>,
    /// Files besides `package.json`, by path inside the package.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// The `deprecated` message of this version.
    #[serde(default)]
    pub deprecated: Option<String>,
}

/// One package.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpmPackage {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `pi-package` is added when missing.
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default = "publisher")]
    pub publisher: String,
    #[serde(default)]
    pub downloads_monthly: u64,
    /// RFC 3339 time of the latest publish.
    #[serde(default = "updated")]
    pub updated: String,
    #[serde(default)]
    pub readme: String,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub insecure: bool,
    /// Oldest first; the last is `latest`.
    pub versions: Vec<NpmVersion>,
}

fn publisher() -> String {
    "tester".to_owned()
}

fn updated() -> String {
    "2026-11-01T00:00:00.000Z".to_owned()
}

impl NpmPackage {
    fn latest(&self) -> Option<&NpmVersion> {
        self.versions.last()
    }

    fn keywords(&self) -> Vec<String> {
        let mut keywords = self.keywords.clone();
        if !keywords.iter().any(|k| k == "pi-package") {
            keywords.push("pi-package".to_owned());
        }
        keywords
    }
}

struct Tarball {
    bytes: Bytes,
    integrity: String,
    shasum: String,
}

#[derive(Default)]
struct Controls {
    offline: bool,
    status: HashMap<String, u16>,
    held: HashSet<String>,
}

struct State {
    packages: Vec<NpmPackage>,
    /// `<name>@<version>` → tarball.
    tarballs: HashMap<String, Tarball>,
    base: String,
    requests: Mutex<Vec<String>>,
    violations: Mutex<Vec<String>>,
    controls: Mutex<Controls>,
    release: Notify,
}

/// The running mock. Dropping it stops the server.
pub struct MockNpm {
    port: u16,
    state: Arc<State>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockNpm {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockNpm {
    /// Builds the tarballs (in `work`) and serves `packages` on `127.0.0.1:<port>` (0: free).
    /// Answers carry `https://<host>:<port>` URLs (`host` is [`REGISTRY_HOST`] or `127.0.0.1`).
    ///
    /// # Errors
    ///
    /// The tarballs cannot be built or the port cannot be bound.
    pub async fn start(
        packages: Vec<NpmPackage>,
        work: &Path,
        host: &str,
        port: u16,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let port = listener.local_addr()?.port();
        let base = format!("https://{host}:{port}");
        let mut tarballs = HashMap::new();
        for package in &packages {
            for version in &package.versions {
                let tarball = build_tarball(work, package, version)?;
                tarballs.insert(format!("{}@{}", package.name, version.version), tarball);
            }
        }
        let state = Arc::new(State {
            packages,
            tarballs,
            base,
            requests: Mutex::default(),
            violations: Mutex::default(),
            controls: Mutex::default(),
            release: Notify::new(),
        });
        let acceptor = tokio_rustls::TlsAcceptor::from(server_tls()?);
        let task = tokio::spawn(accept(listener, acceptor, Arc::clone(&state)));
        Ok(Self { port, state, task })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `https://<host>:<port>`.
    #[must_use]
    pub fn base(&self) -> String {
        self.state.base.clone()
    }

    /// Request paths (with query) in arrival order.
    #[must_use]
    pub fn requests(&self) -> Vec<String> {
        lock(&self.state.requests).clone()
    }

    /// Paths nothing routes (each answered 404).
    #[must_use]
    pub fn violations(&self) -> Vec<String> {
        lock(&self.state.violations).clone()
    }

    pub fn set_offline(&self, offline: bool) {
        lock(&self.state.controls).offline = offline;
    }

    /// Answers requests whose path starts with `prefix` with `status` (0 removes it).
    pub fn set_status(&self, prefix: &str, status: u16) {
        let mut controls = lock(&self.state.controls);
        if status == 0 {
            controls.status.remove(prefix);
        } else {
            controls.status.insert(prefix.to_owned(), status);
        }
    }

    /// Holds requests whose path starts with `prefix` until [`Self::release`].
    pub fn hold(&self, prefix: &str) {
        lock(&self.state.controls).held.insert(prefix.to_owned());
    }

    pub fn release(&self) {
        lock(&self.state.controls).held.clear();
        self.state.release.notify_waiters();
    }

    /// Applies one control line: `offline`, `online`, `status <prefix> <code>`,
    /// `hold <prefix>`, `release`.
    ///
    /// # Errors
    ///
    /// An unknown line.
    pub fn control(&self, line: &str) -> Result<(), String> {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["offline"] => self.set_offline(true),
            ["online"] => self.set_offline(false),
            ["status", prefix, code] => {
                self.set_status(
                    prefix,
                    code.parse().map_err(|_| format!("bad code {code:?}"))?,
                );
            }
            ["hold", prefix] => self.hold(prefix),
            ["release"] => self.release(),
            _ => return Err(format!("unknown control {line:?}")),
        }
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn server_tls() -> std::io::Result<Arc<rustls::ServerConfig>> {
    use rustls::pki_types::pem::PemObject as _;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let invalid = |e: String| std::io::Error::new(std::io::ErrorKind::InvalidData, e);
    let cert = CertificateDer::from_pem_slice(SERVER_CERT).map_err(|e| invalid(e.to_string()))?;
    let key = PrivateKeyDer::from_pem_slice(SERVER_KEY).map_err(|e| invalid(e.to_string()))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| invalid(e.to_string()))?
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .map_err(|e| invalid(e.to_string()))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

fn build_tarball(
    work: &Path,
    package: &NpmPackage,
    version: &NpmVersion,
) -> std::io::Result<Tarball> {
    let dir = work.join(format!(
        "{}-{}",
        package.name.replace(['@', '/'], "_"),
        version.version
    ));
    let root = dir.join("package");
    std::fs::create_dir_all(&root)?;
    let mut manifest = version.manifest.clone();
    manifest.insert("name".into(), json!(package.name));
    manifest.insert("version".into(), json!(version.version));
    manifest.insert("keywords".into(), json!(package.keywords()));
    manifest
        .entry("description")
        .or_insert_with(|| json!(package.description));
    std::fs::write(
        root.join("package.json"),
        Value::Object(manifest).to_string(),
    )?;
    for (path, text) in &version.files {
        let file = path
            .split('/')
            .fold(root.clone(), |dir, part| dir.join(part));
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(file, text)?;
    }
    let out: PathBuf = dir.join("package.tgz");
    // Relative to the working directory: Windows' tar.exe cannot open a path argument with
    // characters outside the ANSI code page (test directories have Chinese in their names).
    let status = std::process::Command::new("tar")
        .arg("-czf")
        .arg("package.tgz")
        .arg("package")
        .current_dir(&dir)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("tar failed"));
    }
    let bytes = std::fs::read(&out)?;
    let integrity = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes))
    );
    let shasum = sha1_hex(&bytes);
    Ok(Tarball {
        bytes: Bytes::from(bytes),
        integrity,
        shasum,
    })
}

/// npm still reads `dist.shasum`; a SHA-512 prefix stands in (npm checks `integrity` first).
fn sha1_hex(bytes: &[u8]) -> String {
    Sha512::digest(bytes)
        .iter()
        .take(20)
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn accept(listener: TcpListener, acceptor: tokio_rustls::TlsAcceptor, state: Arc<State>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let (acceptor, state) = (acceptor.clone(), Arc::clone(&state));
        tokio::spawn(async move {
            if lock(&state.controls).offline {
                return;
            }
            let Ok(tls) = acceptor.accept(tcp).await else {
                return;
            };
            let service = service_fn(move |request| handle(Arc::clone(&state), request));
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(tls), service)
                .await;
        });
    }
}

fn reply(status: StatusCode, content_type: &str, body: Bytes) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Full::new(body))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn json_reply(value: &Value) -> Response<Full<Bytes>> {
    reply(
        StatusCode::OK,
        "application/json",
        Bytes::from(value.to_string()),
    )
}

async fn handle(
    state: Arc<State>,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let uri = request.uri().clone();
    let path_and_query = uri
        .path_and_query()
        .map_or_else(|| uri.path().to_owned(), ToString::to_string);
    lock(&state.requests).push(path_and_query.clone());
    let (status, held) = {
        let controls = lock(&state.controls);
        let status = controls
            .status
            .iter()
            .find(|(prefix, _)| path_and_query.starts_with(prefix.as_str()))
            .map(|(_, code)| *code);
        let held = controls
            .held
            .iter()
            .any(|prefix| path_and_query.starts_with(prefix.as_str()));
        (status, held)
    };
    if held {
        state.release.notified().await;
    }
    if let Some(code) = status {
        let code = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return Ok(reply(code, "application/json", Bytes::from("{}")));
    }
    let path = percent_decode(uri.path());
    let answer = if path == "/-/v1/search" {
        Some(json_reply(&search(&state, uri.query().unwrap_or_default())))
    } else {
        route_package(&state, &path)
    };
    Ok(answer.unwrap_or_else(|| {
        lock(&state.violations).push(path_and_query);
        reply(StatusCode::NOT_FOUND, "application/json", Bytes::from("{}"))
    }))
}

fn route_package(state: &State, path: &str) -> Option<Response<Full<Bytes>>> {
    let rest = path.strip_prefix('/')?;
    // `@scope/name/...` or `name/...`
    let (name, tail) = match rest.strip_prefix('@') {
        Some(scoped) => {
            let mut parts = scoped.splitn(3, '/');
            let scope = parts.next()?;
            let name = parts.next()?;
            (format!("@{scope}/{name}"), parts.next().unwrap_or_default())
        }
        None => {
            let mut parts = rest.splitn(2, '/');
            (parts.next()?.to_owned(), parts.next().unwrap_or_default())
        }
    };
    let package = state.packages.iter().find(|p| p.name == name)?;
    match tail {
        "" => Some(json_reply(&packument(state, package))),
        "latest" => Some(json_reply(&version_doc(state, package, package.latest()?))),
        tail if tail.starts_with("-/") && tail.ends_with(".tgz") => {
            let file = tail.trim_start_matches("-/");
            let version = package
                .versions
                .iter()
                .find(|v| file == tarball_file(&package.name, &v.version))?;
            let tarball = state
                .tarballs
                .get(&format!("{}@{}", package.name, version.version))?;
            Some(reply(
                StatusCode::OK,
                "application/octet-stream",
                tarball.bytes.clone(),
            ))
        }
        version => package
            .versions
            .iter()
            .find(|v| v.version == version)
            .map(|v| json_reply(&version_doc(state, package, v))),
    }
}

fn tarball_file(name: &str, version: &str) -> String {
    let short = name.rsplit('/').next().unwrap_or(name);
    format!("{short}-{version}.tgz")
}

fn version_doc(state: &State, package: &NpmPackage, version: &NpmVersion) -> Value {
    let mut doc = version.manifest.clone();
    doc.insert("name".into(), json!(package.name));
    doc.insert("version".into(), json!(version.version));
    doc.insert("keywords".into(), json!(package.keywords()));
    doc.entry("description")
        .or_insert_with(|| json!(package.description));
    if let Some(license) = &package.license {
        doc.insert("license".into(), json!(license));
    }
    if let Some(message) = &version.deprecated {
        doc.insert("deprecated".into(), json!(message));
    }
    if let Some(tarball) = state
        .tarballs
        .get(&format!("{}@{}", package.name, version.version))
    {
        doc.insert(
            "dist".into(),
            json!({
                "tarball": format!(
                    "{}/{}/-/{}",
                    state.base,
                    package.name,
                    tarball_file(&package.name, &version.version)
                ),
                "integrity": tarball.integrity,
                "shasum": tarball.shasum,
            }),
        );
    }
    Value::Object(doc)
}

fn packument(state: &State, package: &NpmPackage) -> Value {
    let versions: serde_json::Map<String, Value> = package
        .versions
        .iter()
        .map(|v| (v.version.clone(), version_doc(state, package, v)))
        .collect();
    let latest = package
        .latest()
        .map(|v| v.version.clone())
        .unwrap_or_default();
    json!({
        "name": package.name,
        "description": package.description,
        "dist-tags": { "latest": latest },
        "versions": versions,
        "readme": package.readme,
        "license": package.license,
        "repository": package.repository.as_ref().map(|url| json!({"type": "git", "url": url})),
        "time": { "modified": package.updated },
    })
}

fn search(state: &State, query: &str) -> Value {
    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_owned(), percent_decode(&v.replace('+', " "))))
        .collect();
    let size: usize = params
        .get("size")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);
    let mut from: usize = params.get("from").and_then(|s| s.parse().ok()).unwrap_or(0);
    if from > SEARCH_OFFSET_CAP {
        from = 0;
    }
    let text = params.get("text").cloned().unwrap_or_default();
    let words: Vec<String> = text
        .split_whitespace()
        .filter(|w| !w.starts_with("keywords:"))
        .map(str::to_lowercase)
        .collect();
    let mut matching: Vec<&NpmPackage> = state
        .packages
        .iter()
        .filter(|p| {
            let hay =
                format!("{} {} {}", p.name, p.description, p.keywords().join(" ")).to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()))
        })
        .collect();
    matching.sort_by(|a, b| {
        b.downloads_monthly
            .cmp(&a.downloads_monthly)
            .then_with(|| a.name.cmp(&b.name))
    });
    let objects: Vec<Value> = matching
        .iter()
        .skip(from)
        .take(size)
        .map(|p| search_object(state, p))
        .collect();
    json!({ "objects": objects, "total": matching.len(), "time": "2026-11-27T00:00:00Z" })
}

fn search_object(state: &State, package: &NpmPackage) -> Value {
    let version = package
        .latest()
        .map(|v| v.version.clone())
        .unwrap_or_default();
    json!({
        "package": {
            "name": package.name,
            "version": version,
            "description": package.description,
            "keywords": package.keywords(),
            "date": package.updated,
            "license": package.license,
            "links": {
                "npm": format!("https://www.npmjs.com/package/{}", package.name),
                "repository": package.repository,
                "homepage": package.repository,
            },
            "publisher": { "username": package.publisher },
            "maintainers": [{ "username": package.publisher }],
        },
        "downloads": { "monthly": package.downloads_monthly, "weekly": package.downloads_monthly / 4 },
        "updated": package.updated,
        "flags": { "insecure": u8::from(package.insecure) },
        "searchScore": 1.0,
        "registry": state.base,
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
