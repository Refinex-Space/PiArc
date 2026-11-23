//! A grant is tied to one tool invocation, its effective path, input and connection. Each
//! side effect consumes the corresponding operation. Only text transfers span several frames.
use piarc_protocol::exec::{ExecRunParams, ExecShell};
use serde_json::Map;

use super::*;

pub(in crate::tool_io) struct Grant {
    pub(super) tool: String,
    /// Cleared with the MCP grant, waking any nested form or hook still waiting on that call.
    pub(super) elicitation: Option<super::elicitation::Interactions>,
    /// The tool call: a `NotebookEdit`'s new cell id derives from it (T42).
    call: String,
    pub(super) path: Option<PathBuf>,
    pub(super) binding: Option<piarc_fs::DirectoryBinding>,
    pub(super) cwd: Option<PathBuf>,
    pub(super) command: Option<String>,
    /// The scope the preflight judged in (with configured directories).
    pub(super) scope: Option<Scope>,
    /// Programs an automatic Bash allowance relies on, pinned at execution.
    pub(super) programs: Vec<(String, PathBuf)>,
    /// Paths an automatic Bash allowance checked; checked again at execution.
    pub(super) targets: Vec<(PathBuf, bool)>,
    /// The command runs in the sandbox (T39): decided when the call was judged, so a call
    /// approved for running sandboxed never runs outside it.
    pub(super) sandboxed: bool,
    input: Map<String, Value>,
    peer: Peer,
    made_parent: bool,
    stat_paths: Vec<PathBuf>,
    last_read: Option<u64>,
    upload: Option<String>,
}

impl Grant {
    pub(super) fn new(p: &PolicyEvaluateParams, peer: Peer) -> Self {
        Self {
            tool: p.tool.clone(),
            elicitation: p
                .tool
                .starts_with("mcp__")
                .then(super::elicitation::Interactions::default),
            call: p.tool_call_id.clone(),
            path: None,
            binding: None,
            cwd: None,
            command: None,
            scope: None,
            programs: Vec::new(),
            targets: Vec::new(),
            sandboxed: false,
            input: p.input.clone(),
            peer,
            made_parent: false,
            stat_paths: Vec::new(),
            last_read: None,
            upload: None,
        }
    }

    pub(in crate::tool_io) fn matches_write(&self, original: Option<&str>, text: &str) -> bool {
        match self.tool.as_str() {
            "Write" => self.input.get("content").and_then(Value::as_str) == Some(text),
            "Edit" => original
                .zip(self.input.get("edits").and_then(Value::as_array))
                .is_some_and(|(old, edits)| {
                    super::edit::proposed(
                        old,
                        edits,
                        self.input.get("replaceAll").and_then(Value::as_bool) == Some(true),
                    )
                    .as_deref()
                        == Some(text)
                }),
            "NotebookEdit" => original.is_some_and(|old| {
                super::notebook::proposed(old, &self.input, &self.call).as_deref() == Ok(text)
            }),
            _ => false,
        }
    }

    fn accept_write_part(&mut self, params: &Map<String, Value>) -> Result<bool, ErrorObject> {
        let actual = params
            .get("lineEndings")
            .and_then(Value::as_str)
            .unwrap_or("asWritten");
        let required = if matches!(self.tool.as_str(), "Edit" | "NotebookEdit") {
            "asWritten"
        } else {
            "matchFile"
        };
        if actual != required || params.get("append").and_then(Value::as_bool) == Some(true) {
            return Err(mismatch());
        }
        let upload = params.get("upload");
        let id = upload.and_then(|u| u["id"].as_str());
        if self.upload.as_deref().is_some_and(|old| Some(old) != id) {
            return Err(mismatch());
        }
        self.upload = id.map(str::to_owned);
        Ok(upload.is_none_or(|u| u["last"].as_bool() == Some(true)))
    }

    pub(super) fn belongs(&self, tool: &str, peer: &Peer) -> bool {
        self.tool == tool && !peer.is_closed() && self.peer.same_connection(peer)
    }

