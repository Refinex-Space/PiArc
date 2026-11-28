//! Skills, slash commands and output styles in Core (T37, architecture section 6.7, ADR-0054).
//!
//! `piarc_config::skills` finds and parses the files; this module applies the workspace's
//! settings and rules to them and acts on an invocation:
//!
//! - `skills/list`: the catalog from a session's directory, with `skillOverrides`, `Skill`
//!   deny rules, the untrusted project's withheld effects and the current output style. A
//!   session's request also records its skills' directories, which its Read, Glob and Grep
//!   may then read without asking (`policy::prepare`).
//! - `skills/invoke`: the `Skill` tool. It consumes the call's approval, substitutes the
//!   arguments, grants `allowed-tools` until the turn ends and scopes the skill's hooks to the
//!   session (both only for a trusted project's files).
//! - `skills/match`: which `paths` skills the files a session touched make available.
//! - [`ToolIo::expand_command`]: a `/name` input becomes the command's or skill's text before
//!   `UserPromptSubmit` runs; the expansion hook of T41 goes here.

use std::path::{Path, PathBuf};

use piarc_config::Settings;
use piarc_config::skills::{self as config, Catalog, ResourceDirs, args::Arguments, is_project};
use piarc_host::Peer;
use piarc_protocol::skills::{
    CommandKind, CurrentOutputStyle, ForkSkillRun, PromptCommand, ResourceSource, ResourceWarning,
    ResourceWarningKind, SkillsCatalog, SkillsInvokeParams, SkillsInvokeResult, SkillsListParams,
    SkillsMatchParams, SkillsMatchResult,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value, json};

use super::{SessionIo, ToolIo, lock, policy};

/// A `/name` input after expansion.
#[derive(Debug, Clone)]
pub(crate) struct Expansion {
    /// What the model receives.
    pub text: String,
    /// What the user invoked.
    pub command: PromptCommand,
    /// The turn grant of its `allowed-tools`, to withdraw when the input does not start or
    /// join a turn.
    pub grant: Option<u64>,
    /// Context `UserPromptExpansion` hooks added (T41).
    pub context: Option<String>,
}

/// What an invocation turned on.
struct Activated {
    /// Rules the current turn now allows.
    rules: Vec<String>,
    /// The turn grant holding them.
    grant: Option<u64>,
    /// Whether the hooks now apply to the session.
    hooks: bool,
    /// What did not apply.
    warnings: Vec<ResourceWarning>,
}

/// What one invocation turns on: the effects a skill or command file has.
struct Effects<'a> {
    name: &'a str,
    source: ResourceSource,
    file: &'a str,
    dir: Option<&'a Path>,
    allowed: &'a [String],
    hooks: Option<&'a Value>,
}

fn internal(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(ErrorKind::InternalError, error.to_string(), false)
}

fn warning(kind: ResourceWarningKind) -> ResourceWarning {
    ResourceWarning {
        kind,
        field: None,
        value: None,
        task: None,
    }
}

/// Executable effects approved for exactly one forked skill in this parent session.
pub(super) struct PendingForkSkill {
    name: String,
    agent: String,
    background: bool,
    source: ResourceSource,
    file: String,
    dir: PathBuf,
    allowed: Vec<String>,
    hooks: Option<Value>,
}

