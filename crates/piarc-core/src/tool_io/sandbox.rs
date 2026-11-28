//! The Bash sandbox in the tool I/O (T39, architecture section 6.10).
//!
//! Whether a command runs sandboxed is decided when its call is judged (`policy/evaluate`): the
//! sandbox is on in the merged settings (`piarc_config::sandbox`), the platform has a usable
//! sandbox, and the model did not ask to run the command outside it. The decision rides on the
//! call's grant to `exec/run` and `exec/monitor`, so a command approved because it runs
//! sandboxed always runs sandboxed. The profile itself is built for each command from the
//! settings as they stand when it starts ([`ToolIo::sandbox_launch`]): a changed `denyRead`,
//! added directory or allowlist applies to the next command, with no restart of the Agent Host.
//!
//! Every session has its own network proxy, started with its first sandboxed command; its
//! allowlist is replaced at every launch. A host outside the allowlist is put to the user as a
//! network-domain card (`network.rs`); refusals and the paths a failed command was refused
//! (`piarc_sandbox::denials`) go to the audit as `kind: "sandbox"` and into the command's
//! result, so the model knows it may ask to run the command outside the sandbox.
//!
//! When the platform has no sandbox (Windows, requirement D7) or `sandbox-exec` is missing or
//! fails to start (risk R10), commands run without it through the normal approval: the
//! sandbox's auto-approval never applies then, and Core says so once (`core/notices`,
//! `sandboxUnavailable`).

mod network;
mod view;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use piarc_config::Settings;
use piarc_config::sandbox::{Enterprise, Resolved};
use piarc_exec::Launcher;
use piarc_protocol::exec::{
    CommandOutcome, ExecRunResult, SandboxDenial, SandboxDenialKind, SandboxReport,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_sandbox::denials::{MAX_DENIALS, Operation, file_denials};
use piarc_sandbox::proxy::{Allowlist, DenyReason, Network, ProxyHooks, Refused, SystemNetwork};
use piarc_sandbox::{CommandSandbox, ResolvedPolicy, SandboxPolicy, SessionSandbox};
use serde_json::{Value, json};

use super::exec::Wrap;
use super::policy::Services;
use super::{SandboxSettings, SessionIo, ToolIo, lock};
use crate::events::Event;
use crate::route::RouteKey;

/// How long a network-domain card waits for the user before the connection is refused.
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Refusals kept per session to tell a command which ones were its own.
const REFUSALS_KEPT: usize = 64;

/// The sandbox's parts that tests replace.
#[derive(Clone)]
pub struct SandboxConfig {
    /// The OS sandbox; `None` on a platform without one (Windows in the first release).
    pub platform: Option<Arc<dyn CommandSandbox>>,
    /// Name resolution and connections of the sessions' proxies.
    pub network: Arc<dyn Network>,
    /// The enterprise's sandbox values (T47 fills them from managed settings).
    pub enterprise: Option<Enterprise>,
    /// How long a network-domain card waits for the user.
    pub approval_timeout: Duration,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            platform: piarc_sandbox::platform_sandbox(),
            network: Arc::new(SystemNetwork),
            enterprise: None,
            approval_timeout: DEFAULT_APPROVAL_TIMEOUT,
        }
    }
}

impl std::fmt::Debug for SandboxConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxConfig")
            .field("platform", &self.platform.is_some())
            .field("enterprise", &self.enterprise)
            .field("approval_timeout", &self.approval_timeout)
            .finish_non_exhaustive()
    }
}

/// What the sandbox is for a session now.
#[derive(Debug, Clone, Default)]
pub(super) struct Effective {
    /// The merged settings.
    pub resolved: Resolved,
    /// Added directories (`permissions.additionalDirectories`), writable in the sandbox.
    pub extra_dirs: Vec<PathBuf>,
    /// It can run now (`sandbox-exec` is there and has not failed to start).
    pub available: bool,
}

impl Effective {
    /// Commands run sandboxed.
    pub(super) fn active(&self) -> bool {
        self.resolved.enabled && self.available
    }
}

/// How one call relates to the sandbox, decided when it is judged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct CallSandbox {
    /// The command runs sandboxed.
    pub sandboxed: bool,
    /// Sandboxed commands skip the approval (step 7).
    pub auto: bool,
    /// The model asked to run it outside the sandbox while the sandbox is on.
    pub unsandboxed: bool,
}

