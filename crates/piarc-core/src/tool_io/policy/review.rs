//! Auto mode's reviewer step in Core (T46, design addendum
//! `docs/architecture/addenda/T46-auto-mode.md`).
//!
//! After the `PermissionRequest` hooks, a call whose ruling is the general question
//! (`piarc_policy::review::reviewable`) of a session in Auto mode goes to the reviewer model
//! instead of straight to the user:
//!
//! 1. The card enters the ledger marked `reviewing` (no answers taken) and the Agent Host hears
//!    `policy/pending`, which stops its preflight deadline.
//! 2. Core sends `policy/review` to the workspace's Agent Host through the session layer's
//!    [`ReviewOutlet`] and waits at most the review timeout (plus transport slack).
//! 3. The answer is checked again here (`piarc_policy::review::check_answer`). `allow` runs
//!    the call this once; `deny` refuses it with the reviewer's reason (T48's
//!    `PermissionDenied` hook belongs in [`ToolIo::reviewer_refused`]); `unsure` and every
//!    failure put the same card back to the user (revision + 1, `fallback` with the reason).
//! 4. Every review writes one `autoReview` audit row; the call's final decision is the usual
//!    `permission` row.
//!
//! Refusals count on the main session (`Denials`); a pause sends the calls straight to the
//! user until the user allows one or selects Auto mode again.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use piarc_policy::review::{self as rules, Checked, Denials, Pause, Verdict};
use piarc_ports::BoxFuture;
use piarc_protocol::policy::{
    ApprovalReview, AutoReviewReason, AutoReviewState, AutoReviewStatus, PolicyReviewParams,
    PolicyReviewResult, ReviewEnvironment, ReviewFailure, ReviewFallback, ReviewPolicy,
    ReviewState, ReviewVerdict, ToolReview,
};
use piarc_protocol::session::ModelRef;

use super::*;

/// What the transport may add to the review's own limit before Core gives up on it.
const TRANSPORT_SLACK: Duration = Duration::from_secs(5);

/// The session layer's way to the Agent Host of a main session's workspace.
pub(crate) trait ReviewOutlet: Send + Sync {
    /// Sends `params` to the Agent Host of main session `root`, waiting at most `within`.
    fn review(
        &self,
        root: String,
        params: PolicyReviewParams,
        within: Duration,
    ) -> BoxFuture<'static, Result<PolicyReviewResult, ReviewTrouble>>;
}

/// Why `policy/review` got no result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReviewTrouble {
    /// The session is not open or its workspace's Agent Host is not running.
    HostDown(String),
    /// The request did not complete in time.
    Timeout,
    /// The Agent Host answered with an error, or the connection failed.
    Failed(String),
}

/// The review's limit and the session layer's outlet (connected when the runtime starts).
#[derive(Clone)]
pub(crate) struct ReviewConfig {
    /// How long a review may take (the Agent Host's model call ends with it).
    pub timeout: Duration,
    outlet: Arc<Mutex<Option<Arc<dyn ReviewOutlet>>>>,
}

impl Default for ReviewConfig {
    fn default() -> Self {
        Self::with_timeout(rules::REVIEW_TIMEOUT)
    }
}

impl ReviewConfig {
    /// A review limit other than [`rules::REVIEW_TIMEOUT`] (L2 fault injection).
    pub(crate) fn with_timeout(timeout: Duration) -> Self {
        Self {
            timeout,
            outlet: Arc::default(),
        }
    }
}

/// Auto mode's state of a main session (its subagents use their main session's).
#[derive(Debug, Default)]
pub(super) struct AutoState {
    denials: Denials,
    /// The reviewer the settings named at the last check.
    model: Option<String>,
    /// Why the reviewer could not be used at the last attempt.
    unavailable: Option<AutoReviewReason>,
    /// The settings turned Auto mode off while the session was in it.
    demoted: bool,
}

