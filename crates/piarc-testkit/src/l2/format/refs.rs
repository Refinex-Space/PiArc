//! The reference checks after a scenario file passed the schema and serde (third pass of
//! `load`): ids and file names, sessions and endpoints, labels defined before use, paths
//! inside the workspace.

use super::*;

/// The checks the schema cannot express.
pub(super) fn check(spec: &ScenarioSpec, stem: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if spec.id != stem {
        problems.push(format!(
            "/id: `{}` differs from the file name `{stem}`",
            spec.id
        ));
    }
    let platforms = spec.platforms();
    if platforms.len() < Platform::ALL.len() && spec.platform_reason.is_none() {
        problems.push("/platform_reason: required when `platforms` leaves a platform out".into());
    }
    for (provider, endpoint) in &spec.providers {
        if endpoint.configure_as.is_some() && (endpoint.vision || endpoint.reasoning) {
            problems.push(format!(
                "/providers/{provider}: explicit capability overrides require an imported fixture"
            ));
        }
        if let Err(e) = Scenario::new(spec.mock_scenario_id(provider), endpoint.script()) {
            problems.push(format!("/providers/{provider}: {e}"));
        }
    }
    for (label, session) in spec.sessions() {
        if !spec.providers.contains_key(&session.provider) {
            problems.push(format!(
                "/sessions/{label}/provider: no provider `{}`",
                session.provider
            ));
        }
        if let Some(cwd) = &session.cwd {
            check_path(&format!("/sessions/{label}/cwd"), cwd, &mut problems);
        }
    }
    if spec.declared_sessions.is_none() && spec.providers.len() > 1 {
        problems.push("/sessions: required when several providers are declared".into());
    }
    for path in spec.workspace.files.keys() {
        check_path(&format!("/workspace/files/{path}"), path, &mut problems);
    }
    for path in spec.workspace.run_files.keys() {
        check_path(&format!("/workspace/run_files/{path}"), path, &mut problems);
    }
    for path in spec.expect.files.keys() {
        check_path(&format!("/expect/files/{path}"), path, &mut problems);
    }
    for (section, fixtures) in [
        ("workspace", &spec.workspace.fixtures),
        ("expect", &spec.expect.fixtures),
    ] {
        for (path, name) in fixtures {
            let field = format!("/{section}/fixtures/{path}");
            check_path(&field, path, &mut problems);
            check_fixture(spec, &field, name, &mut problems);
        }
    }
    check_actions(spec, &mut problems);
    check_expect(spec, &mut problems);
    problems
}

fn check_fixture(spec: &ScenarioSpec, field: &str, name: &str, problems: &mut Vec<String>) {
    check_path(field, name, problems);
    if !spec.fixture(name).is_file() {
        problems.push(format!(
            "{field}: no fixture `{name}` in {}",
            spec.fixture_dir.display()
        ));
    }
}

fn check_path(field: &str, path: &str, problems: &mut Vec<String>) {
    let bad = path.contains('\\')
        || path.starts_with('/')
        || path.as_bytes().get(1) == Some(&b':')
        || path.split('/').any(|part| part == ".." || part.is_empty());
    if bad {
        problems.push(format!(
            "{field}: `{path}` must be relative, use forward slashes and stay inside the workspace"
        ));
    }
}

/// Session references resolve, and turn and item labels are defined (once) before use.
fn check_actions(spec: &ScenarioSpec, problems: &mut Vec<String>) {
    let mut turns = BTreeSet::new();
    let mut items = BTreeSet::new();
    for (n, action) in spec.actions.iter().enumerate() {
        let field = format!("/actions/{n}/{}", action.name());
        if let Some(session) = action.session()
            && let Err(e) = spec.session_label(session.as_deref())
        {
            problems.push(format!("{field}/session: {e}"));
        }
        check_checkpoint_action(action, &field, &turns, problems);
        check_labels(spec, action, &field, &mut turns, &mut items, problems);
        check_references(spec, action, &field, problems);
    }
}

