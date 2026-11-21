//! The facts of one call before the ladder: its card, boundary, assessment and grant (moved
//! out of `policy.rs`, R4 I165).
use super::*;

pub(super) fn new_request(
    p: &PolicyEvaluateParams,
    peer: &Peer,
) -> Result<ApprovalRequest, ErrorObject> {
    Ok(ApprovalRequest {
        request_id: crate::sessions::new_session_id().map_err(|e| e.to_error_object())?,
        session_id: p.session_id.clone(),
        revision: 1,
        connection_epoch: peer.epoch(),
        tool: p.tool.clone(),
        kind: ApprovalKind::Command,
        command: None,
        cwd: None,
        path: None,
        diff: None,
        rules: Vec::new(),
        directory: None,
        protected_path: None,
        plan: None,
        questions: Vec::new(),
        subagent: None,
    })
}

#[expect(
    clippy::too_many_lines,
    reason = "one arm per tool family, kept together"
)]
pub(super) async fn prepare(
    s: Arc<SessionIo>,
    p: PolicyEvaluateParams,
    settings: &Settings,
    peer: Peer,
    programs: Option<exec::utility::Programs>,
    rules: Arc<RuleSet>,
) -> Result<Prepared, ErrorObject> {
    let dirs: Vec<PathBuf> = settings
        .get("/permissions/additionalDirectories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|d| s.scope.root().join(d))
        .collect();
    // The skills' directories (T37): Read, Glob and Grep may read them without asking.
    let skill_dirs = lock(&s.skill_dirs).clone();
    tokio::task::spawn_blocking(move || {
        let mut scope = with_directories(s.scope.clone(), &dirs)?;
        for dir in &skill_dirs {
            if let Ok(with) = scope.clone().with_read_only_dir(dir) {
                scope = with;
            }
        }
        let places = assess::Places::new(&scope);
        let mut card = new_request(&p, &peer)?;
        let mut grant = Grant::new(&p, peer);
        let mut preview = None;
        let mut boundary = Boundary::Inside;
        let field = |key: &str| p.input.get(key).and_then(Value::as_str);
        let assessment = match p.tool.as_str() {
            "Bash" | "PowerShell" | "Monitor" => {
                let cmd = field("command").ok_or_else(|| denied("The command text is missing."))?;
                let cwd = exec::launch_dir(&s, None)?.dir;
                let assessment = match &programs {
                    Some(programs) if p.tool == "Bash" || p.tool == "Monitor" => {
                        let facts = assess::BashFacts {
                            tool: if p.tool == "Monitor" {
                                "Monitor"
                            } else {
                                "Bash"
                            },
                            scope: &scope,
                            shell_cwd: &cwd,
                            shell_cwd_posix: piarc_policy::paths::posix(&cwd),
                            places: &places,
                            programs,
                            resolved: std::cell::RefCell::default(),
                            targets: std::cell::RefCell::default(),
                        };
                        assess::bash_call(&rules, &facts, cmd)
                    }
                    _ => assess::powershell_call(&rules, &places, cmd),
                };
                card.command = Some(cmd.to_owned());
                card.cwd = Some(display(&cwd));
                grant.cwd = Some(cwd);
                grant.command = Some(cmd.to_owned());
                grant.scope = Some(scope.clone());
                assessment
            }
            "Read" | "Glob" | "Grep" | "Write" | "Edit" => {
                let raw = field("path").unwrap_or(".");
                let (file_boundary, target) = prepare_file(&scope, &p, &mut card)?;
                boundary = file_boundary;
                let binding = piarc_fs::DirectoryBinding::capture(&target)
                    .map_err(|e| e.to_error_object())?;
                if matches!(p.tool.as_str(), "Write" | "Edit")
                    && scope.check(&display(&target), Access::Read).is_ok()
                {
                    scope
                        .clone()
                        .for_bound_path(&binding, target.clone(), Access::Read)
                        .map_err(|e| e.to_error_object())?;
                    preview = Some((target.clone(), scope.label(&target)));
                }
                grant.binding = Some(binding);
                grant.path = Some(target.clone());
                let named = assess::lexical(&scope.cwd().join(raw));
                assess::file_call(&rules, &places, &p.tool, &named, &target, boundary)
            }
            tool => {
                if tool == "ExitPlanMode" {
                    card.kind = ApprovalKind::Plan;
                    card.plan = Some(field("plan").unwrap_or_default().to_owned());
                } else {
                    card.command = Some(format!("{} {}", p.tool, Value::Object(p.input.clone())));
                }
                assess::other_call(&rules, &places, tool, &p.input)
            }
        };
        let mut assessment = assessment;
        assess::param_rules(&rules, &p.tool, &p.input, &mut assessment.input);
        if assessment.input.protected {
            boundary = Boundary::Protected;
        }
        card.protected_path = Some(boundary == Boundary::Protected);
        if p.requires_user_interaction {
            // An MCP tool marked `requiresUserInteraction` (T36): every call asks, in every
            // mode, and the card offers no session or permanent allow.
            assess::requires_user_interaction(&mut assessment);
            card.protected_path = Some(true);
        }
        if card.protected_path != Some(true) {
            card.rules.clone_from(&assessment.rules);
        }
        Ok(Prepared {
            card,
            boundary,
            assessment,
            grant,
            preview,
        })
    })
    .await
    .map_err(|e| denied(format!("Permission preflight failed: {e}")))?
}

pub(super) fn with_directories(mut scope: Scope, dirs: &[PathBuf]) -> Result<Scope, ErrorObject> {
    for dir in dirs {
        // A repository-controlled link is not a durable identity for an external directory.
        // Store physical paths from native confirmations; review a redirected target anew.
        let resolved = scope
            .locate(&display(dir))
            .map_err(|e| e.to_error_object())?;
        if dir.starts_with(scope.root()) && scope.key(&resolved) != scope.key(&assess::lexical(dir))
        {
            continue;
        }
        match std::fs::metadata(&resolved) {
            Ok(meta) if meta.is_dir() => {
                scope = scope
                    .with_added_dir(&resolved)
                    .map_err(|e| e.to_error_object())?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(denied(format!(
                    "Cannot inspect a configured permission directory: {e}"
                )));
            }
        }
    }
    Ok(scope)
}

fn prepare_file(
    scope: &Scope,
    p: &PolicyEvaluateParams,
    card: &mut ApprovalRequest,
) -> Result<(Boundary, PathBuf), ErrorObject> {
    let raw = p.input.get("path").and_then(Value::as_str).unwrap_or(".");
    let target = scope.locate(raw).map_err(|e| e.to_error_object())?;
    let write = matches!(p.tool.as_str(), "Write" | "Edit");
    let boundary = path_boundary(scope, raw, write)?;
    card.kind = if boundary == Boundary::Outside {
        ApprovalKind::PermissionExpansion
    } else {
        ApprovalKind::FileChange
    };
    card.path = Some(display(&target));
    if boundary == Boundary::Outside {
        card.directory = if target.is_dir() {
            Some(display(&target))
        } else {
            target.parent().map(display)
        };
    }
    Ok((boundary, target))
}

pub(super) fn path_boundary(
    scope: &Scope,
    path: &str,
    write: bool,
) -> Result<Boundary, ErrorObject> {
    let access = if write { Access::Write } else { Access::Read };
    let resolved = scope.locate(path).map_err(|e| e.to_error_object())?;
    if write {
        let lexical = scope.cwd().join(path);
        if [lexical.as_path(), resolved.as_path()].iter().any(|p| {
            piarc_fs::access::protected_component(
                p.strip_prefix(scope.root()).unwrap_or(p),
                scope.case_insensitive(),
            )
            .is_some()
        }) {
            return Ok(Boundary::Protected);
        }
    }
    match scope.check(path, access) {
        Ok(_) => Ok(Boundary::Inside),
        Err(piarc_fs::Error::NeedsApproval { .. }) => Ok(Boundary::Outside),
        Err(e) => Err(e.to_error_object()),
    }
}