impl AutoState {
    /// What the session list shows for a session in `mode`.
    pub(super) fn status(&self, mode: PermissionMode) -> Option<AutoReviewStatus> {
        let (state, reason) = if self.demoted && mode == PermissionMode::Default {
            (
                AutoReviewState::Unavailable,
                Some(AutoReviewReason::Disabled),
            )
        } else if mode != PermissionMode::Auto {
            return None;
        } else if let Some(pause) = self.denials.paused() {
            (AutoReviewState::Paused, Some(pause_reason(pause)))
        } else if self.model.is_none() {
            (
                AutoReviewState::Unavailable,
                Some(AutoReviewReason::NoModel),
            )
        } else if let Some(reason) = self.unavailable {
            (AutoReviewState::Unavailable, Some(reason))
        } else {
            (AutoReviewState::Ready, None)
        };
        Some(AutoReviewStatus {
            state,
            reason,
            model: self.model.clone(),
        })
    }

    /// The user allowed a call on a card or selected Auto mode: refusals start over.
    pub(super) fn resume(&mut self) {
        self.denials.resume();
    }

    /// The user chose a mode: a notice about settings turning Auto mode off ends.
    pub(super) fn mode_chosen(&mut self) {
        self.demoted = false;
    }

    pub(super) fn set_model(&mut self, model: Option<String>) {
        if self.model != model {
            self.unavailable = None;
        }
        self.model = model;
    }

    /// Auto mode was turned off by the settings while the session was in it.
    pub(super) fn demote(&mut self) {
        self.demoted = true;
    }
}

fn pause_reason(pause: Pause) -> AutoReviewReason {
    match pause {
        Pause::Consecutive => AutoReviewReason::Consecutive,
        Pause::Total => AutoReviewReason::Total,
    }
}

/// What the review decided.
pub(super) enum Reviewed {
    /// Run the call (this once).
    Allow(ToolReview),
    /// Refuse it; the text is what the model reads.
    Deny(ToolReview, String),
    /// The user answered the card the review handed back (`None`: the wait ended without an
    /// answer).
    User(Option<waits::Answered>),
}

/// How one review went, for the audit and the card.
struct Attempt {
    /// The audit's `outcome`.
    name: &'static str,
    checked: Option<Checked>,
    fallback: Option<ReviewFallback>,
    message: Option<String>,
    result: Option<PolicyReviewResult>,
}

impl Attempt {
    fn failed(name: &'static str, fallback: ReviewFallback, message: Option<String>) -> Self {
        Self {
            name,
            checked: None,
            fallback: Some(fallback),
            message,
            result: None,
        }
    }
}

/// The call's parts the review needs.
pub(super) struct Call<'a> {
    pub s: &'a SessionIo,
    pub services: &'a Services,
    pub settings: &'a Settings,
    pub p: &'a PolicyEvaluateParams,
    pub peer: &'a Peer,
    pub generation: &'a CancellationToken,
}

impl ToolIo {
    /// Lets reviews reach the sessions' Agent Hosts (the session layer, T46).
    pub(crate) fn set_review_outlet(&self, outlet: Arc<dyn ReviewOutlet>) {
        if let Some(services) = &self.policy {
            *lock(&services.review.outlet) = Some(outlet);
        }
    }

