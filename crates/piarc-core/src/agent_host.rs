//! Agent Host supervision with production I/O (architecture sections 5.6 and 7.5).
//!
//! `piarc-host` holds the supervision logic behind the `ProcessSpawner` and `Clock` ports;
//! this module injects the real ones: [`ProcessTreeSpawner`] from `piarc-exec` (killing the
//! Agent Host ends everything it started) and [`SystemClock`]. It is also the headless entry
//! the Agent Host tests drive.
//!
//! A packaged app starts the Agent Host from its own resources ([`BundledRuntime`],
//! [`start_bundled`]): the bundled Node, `PI_PACKAGE_DIR` set to `pi-assets/`, the bundled
//! Node's directory and rg/fd first on `PATH`; on macOS under `/usr/bin/sandbox-exec` with the
//! permissive profile of `piarc_sandbox::agent_host_launch` (ADR-0015).

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_exec::ProcessTreeSpawner;
use piarc_ports::{BoxFuture, Clock, ProcessSpawner, SpawnSpec, SpawnedProcess};

use crate::error::{Error as CoreError, Result};

pub use piarc_host::{
    CallRecord, CallState, DEFAULT_ENV_PASSTHROUGH, Error, ExitReason, HostConfig, HostDeps,
    HostEvent, HostEvents, HostSupervisor, InboundHandler, NoInbound, Peer, PeerClosed,
    RestartConfig, SharedInbound, SupervisorState,
};

/// The operating system's monotonic clock; sleeps on the tokio timer.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// Starts supervising the Agent Host described by `config` on the current tokio runtime.
/// `inbound` answers the Agent Host's requests (`trust/get`, ...).
#[must_use]
pub fn start(config: HostConfig, inbound: SharedInbound) -> (HostSupervisor, HostEvents) {
    start_with(config, inbound, Arc::new(ProcessTreeSpawner))
}

fn start_with(
    config: HostConfig,
    inbound: SharedInbound,
    spawner: Arc<dyn ProcessSpawner>,
) -> (HostSupervisor, HostEvents) {
    HostSupervisor::start(
        config,
        HostDeps {
            spawner,
            clock: Arc::new(SystemClock),
            inbound,
        },
    )
}

/// The Agent Host files of a packaged app: `Resources/agent-host/` (macOS) or
/// `resources\agent-host\` (Windows), laid out as in architecture section 5.6 and
/// `apps/desktop/packaging/agent-host-layout.mjs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledRuntime {
    root: PathBuf,
}

impl BundledRuntime {
    /// Name of the directory under the app's resources directory.
    pub const DIR: &'static str = "agent-host";

    /// The runtime under `resources_dir` (Electron's `process.resourcesPath`).
    ///
    /// # Errors
    ///
    /// [`CoreError::BundledRuntime`] when the node executable, the bundle or `pi-assets/` is
    /// missing.
    pub fn locate(resources_dir: &Path) -> Result<Self> {
        let runtime = Self {
            root: resources_dir.join(Self::DIR),
        };
        for required in [runtime.node(), runtime.bundle(), runtime.pi_package_dir()] {
            if !required.exists() {
                return Err(CoreError::BundledRuntime {
                    reason: format!("{} is missing", required.display()),
                });
            }
        }
        Ok(runtime)
    }

    /// `Resources/agent-host/`.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Directory with node, npm and npx: `node/bin` (macOS) or `node` (Windows).
    #[must_use]
    pub fn node_bin_dir(&self) -> PathBuf {
        if cfg!(windows) {
            self.root.join("node")
        } else {
            self.root.join("node").join("bin")
        }
    }

    /// The bundled Node executable.
    #[must_use]
    pub fn node(&self) -> PathBuf {
        self.node_bin_dir()
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    }

    /// The Agent Host bundle.
    #[must_use]
    pub fn bundle(&self) -> PathBuf {
        self.root.join("agent-host.mjs")
    }

    /// Pi's resources, exported as `PI_PACKAGE_DIR`.
    #[must_use]
    pub fn pi_package_dir(&self) -> PathBuf {
        self.root.join("pi-assets")
    }