    fn file_op(
        &mut self,
        s: &SessionIo,
        method: &str,
        params: &Map<String, Value>,
        target: &Path,
    ) -> Result<bool, ErrorObject> {
        let p = &self.input;
        match (method, self.tool.as_str()) {
            ("fs/mkdir", "Write")
                if !self.made_parent
                    && self.path.as_deref().and_then(Path::parent) == Some(target) =>
            {
                self.made_parent = true;
                return Ok(false);
            }
            ("fs/stat", "Read") if self.path.as_deref() != Some(target) => {
                let raw = params
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let original = self.path.as_deref().ok_or_else(mismatch)?;
                let fallback = p
                    .get("readPathCandidates")
                    .and_then(Value::as_array)
                    .is_some_and(|list| list.iter().take(5).any(|v| v.as_str() == Some(raw)));
                if !fallback
                    || self.stat_paths.iter().any(|p| p.exists())
                    || original.exists()
                    || original.parent() != target.parent()
                    || !original.starts_with(s.scope.root())
                    || !target.starts_with(s.scope.root())
                {
                    return Err(mismatch());
                }
                if target.exists() {
                    self.path = Some(target.to_path_buf());
                }
            }
            _ if self.path.as_deref() != Some(target) => return Err(mismatch()),
            _ => {}
        }
        let terminal = match (method, self.tool.as_str()) {
            ("fs/stat", "Read")
                if params.get("completeRead") == Some(&Value::Bool(true))
                    && self.stat_paths.iter().any(|p| p == target)
                    && self.last_read.is_some() =>
            {
                true
            }
            ("fs/stat", "Read" | "Glob" | "Edit")
                if !self.stat_paths.iter().any(|p| p == target)
                    && (self.tool == "Read"
                        || !params.contains_key("read") && !params.contains_key("detectImage")) =>
            {
                self.stat_paths.push(target.to_path_buf());
                false
            }
            ("fs/read", "Read" | "Edit" | "NotebookEdit") => {
                let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
                let blob = params.get("mode").and_then(Value::as_str) == Some("blob");
                if self.last_read.is_some_and(|prior| offset <= prior)
                    || (matches!(self.tool.as_str(), "Edit" | "NotebookEdit")
                        && (blob
                            || offset == 0
                                && params.get("requireFresh").and_then(Value::as_bool)
                                    != Some(true)))
                {
                    return Err(mismatch());
                }
                self.last_read = Some(if blob { u64::MAX } else { offset });
                blob && matches!(self.tool.as_str(), "Edit" | "NotebookEdit")
            }
            ("fs/pdf", "Read")
                if params.get("pages") == p.get("pages") && self.last_read.is_none() =>
            {
                self.last_read = Some(u64::MAX);
                false
            }
            ("fs/glob", "Glob") if glob_matches(p, params) => true,
            ("fs/grep", "Grep") if grep_matches(p, params) => true,
            ("fs/write", "Write" | "Edit" | "NotebookEdit") => self.accept_write_part(params)?,
            _ => return Err(mismatch()),
        };
        Ok(terminal)
    }
}

fn glob_matches(input: &Map<String, Value>, wire: &Map<String, Value>) -> bool {
    let ignore = wire.get("exclude").and_then(Value::as_array);
    let expected_limit = input
        .get("limit")
        .and_then(Value::as_f64)
        .unwrap_or(1000.)
        .floor()
        .max(1.)
        + 1.;
    input.get("pattern") == wire.get("pattern")
        && wire.get("limit").and_then(Value::as_f64) == Some(expected_limit)
        && ignore.is_some_and(|list| {
            list.len() == 2 && list[0] == "**/node_modules/**" && list[1] == "**/.git/**"
        })
}

fn grep_matches(input: &Map<String, Value>, wire: &Map<String, Value>) -> bool {
    let glob = input.get("glob").and_then(Value::as_str).map(|g| {
        let (prefix, text) = g.strip_prefix('!').map_or(("", g), |s| ("!", s));
        format!("{prefix}{}", text.trim_start_matches("./"))
    });
    let flag = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
    input.get("pattern") == wire.get("pattern")
        && glob.as_deref() == wire.get("glob").and_then(Value::as_str)
        && flag(input, "ignoreCase") == flag(wire, "ignoreCase")
        && flag(input, "literal") == flag(wire, "literal")
        && wire.get("limit").and_then(Value::as_f64)
            == Some(
                input
                    .get("limit")
                    .and_then(Value::as_f64)
                    .unwrap_or(100.)
                    .floor()
                    .max(1.),
            )
        && wire.get("context").and_then(Value::as_f64)
            == Some(
                input
                    .get("context")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.)
                    .floor()
                    .clamp(0., 9_007_199_254_740_991.),
            )
}

fn mismatch() -> ErrorObject {
    denied(
        "The delegated operation differs from the approved tool invocation. Request approval again.",
    )
}

pub(in crate::tool_io) struct FilePermit {
    pub(in crate::tool_io) scope: Scope,
    pub(in crate::tool_io) write: Option<Grant>,
}

