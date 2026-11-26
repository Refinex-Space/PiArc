//! Files of the agent's browser (ADR-0089, design addendum B2.6.6). A page's file input only
//! ever gets copies Core staged after deciding the read, and a finished download leaves the
//! session's temporary directory only through Core's write decision.
//!
//! - Upload: each path is located like a Read: inside the session's directories it is copied
//!   through the session scope (a handle read, ADR-0036), elsewhere the user is asked (every
//!   mode but `bypassPermissions`); a `Read(…)` deny rule refuses. Copies go to
//!   `<session tmp>/browser/uploads/<call>/<n>/<name>` (a new `<n>` for every file, so a later
//!   upload of the same name never replaces a copy the page may still read), keeping the name.
//! - Save: the source must be a finished download in `<session tmp>/browser/downloads/`; the
//!   target is decided like a Write: `plan` refuses, manual mode asks, accept-edits and Auto
//!   and bypass allow inside the workspace; outside the workspace or on a protected path the
//!   user is asked (bypass allows outside, never a protected path); an `Edit(…)` deny rule
//!   refuses; an existing file is never replaced.
//!
//! Cards belong to the running `Browser` call and go away with it; each decision writes one
//! `kind: "browser"` audit row (paths, no contents).

use std::path::{Path, PathBuf};
use std::time::Duration;

use piarc_fs::{Access, Scope};
use piarc_policy::rules::{Behavior, Certainty, Subject};
use piarc_protocol::policy::{ApprovalDecision, ApprovalKind, ApprovalRequest, PermissionMode};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::super::{SessionIo, ToolIo, lock, subagents};
use piarc_policy::paths::posix;

use super::assess::{Places, read_denied};
use super::waits::{post_local_card, withdraw_local_card};
use super::{Services, denied, rules_of, session_settings};

/// Files one upload may stage.
pub const MAX_UPLOAD_FILES: usize = 20;
/// The largest file an upload copies.
pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// Staged copies one call may make in all (each in its own directory).
const MAX_STAGED_DIRS: usize = 1_000;
/// The card tools: no tool call asks, a page of the agent's `Browser` call does.
pub const UPLOAD_TOOL: &str = "BrowserUpload";
pub const SAVE_TOOL: &str = "BrowserSave";

/// What a path needs before the browser may use it.
enum Need {
    Free(PathBuf),
    Ask { path: PathBuf, protected: bool },
}

fn decide(scope: &Scope, requested: &str, access: Access) -> Result<Need, ErrorObject> {
    match scope.check(requested, access) {
        Ok(path) => Ok(Need::Free(path)),
        Err(piarc_fs::Error::NeedsApproval { reason, .. }) => {
            let path = scope.locate(requested).map_err(|e| e.to_error_object())?;
            let protected = matches!(reason, piarc_fs::ApprovalReason::ProtectedPath { .. });
            Ok(Need::Ask { path, protected })
        }
        Err(other) => Err(other.to_error_object()),
    }
}

fn edit_denied(rules: &piarc_policy::rules::RuleSet, places: &Places, path: &Path) -> bool {
    let paths = [posix(path)];
    matches!(
        rules.find(
            Behavior::Deny,
            "Edit",
            Subject::Paths(&paths),
            Some(&places.context())
        ),
        Some((_, Certainty::Certain))
    )
}

fn base_name(path: &Path) -> Result<String, ErrorObject> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid("The path does not name a file."))
}

fn invalid(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorKind::InvalidParams, message, false)
}

fn internal(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(ErrorKind::InternalError, error.to_string(), false)
}

impl ToolIo {
    /// The directory the main process saves the downloads of a session's agent tabs to.
    ///
    /// # Errors
    /// `sessionNotFound` for an unknown session.
    pub fn browser_downloads_dir(&self, session_id: &str) -> Result<PathBuf, ErrorObject> {
        let s = self.session(session_id)?;
        Ok(s.tmp_dir.join("browser").join("downloads"))
    }

    /// Whether a `Read(…)` deny rule covers `relative` (a path under the session's files root)
    /// for the built-in browser (B1.6, THR-16). The workspace file scheme cannot tell the page
    /// that asks, and the agent's pages share the session's origin with the user's, so every
    /// page is held to the session's rules. A session that is not open has none to apply: no
    /// agent drives its pages.
    ///
    /// # Errors
    /// The settings cannot be read, or the path cannot be located.
    pub async fn browser_read_denied(
        &self,
        session_id: &str,
        relative: &str,
    ) -> Result<bool, ErrorObject> {
        let Ok(s) = self.session(session_id) else {
            return Ok(false);
        };
        let services = self.services()?;
        let settings = session_settings(services, &s).await?;
        let rules = rules_of(&s, &settings);
        let places = Places::new(&s.scope);
        let path = s
            .scope
            .project_root()
            .locate(relative)
            .map_err(|e| e.to_error_object())?;
        Ok(read_denied(&rules, &places, &path))
    }