impl Effective {
    /// The sandbox of a call of `tool` with `input`.
    pub(super) fn for_call(
        &self,
        tool: &str,
        input: &serde_json::Map<String, Value>,
    ) -> CallSandbox {
        if !matches!(tool, "Bash" | "Monitor") || !self.active() {
            return CallSandbox::default();
        }
        let outside = tool == "Bash"
            && input
                .get("dangerouslyDisableSandbox")
                .and_then(Value::as_bool)
                == Some(true);
        CallSandbox {
            sandboxed: !outside,
            // Monitor commands are approved like before: no read-only allowance, no sandbox
            // auto-approval (T32; Claude Code does the same).
            auto: !outside && tool == "Bash" && self.resolved.auto_allow,
            unsandboxed: outside,
        }
    }
}

/// One session's sandbox: settings forced at open (tests), the proxy, what the user allowed.
#[derive(Default)]
pub(super) struct SessionState {
    /// Every command of the session sandboxed with these settings
    /// ([`ToolIo::open_sandboxed_session`]); none: the merged settings decide.
    pub forced: Option<SandboxSettings>,
    proxy: tokio::sync::Mutex<Option<Arc<SessionSandbox>>>,
    /// Hosts the user allowed for the rest of the session (and those added to the allowlist,
    /// until the next launch reads it).
    hosts: Arc<Mutex<Vec<String>>>,
    /// The proxy's recent refusals, oldest first.
    refusals: Arc<Mutex<VecDeque<(Instant, Refused)>>>,
    /// Managed settings allow their own domains only (T47): no card for any other host; set
    /// by each launch from the settings as they stand.
    managed_only: Arc<std::sync::atomic::AtomicBool>,
}

impl SessionState {
    pub(super) fn forced(forced: SandboxSettings) -> Self {
        Self {
            forced: Some(forced),
            ..Self::default()
        }
    }
}

/// A command about to run in the sandbox: its resolved policy and when it started, to tell
/// which refusals were its own.
pub(super) struct SandboxRun {
    policy: ResolvedPolicy,
    started: Instant,
}

/// Whether the sandbox broke (R10) in this Core, and whether the user heard about it.
#[derive(Debug, Default)]
pub(super) struct Health {
    broken: AtomicBool,
    told: AtomicBool,
}

impl ToolIo {
    /// The sandbox of session `s` now: the merged settings of its workspace, or those forced
    /// at open.
    pub(super) async fn sandbox_effective(&self, s: &SessionIo) -> Result<Effective, ErrorObject> {
        match &self.policy {
            Some(services) if s.sandbox.forced.is_none() => {
                let settings = services.settings(s.project()).await?;
                Ok(self.sandbox_with(s, Some(&settings)))
            }
            _ => Ok(self.sandbox_with(s, None)),
        }
    }