pub(in crate::tool_io) fn file_permit(
    s: &SessionIo,
    method: &str,
    params: &Map<String, Value>,
    peer: &Peer,
) -> Result<FilePermit, ErrorObject> {
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(mismatch)?;
    let target = s.scope.locate(requested).map_err(|e| e.to_error_object())?;
    let internal = s
        .tmp_dir
        .parent()
        .ok_or_else(mismatch)?
        .canonicalize()
        .map_err(|_| mismatch())?;
    if method == "fs/pdf"
        && !params.contains_key("origin")
        && target.starts_with(internal.join("attachments"))
    {
        s.scope
            .check(requested, Access::Read)
            .map_err(|e| e.to_error_object())?;
        return Ok(FilePermit {
            scope: s.scope.clone(),
            write: None,
        });
    }
    if method == "fs/read"
        && !params.contains_key("origin")
        && params.get("restore").and_then(Value::as_bool) == Some(true)
    {
        // A file the session already saw, read again after a compaction (T27): readable
        // without approval and in the session's file state table.
        s.scope
            .check(requested, Access::Read)
            .map_err(|e| e.to_error_object())?;
        if !lock(&s.files).contains(&s.scope.key(&target)) {
            return Err(denied(
                "Only files the session already read or wrote can be restored.",
            ));
        }
        return Ok(FilePermit {
            scope: s.scope.clone(),
            write: None,
        });
    }
    let origin = params.get("origin").ok_or_else(mismatch)?;
    let call = origin["toolCallId"].as_str().ok_or_else(mismatch)?;
    let tool = origin["tool"].as_str().ok_or_else(mismatch)?;
    let write = matches!(method, "fs/mkdir" | "fs/write");
    if write && target.starts_with(internal) {
        return Err(denied("The session's internal directories are read-only."));
    }
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get_mut(call)
        .filter(|g| g.belongs(tool, peer))
        .ok_or_else(mismatch)?;
    let terminal = grant.file_op(s, method, params, &target)?;
    let binding = grant.binding.as_ref().ok_or_else(mismatch)?.clone();
    let consumed = terminal.then(|| state.grants.remove(call)).flatten();
    Ok(FilePermit {
        scope: s
            .scope
            .clone()
            .for_bound_path(
                &binding,
                target,
                if write { Access::Write } else { Access::Read },
            )
            .map_err(|e| e.to_error_object())?,
        write: consumed.filter(|_| method == "fs/write"),
    })
}

/// What a consumed command grant carries to the execution.
pub(in crate::tool_io) struct Claimed {
    /// Programs an automatic allowance pinned.
    pub pinned: Vec<(String, PathBuf)>,
    /// The command runs in the sandbox (T39).
    pub sandboxed: bool,
}

pub(in crate::tool_io) fn claim_command(
    s: &SessionIo,
    p: &ExecRunParams,
    peer: &Peer,
    cwd: &Path,
) -> Result<Claimed, ErrorObject> {
    let origin = p.origin.as_ref().ok_or_else(mismatch)?;
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(&origin.tool_call_id)
        .filter(|g| g.belongs(&origin.tool, peer))
        .ok_or_else(mismatch)?;
    let expected_shell = match grant.tool.as_str() {
        "Bash" => ExecShell::Bash,
        "PowerShell" => ExecShell::Powershell,
        _ => return Err(mismatch()),
    };
    let timeout = grant
        .input
        .get("timeout")
        .and_then(Value::as_f64)
        .map(|t| (1000. * t).round().clamp(1., 9_007_199_254_740_991.));
    if Some(cwd) != grant.cwd.as_deref()
        || grant.command.as_deref() != Some(p.command.as_str())
        || p.shell.unwrap_or(ExecShell::Bash) != expected_shell
        || p.env.as_ref().is_some_and(|v| !v.is_empty())
        || p.cwd.is_some()
        || !timeout_matches(timeout, p.timeout_ms)
        || background_of(&grant.input) != p.background
        || flag(&grant.input, "terminal") != p.terminal
    {
        return Err(mismatch());
    }
    // An automatic allowance relied on these paths staying inside: a link created since the
    // preflight must not redirect them.
    if let Some(scope) = &grant.scope {
        for (path, write) in &grant.targets {
            if super::path_boundary(scope, &display(path), *write)? != Boundary::Inside {
                return Err(mismatch());
            }
        }
    }
    state
        .grants
        .remove(&origin.tool_call_id)
        .map(|g| Claimed {
            pinned: g.programs,
            sandboxed: g.sandboxed,
        })
        .ok_or_else(mismatch)
}

/// Whether the approved call asked to run in the background (T32), which running in a
/// terminal implies (T33): the request must match, so a rule on `run_in_background` or
/// `terminal` decides what runs.
fn background_of(input: &serde_json::Map<String, Value>) -> bool {
    flag(input, "run_in_background") || flag(input, "terminal")
}