impl ToolIo {
    fn prepare_fork_skill(
        parent: &SessionIo,
        settings: &Settings,
        skill: &config::Skill,
        fork: &config::SkillFork,
    ) -> Result<ForkSkillRun, ErrorObject> {
        let session_id = crate::sessions::new_session_id().map_err(|e| e.to_error_object())?;
        let agent = fork
            .agent
            .as_deref()
            .unwrap_or("general-purpose")
            .to_owned();
        if (!skill.info.allowed_tools.is_empty() || skill.hooks.is_some())
            && covered(
                skill.info.source,
                &skill.info.path,
                parent.project(),
                settings.trust().is_trusted(),
            )
        {
            lock(&parent.fork_skills).insert(
                session_id.clone(),
                PendingForkSkill {
                    name: skill.info.name.clone(),
                    agent: agent.clone(),
                    background: fork.background,
                    source: skill.info.source,
                    file: skill.info.path.clone(),
                    dir: PathBuf::from(&skill.info.dir),
                    allowed: skill.info.allowed_tools.clone(),
                    hooks: skill.hooks.clone(),
                },
            );
        }
        Ok(ForkSkillRun {
            model: fork.model.clone(),
            effort: fork.effort,
            session_id,
            agent,
            background: fork.background,
        })
    }

    pub(crate) fn discard_fork_effects(&self, id: &str, child: &str) {
        if let Ok(parent) = self.session(id) {
            lock(&parent.fork_skills).remove(child);
        }
    }

    /// Consume the grant once and recheck trust at the time of the child's registration.
    pub(super) async fn activate_fork_skill(
        &self,
        p: &piarc_protocol::subagent::SubagentStartParams,
        parent: &SessionIo,
    ) -> Result<(), ErrorObject> {
        let grant = lock(&parent.fork_skills).remove(&p.session_id);
        if let Some(g) = grant {
            if g.agent != p.agent_type || g.background != p.background {
                return Err(policy::denied("The skill did not authorize this subagent."));
            }
            let (catalog, settings) = self
                .resource_catalog(parent.project(), parent.scope.cwd())
                .await?;
            if !catalog.skill(&g.name).is_some_and(|skill| {
                skill.info.path == g.file
                    && skill.info.source == g.source
                    && skill.info.allowed_tools == g.allowed
                    && skill.hooks == g.hooks
                    && skill.fork.as_ref().is_some_and(|fork| {
                        fork.agent.as_deref().unwrap_or("general-purpose") == g.agent
                            && fork.background == g.background
                    })
            }) {
                return Err(policy::denied(
                    "The skill changed before its subagent started.",
                ));
            }
            let child = self.session(&p.session_id)?;
            self.activate(
                &child,
                &p.session_id,
                &settings,
                &Effects {
                    name: &g.name,
                    source: g.source,
                    file: &g.file,
                    dir: Some(&g.dir),
                    allowed: &g.allowed,
                    hooks: g.hooks.as_ref(),
                },
            );
        }
        Ok(())
    }

    /// The settings `project`'s skills follow (with its trust).
    async fn resource_settings(&self, project: &Path) -> Result<Settings, ErrorObject> {
        self.services()?
            .trust
            .permission_settings(project)
            .await
            .map_err(|e| e.to_error_object())
    }

    /// Everything found from `cwd`, with `project`'s settings applied.
    pub(crate) async fn resource_catalog(
        &self,
        project: &Path,
        cwd: &Path,
    ) -> Result<(Catalog, Settings), ErrorObject> {
        let dirs = self.services()?.storage.dirs().clone();
        let lookup = cwd.to_path_buf();
        let settings = self.resource_settings(project).await?;
        // Extension packages in effect (T40): their skills and commands come last.
        let packages = settings.packages().active.clone();
        let mut catalog = tokio::task::spawn_blocking(move || {
            config::load(&ResourceDirs {
                cwd: &lookup,
                data: Some(dirs.data()),
                home: dirs.home(),
                packages: &packages,
            })
        })
        .await
        .map_err(internal)?;
        config::apply_visibility(&mut catalog.skills, settings.get("/skillOverrides"));
        let rules = policy::workspace_rules(&settings, project);
        let trusted = settings.trust().is_trusted();
        for skill in &mut catalog.skills {
            if policy::denies_skill(&rules, &skill.info.name) {
                skill.info.model_invocable = false;
                skill
                    .info
                    .warnings
                    .push(warning(ResourceWarningKind::Denied));
            }
            if !covered(skill.info.source, &skill.info.path, project, trusted)
                && (!skill.info.allowed_tools.is_empty() || skill.hooks.is_some())
            {
                skill
                    .info
                    .warnings
                    .push(warning(ResourceWarningKind::Untrusted));
            }
        }
        for command in &mut catalog.commands {
            if !covered(
                command.info.source,
                command.info.path.as_deref().unwrap_or_default(),
                project,
                trusted,
            ) && (!command.info.allowed_tools.is_empty() || command.hooks.is_some())
            {
                command
                    .info
                    .warnings
                    .push(warning(ResourceWarningKind::Untrusted));
            }
        }
        Ok((catalog, settings))
    }

