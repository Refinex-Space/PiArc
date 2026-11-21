//! How Core starts and supervises one workspace's Agent Host.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::time::Duration;

use piarc_ports::SpawnSpec;
use piarc_protocol::{Capability, DEFAULT_MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolVersion};

use crate::restart::RestartConfig;

/// Environment variables copied from Core's own environment into the Agent Host's, when set.
/// Only what Node, Pi's tools and the OS need; never credentials (architecture section 5.4).
pub const DEFAULT_ENV_PASSTHROUGH: [&str; 15] = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "APPDATA",
    "LOCALAPPDATA",
    // Windows: resolving executables (cross-spawn, shells) needs these.
    "PATHEXT",
    "COMSPEC",
    "WINDIR",
];

/// Variables Core always sets: Pi must not check for updates or attribute requests to its own
/// telemetry (architecture section 5.5).
const FIXED_ENV: [(&str, &str); 2] = [("PI_SKIP_VERSION_CHECK", "1"), ("PI_TELEMETRY", "0")];

/// Settings of one supervised Agent Host.
#[derive(Debug, Clone)]
pub struct HostConfig {
    /// Workspace root: the process's working directory and `core/welcome.workspace`.
    pub workspace: PathBuf,
    /// PiArc's data directory, passed as `--data-dir`.
    pub data_dir: PathBuf,
    /// The Node executable (development: the `.nvmrc` version; packaged: the bundled one).
    pub node: PathBuf,
    /// The Agent Host bundle (`agent-host.mjs`).
    pub bundle: PathBuf,
    /// Directory with Pi's `package.json` (`pi-assets/`), exported as `PI_PACKAGE_DIR`.
    pub pi_package_dir: Option<PathBuf>,
    /// Arguments appended after `--data-dir`.
    pub extra_args: Vec<OsString>,
    /// Names of variables copied from Core's environment.
    pub env_passthrough: Vec<OsString>,
    /// Variables set in addition, after the passthrough ones.
    pub extra_env: Vec<(OsString, OsString)>,
    /// Protocol version Core speaks.
    pub protocol: ProtocolVersion,
    /// Capabilities Core supports; the connection enables the intersection.
    pub capabilities: Vec<Capability>,
    /// The live user preference read at each handshake, including restarts.
    pub allow_model_network: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// The live model preferences (T29) read at each handshake, including restarts.
    pub model_preferences:
        Option<std::sync::Arc<std::sync::Mutex<piarc_protocol::models::ModelPreferences>>>,
    /// How long to wait for `host/hello` after starting the process.
    pub handshake_timeout: Duration,
    /// Interval between `host/ping` heartbeats.
    pub heartbeat_interval: Duration,
    /// How long a heartbeat waits for its response.
    pub heartbeat_timeout: Duration,
    /// Consecutive failed heartbeats after which the Agent Host is considered hung and killed.
    pub heartbeat_failures: u32,
    /// Default timeout of calls (`session/prompt` only waits for the acknowledgement).
    pub call_timeout: Duration,
    /// How long `shutdown` waits for an orderly exit before killing the process.
    pub shutdown_timeout: Duration,
    /// Frames waiting to be written to the Agent Host's stdin; a full queue refuses calls with
    /// a retryable `busy` error.
    pub write_queue_frames: usize,
    /// Session notifications waiting for the consumer; a full queue stops reading stdout, which
    /// pushes back on the Agent Host. Lifecycle events are not counted.
    pub event_queue: usize,
    /// The most requests from the Agent Host handled at once; further requests wait (the
    /// reader stops) until one finishes. Default 256.
    pub inbound_concurrency: usize,
    /// Largest frame accepted from the Agent Host.
    pub max_frame_bytes: usize,
    /// Restart limits.
    pub restart: RestartConfig,
}

impl HostConfig {
    /// Settings with the defaults of architecture section 7.5.
    #[must_use]
    pub fn new(workspace: PathBuf, data_dir: PathBuf, node: PathBuf, bundle: PathBuf) -> Self {
        Self {
            workspace,
            data_dir,
            node,
            bundle,
            pi_package_dir: None,
            extra_args: Vec::new(),
            env_passthrough: DEFAULT_ENV_PASSTHROUGH.iter().map(OsString::from).collect(),
            extra_env: Vec::new(),
            protocol: PROTOCOL_VERSION,
            capabilities: vec![
                Capability::new("models"),
                Capability::new("memory"),
                Capability::new("hooks"),
                Capability::new("planMode"),
                Capability::new("todo"),
                Capability::new("ask"),
                Capability::new("context"),
                Capability::new("checkpoints"),
                Capability::new("webFetch"),
                Capability::new("webSearch"),
                Capability::new("login"),
                Capability::new("subagents"),
                Capability::new("backgroundTasks"),
                Capability::new("terminalTasks"),
                Capability::new("mcpPool"),
                Capability::new("skills"),
            ],
            allow_model_network: None,
            model_preferences: None,
            handshake_timeout: Duration::from_secs(10),
            heartbeat_interval: Duration::from_secs(30),
            heartbeat_timeout: Duration::from_secs(10),
            heartbeat_failures: 2,
            call_timeout: Duration::from_secs(30),
            shutdown_timeout: Duration::from_secs(5),
            write_queue_frames: 256,
            event_queue: 1024,
            inbound_concurrency: 256,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            restart: RestartConfig::default(),
        }
    }

    /// The process to start. `lookup` reads Core's environment (`std::env::var_os` in
    /// production).
    #[must_use]
    pub fn spawn_spec(&self, lookup: &dyn Fn(&OsStr) -> Option<OsString>) -> SpawnSpec {
        let mut args = vec![
            self.bundle.clone().into_os_string(),
            OsString::from("--data-dir"),
            self.data_dir.clone().into_os_string(),
        ];
        args.extend(self.extra_args.iter().cloned());
        let mut env: Vec<(OsString, OsString)> = self
            .env_passthrough
            .iter()
            .filter_map(|name| lookup(name).map(|value| (name.clone(), value)))
            .collect();
        env.extend(
            FIXED_ENV
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        );
        if let Some(dir) = &self.pi_package_dir {
            env.push((
                OsString::from("PI_PACKAGE_DIR"),
                dir.clone().into_os_string(),
            ));
        }
        env.extend(self.extra_env.iter().cloned());
        SpawnSpec {
            program: self.node.clone(),
            args,
            cwd: self.workspace.clone(),
            env,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_only_named_variables_and_the_fixed_ones() {
        let mut config = HostConfig::new(
            PathBuf::from("work space/项目"),
            PathBuf::from("data"),
            PathBuf::from("node"),
            PathBuf::from("agent-host.mjs"),
        );
        config.pi_package_dir = Some(PathBuf::from("pi-assets"));
        config.extra_env.push(("PI_OFFLINE".into(), "1".into()));
        let lookup = |name: &OsStr| -> Option<OsString> {
            match name.to_str() {
                Some("PATH") => Some("/bin".into()),
                Some("ANTHROPIC_API_KEY") => Some("secret".into()),
                _ => None,
            }
        };
        let spec = config.spawn_spec(&lookup);
        let names: Vec<&str> = spec.env.iter().filter_map(|(k, _)| k.to_str()).collect();
        assert_eq!(
            names,
            [
                "PATH",
                "PI_SKIP_VERSION_CHECK",
                "PI_TELEMETRY",
                "PI_PACKAGE_DIR",
                "PI_OFFLINE"
            ]
        );
        assert_eq!(spec.args, ["agent-host.mjs", "--data-dir", "data"]);
        assert_eq!(spec.cwd, PathBuf::from("work space/项目"));
    }
}