    /// The sandbox of session `s` under `settings` (already loaded for the call being judged);
    /// `None`: the settings forced at open, or no sandbox.
    pub(super) fn sandbox_with(&self, s: &SessionIo, settings: Option<&Settings>) -> Effective {
        let platform = self.config.sandbox.platform.as_ref();
        let available = platform.is_some_and(|p| p.available())
            && !self.sandbox_health.broken.load(Ordering::Relaxed);
        let entry = |value, layer| piarc_config::sandbox::Entry {
            value,
            origin: piarc_config::sandbox::Origin::User,
            layer,
        };
        if let Some(forced) = &s.sandbox.forced {
            return Effective {
                resolved: Resolved {
                    enabled: true,
                    auto_allow: false,
                    deny_read: forced
                        .deny_read
                        .iter()
                        .map(|p| entry(p.clone(), "session"))
                        .collect(),
                    allowed_domains: forced
                        .allowed_domains
                        .iter()
                        .map(|d| piarc_config::sandbox::Entry {
                            value: d.clone(),
                            origin: piarc_config::sandbox::Origin::User,
                            layer: "session",
                        })
                        .collect(),
                    managed_domains_only: false,
                },
                extra_dirs: forced.extra_dirs.clone(),
                available,
            };
        }
        let Some(settings) = settings else {
            return Effective {
                available,
                ..Effective::default()
            };
        };
        let resolved = piarc_config::sandbox::resolve(
            settings,
            self.config.sandbox.enterprise.as_ref(),
            self.config.home.as_deref(),
        );
        let extra_dirs = settings
            .get("/permissions/additionalDirectories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|d| s.scope.root().join(d))
            .filter(|d| d.is_dir())
            .collect();
        Effective {
            resolved,
            extra_dirs,
            available,
        }
    }

    /// The wrapper of one sandboxed command of session `s` (`session_id`), built from the
    /// settings as they stand: its profile, the proxy's allowlist now, the proxy variables.
    pub(super) async fn sandbox_launch(
        &self,
        s: &Arc<SessionIo>,
        session_id: &str,
    ) -> Result<(Wrap, SandboxRun), ErrorObject> {
        let effective = self.sandbox_effective(s).await?;
        let Some(platform) = self
            .config
            .sandbox
            .platform
            .clone()
            .filter(|_| effective.available)
        else {
            self.tell_unavailable();
            return Err(ErrorObject::new(
                ErrorKind::InternalError,
                "the command was approved to run in the sandbox, but the sandbox is not available; request approval again",
                false,
            ));
        };
        let mut policy = SandboxPolicy::new(s.scope.root().to_path_buf(), s.tmp_dir.clone());
        policy.extra_dirs = effective.extra_dirs.clone();
        policy.deny_read = effective.resolved.deny_read_paths();
        let proxy = self.session_proxy(s, session_id, platform).await?;
        s.sandbox.managed_only.store(
            effective.resolved.managed_domains_only,
            std::sync::atomic::Ordering::Relaxed,
        );
        proxy.set_allowlist(allowlist(&effective.resolved.domains()));
        let (launch, resolved) = proxy.launch(&policy).map_err(|e| sandbox_error(&e))?;
        let wrap = Wrap {
            launcher: Some(Launcher {
                program: launch.program,
                args: launch.args,
            }),
            env: launch.env,
        };
        Ok((
            wrap,
            SandboxRun {
                policy: resolved,
                started: Instant::now(),
            },
        ))
    }

    /// The session's proxy, started on first use.
    async fn session_proxy(
        &self,
        s: &Arc<SessionIo>,
        session_id: &str,
        platform: Arc<dyn CommandSandbox>,
    ) -> Result<Arc<SessionSandbox>, ErrorObject> {
        let mut proxy = s.sandbox.proxy.lock().await;
        if let Some(proxy) = proxy.as_ref() {
            return Ok(Arc::clone(proxy));
        }
        let gate = Arc::new(Gate {
            session: Arc::downgrade(s),
            session_id: session_id.to_owned(),
            services: self.policy.clone(),
            hosts: Arc::clone(&s.sandbox.hosts),
            refusals: Arc::clone(&s.sandbox.refusals),
            managed_only: Arc::clone(&s.sandbox.managed_only),
            timeout: self.config.sandbox.approval_timeout,
        });
        let started = SessionSandbox::start(
            platform,
            Allowlist::default(),
            Arc::clone(&self.config.sandbox.network),
            gate,
        )
        .await
        .map_err(|e| sandbox_error(&e))?;
        let started = Arc::new(started);
        *proxy = Some(Arc::clone(&started));
        Ok(started)
    }

    /// The proxy port of a session whose proxy has started.
    pub(super) fn started_proxy_port(s: &SessionIo) -> Option<u16> {
        s.sandbox
            .proxy
            .try_lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.proxy_port()))
    }

    /// Fills the result of a sandboxed foreground command (`result`, of tool call `call`):
    /// what the sandbox refused, written to the audit too; a sandbox that failed to start
    /// stops being used (R10).
    pub(super) async fn sandbox_report(
        &self,
        s: &SessionIo,
        session_id: &str,
        call: Option<&str>,
        run: &SandboxRun,
        result: &mut ExecRunResult,
    ) {
        let mut report = SandboxReport::default();
        let failed = result.outcome == Some(CommandOutcome::Failure);
        let output = result
            .output
            .as_ref()
            .map(|o| format!("{}\n{}", o.head, o.tail.as_deref().unwrap_or_default()))
            .unwrap_or_default();
        if failed && piarc_sandbox::launch_failed(result.exit_code, &output) {
            self.sandbox_health.broken.store(true, Ordering::Relaxed);
            self.tell_unavailable();
            report.failed_to_start = true;
        }
        let cwd = result
            .cwd
            .as_deref()
            .map_or_else(|| s.scope.root().to_path_buf(), PathBuf::from);
        if failed {
            for denial in file_denials(&output, &cwd, &run.policy) {
                let kind = match denial.operation {
                    Operation::Read => SandboxDenialKind::Read,
                    Operation::Write => SandboxDenialKind::Write,
                };
                let target = piarc_fs::display(&denial.path);
                self.audit_sandbox(
                    s,
                    session_id,
                    json!({"denial":"file","operation":kind,"path":target,"toolCallId":call}),
                )
                .await;
                report.denials.push(SandboxDenial { kind, target });
            }
        }
        for refused in refusals_since(&s.sandbox.refusals, run.started) {
            if report.denials.len() >= MAX_DENIALS * 2 {
                break;
            }
            report.denials.push(SandboxDenial {
                kind: SandboxDenialKind::Network,
                target: format!("{}:{}", refused.host, refused.port),
            });
        }
        result.sandbox = Some(report);
    }

    /// One `kind: "sandbox"` audit row of session `s`.
    async fn audit_sandbox(&self, s: &SessionIo, session_id: &str, detail: Value) {
        if let Some(services) = &self.policy {
            audit(services, session_id, s.project(), detail).await;
        }
    }

    /// Tells the user once per Core that commands run without the sandbox although it is on.
    pub(super) fn tell_unavailable(&self) {
        if self.sandbox_health.told.swap(true, Ordering::Relaxed) {
            return;
        }
        tracing::warn!(target: "piarc_core::sandbox", "the sandbox is on but not available; commands run without it");
        let notice = json!({
            "type": "sandboxUnavailable",
            "message": "The sandbox is on but cannot run, so commands run without it and each needs approval.",
            "reason": if self.config.sandbox.platform.is_none() { "platform" } else { "failed" },
        });
        if let Some(events) = &self.notices
            && let Ok(event) = Event::from_json(RouteKey::notices(), &notice)
        {
            // Only a Core shutting down or a full queue refuses it; the notice is advisory.
            let _ = events.try_send(event);
        }
    }
}

