//! In-app updates (ADR-0111): the latest GitHub release's signed manifest, read and verified
//! through the user's proxy; the platform's artefacts downloaded and verified into the cache;
//! the main process installs them.
//!
//! - **Network**: `piarc_web::get` for the manifest, its signature and the release notes,
//!   `piarc_web::download` for the artefacts. Every hop's host is in
//!   [`UpdateConfig::hosts`]; with an effective proxy every request goes through `CONNECT`
//!   and a proxy failure never falls back to a direct connection. The loopback (a development
//!   build's local feed) is reached directly, as `crate::network::NO_PROXY` says for the
//!   Agent Hosts (ADR-0082).
//! - **Trust**: [`crate::release::verify_manifest`] with [`UpdateConfig::keys`] (the built-in
//!   keys in a release build) before anything is parsed; the notes, Velopack's feed and every
//!   artefact are checked against their manifest entry, and [`Updates::install_plan`]
//!   verifies the files again before the main process takes them.
//! - **State**: one [`UpdateStatus`] snapshot, sent to `core/updates` ([`UPDATES_ROUTE`])
//!   through the emitter whenever it changes (download progress at most every 200 ms).

pub mod feed;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::ErrorKind;
use piarc_protocol::updates::{
    UpdateInstall, UpdateProblem, UpdateProgress, UpdateRelease, UpdateState, UpdateStatus,
    UpdateUnavailable,
};
use piarc_web::download::{DownloadError, DownloadJob, Downloader};
use piarc_web::get::{GetError, GetJob, Getter};
use piarc_web::{Allowlist, Resolve, SystemResolver};
use tokio_util::sync::CancellationToken;

use crate::release::{self, ManifestFile, ReleaseManifest, TrustedKeys};
use crate::{Error, Result};
use feed::{FeedError, Os};

/// The route of the update status snapshots (`core/updates`).
pub const UPDATES_ROUTE: &str = "core/updates";

/// The repository releases come from.
pub const RELEASES: &str = "https://github.com/Refinex-Space/PiArc/releases";

/// The most bytes of the manifest, its signature and the release notes.
const SMALL_FILE_BYTES: usize = 1 << 20;

/// How often download progress is sent.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Where updates come from and what this build is.
#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// The running version (`app.getVersion()`).
    pub current: String,
    /// The latest release's download directory (no trailing slash).
    pub latest_url: String,
    /// One artefact of a release: `{version}` and `{name}` are replaced.
    pub asset_url: String,
    /// A release's page: `{version}` is replaced.
    pub page_url: String,
    /// The hosts a hop may go to (lowercase).
    pub hosts: Vec<String>,
    /// Trusted release keys (base64 minisign public keys).
    pub keys: Vec<String>,
    /// This build's platform; `None`: no artefact is published for it.
    pub platform: Option<(Os, String)>,
    /// Development builds and tests: a local feed.
    pub test_net: Option<UpdateTestNet>,
    /// One small request, redirects included.
    pub request_timeout: Duration,
}

/// A local feed's trust root and names (development builds and tests only).
#[derive(Debug, Clone)]
pub struct UpdateTestNet {
    /// PEM of the only CA trusted.
    pub ca_pem: Vec<u8>,
    /// Host names that resolve to loopback.
    pub loopback: Vec<String>,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            current: "0.0.0".to_owned(),
            latest_url: format!("{RELEASES}/latest/download"),
            asset_url: format!("{RELEASES}/download/v{{version}}/{{name}}"),
            page_url: format!("{RELEASES}/tag/v{{version}}"),
            hosts: [
                "github.com",
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
            ]
            .map(str::to_owned)
            .to_vec(),
            keys: release::BUILTIN_RELEASE_KEYS
                .iter()
                .map(|k| (*k).to_owned())
                .collect(),
            platform: feed::this_platform().map(|(os, arch)| (os, arch.to_owned())),
            test_net: None,
            request_timeout: Duration::from_secs(30),
        }
    }
}

/// Receives every new snapshot.
pub type Emit = Arc<dyn Fn(&UpdateStatus) + Send + Sync>;

/// The update flow. One per Core; cheap to clone.
#[derive(Clone)]
pub struct Updates {
    inner: Arc<Inner>,
}