    /// Copies `paths` for an upload of the running `Browser` call `call`; answers the copies.
    pub(crate) async fn stage_browser_upload(
        &self,
        session_id: &str,
        call: &str,
        paths: &[String],
        timeout: Duration,
    ) -> Result<Vec<String>, ErrorObject> {
        if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
            return Err(invalid("An upload names 1 to 20 files."));
        }
        let s = self.session(session_id)?;
        let run = running(&s, call)?;
        let services = self.services()?;
        let settings = session_settings(services, &s).await?;
        let rules = rules_of(&s, &settings);
        let places = Places::new(&s.scope);
        let mode = subagents::current_mode(&s);
        let staging = s.tmp_dir.join("browser").join("uploads").join(call);
        let mut staged = Vec::with_capacity(paths.len());
        for requested in paths {
            let need = decide(&s.scope, requested, Access::Read)?;
            let path = match &need {
                Need::Free(path) | Need::Ask { path, .. } => path.clone(),
            };
            if read_denied(&rules, &places, &path) {
                return Err(denied(format!(
                    "Reading {} is denied by a permission rule.",
                    piarc_fs::display(&path)
                )));
            }
            let free = matches!(need, Need::Free(_)) || mode == PermissionMode::BypassPermissions;
            let allowed = free
                || ask_file(
                    &s,
                    services,
                    session_id,
                    UPLOAD_TOOL,
                    &path,
                    false,
                    &run,
                    timeout,
                )
                .await;
            record(services, &s, session_id, call, "upload", &path, allowed).await?;
            if !allowed {
                return Err(denied(format!(
                    "The user did not let the page upload {}.",
                    piarc_fs::display(&path)
                )));
            }
            // A directory no earlier staging of this call used: copies the page may still read
            // are never replaced by a later file of the same name.
            let dest = fresh_dir(&staging)?;
            staged.push(copy_in(&s.scope, requested, &path, &dest, free_inside(&need)).await?);
        }
        Ok(staged)
    }

    /// Saves the finished download `source` of the running `Browser` call `call` to `target`.
    pub(crate) async fn save_browser_download(
        &self,
        session_id: &str,
        call: &str,
        source: &str,
        target: &str,
        timeout: Duration,
    ) -> Result<String, ErrorObject> {
        let s = self.session(session_id)?;
        let run = running(&s, call)?;
        let downloads = s.tmp_dir.join("browser").join("downloads");
        let from = std::fs::canonicalize(source).map_err(|_| invalid("No such download."))?;
        let root = std::fs::canonicalize(&downloads).map_err(|_| invalid("No such download."))?;
        if !from.starts_with(&root) || !from.is_file() {
            return Err(invalid(
                "Only a finished download of this session can be saved.",
            ));
        }
        let services = self.services()?;
        let settings = session_settings(services, &s).await?;
        let rules = rules_of(&s, &settings);
        let places = Places::new(&s.scope);
        let mode = subagents::current_mode(&s);
        let need = decide(&s.scope, target, Access::Write)?;
        let (path, inside, protected) = match need {
            Need::Free(path) => (path, true, false),
            Need::Ask { path, protected } => (path, false, protected),
        };
        if edit_denied(&rules, &places, &path) {
            return Err(denied(format!(
                "Writing {} is denied by a permission rule.",
                piarc_fs::display(&path)
            )));
        }
        if path.exists() {
            return Err(invalid(
                "A file already exists there; save the download under a new name.",
            ));
        }
        let allowed = match mode {
            PermissionMode::Plan => false,
            PermissionMode::BypassPermissions if !protected => true,
            PermissionMode::AcceptEdits | PermissionMode::Auto if inside => true,
            _ => {
                ask_file(
                    &s, services, session_id, SAVE_TOOL, &path, protected, &run, timeout,
                )
                .await
            }
        };
        record(services, &s, session_id, call, "save", &path, allowed).await?;
        if !allowed {
            return Err(denied(format!(
                "Saving to {} was not allowed.",
                piarc_fs::display(&path)
            )));
        }
        let to = path.clone();
        tokio::task::spawn_blocking(move || place(&from, &to))
            .await
            .map_err(internal)??;
        Ok(piarc_fs::display(&path))
    }
}

fn free_inside(need: &Need) -> bool {
    matches!(need, Need::Free(_))
}