    /// The reviewer step for a reviewable call of a session in Auto mode.
    pub(super) async fn auto_review(
        &self,
        call: &Call<'_>,
        prepared: &mut Prepared,
    ) -> Result<Reviewed, ErrorObject> {
        let Call { s, services, p, .. } = *call;
        prepared.add_preview(p).await?;
        prepared.card.notification_allow = notify::allowed(&prepared.card);
        let root = super::super::subagents::rule_owner(s);
        let auto = piarc_config::auto_mode::read(call.settings);
        let model = match self.reviewer_for(call, prepared, &auto).await? {
            Ok(model) => model,
            Err(handed_back) => return Ok(handed_back),
        };
        let Some((card, rx)) = post_reviewing(call, &prepared.card, Some(model.clone())).await?
        else {
            return Ok(Reviewed::User(None));
        };
        let started = Instant::now();
        let outcome = self.ask_reviewer(call, &auto, &model).await;
        let duration = started.elapsed();
        let Some(mut outcome) = outcome else {
            waits::withdraw_card(s, services, &p.tool_call_id, &card, call.peer);
            let cancelled = Attempt::failed("cancelled", ReviewFallback::Discarded, None);
            self.audit_review(call, &cancelled, Some(&model), duration, None)
                .await?;
            return Ok(Reviewed::User(None));
        };
        // A mode switch while the reviewer worked voids its answer (no second decision).
        if outcome.checked.is_some()
            && super::super::subagents::current_mode(s) != PermissionMode::Auto
        {
            outcome = Attempt {
                name: "discarded",
                fallback: Some(ReviewFallback::Discarded),
                checked: None,
                ..outcome
            };
        }
        self.remember_availability(call, &outcome);
        let reviewer = outcome
            .result
            .as_ref()
            .and_then(|r| r.model.clone())
            .unwrap_or_else(|| model.clone());
        match outcome.checked.clone() {
            Some(checked) if checked.verdict != Verdict::Unsure => {
                waits::withdraw_card(s, services, &p.tool_call_id, &card, call.peer);
                self.reviewer_decided(call, root, &outcome, checked, reviewer, duration)
                    .await
            }
            checked => {
                let fallback = outcome.fallback.unwrap_or(ReviewFallback::Unsure);
                let reason = checked
                    .map(|c| c.reason)
                    .or_else(|| outcome.message.clone());
                self.audit_review(call, &outcome, Some(&reviewer), duration, None)
                    .await?;
                self.hand_back(
                    call,
                    prepared,
                    Some((card, rx)),
                    fallback,
                    reason,
                    Some(model),
                )
                .await
            }
        }
    }

    /// The reviewer to ask, or the card already handed to the user: review is paused, or no
    /// reviewer model is set.
    async fn reviewer_for(
        &self,
        call: &Call<'_>,
        prepared: &mut Prepared,
        auto: &piarc_config::auto_mode::AutoModeSettings,
    ) -> Result<Result<String, Reviewed>, ErrorObject> {
        let root = super::super::subagents::rule_owner(call.s);
        let model = auto.model.clone();
        let paused = {
            let mut state = lock(&root.policy);
            state.auto.set_model(model.clone());
            state.auto.denials.paused()
        };
        if let Some(pause) = paused {
            let user = self
                .hand_back(call, prepared, None, pause.fallback(), None, model)
                .await?;
            return Ok(Err(user));
        }
        let Some(model) = model else {
            // Nothing to ask: the card goes to the user at once, with the reason.
            let attempt = Attempt::failed(
                "unavailable",
                ReviewFallback::Unavailable,
                Some("No reviewer model is set (autoMode.model).".into()),
            );
            self.audit_review(call, &attempt, None, Duration::ZERO, None)
                .await?;
            let user = self
                .hand_back(
                    call,
                    prepared,
                    None,
                    ReviewFallback::Unavailable,
                    attempt.message,
                    None,
                )
                .await?;
            return Ok(Err(user));
        };
        Ok(Ok(model))
    }

    /// The reviewer allowed or refused the call.
    async fn reviewer_decided(
        &self,
        call: &Call<'_>,
        root: &SessionIo,
        outcome: &Attempt,
        checked: Checked,
        model: String,
        duration: Duration,
    ) -> Result<Reviewed, ErrorObject> {
        let verdict = if checked.verdict == Verdict::Allow {
            ReviewVerdict::Allow
        } else {
            ReviewVerdict::Deny
        };
        let note = ToolReview {
            verdict,
            reason: checked.reason.clone(),
            model: model.clone(),
            category: checked.category.clone(),
        };
        if verdict == ReviewVerdict::Allow {
            lock(&root.policy).auto.denials.reviewer_allowed();
            self.audit_review(call, outcome, Some(&model), duration, None)
                .await?;
            return Ok(Reviewed::Allow(note));
        }
        let count = lock(&root.policy).auto.denials.deny();
        publish_root(call);
        self.audit_review(call, outcome, Some(&model), duration, Some(count))
            .await?;
        let guidance = if self.reviewer_refused(call, &checked.reason).await {
            "You may retry this tool call. The new call will be reviewed independently."
        } else {
            rules::DENIAL_NOTE
        };
        let mut reason = format!(
            "Permission denied by the automatic reviewer: {} {guidance}",
            checked.reason
        );
        if count.paused.is_some() {
            reason.push(' ');
            reason.push_str(rules::PAUSE_NOTE);
        }
        Ok(Reviewed::Deny(note, reason))
    }

