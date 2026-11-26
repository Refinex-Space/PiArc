//! Site cards (ADR-0089, design addendum `docs/architecture/addenda/browser.md` B2.6.3): a page
//! the agent's `Browser` script drives asks to reach a host the session has not allowed, and
//! the desktop client's request gate asks Core.
//!
//! In order: the session's allowed hosts (a subagent's are its main session's) → allow for
//! the session; a `Browser(domain:…)` deny rule on any of the hosts → refuse; an ask rule →
//! the card; an allow rule covering every host → allow for the run (not for a sensitive host:
//! a private address or a site with imported sign-ins); the mode: `bypassPermissions` allows
//! for the run (not a sensitive host), `plan` allows local addresses and refuses the rest;
//! otherwise the card. The card lists every host the run is waiting on:
//!
//! - "Allow once" covers the rest of this run, "Allow for this session" the session;
//! - "Always allow" saves `Browser(domain:…)` in the user's settings (after the main process's
//!   native confirmation), offered only for sites that are neither local nor sensitive;
//! - "Deny", the run ending (interrupt, timeout) or no answer within the timeout refuse.
//!
//! No hook answers a site card and Auto mode's reviewer does not see it: the reviewer judges
//! tool calls, and a site visit is part of a call already allowed. Every decision that is not
//! a remembered grant writes one `kind: "browser"` audit row.

use std::time::Duration;

use piarc_policy::rules::{Behavior, Certainty, RuleSet, Subject};
use piarc_protocol::browser::{
    BrowserSiteCard, BrowserSiteDecision, BrowserSiteRequest, BrowserSiteScope,
};
use piarc_protocol::policy::{
    ApprovalDecision, ApprovalKind, ApprovalRequest, BROWSER_SITE_TOOL, PermissionMode,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::super::{SessionIo, ToolIo, lock, subagents};
use super::waits::{post_local_card, withdraw_local_card};
use super::{Services, denied, rules_of, session_settings};

/// Hosts one card may list.
const MAX_HOSTS: usize = 20;
/// The user settings key with the agent's allowed sites.
const ALLOW_POINTER: &str = "/permissions/allow";

fn allowed(scope: BrowserSiteScope) -> BrowserSiteDecision {
    BrowserSiteDecision {
        allowed: true,
        scope: Some(scope),
    }
}

fn refused() -> BrowserSiteDecision {
    BrowserSiteDecision {
        allowed: false,
        scope: None,
    }
}

/// The host a rule matches: a local address's port is not part of it.
fn rule_host(host: &str, local: bool) -> &str {
    if local {
        host.rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
            .map_or(host, |(name, _)| name)
    } else {
        host
    }
}

/// The card's hosts: the one asked about first, then the run's other waiting hosts.
fn hosts_of(request: &BrowserSiteRequest) -> Vec<String> {
    let mut hosts = vec![request.host.trim().to_ascii_lowercase()];
    for host in &request.pending {
        let host = host.trim().to_ascii_lowercase();
        if !host.is_empty() && !hosts.contains(&host) && hosts.len() < MAX_HOSTS {
            hosts.push(host);
        }
    }
    hosts
}

/// What the rules say about every host: a deny on any, an ask on any, or an allow on all.
fn rules_say(rules: &RuleSet, hosts: &[String], local: bool) -> Option<Behavior> {
    let hit = |behavior: Behavior, host: &str| {
        rules
            .find(
                behavior,
                "Browser",
                Subject::Domain(rule_host(host, local)),
                None,
            )
            .is_some_and(|(_, certainty)| certainty == Certainty::Certain)
    };
    if hosts.iter().any(|h| hit(Behavior::Deny, h)) {
        Some(Behavior::Deny)
    } else if hosts.iter().any(|h| hit(Behavior::Ask, h)) {
        Some(Behavior::Ask)
    } else if hosts.iter().all(|h| hit(Behavior::Allow, h)) {
        Some(Behavior::Allow)
    } else {
        None
    }
}

impl ToolIo {
    /// Whether a page of the running `Browser` call may reach `request.host` (and the run's
    /// other waiting hosts). `timeout` bounds the wait for the user's answer.
    pub(crate) async fn decide_site(
        &self,
        request: &BrowserSiteRequest,
        timeout: Duration,
    ) -> Result<BrowserSiteDecision, ErrorObject> {
        let s = self.session(&request.session_id.0)?;
        // The card belongs to a running call: no run, no question.
        let key = format!("browser:{}", request.tool_call_id);
        let Some(run) = lock(&s.running).get(&key).cloned() else {
            return Ok(refused());
        };
        let hosts = hosts_of(request);
        let owner = subagents::rule_owner(&s);
        {
            let granted = lock(&owner.browser_hosts);
            if hosts.iter().all(|h| granted.contains(h)) {
                return Ok(allowed(BrowserSiteScope::Session));
            }
        }
        let services = self.services()?;
        let settings = session_settings(services, &s).await?;
        let rules = rules_of(&s, &settings);
        let said = rules_say(&rules, &hosts, request.local);
        let mode = subagents::current_mode(&s);
        let quick = match said {
            Some(Behavior::Deny) => Some((false, "denyRule")),
            Some(Behavior::Ask) => None,
            Some(Behavior::Allow) if !request.sensitive => Some((true, "allowRule")),
            _ => match mode {
                PermissionMode::BypassPermissions if !request.sensitive => Some((true, "mode")),
                PermissionMode::Plan => Some((request.local, "mode")),
                _ => None,
            },
        };
        if let Some((allow, step)) = quick {
            let detail = site_detail(request, &hosts, step, allow);
            services
                .record("browser", &request.session_id.0, s.project(), &detail)
                .await?;
            return Ok(if allow {
                allowed(BrowserSiteScope::Run)
            } else {
                refused()
            });
        }
        let card = site_card(request, &hosts);
        self.ask_site(&s, services, request, &hosts, card, &run, timeout)
            .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one card's inputs, all borrowed from decide_site"
    )]
    async fn ask_site(
        &self,
        s: &SessionIo,
        services: &Services,
        request: &BrowserSiteRequest,
        hosts: &[String],
        card: ApprovalRequest,
        run: &CancellationToken,
        timeout: Duration,
    ) -> Result<BrowserSiteDecision, ErrorObject> {
        let (tx, rx) = oneshot::channel();
        if !post_local_card(s, services, &card, tx) {
            return Ok(refused());
        }
        let answered = tokio::select! {
            answer = tokio::time::timeout(timeout, rx) => answer.ok().and_then(Result::ok),
            () = run.cancelled() => None,
        };
        let Some((answer, ack)) = answered else {
            withdraw_local_card(s, services, &card);
            let detail = site_detail(request, hosts, "timeout", false);
            services
                .record("browser", &request.session_id.0, s.project(), &detail)
                .await?;
            return Ok(refused());
        };
        let owner = subagents::rule_owner(s);
        let decision = match answer.decision {
            ApprovalDecision::Deny => refused(),
            ApprovalDecision::AllowOnce => allowed(BrowserSiteScope::Run),
            ApprovalDecision::AllowSession | ApprovalDecision::AllowAlways => {
                let mut granted = lock(&owner.browser_hosts);
                for host in hosts {
                    if !granted.contains(host) {
                        granted.push(host.clone());
                    }
                }
                allowed(BrowserSiteScope::Session)
            }
        };
        let saved = if answer.decision == ApprovalDecision::AllowAlways {
            save_rules(services, s, &card.rules).await
        } else {
            Ok(())
        };
        // The answering window hears whether saving worked; the page goes ahead either way.
        let _ = ack.send(saved);
        let mut detail = site_detail(request, hosts, "card", decision.allowed);
        detail["decision"] = json!(decision_name(answer.decision));
        services
            .record("browser", &request.session_id.0, s.project(), &detail)
            .await?;
        Ok(decision)
    }
}