    /// The catalog as the Agent Host and the client see it.
    pub(crate) async fn skills_view(
        &self,
        project: &Path,
        cwd: &Path,
    ) -> Result<(Catalog, SkillsCatalog), ErrorObject> {
        let (catalog, settings) = self.resource_catalog(project, cwd).await?;
        let output_styles = config::styles(&catalog);
        let (name, missing) = config::current_style(&output_styles, settings.get("/outputStyle"));
        let view = SkillsCatalog {
            skills: catalog.skills.iter().map(|s| s.info.clone()).collect(),
            commands: config::commands(&catalog),
            output_styles,
            output_style: CurrentOutputStyle { name, missing },
            issues: catalog.issues.clone(),
        };
        Ok((catalog, view))
    }

    /// Answers `skills/list`, `skills/invoke` and `skills/match` for `workspace`'s Agent Host.
    pub(crate) async fn skills_request(
        &self,
        workspace: &Path,
        method: &str,
        params: Map<String, Value>,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        match method {
            "skills/list" => {
                let p: SkillsListParams = super::parse(method, params)?;
                super::to_value(&self.skills_list(workspace, p).await?)
            }
            "skills/invoke" => {
                let p: SkillsInvokeParams = super::parse(method, params)?;
                super::to_value(&self.skills_invoke(p, peer).await?)
            }
            "skills/match" => {
                let p: SkillsMatchParams = super::parse(method, params)?;
                super::to_value(&self.skills_match(p).await?)
            }
            _ => Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not answer {method}"),
                false,
            )),
        }
    }

    async fn skills_list(
        &self,
        workspace: &Path,
        p: SkillsListParams,
    ) -> Result<SkillsCatalog, ErrorObject> {
        let session = p
            .session_id
            .as_deref()
            .map(|id| self.session(id))
            .transpose()?;
        let (project, cwd) = match (&session, &p.cwd) {
            (Some(s), _) => (s.project().to_path_buf(), s.scope.cwd().to_path_buf()),
            (None, Some(cwd)) => (workspace.to_path_buf(), PathBuf::from(cwd)),
            (None, None) => (workspace.to_path_buf(), workspace.to_path_buf()),
        };
        if !cwd.starts_with(workspace) && session.is_none() {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "skills/list: cwd must be inside the workspace",
                false,
            ));
        }
        let (catalog, view) = self.skills_view(&project, &cwd).await?;
        if let Some(s) = &session {
            *lock(&s.skill_dirs) = catalog
                .skills
                .iter()
                .map(|skill| PathBuf::from(&skill.info.dir))
                .collect();
        }
        Ok(view)
    }

    async fn skills_invoke(
        &self,
        p: SkillsInvokeParams,
        peer: &Peer,
    ) -> Result<SkillsInvokeResult, ErrorObject> {
        let s = self.session(&p.session_id)?;
        policy::claim_skill(&s, &p.tool_call_id, &p.name, peer)?;
        let (catalog, settings) = self.resource_catalog(s.project(), s.scope.cwd()).await?;
        let not_found = || {
            ErrorObject::new(
                ErrorKind::NotFound,
                format!("No skill named \"{}\" is available.", p.name),
                false,
            )
        };
        let skill = catalog.skill(&p.name).ok_or_else(not_found)?;
        if !skill.info.model_invocable {
            return Err(ErrorObject::new(
                ErrorKind::PermissionDenied,
                format!(
                    "The skill \"{}\" can only be started by the user (as /{}).",
                    p.name, p.name
                ),
                false,
            ));
        }
        let dir = PathBuf::from(&skill.info.dir);
        let fork = skill
            .fork
            .as_ref()
            .map(|options| Self::prepare_fork_skill(&s, &settings, skill, options))
            .transpose()?;
        let content = render(
            &skill.body,
            p.arguments.as_deref().unwrap_or_default(),
            &skill.info.arguments,
            Some(&dir),
            fork.as_ref().map_or(&p.session_id, |f| &f.session_id),
            s.project(),
        );
        if fork.is_some() {
            return Ok(SkillsInvokeResult {
                fork,
                name: skill.info.name.clone(),
                content,
                dir: skill.info.dir.clone(),
                allowed_tools: Vec::new(),
                hooks: false,
                warnings: skill.info.warnings.clone(),
            });
        }
        let activated = self.activate(
            &s,
            &p.session_id,
            &settings,
            &Effects {
                name: &skill.info.name,
                source: skill.info.source,
                file: &skill.info.path,
                dir: Some(&dir),
                allowed: &skill.info.allowed_tools,
                hooks: skill.hooks.as_ref(),
            },
        );
        Ok(SkillsInvokeResult {
            fork: None,
            name: skill.info.name.clone(),
            content,
            dir: skill.info.dir.clone(),
            allowed_tools: activated.rules,
            hooks: activated.hooks,
            warnings: activated.warnings,
        })
    }

    /// Grants `allowed-tools` to the session's current turn and scopes the hooks; an
    /// untrusted project's files do neither.
    fn activate(
        &self,
        s: &SessionIo,
        session_id: &str,
        settings: &Settings,
        effects: &Effects<'_>,
    ) -> Activated {
        let mut activated = Activated {
            rules: Vec::new(),
            grant: None,
            hooks: false,
            warnings: Vec::new(),
        };
        if effects.allowed.is_empty() && effects.hooks.is_none() {
            return activated;
        }
        if !covered(
            effects.source,
            effects.file,
            s.project(),
            settings.trust().is_trusted(),
        ) {
            activated
                .warnings
                .push(warning(ResourceWarningKind::Untrusted));
            return activated;
        }
        let vars = config::variables(effects.dir, session_id, s.project());
        let rules: Vec<String> = effects
            .allowed
            .iter()
            .map(|rule| config::args::replace_vars(rule, &vars))
            .collect();
        if !rules.is_empty() {
            activated.grant = Some(lock(&s.policy).grant_turn_rules(rules.clone()));
        }
        activated.rules = rules;
        if let (Some(hooks), Some(service)) = (
            effects.hooks,
            self.policy.as_ref().and_then(|p| p.hooks.as_ref()),
        ) {
            service.scope_skill_hooks(
                session_id,
                effects.name,
                Some(Path::new(effects.file)),
                hooks.clone(),
            );
            activated.hooks = true;
        }
        activated
    }

    async fn skills_match(&self, p: SkillsMatchParams) -> Result<SkillsMatchResult, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let (catalog, _) = self.resource_catalog(s.project(), s.scope.cwd()).await?;
        let root = s.scope.root().to_path_buf();
        let relative: Vec<String> = p
            .files
            .iter()
            // Canonical like the root: the Agent Host names files the way the model wrote them.
            .filter_map(|file| {
                let located = s.scope.locate(file).unwrap_or_else(|_| PathBuf::from(file));
                piarc_config::rules::relative_to(&root, &located)
            })
            .collect();
        let matched = catalog
            .skills
            .iter()
            .filter(|skill| p.skills.contains(&skill.info.name) && !skill.info.paths.is_empty())
            .filter(|skill| {
                piarc_config::rules::PathMatcher::new(&skill.info.paths)
                    .is_ok_and(|m| relative.iter().any(|file| m.matches(file)))
            })
            .map(|skill| skill.info.name.clone())
            .collect();
        Ok(SkillsMatchResult { matched })
    }

    /// Expands `text` when it starts with a command file's or a user-invocable skill's
    /// `/name` (ADR-0054 rule 9); built-in commands and unknown names stay as typed. The
    /// command's `allowed-tools` apply to the turn the input starts or joins.
    pub(crate) async fn expand_command(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<Option<Expansion>, ErrorObject> {
        let Some((name, arguments)) = config::slash_command(text) else {
            return Ok(None);
        };
        let s = self.session(session_id)?;
        let (catalog, settings) = self.resource_catalog(s.project(), s.scope.cwd()).await?;
        let Some(entry) = config::commands(&catalog)
            .into_iter()
            .find(|c| c.name == name)
        else {
            return Ok(None);
        };
        if entry.kind == CommandKind::BuiltIn && entry.name == "subtask" {
            return subtask(&entry, text, arguments).map(Some);
        }
        let Some(file) = ExpansionFile::from_catalog(&catalog, &entry) else {
            return Ok(None);
        };
        let fork = file
            .skill
            .and_then(|skill| skill.fork.as_ref().map(|options| (skill, options)))
            .map(|(skill, options)| Self::prepare_fork_skill(&s, &settings, skill, options))
            .transpose()?;
        let expanded = render(
            file.body,
            arguments,
            file.names,
            file.dir,
            fork.as_ref()
                .map_or(session_id, |run| run.session_id.as_str()),
            s.project(),
        );
        let context = self
            .user_prompt_expansion(
                session_id,
                expansion_fields(&entry, name, arguments, &expanded),
            )
            .await
            .map_err(|reason| {
                if let Some(run) = &fork {
                    self.discard_fork_effects(session_id, &run.session_id);
                }
                expansion_blocked(name, &reason)
            })?;
        let grant = if fork.is_some() {
            None
        } else {
            self.activate(
                &s,
                session_id,
                &settings,
                &Effects {
                    name,
                    source: entry.source,
                    file: file.path,
                    dir: file.dir,
                    allowed: &entry.allowed_tools,
                    hooks: file.hooks,
                },
            )
            .grant
        };
        Ok(Some(Expansion {
            text: expanded,
            command: PromptCommand {
                fork,
                name: name.to_owned(),
                kind: entry.kind,
                source: entry.source,
                arguments: arguments.to_owned(),
                input: text.trim().to_owned(),
            },
            grant,
            context,
        }))
    }

    /// Withdraws a turn grant of `session_id` whose input did not start or join a turn.
    pub(crate) fn revoke_turn_grant(&self, session_id: &str, grant: u64) {
        if let Ok(s) = self.session(session_id) {
            lock(&s.policy).revoke_turn_rules(grant);
        }
    }

    /// The directories `session_id`'s file tools may read as skills (tests).
    #[cfg(test)]
    pub(crate) fn skill_dirs(&self, session_id: &str) -> Vec<PathBuf> {
        self.session(session_id)
            .map(|s| lock(&s.skill_dirs).clone())
            .unwrap_or_default()
    }
}