    /// Gives the card to the user with the reason: in place of the reviewing card (`posted`),
    /// or as a new card when no review ran (paused, unavailable).
    async fn hand_back(
        &self,
        call: &Call<'_>,
        prepared: &mut Prepared,
        posted: Option<(ApprovalRequest, oneshot::Receiver<waits::Answered>)>,
        fallback: ReviewFallback,
        reason: Option<String>,
        model: Option<String>,
    ) -> Result<Reviewed, ErrorObject> {
        let Call {
            s,
            services,
            p,
            peer,
            ..
        } = *call;
        let review = ApprovalReview {
            state: ReviewState::Fallback,
            fallback: Some(fallback),
            reason: reason
                .map(|r| rules::clean_reason(&r))
                .filter(|r| !r.is_empty()),
            model,
        };
        let rx = if let Some((card, rx)) = posted {
            let reopened = {
                let mut state = lock(&s.policy);
                let updated = state.ledger.update(&card.request_id, |r| {
                    r.revision += 1;
                    r.review = Some(review.clone());
                });
                if updated {
                    state.publish(&card.session_id, services);
                }
                updated
            };
            if !reopened {
                return Ok(Reviewed::User(None));
            }
            prepared.card.revision = card.revision + 1;
            prepared.card.review = Some(review);
            rx
        } else {
            prepared.card.review = Some(review);
            let (tx, rx) = oneshot::channel();
            if !waits::post_card(
                s,
                services,
                &p.tool_call_id,
                &prepared.card,
                peer,
                call.generation,
                tx,
            )
            .await?
            {
                return Ok(Reviewed::User(None));
            }
            rx
        };
        // The user is asked now (not while the reviewer worked).
        let (io, id) = (self.clone(), p.session_id.clone());
        let message = format!("PiArc needs your permission to use {}", p.tool);
        tokio::spawn(async move {
            io.notification_hooks(&id, "permission_prompt", &message)
                .await;
        });
        let answer = tokio::select! {
            biased;
            ()=peer.closed()=>None,
            ()=call.generation.cancelled()=>None,
            reply=rx=>reply.ok(),
        };
        if answer.is_none() {
            waits::withdraw_card(s, services, &p.tool_call_id, &prepared.card, peer);
        }
        Ok(Reviewed::User(answer))
    }

    /// Sends the review and reads its answer; `None` when the turn was interrupted or the
    /// connection ended meanwhile.
    async fn ask_reviewer(
        &self,
        call: &Call<'_>,
        auto: &piarc_config::auto_mode::AutoModeSettings,
        model: &str,
    ) -> Option<Attempt> {
        let Call { s, services, p, .. } = *call;
        let Some((provider, id)) = model
            .split_once('/')
            .filter(|(a, b)| !a.is_empty() && !b.is_empty())
        else {
            return Some(Attempt::failed(
                "unavailable",
                ReviewFallback::Unavailable,
                Some(format!(
                    "The reviewer model {model:?} is not a provider/model pair."
                )),
            ));
        };
        let outlet = lock(&services.review.outlet).clone();
        let Some(outlet) = outlet else {
            return Some(Attempt::failed(
                "unavailable",
                ReviewFallback::Unavailable,
                Some("The workspace's Agent Host is not running.".into()),
            ));
        };
        let timeout = services.review.timeout;
        let params = PolicyReviewParams {
            session_id: p.session_id.clone(),
            tool_call_id: p.tool_call_id.clone(),
            tool: p.tool.clone(),
            input: call_input(p),
            why: why(p),
            environment: self.environment(s, call.settings, p),
            policy: ReviewPolicy {
                environment: auto.environment.clone(),
                allow: auto.allow.clone(),
                soft_deny: auto.soft_deny.clone(),
                hard_deny: auto.hard_deny.clone(),
            },
            model: ModelRef {
                provider: provider.to_owned(),
                id: id.to_owned(),
            },
            timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
        };
        let root = s
            .subagent
            .as_ref()
            .map_or_else(|| p.session_id.clone(), |link| link.root_id.clone());
        let answer = tokio::select! {
            biased;
            ()=call.peer.closed()=>return None,
            ()=call.generation.cancelled()=>return None,
            answer=outlet.review(root, params, timeout + TRANSPORT_SLACK)=>answer,
        };
        Some(match answer {
            Ok(result) => read_result(result),
            Err(ReviewTrouble::HostDown(why)) => {
                Attempt::failed("unavailable", ReviewFallback::Unavailable, Some(why))
            }
            Err(ReviewTrouble::Timeout) => {
                Attempt::failed("timeout", ReviewFallback::Timeout, None)
            }
            Err(ReviewTrouble::Failed(why)) => {
                Attempt::failed("providerError", ReviewFallback::ProviderError, Some(why))
            }
        })
    }