/// The card for `hosts`: "always" (its rules) only for public, non-sensitive sites.
fn site_card(request: &BrowserSiteRequest, hosts: &[String]) -> ApprovalRequest {
    let rules = if request.local || request.sensitive {
        Vec::new()
    } else {
        hosts
            .iter()
            .map(|host| format!("Browser(domain:{host})"))
            .filter(|rule| piarc_policy::rules::parse(rule, Behavior::Allow).is_ok())
            .collect()
    };
    ApprovalRequest {
        elicitation: None,
        // A fresh id per card; the session id generator gives unique values.
        request_id: crate::sessions::new_session_id()
            .unwrap_or_else(|_| format!("site-{}-{}", request.tool_call_id, hosts.len())),
        session_id: request.session_id.0.clone(),
        revision: 1,
        connection_epoch: 0,
        tool: BROWSER_SITE_TOOL.to_owned(),
        kind: ApprovalKind::PermissionExpansion,
        command: None,
        cwd: None,
        path: None,
        diff: None,
        rules,
        directory: None,
        protected_path: None,
        plan: None,
        questions: Vec::new(),
        subagent: None,
        sandbox: None,
        domain: hosts.first().cloned(),
        site: Some(BrowserSiteCard {
            url: request.url.clone(),
            hosts: hosts.iter().skip(1).cloned().collect(),
        }),
        notification_allow: false,
        review: None,
    }
}

/// Appends the card's rules to the user's `permissions.allow`.
async fn save_rules(
    services: &Services,
    s: &SessionIo,
    rules: &[String],
) -> Result<(), ErrorObject> {
    if rules.is_empty() {
        return Err(denied("This site cannot be allowed permanently."));
    }
    let table = services.storage.dirs().layers(s.project());
    let rules = rules.to_vec();
    tokio::task::spawn_blocking(move || {
        for rule in &rules {
            piarc_config::append_unique(&table, piarc_config::ids::USER, ALLOW_POINTER, rule)
                .map_err(|e| denied(e.to_string()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?
}

fn site_detail(request: &BrowserSiteRequest, hosts: &[String], step: &str, allow: bool) -> Value {
    json!({
        "approval": "site",
        "tool": "Browser",
        "toolCallId": request.tool_call_id,
        "hosts": hosts,
        "local": request.local,
        "sensitive": request.sensitive,
        "step": step,
        "conclusion": if allow { "allow" } else { "deny" },
    })
}

fn decision_name(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::AllowOnce => "allowOnce",
        ApprovalDecision::AllowSession => "allowSession",
        ApprovalDecision::AllowAlways => "allowAlways",
        ApprovalDecision::Deny => "deny",
    }
}