struct Inner {
    config: UpdateConfig,
    keys: std::result::Result<TrustedKeys, String>,
    getter: std::result::Result<Getter, String>,
    downloader: std::result::Result<Downloader, String>,
    /// `<cache>/updates`.
    dir: PathBuf,
    emit: Emit,
    cancel: CancellationToken,
    flow: Mutex<Flow>,
    checking: AtomicBool,
}

#[derive(Default)]
struct Flow {
    status: UpdateStatus,
    found: Option<Found>,
    /// The running download's token.
    download: Option<CancellationToken>,
}

#[derive(Clone)]
struct Found {
    manifest: ReleaseManifest,
    files: Vec<ManifestFile>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Names that resolve to loopback (development builds and tests: the local feed).
struct Loopback(Vec<String>);

impl Resolve for Loopback {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::io::Result<Vec<std::net::IpAddr>>> + Send + 'a>,
    > {
        let local = self.0.iter().any(|n| n.eq_ignore_ascii_case(host));
        Box::pin(async move {
            if local {
                Ok(vec![std::net::IpAddr::from([127, 0, 0, 1])])
            } else {
                SystemResolver.resolve(host, port).await
            }
        })
    }
}

fn clients(
    config: &UpdateConfig,
) -> (
    std::result::Result<Getter, String>,
    std::result::Result<Downloader, String>,
) {
    let agent = format!("PiArc/{}", config.current);
    match &config.test_net {
        None => (
            Getter::new().map_err(|e| e.to_string()),
            Downloader::new()
                .map(|d| d.with_user_agent(agent))
                .map_err(|e| e.to_string()),
        ),
        Some(test) => {
            let allow = || Allowlist::new(&["127.0.0.1".to_owned()]);
            let resolver = Arc::new(Loopback(test.loopback.clone()));
            let getter = allow().and_then(|a| {
                Getter::trusting(&test.ca_pem, resolver.clone(), a).map_err(|e| e.to_string())
            });
            let downloader = allow().and_then(|a| {
                Downloader::trusting(&test.ca_pem, resolver, a)
                    .map(|d| d.with_user_agent(agent))
                    .map_err(|e| e.to_string())
            });
            (getter, downloader)
        }
    }
}

fn problem(code: &str, message: impl std::fmt::Display) -> UpdateProblem {
    UpdateProblem {
        code: code.to_owned(),
        message: message.to_string(),
    }
}

fn get_problem(error: &GetError) -> UpdateProblem {
    let code = match error.code() {
        "status" | "tooLarge" => "network",
        other => other,
    };
    problem(code, error)
}

fn download_problem(error: &DownloadError) -> UpdateProblem {
    let code = match error.code() {
        "checksum" => "integrity",
        other => other,
    };
    problem(code, error)
}

fn integrity(error: impl std::fmt::Display) -> UpdateProblem {
    problem("integrity", error)
}

/// The lowercase host of an `https://host[:port][/path]` URL (a test feed's own host).
#[must_use]
pub fn host_of_url(url: &str) -> String {
    crate::market::net::host_of(url)
}

/// The proxy for a request to `url`: none for the loopback (ADR-0082's `NO_PROXY`).
fn proxy_for<'a>(url: &str, proxy: Option<&'a str>) -> Option<&'a str> {
    let host = host_of_url(url);
    let loopback = crate::network::NO_PROXY
        .split(',')
        .any(|h| h.eq_ignore_ascii_case(&host));
    if loopback { None } else { proxy }
}

fn fill(template: &str, version: &str, name: &str) -> String {
    template
        .replace("{version}", version)
        .replace("{name}", name)
}

impl Updates {
    /// The update flow; `cache` is Core's cache directory (`updates/` below it is used).
    #[must_use]
    pub fn new(config: UpdateConfig, cache: &Path, emit: Emit, cancel: CancellationToken) -> Self {
        let keys: Vec<&str> = config.keys.iter().map(String::as_str).collect();
        let keys = TrustedKeys::from_base64(&keys).map_err(|e| e.to_string());
        let (getter, downloader) = clients(&config);
        let unavailable = if config.keys.is_empty() {
            Some(UpdateUnavailable::NoTrustedKey)
        } else if config.platform.is_none() {
            Some(UpdateUnavailable::Platform)
        } else {
            None
        };
        let status = UpdateStatus {
            current: config.current.clone(),
            unavailable,
            ..UpdateStatus::default()
        };
        Self {
            inner: Arc::new(Inner {
                config,
                keys,
                getter,
                downloader,
                dir: cache.join("updates"),
                emit,
                cancel,
                flow: Mutex::new(Flow {
                    status,
                    ..Flow::default()
                }),
                checking: AtomicBool::new(false),
            }),
        }
    }