fn flag(input: &serde_json::Map<String, Value>, name: &str) -> bool {
    input.get(name).and_then(Value::as_bool).unwrap_or(false)
}

/// The approved `Monitor` call `p` names (T32): same command, the session's shell directory,
/// the same timeout; consumed. Returns the programs an automatic allowance pinned.
pub(in crate::tool_io) fn claim_monitor(
    s: &SessionIo,
    p: &piarc_protocol::tasks::ExecMonitorParams,
    peer: &Peer,
    cwd: &Path,
) -> Result<Claimed, ErrorObject> {
    let origin = p.origin.as_ref().ok_or_else(mismatch)?;
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(&origin.tool_call_id)
        .filter(|g| g.belongs(&origin.tool, peer) && g.tool == "Monitor")
        .ok_or_else(mismatch)?;
    let timeout = grant
        .input
        .get("timeout")
        .and_then(Value::as_f64)
        .map(|t| (1000. * t).round().clamp(1., 9_007_199_254_740_991.));
    if Some(cwd) != grant.cwd.as_deref()
        || grant.command.as_deref() != Some(p.command.as_str())
        || !timeout_matches(timeout, p.timeout_ms)
    {
        return Err(mismatch());
    }
    state
        .grants
        .remove(&origin.tool_call_id)
        .map(|g| Claimed {
            pinned: g.programs,
            sandboxed: g.sandboxed,
        })
        .ok_or_else(mismatch)
}

fn timeout_matches(expected: Option<f64>, wire: Option<u64>) -> bool {
    match (expected, wire) {
        (Some(ms), Some(value)) => serde_json::Number::from(value).as_f64() == Some(ms),
        (None, None) => true,
        _ => false,
    }
}

/// The approved `WebFetch` call `p` names, for this URL: consumed, so one approval is one
/// fetch (T29). Same-site redirects are part of that fetch; another site is a new call.
/// Consumes the approval of `Skill` call `call` for skill `name` (T37): one approval, one load.
pub(in crate::tool_io) fn claim_skill(
    s: &SessionIo,
    call: &str,
    name: &str,
    peer: &Peer,
) -> Result<(), ErrorObject> {
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(call)
        .filter(|g| g.belongs("Skill", peer))
        .ok_or_else(mismatch)?;
    if grant.input.get("skill").and_then(Value::as_str) != Some(name) {
        return Err(mismatch());
    }
    state.grants.remove(call);
    Ok(())
}

/// Consumes the permission of `Memory` call `call` (T47): the action and name must be the ones
/// the decision saw.
pub(in crate::tool_io) fn claim_memory(
    s: &SessionIo,
    call: &str,
    action: &str,
    name: Option<&str>,
    peer: &Peer,
) -> Result<(), ErrorObject> {
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(call)
        .filter(|g| g.belongs("Memory", peer))
        .ok_or_else(mismatch)?;
    if grant.input.get("action").and_then(Value::as_str) != Some(action)
        || grant.input.get("name").and_then(Value::as_str) != name
    {
        return Err(mismatch());
    }
    state.grants.remove(call);
    Ok(())
}

pub(in crate::tool_io) fn claim_fetch(
    s: &SessionIo,
    p: &piarc_protocol::web::WebFetchParams,
    peer: &Peer,
) -> Result<(), ErrorObject> {
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(&p.origin.tool_call_id)
        .filter(|g| g.belongs(&p.origin.tool, peer) && g.tool == "WebFetch")
        .ok_or_else(mismatch)?;
    if grant.input.get("url").and_then(Value::as_str) != Some(p.url.as_str()) {
        return Err(mismatch());
    }
    state.grants.remove(&p.origin.tool_call_id);
    Ok(())
}

/// Consumes the grant of an allowed `WebSearch` call whose `query` is `p.query` (T38): one
/// approval, one search.
pub(in crate::tool_io) fn claim_search(
    s: &SessionIo,
    p: &piarc_protocol::web::WebSearchParams,
    peer: &Peer,
) -> Result<(), ErrorObject> {
    let mut state = lock(&s.policy);
    let grant = state
        .grants
        .get(&p.origin.tool_call_id)
        .filter(|g| g.belongs(&p.origin.tool, peer) && g.tool == "WebSearch")
        .ok_or_else(mismatch)?;
    if grant.input.get("query").and_then(Value::as_str) != Some(p.query.as_str()) {
        return Err(mismatch());
    }
    state.grants.remove(&p.origin.tool_call_id);
    Ok(())
}