    /// The session's surroundings as the reviewer reads them.
    fn environment(
        &self,
        s: &SessionIo,
        settings: &Settings,
        p: &PolicyEvaluateParams,
    ) -> ReviewEnvironment {
        let home = self.config.home.clone().or_else(std::env::home_dir);
        let shown = |path: &Path| -> String {
            let text = display(path);
            match home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
                Some(rest) if rest.as_os_str().is_empty() => "~".into(),
                Some(rest) => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
                None => text,
            }
        };
        let sandboxed = (p.tool == "Bash" || p.tool == "Monitor")
            && self
                .sandbox_with(s, Some(settings))
                .for_call(&p.tool, &p.input)
                .sandboxed;
        ReviewEnvironment {
            platform: match std::env::consts::OS {
                "macos" => "macos",
                "windows" => "windows",
                _ => "linux",
            }
            .into(),
            workspace: shown(s.project()),
            cwd: shown(&lock(&s.shell_cwd).clone()),
            remotes: s.remotes.clone(),
            sandboxed,
            agent_type: s.subagent.as_ref().map(|link| link.agent_type.clone()),
        }
    }

    /// Keeps what the attempt said about the reviewer for the session list.
    fn remember_availability(&self, call: &Call<'_>, outcome: &Attempt) {
        let reason = match (
            outcome.fallback,
            outcome.result.as_ref().and_then(|r| r.failure),
        ) {
            (_, Some(ReviewFailure::UnknownModel)) => Some(AutoReviewReason::UnknownModel),
            (_, Some(ReviewFailure::BelowBar)) => Some(AutoReviewReason::BelowBar),
            (Some(ReviewFallback::Unavailable), None) if outcome.result.is_none() => {
                Some(AutoReviewReason::HostDown)
            }
            _ => None,
        };
        let root = super::super::subagents::rule_owner(call.s);
        let changed = {
            let mut state = lock(&root.policy);
            let changed = state.auto.unavailable != reason;
            state.auto.unavailable = reason;
            changed
        };
        if changed {
            publish_root(call);
        }
    }

    /// The audit row of one review.
    async fn audit_review(
        &self,
        call: &Call<'_>,
        outcome: &Attempt,
        model: Option<&str>,
        duration: Duration,
        denials: Option<piarc_policy::review::DenialCount>,
    ) -> Result<(), ErrorObject> {
        let p = call.p;
        let checked = outcome.checked.as_ref();
        let conclusion = match checked.map(|c| c.verdict) {
            _ if outcome.name == "discarded" || outcome.name == "cancelled" => "ask",
            Some(Verdict::Allow) => "allow",
            Some(Verdict::Deny) => "deny",
            _ => "ask",
        };
        let reason = checked
            .map(|c| c.reason.clone())
            .or_else(|| outcome.message.as_deref().map(rules::clean_reason));
        let result = outcome.result.as_ref();
        let usage = result.map(|r| r.usage).unwrap_or_default();
        let mut detail = json!({
            "tool": p.tool, "toolCallId": p.tool_call_id, "arguments": argument_summary(p),
            "model": model, "outcome": outcome.name, "conclusion": conclusion,
            "reason": reason, "category": checked.and_then(|c| c.category.clone()),
            "durationMs": u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
            "tokens": {"input": usage.input, "output": usage.output,
                "cacheRead": usage.cache_read, "cacheWrite": usage.cache_write},
            "inputHash": result.map(|r| r.input_hash.as_str()).filter(|h| !h.is_empty()),
            "inputChars": result.map(|r| r.input_chars),
            "promptId": result.map(|r| r.prompt_id.as_str()).filter(|h| !h.is_empty()),
            "source": "reviewer",
        });
        if let Some(count) = denials {
            detail["denials"] = json!({"consecutive": count.consecutive, "total": count.total,
                "paused": count.paused.map(Pause::name)});
        }
        super::super::subagents::annotate(&mut detail, call.s);
        call.services
            .record("autoReview", &p.session_id, call.s.project(), &detail)
            .await
    }
}