    /// The current snapshot.
    #[must_use]
    pub fn status(&self) -> UpdateStatus {
        lock(&self.inner.flow).status.clone()
    }

    fn set(&self, change: impl FnOnce(&mut Flow)) -> UpdateStatus {
        let status = {
            let mut flow = lock(&self.inner.flow);
            change(&mut flow);
            flow.status.clone()
        };
        (self.inner.emit)(&status);
        status
    }

    fn release_dir(&self, version: &str) -> PathBuf {
        self.inner.dir.join(version)
    }

    /// Reads the latest release. Answers the new snapshot; a check while another one or a
    /// download runs answers the current snapshot.
    pub async fn check(&self, proxy: Option<String>) -> UpdateStatus {
        if self.status().unavailable.is_some()
            || lock(&self.inner.flow).download.is_some()
            || self.inner.checking.swap(true, Ordering::SeqCst)
        {
            return self.status();
        }
        self.set(|f| {
            f.status.state = UpdateState::Checking;
            f.status.problem = None;
        });
        let result = self.read_latest(proxy.as_deref()).await;
        self.inner.checking.store(false, Ordering::SeqCst);
        let checked_at = crate::storage::now_ms();
        match result {
            Ok(None) => {
                self.prune(None).await;
                self.set(|f| {
                    f.found = None;
                    f.status.state = UpdateState::UpToDate;
                    f.status.release = None;
                    f.status.progress = None;
                    f.status.checked_at = Some(checked_at);
                })
            }
            Ok(Some((found, release))) => {
                self.prune(Some(&found.manifest.version)).await;
                let ready = self.files_complete(&found).await;
                self.set(|f| {
                    f.status.state = if ready {
                        UpdateState::Ready
                    } else {
                        UpdateState::Available
                    };
                    f.status.release = Some(release);
                    f.status.progress = None;
                    f.status.checked_at = Some(checked_at);
                    f.found = Some(found);
                })
            }
            Err(problem) => self.set(|f| {
                f.status.state = UpdateState::Failed;
                f.status.problem = Some(problem);
                f.status.checked_at = Some(checked_at);
            }),
        }
    }

    async fn small(
        &self,
        url: &str,
        proxy: Option<&str>,
    ) -> std::result::Result<Vec<u8>, UpdateProblem> {
        let getter = self.inner.getter.as_ref().map_err(|e| problem("tls", e))?;
        let hosts = self.inner.config.hosts.clone();
        let allows = move |h: &str| hosts.iter().any(|a| a.eq_ignore_ascii_case(h));
        let job = GetJob {
            url,
            allows_host: &allows,
            proxy: proxy_for(url, proxy),
            max_bytes: SMALL_FILE_BYTES,
            accept: "*/*",
            timeout: self.inner.config.request_timeout,
        };
        getter
            .get(&job, &self.inner.cancel)
            .await
            .map(|b| b.to_vec())
            .map_err(|e| get_problem(&e))
    }

    /// The newer release and what this platform downloads, or `None` when up to date.
    async fn read_latest(
        &self,
        proxy: Option<&str>,
    ) -> std::result::Result<Option<(Found, UpdateRelease)>, UpdateProblem> {
        let config = &self.inner.config;
        let Some((os, arch)) = config.platform.clone() else {
            return Err(problem("refused", "no artefact for this platform"));
        };
        let keys = self.inner.keys.as_ref().map_err(integrity)?;
        let manifest_url = format!("{}/{}", config.latest_url, feed::MANIFEST_FILE);
        let signature_url = format!("{}/{}", config.latest_url, feed::SIGNATURE_FILE);
        let bytes = self.small(&manifest_url, proxy).await?;
        let signature = self.small(&signature_url, proxy).await?;
        let signature = String::from_utf8(signature).map_err(integrity)?;
        let manifest = release::verify_manifest(&bytes, &signature, keys).map_err(integrity)?;
        if manifest.product != "PiArc" {
            return Err(integrity(format!("a manifest of {:?}", manifest.product)));
        }
        let version = manifest.version.clone();
        if !feed::is_release(&version) || !feed::is_newer(&version, &config.current) {
            return Ok(None);
        }
        let notes_bytes = self.asset(&version, feed::NOTES_FILE, proxy).await?;
        feed::verify_bytes(&manifest, feed::NOTES_FILE, &notes_bytes).map_err(integrity)?;
        let notes = feed::parse_notes(&notes_bytes, &version).map_err(integrity)?;
        let package = match os {
            Os::Macos => None,
            Os::Windows => {
                let name = feed::windows_feed(&arch);
                let bytes = self.asset(&version, &name, proxy).await?;
                feed::verify_bytes(&manifest, &name, &bytes).map_err(integrity)?;
                Some(feed::velopack_full_package(&bytes, &name, &version).map_err(integrity)?)
            }
        };
        let files = feed::platform_files(&manifest, os, &arch, package.as_deref()).map_err(
            |e| match e {
                FeedError::NotListed(name) => {
                    problem("notFound", format!("{name} is not published"))
                }
                other => integrity(other),
            },
        )?;
        let release = UpdateRelease {
            version: version.clone(),
            date: notes.date,
            security: notes.security,
            notes: notes.notes,
            size: files.iter().map(|f| f.size).sum(),
            page_url: fill(&config.page_url, &version, ""),
        };
        Ok(Some((Found { manifest, files }, release)))
    }