/// The body and scoped effects of a command or a skill from the selected catalog.
struct ExpansionFile<'a> {
    body: &'a str,
    names: &'a [String],
    dir: Option<&'a Path>,
    path: &'a str,
    hooks: Option<&'a Value>,
    skill: Option<&'a config::Skill>,
}

impl<'a> ExpansionFile<'a> {
    fn from_catalog(
        catalog: &'a Catalog,
        entry: &piarc_protocol::skills::CommandInfo,
    ) -> Option<Self> {
        match entry.kind {
            CommandKind::Skill => {
                let s = catalog.skill(&entry.name)?;
                Some(Self {
                    body: &s.body,
                    names: &s.info.arguments,
                    dir: Some(Path::new(&s.info.dir)),
                    path: &s.info.path,
                    hooks: s.hooks.as_ref(),
                    skill: Some(s),
                })
            }
            CommandKind::Command => {
                let c = catalog.command(&entry.name)?;
                let path = c.info.path.as_deref().unwrap_or_default();
                Some(Self {
                    body: &c.body,
                    names: &c.info.arguments,
                    dir: Path::new(path).parent(),
                    path,
                    hooks: c.hooks.as_ref(),
                    skill: None,
                })
            }
            CommandKind::BuiltIn | CommandKind::McpPrompt => None,
        }
    }
}