    /// Directory with rg and fd.
    #[must_use]
    pub fn tools_bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }

    /// Supervisor settings for one workspace. `lookup` reads Core's environment
    /// (`std::env::var_os` in production).
    ///
    /// The environment is the passthrough set of [`DEFAULT_ENV_PASSTHROUGH`] except `PATH` and
    /// `TMPDIR`, plus:
    /// - `PATH`: the bundled Node's directory and `bin/` (rg, fd) before Core's own `PATH`, so
    ///   `npx` and the MCP servers it starts run on the bundled Node (ADR-0015 rule 6);
    /// - `TMPDIR`, `npm_config_cache`: inside [`agent_host_dirs`], which the Seatbelt profile
    ///   lets the Agent Host write;
    /// - `npm_config_update_notifier=false`: npm never checks for its own updates.
    ///
    /// # Errors
    ///
    /// [`CoreError::BundledRuntime`] when `PATH` cannot be joined (a directory contains the
    /// platform's path separator).
    pub fn host_config(
        &self,
        workspace: PathBuf,
        data_dir: PathBuf,
        lookup: &dyn Fn(&OsStr) -> Option<OsString>,
    ) -> Result<HostConfig> {
        let (tmp, npm_cache) = agent_host_dirs(&data_dir);
        let mut config = HostConfig::new(workspace, data_dir, self.node(), self.bundle());
        config.pi_package_dir = Some(self.pi_package_dir());
        config
            .env_passthrough
            .retain(|name| name != "PATH" && name != "TMPDIR");
        let mut path = vec![self.node_bin_dir(), self.tools_bin_dir()];
        if let Some(existing) = lookup(OsStr::new("PATH")) {
            path.extend(std::env::split_paths(&existing));
        }
        let path = std::env::join_paths(path).map_err(|e| CoreError::BundledRuntime {
            reason: format!("cannot build PATH: {e}"),
        })?;
        config.extra_env = vec![
            (OsString::from("PATH"), path),
            (OsString::from("TMPDIR"), tmp.into_os_string()),
            (
                OsString::from("npm_config_cache"),
                npm_cache.into_os_string(),
            ),
            (
                OsString::from("npm_config_update_notifier"),
                OsString::from("false"),
            ),
        ];
        Ok(config)
    }
}

/// The Agent Host's temporary directory and npm cache: `<data>/agent-host/tmp` and
/// `<data>/agent-host/npm-cache` (architecture section 9.1).
#[must_use]
pub fn agent_host_dirs(data_dir: &Path) -> (PathBuf, PathBuf) {
    let base = data_dir.join("agent-host");
    (base.join("tmp"), base.join("npm-cache"))
}

/// Starts supervising the Agent Host of a packaged app for one workspace: settings from
/// [`BundledRuntime::host_config`], processes through [`ProcessTreeSpawner`]; on macOS every
/// start goes through `sandbox-exec` with the permissive profile, whose writable directories
/// are `workspace` and `data_dir`. Creates the Agent Host's directories first.
///
/// # Errors
///
/// [`CoreError::BundledRuntime`] when the directories cannot be created or the profile cannot be
/// built (a directory is missing or not UTF-8).
pub fn start_bundled(
    runtime: &BundledRuntime,
    workspace: PathBuf,
    data_dir: PathBuf,
    inbound: SharedInbound,
) -> Result<(HostSupervisor, HostEvents)> {
    let (tmp, npm_cache) = agent_host_dirs(&data_dir);
    for dir in [&tmp, &npm_cache] {
        std::fs::create_dir_all(dir).map_err(|e| CoreError::BundledRuntime {
            reason: format!("cannot create {}: {e}", dir.display()),
        })?;
    }
    let spawner = platform_spawner(&workspace, &data_dir)?;
    let config = runtime.host_config(workspace, data_dir, &|name| std::env::var_os(name))?;
    Ok(start_with(config, inbound, spawner))
}

#[cfg(target_os = "macos")]
fn platform_spawner(workspace: &Path, data_dir: &Path) -> Result<Arc<dyn ProcessSpawner>> {
    let launch =
        piarc_sandbox::agent_host_launch(&[workspace.to_path_buf(), data_dir.to_path_buf()])
            .map_err(|e| CoreError::BundledRuntime {
                reason: format!("cannot build the Agent Host's Seatbelt profile: {e}"),
            })?;
    Ok(Arc::new(LauncherSpawner {
        program: launch.program,
        args: launch.args,
        inner: Arc::new(ProcessTreeSpawner),
    }))
}

#[cfg(not(target_os = "macos"))]
fn platform_spawner(_workspace: &Path, _data_dir: &Path) -> Result<Arc<dyn ProcessSpawner>> {
    // Windows: no OS sandbox in the first release (requirement D7); the Job Object of
    // ProcessTreeSpawner holds the process tree.
    Ok(Arc::new(ProcessTreeSpawner))
}

/// Runs every process as `program args… <process> <its args…>`: the wrapper keeps the
/// process's working directory and environment.
#[derive(Clone)]
pub struct LauncherSpawner {
    /// The wrapper's executable (`/usr/bin/sandbox-exec`).
    pub program: PathBuf,
    /// The wrapper's arguments before the wrapped program.
    pub args: Vec<OsString>,
    /// Starts the wrapper.
    pub inner: Arc<dyn ProcessSpawner>,
}

impl std::fmt::Debug for LauncherSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LauncherSpawner")
            .field("program", &self.program)
            .field("args", &self.args.len())
            .finish_non_exhaustive()
    }
}

