//! `prompt` hooks' way to a model (T38, ADR-0055): Core runs the hook, the main session's Agent
//! Host makes the one model call (`hooks/prompt`) with its auxiliary model channel. Auto mode's
//! reviews (T46, `policy/review`) take the same way.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use piarc_ports::BoxFuture;
use piarc_protocol::hooks::{HooksPrompt, HooksPromptParams, HooksPromptResult};
use piarc_protocol::policy::{PolicyReview, PolicyReviewParams, PolicyReviewResult};
use piarc_protocol::{ErrorKind, ErrorObject};

use super::{Hub, Routes, lock};
use crate::hooks::HookOutlet;
use crate::tool_io::policy::review::{ReviewOutlet, ReviewTrouble};

/// What the transport may add to a judgement's own timeout before Core gives up on it.
const TRANSPORT_SLACK: Duration = Duration::from_secs(5);

impl Hub {
    /// Lets the tool I/O's hooks reach the sessions' Agent Hosts.
    pub(crate) fn connect_hooks(&self) {
        self.ctx.tool_io.set_hook_outlet(Arc::new(HubHooks {
            routes: Arc::downgrade(&self.routes),
        }));
    }
}

/// Weak, so the hooks service the tool I/O holds does not keep the hub alive.
struct HubHooks {
    routes: Weak<Mutex<Routes>>,
}

impl HookOutlet for HubHooks {
    fn judge(
        &self,
        params: HooksPromptParams,
    ) -> BoxFuture<'static, Result<HooksPromptResult, String>> {
        let session = self
            .routes
            .upgrade()
            .and_then(|routes| lock(&routes).sessions.get(&params.session_id).cloned());
        Box::pin(async move {
            let session = session.ok_or_else(|| "the session is not open".to_owned())?;
            let host = session
                .host()
                .await
                .ok_or_else(|| "the session's Agent Host is not running".to_owned())?;
            let timeout = Duration::from_millis(params.timeout_ms) + TRANSPORT_SLACK;
            host.call_within::<HooksPrompt>(params, timeout)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn mcp_tool(
        &self,
        params: piarc_protocol::hooks::HooksMcpToolParams,
    ) -> BoxFuture<'static, Result<piarc_protocol::hooks::HooksMcpToolResult, ErrorObject>> {
        let session = self
            .routes
            .upgrade()
            .and_then(|routes| lock(&routes).sessions.get(&params.session_id).cloned());
        Box::pin(async move {
            let session = session.ok_or_else(|| {
                ErrorObject::new(ErrorKind::SessionNotFound, "the session is not open", false)
            })?;
            let host = session.host().await.ok_or_else(|| {
                ErrorObject::new(
                    ErrorKind::HostUnavailable,
                    "the session's Agent Host is not running",
                    true,
                )
            })?;
            let timeout = Duration::from_millis(params.timeout_ms) + TRANSPORT_SLACK;
            host.call_within::<piarc_protocol::hooks::HooksMcpTool>(params, timeout)
                .await
                .map_err(|e| e.to_error_object())
        })
    }
}

impl Hub {
    /// Lets Auto mode's reviews reach the sessions' Agent Hosts (T46, `policy/review`).
    pub(crate) fn connect_reviews(&self) {
        self.ctx.tool_io.set_review_outlet(Arc::new(HubReviews {
            routes: Arc::downgrade(&self.routes),
        }));
    }
}

/// Weak, as [`HubHooks`].
struct HubReviews {
    routes: Weak<Mutex<Routes>>,
}

impl ReviewOutlet for HubReviews {
    fn review(
        &self,
        root: String,
        params: PolicyReviewParams,
        within: Duration,
    ) -> BoxFuture<'static, Result<PolicyReviewResult, ReviewTrouble>> {
        let session = self
            .routes
            .upgrade()
            .and_then(|routes| lock(&routes).sessions.get(&root).cloned());
        Box::pin(async move {
            let session = session
                .ok_or_else(|| ReviewTrouble::HostDown("the session is not open".to_owned()))?;
            let host = session.host().await.ok_or_else(|| {
                ReviewTrouble::HostDown("the session's Agent Host is not running".to_owned())
            })?;
            host.call_within::<PolicyReview>(params, within)
                .await
                .map_err(|e| match e {
                    piarc_host::Error::Timeout { .. } => ReviewTrouble::Timeout,
                    piarc_host::Error::Remote { error, .. } => ReviewTrouble::Failed(error.message),
                    other => ReviewTrouble::Failed(other.to_string()),
                })
        })
    }
}