fn subtask(
    entry: &piarc_protocol::skills::CommandInfo,
    text: &str,
    arguments: &str,
) -> Result<Expansion, ErrorObject> {
    if arguments.trim().is_empty() {
        return Err(ErrorObject::new(
            ErrorKind::InvalidParams,
            "/subtask requires a task.",
            false,
        ));
    }
    Ok(Expansion {
        text: arguments.to_owned(),
        grant: None,
        context: None,
        command: PromptCommand {
            name: entry.name.clone(),
            kind: entry.kind,
            source: entry.source,
            arguments: arguments.to_owned(),
            input: text.trim().to_owned(),
            fork: Some(ForkSkillRun {
                model: None,
                effort: None,
                session_id: crate::sessions::new_session_id().map_err(|e| e.to_error_object())?,
                agent: "fork".to_owned(),
                background: true,
            }),
        },
    })
}

/// The error of an input whose expansion a `UserPromptExpansion` hook blocked (T41).
pub(crate) fn expansion_blocked(name: &str, reason: &str) -> ErrorObject {
    let mut error = ErrorObject::new(
        ErrorKind::PermissionDenied,
        format!("A UserPromptExpansion hook blocked /{name}: {reason}"),
        false,
    );
    error.data.details = Some(json!({ "reason": "hookBlocked", "hookReason": reason }));
    error
}