/// Turn and item labels: defined once by inputs, used by queue edits and waits.
fn check_labels(
    spec: &ScenarioSpec,
    action: &Action,
    field: &str,
    turns: &mut BTreeSet<String>,
    items: &mut BTreeSet<String>,
    problems: &mut Vec<String>,
) {
    let mut define = |set: &mut BTreeSet<String>, label: &Option<String>, what: &str| {
        if let Some(label) = label
            && !set.insert(label.clone())
        {
            problems.push(format!(
                "{field}/{what}: label `{label}` is already defined"
            ));
        }
    };
    match action {
        Action::Prompt(input) | Action::Steer(input) | Action::FollowUp(input) => {
            define(turns, &input.turn, "turn");
            define(items, &input.item, "item");
            for (index, attachment) in input.attachments.iter().enumerate() {
                check_fixture(
                    spec,
                    &format!("{field}/attachments/{index}/fixture"),
                    &attachment.fixture,
                    problems,
                );
            }
        }
        Action::QueueEdit { item, .. } | Action::QueueDelete { item, .. } => {
            if !items.contains(item) {
                problems.push(format!("{field}/item: no earlier item `{item}`"));
            }
        }
        Action::QueueReorder { items: order, .. } => {
            for item in order.iter().filter(|item| !items.contains(*item)) {
                problems.push(format!("{field}/items: no earlier item `{item}`"));
            }
        }
        Action::Wait(wait) => {
            if let Some(turn) = wait.turn.as_ref().filter(|t| !turns.contains(*t)) {
                problems.push(format!("{field}/turn: no earlier turn `{turn}`"));
            }
        }
        _ => {}
    }
}

/// Endpoint, session, fixture and path references of the other actions.
#[expect(
    clippy::too_many_lines,
    reason = "one arm per action kind, kept together"
)]
fn check_references(spec: &ScenarioSpec, action: &Action, field: &str, problems: &mut Vec<String>) {
    match action {
        Action::SetModel { provider, .. } => {
            if !spec.providers.contains_key(provider) {
                problems.push(format!("{field}/provider: no such endpoint"))
            }
        }
        // Checked by `check_labels`.
        Action::Prompt(_)
        | Action::Steer(_)
        | Action::FollowUp(_)
        | Action::QueueEdit { .. }
        | Action::QueueDelete { .. }
        | Action::QueueReorder { .. }
        | Action::Wait(_)
        | Action::SetPrefs(_)
        | Action::DeleteSession { .. }
        | Action::CheckStoredSession { .. }
        | Action::CheckTrust { .. }
        | Action::SetEffort { .. }
        | Action::SideChat { .. }
        | Action::Compact { .. }
        | Action::SetMode { .. }
        | Action::Abort { .. }
        | Action::RestartCore {}
        | Action::Resume { .. }
        | Action::AdvanceClock { .. }
        | Action::StopTask { .. }
        | Action::OpenTerminal { .. }
        | Action::TypeTerminal { .. }
        | Action::ShareTerminal { .. }
        | Action::CheckHarness(_)
        | Action::CheckUsage(_)
        | Action::CheckCost(_)
        | Action::UndoRewind(_)
        | Action::CheckChanges(_)
        | Action::SwitchBranch(_)
        | Action::CheckBranch(_)
        | Action::CheckWorktree(_)
        | Action::RemoveWorktree(_)
        | Action::KeepWorktree(_)
        | Action::CheckGit(_)
        // Checked by `check_checkpoint_action`.
        | Action::Rewind(_)
        | Action::Discard(_)
        | Action::SetOutputStyle { .. }
        | Action::CheckCommands { .. }
        | Action::SetWebSearchKey { .. }
        | Action::CheckFiles(_) => {}
        Action::Fork(fork) => {
            if !spec.sessions().get(&fork.label).is_some_and(|s| s.deferred) {
                problems.push(format!(
                    "{field}/as: `{}` must be a deferred session",
                    fork.label
                ));
            }
        }
        Action::WriteFile { path, .. } => check_path(&format!("{field}/path"), path, problems),
        Action::WriteManaged { path, .. } => check_path(&format!("{field}/path"), path, problems),
        Action::Search(search) => {
            let sessions = spec.sessions();
            for label in &search.sessions {
                if !sessions.contains_key(label) {
                    problems.push(format!("{field}: no session `{label}`"));
                }
            }
        }
        Action::SweepWorktrees(sweep) => {
            let sessions = spec.sessions();
            for label in sweep.removed.iter().chain(&sweep.waiting) {
                if !sessions.contains_key(label) {
                    problems.push(format!("{field}: no session `{label}`"));
                }
            }
        }
        Action::SignIn(_) | Action::SignOut {} => {
            if spec.oauth.is_none() {
                problems.push(format!("{field}: signing in needs an `oauth` section"));
            }
        }
        Action::McpSignIn(sign_in) => {
            if !spec.mcp_http.contains_key(&sign_in.server) {
                problems.push(format!(
                    "{field}: `{}` is not an `mcp_http` server",
                    sign_in.server
                ));
            }
        }
    }
}