/// The cancellation token of the running `Browser` call `call`.
fn running(s: &SessionIo, call: &str) -> Result<CancellationToken, ErrorObject> {
    lock(&s.running)
        .get(&format!("browser:{call}"))
        .cloned()
        .ok_or_else(|| denied("The browser call has ended."))
}

/// Copies one approved file into the staging directory `dest`, keeping its name.
async fn copy_in(
    scope: &Scope,
    requested: &str,
    path: &Path,
    dest: &Path,
    through_scope: bool,
) -> Result<String, ErrorObject> {
    let name = base_name(path)?;
    let size = std::fs::metadata(path)
        .map_err(|e| invalid(&format!("Cannot read the file: {e}")))?
        .len();
    if size > MAX_UPLOAD_BYTES {
        return Err(invalid("The file is larger than 100 MiB."));
    }
    let scope = scope.clone();
    let requested = requested.to_owned();
    let path = path.to_owned();
    let dest = dest.to_owned();
    tokio::task::spawn_blocking(move || -> Result<String, ErrorObject> {
        std::fs::create_dir_all(&dest).map_err(internal)?;
        let target = dest.join(&name);
        if through_scope {
            // A handle read through the session scope (ADR-0036), then the page's file name.
            let blob = piarc_fs::read_blob(&scope, &requested, &dest)
                .map_err(|e| e.to_error_object())?
                .blob
                .ok_or_else(|| internal("no blob"))?;
            std::fs::rename(&blob.path, &target).map_err(internal)?;
        } else {
            std::fs::copy(&path, &target).map_err(internal)?;
        }
        Ok(piarc_fs::display(&target))
    })
    .await
    .map_err(internal)?
}

/// A new empty directory under `parent` (`0`, `1`, … : the first one nobody created yet).
fn fresh_dir(parent: &Path) -> Result<PathBuf, ErrorObject> {
    std::fs::create_dir_all(parent).map_err(internal)?;
    for n in 0..MAX_STAGED_DIRS {
        let dir = parent.join(n.to_string());
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(internal(e)),
        }
    }
    Err(invalid("This call staged too many files."))
}

/// Copies `from` to the new file `to` through a temporary name beside it.
fn place(from: &Path, to: &Path) -> Result<(), ErrorObject> {
    let parent = to
        .parent()
        .ok_or_else(|| invalid("The target has no folder."))?;
    std::fs::create_dir_all(parent).map_err(internal)?;
    let partial = parent.join(format!(".piarc-download-{}.partial", std::process::id()));
    std::fs::copy(from, &partial).map_err(internal)?;
    if to.exists() {
        let _ = std::fs::remove_file(&partial);
        return Err(invalid(
            "A file already exists there; save the download under a new name.",
        ));
    }
    std::fs::rename(&partial, to).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        internal(e)
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "one file card's inputs, borrowed from the caller"
)]
async fn ask_file(
    s: &SessionIo,
    services: &Services,
    session_id: &str,
    tool: &str,
    path: &Path,
    protected: bool,
    run: &CancellationToken,
    timeout: Duration,
) -> bool {
    let Ok(request_id) = crate::sessions::new_session_id() else {
        return false;
    };
    let card = ApprovalRequest {
        elicitation: None,
        request_id,
        session_id: session_id.to_owned(),
        revision: 1,
        connection_epoch: 0,
        tool: tool.to_owned(),
        kind: ApprovalKind::PermissionExpansion,
        command: None,
        cwd: None,
        path: Some(piarc_fs::display(path)),
        diff: None,
        rules: Vec::new(),
        directory: None,
        protected_path: protected.then_some(true),
        plan: None,
        questions: Vec::new(),
        subagent: None,
        sandbox: None,
        domain: None,
        site: None,
        notification_allow: false,
        review: None,
    };
    let (tx, rx) = oneshot::channel();
    if !post_local_card(s, services, &card, tx) {
        return false;
    }
    let answered = tokio::select! {
        answer = tokio::time::timeout(timeout, rx) => answer.ok().and_then(Result::ok),
        () = run.cancelled() => None,
    };
    match answered {
        Some((answer, ack)) => {
            let _ = ack.send(Ok(()));
            answer.decision != ApprovalDecision::Deny
        }
        None => {
            withdraw_local_card(s, services, &card);
            false
        }
    }
}

async fn record(
    services: &Services,
    s: &SessionIo,
    session_id: &str,
    call: &str,
    what: &str,
    path: &Path,
    allowed: bool,
) -> Result<(), ErrorObject> {
    let detail = json!({
        "approval": what,
        "tool": "Browser",
        "toolCallId": call,
        "path": piarc_fs::display(path),
        "conclusion": if allowed { "allow" } else { "deny" },
    });
    services
        .record("browser", session_id, s.project(), &detail)
        .await
}