    async fn asset(
        &self,
        version: &str,
        name: &str,
        proxy: Option<&str>,
    ) -> std::result::Result<Vec<u8>, UpdateProblem> {
        let url = fill(&self.inner.config.asset_url, version, name);
        self.small(&url, proxy).await
    }

    /// Whether every file of `found` is already in the cache and verifies.
    async fn files_complete(&self, found: &Found) -> bool {
        let dir = self.release_dir(&found.manifest.version);
        let found = found.clone();
        tokio::task::spawn_blocking(move || {
            found
                .files
                .iter()
                .all(|f| release::verify_file(&found.manifest, &dir.join(&f.name)).is_ok())
        })
        .await
        .unwrap_or(false)
    }

    /// Removes cached releases other than `keep`.
    async fn prune(&self, keep: Option<&str>) {
        let dir = self.inner.dir.clone();
        let keep = keep.map(str::to_owned);
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if keep.as_deref() != Some(name.as_str()) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        })
        .await;
    }

    /// Starts downloading the newer release in the background (single flight). Answers the
    /// new snapshot.
    ///
    /// # Errors
    ///
    /// `busy` when no newer release is known (check first).
    pub fn download(&self, proxy: Option<String>) -> Result<UpdateStatus> {
        let token = self.inner.cancel.child_token();
        let found = {
            let mut flow = lock(&self.inner.flow);
            if flow.download.is_some() || flow.status.state == UpdateState::Ready {
                return Ok(flow.status.clone());
            }
            let Some(found) = flow.found.clone() else {
                return Err(Error::Feature {
                    kind: ErrorKind::Busy,
                    retryable: false,
                    message: "no newer release is known; check for updates first".into(),
                    details: None,
                });
            };
            flow.download = Some(token.clone());
            found
        };
        let total = found.files.iter().map(|f| f.size).sum();
        let status = self.set(|f| {
            f.status.state = UpdateState::Downloading;
            f.status.problem = None;
            f.status.progress = Some(UpdateProgress { received: 0, total });
        });
        let this = self.clone();
        tokio::spawn(async move {
            let result = this.fetch_all(&found, proxy.as_deref(), &token).await;
            this.finish_download(result);
        });
        Ok(status)
    }

    async fn fetch_all(
        &self,
        found: &Found,
        proxy: Option<&str>,
        token: &CancellationToken,
    ) -> std::result::Result<(), UpdateProblem> {
        let downloader = self
            .inner
            .downloader
            .as_ref()
            .map_err(|e| problem("tls", e))?;
        let version = &found.manifest.version;
        let dir = self.release_dir(version);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| problem("disk", e))?;
        let hosts = self.inner.config.hosts.clone();
        let allows = move |h: &str| hosts.iter().any(|a| a.eq_ignore_ascii_case(h));
        let total: u64 = found.files.iter().map(|f| f.size).sum();
        let mut done = 0_u64;
        let last = Mutex::new(Instant::now());
        for file in &found.files {
            let url = fill(&self.inner.config.asset_url, version, &file.name);
            let dest = dir.join(&file.name);
            let job = DownloadJob {
                url: &url,
                dest: &dest,
                size: file.size,
                sha256: &file.sha256,
                allows_host: &allows,
                proxy: proxy_for(&url, proxy),
            };
            let base = done;
            let progress = |bytes: u64| {
                let mut last = lock(&last);
                if last.elapsed() >= PROGRESS_INTERVAL {
                    *last = Instant::now();
                    drop(last);
                    self.set(|f| {
                        f.status.progress = Some(UpdateProgress {
                            received: base + bytes,
                            total,
                        });
                    });
                }
            };
            downloader
                .download(&job, token, &progress)
                .await
                .map_err(|e| download_problem(&e))?;
            done += file.size;
        }
        let check = found.clone();
        tokio::task::spawn_blocking(move || {
            check
                .files
                .iter()
                .try_for_each(|f| release::verify_file(&check.manifest, &dir.join(&f.name)))
        })
        .await
        .map_err(|e| problem("disk", e))?
        .map_err(integrity)
    }

    fn finish_download(&self, result: std::result::Result<(), UpdateProblem>) {
        self.set(|f| {
            f.download = None;
            f.status.progress = None;
            match result {
                Ok(()) => f.status.state = UpdateState::Ready,
                Err(p) if p.code == "cancelled" => f.status.state = UpdateState::Available,
                Err(p) => {
                    f.status.state = UpdateState::Failed;
                    f.status.problem = Some(p);
                }
            }
        });
    }

    /// Cancels the running download (the partial files stay for a resume). Answers the
    /// snapshot.
    pub fn cancel_download(&self) -> UpdateStatus {
        if let Some(token) = lock(&self.inner.flow).download.as_ref() {
            token.cancel();
        }
        self.status()
    }

    /// What the main process installs: the verified files of a `ready` release, checked once
    /// more.
    ///
    /// # Errors
    ///
    /// `busy` when nothing is ready; `releaseIntegrity` (and the state becomes `failed`) when
    /// a file no longer verifies.
    pub async fn install_plan(&self) -> Result<UpdateInstall> {
        let (found, ready) = {
            let flow = lock(&self.inner.flow);
            (flow.found.clone(), flow.status.state == UpdateState::Ready)
        };
        let Some(found) = found.filter(|_| ready) else {
            return Err(Error::Feature {
                kind: ErrorKind::Busy,
                retryable: false,
                message: "no downloaded update is ready".into(),
                details: None,
            });
        };
        let Some((os, arch)) = self.inner.config.platform.clone() else {
            return Err(Error::Feature {
                kind: ErrorKind::Busy,
                retryable: false,
                message: "no artefact for this platform".into(),
                details: None,
            });
        };
        let version = found.manifest.version.clone();
        let dir = self.release_dir(&version);
        let verified = {
            let (dir, found) = (dir.clone(), found.clone());
            tokio::task::spawn_blocking(move || {
                found
                    .files
                    .iter()
                    .try_for_each(|f| release::verify_file(&found.manifest, &dir.join(&f.name)))
            })
            .await
            .map_err(|e| Error::Feature {
                kind: ErrorKind::InternalError,
                retryable: false,
                message: e.to_string(),
                details: None,
            })?
        };
        if let Err(error) = verified {
            self.set(|f| {
                f.status.state = UpdateState::Failed;
                f.status.problem = Some(integrity(&error));
            });
            return Err(Error::Feature {
                kind: error.kind(),
                retryable: false,
                message: error.to_string(),
                details: None,
            });
        }
        Ok(match os {
            Os::Macos => UpdateInstall::Macos {
                archive: dir
                    .join(feed::mac_archive(&version, &arch))
                    .to_string_lossy()
                    .into_owned(),
                version,
            },
            Os::Windows => UpdateInstall::Windows {
                feed: dir.to_string_lossy().into_owned(),
                version,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::proxy_for;

    #[test]
    fn the_loopback_is_reached_directly_and_everything_else_through_the_proxy() {
        let proxy = Some("http://127.0.0.1:7897");
        for local in [
            "https://localhost:8443/releases/latest/download/x",
            "https://127.0.0.1:8443/assets/1.1.0/x",
            "https://[::1]:8443/x",
        ] {
            assert_eq!(proxy_for(local, proxy), None, "{local}");
        }
        assert_eq!(
            proxy_for(
                "https://github.com/Refinex-Space/PiArc/releases/latest/download/x",
                proxy
            ),
            proxy
        );
        assert_eq!(proxy_for("https://github.com/x", None), None);
    }
}