/// Writes one sandbox audit row; a failure to record is logged, the command goes on.
async fn audit(services: &Services, session_id: &str, root: &std::path::Path, detail: Value) {
    if let Err(error) = services.record("sandbox", session_id, root, &detail).await {
        tracing::warn!(target: "piarc_core::sandbox", "cannot record a sandbox denial: {}", error.message);
    }
}

/// The allowlist of the valid entries of `domains` (a malformed entry leaves out only itself;
/// the settings' schema already warned about it).
fn allowlist(domains: &[String]) -> Allowlist {
    let valid: Vec<&String> = domains
        .iter()
        .filter(|d| Allowlist::new([d.as_str()]).is_ok())
        .collect();
    Allowlist::new(valid).unwrap_or_default()
}

/// The refusals after `since`.
fn refusals_since(refusals: &Mutex<VecDeque<(Instant, Refused)>>, since: Instant) -> Vec<Refused> {
    lock(refusals)
        .iter()
        .filter(|(at, _)| *at >= since)
        .map(|(_, r)| r.clone())
        .collect()
}

/// The proxy's hooks for one session: hosts the user allowed, cards for the others, refusals
/// to the audit.
struct Gate {
    session: Weak<SessionIo>,
    session_id: String,
    services: Option<Services>,
    hosts: Arc<Mutex<Vec<String>>>,
    refusals: Arc<Mutex<VecDeque<(Instant, Refused)>>>,
    managed_only: Arc<std::sync::atomic::AtomicBool>,
    timeout: Duration,
}

impl ProxyHooks for Gate {
    fn unlisted<'a>(&'a self, host: &'a str, port: u16) -> piarc_ports::BoxFuture<'a, bool> {
        Box::pin(async move {
            // Managed settings allow their domains only: refused without a card, the refusal
            // is audited like any other (T47).
            if self.managed_only.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            if lock(&self.hosts)
                .iter()
                .any(|h| h.eq_ignore_ascii_case(host))
            {
                return true;
            }
            let (Some(s), Some(services)) = (self.session.upgrade(), self.services.as_ref()) else {
                return false;
            };
            network::ask(&network::Ask {
                s: &s,
                services,
                session_id: &self.session_id,
                host,
                port,
                timeout: self.timeout,
                hosts: &self.hosts,
            })
            .await
        })
    }

    fn refused(&self, refused: &Refused) {
        {
            let mut refusals = lock(&self.refusals);
            if refusals.len() == REFUSALS_KEPT {
                refusals.pop_front();
            }
            refusals.push_back((Instant::now(), refused.clone()));
        }
        let (Some(s), Some(services)) = (self.session.upgrade(), self.services.clone()) else {
            return;
        };
        let (session_id, project) = (self.session_id.clone(), s.project().to_path_buf());
        let reason = match refused.reason {
            DenyReason::NotAllowed => "notAllowed",
            DenyReason::BlockedAddress => "blockedAddress",
        };
        let detail =
            json!({"denial":"network","host":refused.host,"port":refused.port,"reason":reason});
        tokio::spawn(async move {
            audit(&services, &session_id, &project, detail).await;
        });
    }
}

fn sandbox_error(error: &piarc_sandbox::Error) -> ErrorObject {
    ErrorObject::new(error.kind(), error.to_string(), error.retryable())
}