/// T28's references: a rewind and a fork before a turn name an earlier turn, paths stay in the
/// workspace.
fn check_checkpoint_action(
    action: &Action,
    field: &str,
    turns: &BTreeSet<String>,
    problems: &mut Vec<String>,
) {
    match action {
        Action::Rewind(rewind) if !turns.contains(&rewind.turn) => {
            problems.push(format!("{field}/turn: no earlier turn `{}`", rewind.turn));
        }
        Action::Fork(fork) => {
            if let Some(turn) = fork.before_turn.as_ref().filter(|t| !turns.contains(*t)) {
                problems.push(format!("{field}/before_turn: no earlier turn `{turn}`"));
            }
        }
        Action::Discard(discard) => check_path(&format!("{field}/path"), &discard.path, problems),
        Action::CheckFiles(check) => {
            for path in check.files.keys() {
                check_path(&format!("{field}/files"), path, problems);
            }
        }
        _ => {}
    }
}

fn check_expect(spec: &ScenarioSpec, problems: &mut Vec<String>) {
    let turns: BTreeSet<&String> = spec
        .actions
        .iter()
        .filter_map(|action| match action {
            Action::Prompt(input) | Action::Steer(input) | Action::FollowUp(input) => {
                input.turn.as_ref()
            }
            _ => None,
        })
        .collect();
    for (n, expected) in spec.expect.events.iter().enumerate() {
        let mut sessions = BTreeSet::new();
        for matcher in expected.matchers() {
            match spec.session_label(matcher.session.as_deref()) {
                Ok(label) => {
                    sessions.insert(label);
                }
                Err(e) => problems.push(format!("/expect/events/{n}/session: {e}")),
            }
            if let Some(turn) = matcher.turn.as_ref().filter(|t| !turns.contains(t)) {
                problems.push(format!("/expect/events/{n}/turn: no turn `{turn}`"));
            }
        }
        if sessions.len() > 1 {
            problems.push(format!(
                "/expect/events/{n}/any_order: all events of a group belong to one session"
            ));
        }
    }
    for (n, request) in spec.expect.requests.iter().enumerate() {
        for (key, earlier) in [
            ("same_system_as", request.same_system_as),
            ("same_tools_as", request.same_tools_as),
            ("message_prefix_as", request.message_prefix_as),
        ] {
            if earlier.is_some_and(|index| index >= request.index) {
                problems.push(format!(
                    "/expect/requests/{n}/{key}: must name an earlier request"
                ));
            }
        }
        if let Err(e) = spec.provider_label(request.provider.as_deref()) {
            problems.push(format!("/expect/requests/{n}/provider: {e}"));
        }
    }
    for provider in spec.expect.request_counts.keys() {
        if !spec.providers.contains_key(provider) {
            problems.push(format!(
                "/expect/request_counts/{provider}: no such provider"
            ));
        }
    }
    let mut seen = BTreeSet::new();
    for (n, batch) in spec.expect.tool_batches.iter().enumerate() {
        for call in batch.iter().filter(|call| !seen.insert(*call)) {
            problems.push(format!(
                "/expect/tool_batches/{n}: `{call}` is in more than one batch"
            ));
        }
    }
}