impl ProcessSpawner for LauncherSpawner {
    fn spawn(&self, spec: SpawnSpec) -> io::Result<SpawnedProcess> {
        let mut args = self.args.clone();
        args.push(spec.program.into_os_string());
        args.extend(spec.args);
        self.inner.spawn(SpawnSpec {
            program: self.program.clone(),
            args,
            cwd: spec.cwd,
            env: spec.env,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_in(dir: &Path) -> BundledRuntime {
        let root = dir.join(BundledRuntime::DIR);
        let node_bin = if cfg!(windows) {
            root.join("node")
        } else {
            root.join("node").join("bin")
        };
        std::fs::create_dir_all(&node_bin).expect("node dir");
        std::fs::create_dir_all(root.join("pi-assets")).expect("pi-assets");
        let node = node_bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(node, b"").expect("node");
        std::fs::write(root.join("agent-host.mjs"), b"").expect("bundle");
        BundledRuntime::locate(dir).expect("complete layout")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("piarc-bundled {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn locate_reports_the_missing_file() {
        let dir = temp_dir("missing");
        let error = BundledRuntime::locate(&dir).expect_err("empty resources");
        assert_eq!(error.kind(), piarc_protocol::ErrorKind::InternalError);
        assert!(error.to_string().contains("agent-host"), "{error}");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn host_config_puts_the_bundled_node_first_on_path() {
        let dir = temp_dir("config");
        let runtime = runtime_in(&dir);
        let system_path = std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
            .expect("joins");
        let lookup = |name: &OsStr| match name.to_str() {
            Some("PATH") => Some(system_path.clone()),
            Some("HOME") => Some(OsString::from("/Users/dev")),
            Some("TMPDIR") => Some(OsString::from("/var/folders/x/T/")),
            Some("ANTHROPIC_API_KEY") => Some(OsString::from("secret")),
            _ => None,
        };
        let data = dir.join("data");
        let config = runtime
            .host_config(dir.join("ws"), data.clone(), &lookup)
            .expect("config");
        assert_eq!(config.node, runtime.node());
        assert_eq!(config.pi_package_dir, Some(runtime.pi_package_dir()));
        let spec = config.spawn_spec(&lookup);
        let env: Vec<(String, String)> = spec
            .env
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect();
        let get = |key: &str| {
            let values: Vec<&String> = env
                .iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v)
                .collect();
            assert!(values.len() <= 1, "{key} is set once: {values:?}");
            values.first().map(|v| (*v).clone())
        };
        let path: Vec<PathBuf> = std::env::split_paths(&get("PATH").expect("PATH")).collect();
        assert_eq!(path[0], runtime.node_bin_dir());
        assert_eq!(path[1], runtime.tools_bin_dir());
        assert_eq!(path[2], PathBuf::from("/usr/bin"));
        let (tmp, npm_cache) = agent_host_dirs(&data);
        assert_eq!(get("TMPDIR").map(PathBuf::from), Some(tmp));
        assert_eq!(get("npm_config_cache").map(PathBuf::from), Some(npm_cache));
        assert_eq!(get("npm_config_update_notifier").as_deref(), Some("false"));
        assert_eq!(get("HOME").as_deref(), Some("/Users/dev"));
        assert_eq!(
            get("ANTHROPIC_API_KEY"),
            None,
            "credentials never pass through"
        );
        assert_eq!(
            get("PI_PACKAGE_DIR").map(PathBuf::from),
            Some(runtime.pi_package_dir())
        );
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn the_launcher_wraps_program_and_keeps_cwd_and_env() {
        #[derive(Default)]
        struct Recording(std::sync::Mutex<Option<SpawnSpec>>);
        impl ProcessSpawner for Recording {
            fn spawn(&self, spec: SpawnSpec) -> io::Result<SpawnedProcess> {
                *self.0.lock().expect("lock") = Some(spec);
                Err(io::Error::other("recorded"))
            }
        }
        let recording = Arc::new(Recording::default());
        let launcher = LauncherSpawner {
            program: PathBuf::from("/usr/bin/sandbox-exec"),
            args: vec![
                OsString::from("-p"),
                OsString::from("(version 1)"),
                OsString::from("--"),
            ],
            inner: Arc::clone(&recording) as Arc<dyn ProcessSpawner>,
        };
        let _ = launcher.spawn(SpawnSpec {
            program: PathBuf::from("/app/node"),
            args: vec![OsString::from("agent-host.mjs")],
            cwd: PathBuf::from("/ws"),
            env: vec![(OsString::from("A"), OsString::from("1"))],
        });
        let spec = recording.0.lock().expect("lock").take().expect("spawned");
        assert_eq!(spec.program, PathBuf::from("/usr/bin/sandbox-exec"));
        assert_eq!(
            spec.args,
            ["-p", "(version 1)", "--", "/app/node", "agent-host.mjs"]
        );
        assert_eq!(spec.cwd, PathBuf::from("/ws"));
        assert_eq!(spec.env, vec![(OsString::from("A"), OsString::from("1"))]);
    }
}