/// A body with its arguments substituted and its variables replaced.
fn render(
    body: &str,
    arguments: &str,
    names: &[String],
    dir: Option<&Path>,
    session_id: &str,
    project: &Path,
) -> String {
    let vars = config::variables(dir, session_id, project);
    config::args::substitute(
        body.trim(),
        &Arguments {
            text: arguments,
            names,
            vars: &vars,
        },
    )
}

/// Whether the trust that applies covers a resource file's `allowed-tools` and hooks: a user
/// file always; a project file when the project is trusted and the file is one of its own,
/// listed by its trust manifest (R4 E1: not a worktree's copy or a directory above the root).
fn covered(source: ResourceSource, file: &str, project: &Path, trusted: bool) -> bool {
    // A package's skills and commands are instructions: their `allowed-tools` and hooks are
    // not among the executable items a user confirms (T40), so they do not apply.
    if source == ResourceSource::Plugin {
        return false;
    }
    !is_project(source)
        || (trusted && piarc_config::executables::covered_by_trust(project, Path::new(file)))
}

/// `UserPromptExpansion`'s input for a command file or skill the user typed (T41).
fn expansion_fields(
    entry: &piarc_protocol::skills::CommandInfo,
    name: &str,
    arguments: &str,
    expanded: &str,
) -> Map<String, Value> {
    let kind = if entry.kind == CommandKind::Skill {
        "skill"
    } else {
        "slash_command"
    };
    let mut fields = Map::new();
    fields.insert("expansion_type".into(), json!(kind));
    fields.insert("command_name".into(), json!(name));
    fields.insert("command_args".into(), json!(arguments));
    fields.insert("command_source".into(), json!(entry.source));
    fields.insert("prompt".into(), json!(expanded));
    fields
}