/// Puts the card in the ledger marked `reviewing` and stops the Agent Host's deadline; `None`
/// when the connection is gone.
async fn post_reviewing(
    call: &Call<'_>,
    card: &ApprovalRequest,
    model: Option<String>,
) -> Result<Option<(ApprovalRequest, oneshot::Receiver<waits::Answered>)>, ErrorObject> {
    let (tx, rx) = oneshot::channel();
    let mut card = card.clone();
    card.review = Some(ApprovalReview {
        state: ReviewState::Reviewing,
        fallback: None,
        reason: None,
        model,
    });
    let posted = waits::post_card(
        call.s,
        call.services,
        &call.p.tool_call_id,
        &card,
        call.peer,
        call.generation,
        tx,
    )
    .await?;
    Ok(posted.then_some((card, rx)))
}

/// Sends the main session's snapshot: its Auto mode status lives there.
fn publish_root(call: &Call<'_>) {
    let root = super::super::subagents::rule_owner(call.s);
    let id = call
        .s
        .subagent
        .as_ref()
        .map_or(call.p.session_id.as_str(), |link| link.root_id.as_str());
    lock(&root.policy).publish(id, call.services);
}

/// Reads the Agent Host's answer.
fn read_result(result: PolicyReviewResult) -> Attempt {
    let failure = |name, fallback| Attempt {
        name,
        checked: None,
        fallback: Some(fallback),
        message: result.message.clone(),
        result: Some(result.clone()),
    };
    if let Some(kind) = result.failure {
        return match kind {
            ReviewFailure::Timeout => failure("timeout", ReviewFallback::Timeout),
            ReviewFailure::ProviderError => failure("providerError", ReviewFallback::ProviderError),
            ReviewFailure::Unparsable => failure("unparsable", ReviewFallback::Unparsable),
            ReviewFailure::UnknownModel | ReviewFailure::BelowBar => {
                failure("unavailable", ReviewFallback::Unavailable)
            }
            ReviewFailure::Cancelled => failure("cancelled", ReviewFallback::Discarded),
        };
    }
    let Some(answer) = &result.answer else {
        return failure("unparsable", ReviewFallback::Unparsable);
    };
    match rules::check_answer(answer) {
        Ok(checked) => Attempt {
            name: match checked.verdict {
                Verdict::Allow => "allow",
                Verdict::Deny => "deny",
                Verdict::Unsure => "unsure",
            },
            fallback: (checked.verdict == Verdict::Unsure).then_some(ReviewFallback::Unsure),
            checked: Some(checked),
            message: None,
            result: Some(result),
        },
        Err(ReviewFallback::InvalidVerdict) => {
            failure("invalidVerdict", ReviewFallback::InvalidVerdict)
        }
        Err(other) => failure("unparsable", other),
    }
}

/// Why the call would ask the user, as the reviewer reads it.
fn why(p: &PolicyEvaluateParams) -> String {
    match p.tool.as_str() {
        "Bash" | "PowerShell" | "Monitor" => {
            "The command is not read-only and no allow rule covers it.".into()
        }
        "WebFetch" => "No allow rule covers the domain.".into(),
        tool if tool.starts_with("mcp__") => "No allow rule covers this MCP tool.".into(),
        _ => "No allow rule or mode default covers this call.".into(),
    }
}
