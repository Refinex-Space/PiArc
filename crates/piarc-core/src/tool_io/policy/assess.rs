//! The rules and facts of one call, turned into the decision ladder's input (T23).
//!
//! - Rule sources, highest first: enterprise (M5), the session's rules, then the settings
//!   layers in ADR-0005 order. `/path` patterns are anchored at the workspace root for
//!   project and session rules and at the settings file's directory for user files.
//! - Bash: `piarc_policy::bash` analyzes and judges the text; [`BashFacts`] resolves its
//!   paths with the session's scope and its programs the way the command's bash will.
//! - PowerShell: the whole text is matched; a rule with `*` allows it only when the text has
//!   no statement separator or subexpression, and a deny or ask rule that matches one of the
//!   rough segments asks.
use std::cell::RefCell;
use std::hash::{Hash, Hasher};

use piarc_config::{PermissionLists, Scope as LayerScope};
use piarc_policy::bash::{self, CriticalContext, Facts, Located, Operand};
use piarc_policy::paths::{PathContext, escape, posix};
use piarc_policy::pattern::DYNAMIC;
use piarc_policy::rules::{
    Behavior, Certainty, Hit, RuleSet, Source, Subject, powershell_segments,
};
use piarc_policy::{Input, MustAsk};

use super::*;

/// The user's home directory, canonical.
pub(super) fn home() -> PathBuf {
    std::env::home_dir()
        .map(|h| h.canonicalize().unwrap_or(h))
        .unwrap_or_default()
}

/// Build (or reuse) the rule set of a call.
pub(super) fn rule_set(
    lists: &[PermissionLists],
    session: &[String],
    root: &Path,
    cache: &mut Option<(u64, Arc<RuleSet>)>,
) -> Arc<RuleSet> {
    let root_anchor = posix(root);
    let anchor = |l: &PermissionLists| match (l.scope, &l.file) {
        (LayerScope::User | LayerScope::Enterprise, Some(file)) => {
            file.parent().map_or_else(|| root_anchor.clone(), posix)
        }
        _ => root_anchor.clone(),
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (session, &root_anchor).hash(&mut hasher);
    for l in lists {
        (l.layer, anchor(l), &l.deny, &l.ask, &l.allow).hash(&mut hasher);
    }
    let key = hasher.finish();
    if let Some((k, set)) = cache
        && *k == key
    {
        return Arc::clone(set);
    }
    let mut set = RuleSet::default();
    let mut add = |id: &str, anchor: String, l: Option<&PermissionLists>, session: &[String]| {
        let lists = l
            .map(|l| {
                l.deny
                    .iter()
                    .map(|r| (Behavior::Deny, r.as_str()))
                    .chain(l.ask.iter().map(|r| (Behavior::Ask, r.as_str())))
                    .chain(l.allow.iter().map(|r| (Behavior::Allow, r.as_str())))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        set.add_source(
            Source {
                id: id.to_owned(),
                anchor,
            },
            lists
                .into_iter()
                .chain(session.iter().map(|r| (Behavior::Allow, r.as_str()))),
        );
    };
    let (enterprise, others): (Vec<_>, Vec<_>) = lists
        .iter()
        .partition(|l| l.scope == LayerScope::Enterprise);
    for l in enterprise {
        add(l.layer, anchor(l), Some(l), &[]);
    }
    add("session", root_anchor.clone(), None, session);
    for l in others {
        add(l.layer, anchor(l), Some(l), &[]);
    }
    let set = Arc::new(set);
    *cache = Some((key, Arc::clone(&set)));
    set
}

/// What the preflight found for one call.
pub(super) struct Assessment {
    /// The ladder input without the mode.
    pub input: Input,
    /// Rules "always allow" would save.
    pub rules: Vec<String>,
    /// Programs an automatic Bash allowance relies on.
    pub programs: Vec<(String, PathBuf)>,
    /// Paths an automatic Bash allowance checked, to check again at execution.
    pub targets: Vec<(PathBuf, bool)>,
}

impl Assessment {
    fn new(input: Input, rules: Vec<String>) -> Self {
        Self {
            input,
            rules,
            programs: Vec::new(),
            targets: Vec::new(),
        }
    }
}

/// The paths and directories rule matching needs, in POSIX form.
pub(super) struct Places {
    pub home: PathBuf,
    pub home_posix: String,
    pub root_posix: String,
    pub cwd_posix: String,
    pub fold: bool,
}

impl Places {
    pub(super) fn new(scope: &piarc_fs::Scope) -> Self {
        let home = home();
        Self {
            home_posix: posix(&home),
            home,
            root_posix: posix(scope.root()),
            cwd_posix: posix(scope.cwd()),
            fold: scope.case_insensitive(),
        }
    }

    fn context(&self) -> PathContext<'_> {
        PathContext {
            home: &self.home_posix,
            cwd: &self.cwd_posix,
            anchor: &self.root_posix,
            fold_case: self.fold,
        }
    }
}

fn split_hit(hit: Hit) -> (Option<Hit>, Option<Hit>) {
    if hit.source == "enterprise" {
        (Some(hit), None)
    } else {
        (None, Some(hit))
    }
}

/// Deny, ask, invalid rules and allow for a call matched by tool name and one subject.
fn plain(rules: &RuleSet, tool: &str, subject: Subject<'_>, ctx: &PathContext<'_>) -> Input {
    let mut input = Input::default();
    let deny_tools: Vec<&str> = if matches!(tool, "Write" | "Edit") {
        vec![tool, "Read"]
    } else {
        vec![tool]
    };
    for t in deny_tools {
        if let Some((hit, Certainty::Certain)) = rules.find(Behavior::Deny, t, subject, Some(ctx)) {
            (input.enterprise, input.deny) = split_hit(hit);
            break;
        }
    }
    if let Some((hit, _)) = rules.find(Behavior::Ask, tool, subject, Some(ctx)) {
        input.ask = Some(MustAsk {
            step: "askRule",
            hit: Some(hit),
        });
    } else if let Some(hit) = rules.invalid_for(tool) {
        input.ask = Some(MustAsk {
            step: "invalidRule",
            hit: Some(hit),
        });
    }
    if let Some((hit, _)) = rules.find(Behavior::Allow, tool, subject, Some(ctx)) {
        input.allow = vec![hit];
        input.allowed = true;
    }
    input
}

/// Read, Glob, Grep, Write and Edit: rules on the path as named and as resolved.
pub(super) fn file_call(
    rules: &RuleSet,
    places: &Places,
    tool: &str,
    lexical: &Path,
    resolved: &Path,
    boundary: Boundary,
) -> Assessment {
    let mut paths = vec![posix(lexical)];
    let real = posix(resolved);
    if !paths.contains(&real) {
        paths.push(real);
    }
    let mut input = plain(rules, tool, Subject::Paths(&paths), &places.context());
    let write = matches!(tool, "Write" | "Edit");
    input.write = write;
    input.protected = boundary == Boundary::Protected;
    input.outside = boundary == Boundary::Outside;
    input.read_only = !write && boundary == Boundary::Inside;
    input.accept_edit = write && boundary == Boundary::Inside;
    let family = if write { "Edit" } else { "Read" };
    let rule = format!("{family}({})", path_rule(resolved, places));
    Assessment::new(input, vec![rule])
}

/// A path as a rule names it: `./rel` under the session's directory, `~/rel` under home,
/// `//abs` elsewhere, with pattern characters escaped.
fn path_rule(path: &Path, places: &Places) -> String {
    let text = posix(path);
    let under = |base: &str| {
        text.strip_prefix(base)
            .and_then(|r| r.strip_prefix('/'))
            .map(escape)
    };
    if let Some(rel) = under(&places.cwd_posix) {
        format!("./{rel}")
    } else if let Some(rel) = under(&places.home_posix) {
        format!("~/{rel}")
    } else {
        format!("/{}", escape(&text))
    }
}

/// PowerShell: no splitting (architecture section 6.2.2).
pub(super) fn powershell_call(rules: &RuleSet, places: &Places, text: &str) -> Assessment {
    let ctx = places.context();
    let mut input = plain(rules, "PowerShell", Subject::Command(text), &ctx);
    if input.deny.is_none() && input.enterprise.is_none() && input.ask.is_none() {
        for segment in powershell_segments(text) {
            let hit = rules
                .find(
                    Behavior::Deny,
                    "PowerShell",
                    Subject::Command(segment),
                    None,
                )
                .or_else(|| {
                    rules.find(Behavior::Ask, "PowerShell", Subject::Command(segment), None)
                });
            if let Some((hit, _)) = hit {
                input.ask = Some(MustAsk {
                    step: "askRule",
                    hit: Some(hit),
                });
                break;
            }
        }
    }
    let compound = text.contains([';', '|', '&', '\n', '\r', '`', '(', ')', '{', '}', '$', '@']);
    if compound && input.allowed {
        input.allow = rules.exact_allow("PowerShell", text).into_iter().collect();
        input.allowed = !input.allow.is_empty();
    }
    input.write = true;
    let rules_offered = if input.ask.is_none() {
        vec![format!("PowerShell({text})")]
    } else {
        Vec::new()
    };
    Assessment::new(input, rules_offered)
}

/// Tools matched by name, domain or type (MCP, WebFetch, Agent, Skill, others).
pub(super) fn other_call(
    rules: &RuleSet,
    places: &Places,
    tool: &str,
    input: &serde_json::Map<String, Value>,
) -> Assessment {
    let field = |k: &str| input.get(k).and_then(Value::as_str);
    let host = field("url")
        .and_then(|u| u.split_once("://").map(|(_, rest)| rest))
        .map(|rest| {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
            let host = authority.rsplit('@').next().unwrap_or_default();
            host.rsplit_once(':')
                .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
                .map_or(host, |(h, _)| h)
                .to_ascii_lowercase()
        });
    let name = match tool {
        "Agent" => field("subagent_type"),
        "Skill" => field("skill"),
        _ => None,
    };
    let (subject, suggestion) = match (tool, &host, name) {
        ("WebFetch", Some(h), _) if !h.is_empty() => {
            (Subject::Domain(h), format!("WebFetch(domain:{h})"))
        }
        ("Agent" | "Skill", _, Some(n)) => (Subject::Name(n), format!("{tool}({n})")),
        _ => (Subject::Tool, tool.to_owned()),
    };
    let mut ladder = plain(rules, tool, subject, &places.context());
    match tool {
        // The Harness Kit's host tools (T26) change no file and run no command. The question
        // form of AskUserQuestion is shown by the tool itself (`ui/ask`) in every mode.
        "TodoWrite" | "EnterPlanMode" | "SuggestNextSteps" | "AskUserQuestion" => {
            ladder.read_only = true;
            return Assessment::new(ladder, Vec::new());
        }
        "ExitPlanMode" => {
            ladder.exit_plan = true;
            return Assessment::new(ladder, Vec::new());
        }
        _ => {}
    }
    let offered = if ladder.ask.is_none()
        && piarc_policy::rules::parse(&suggestion, Behavior::Allow).is_ok()
    {
        vec![suggestion]
    } else {
        Vec::new()
    };
    Assessment::new(ladder, offered)
}

/// Resolves a Bash command's paths and programs for `piarc_policy::bash::judge`.
pub(super) struct BashFacts<'a> {
    pub scope: &'a piarc_fs::Scope,
    pub shell_cwd: &'a Path,
    pub shell_cwd_posix: String,
    pub places: &'a Places,
    pub programs: &'a exec::utility::Programs,
    pub resolved: RefCell<Vec<(String, PathBuf)>>,
    pub targets: RefCell<Vec<(PathBuf, bool)>>,
}

impl BashFacts<'_> {
    fn expand(&self, text: &str) -> Option<PathBuf> {
        if text == "~" {
            return Some(self.places.home.clone());
        }
        if let Some(rest) = text.strip_prefix("~/") {
            return Some(self.places.home.join(rest));
        }
        if text.starts_with('~') {
            return None;
        }
        #[cfg(windows)]
        if text.starts_with('/') {
            return piarc_exec::shells::msys_to_windows(text).map(PathBuf::from);
        }
        Some(PathBuf::from(text))
    }
}

/// `path` with `.` and `..` removed lexically.
pub(super) fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            part => out.push(part.as_os_str()),
        }
    }
    out
}

impl Facts for BashFacts<'_> {
    fn locate(&self, operand: &Operand, write: bool) -> Option<Located> {
        let text = &operand.word.text;
        if text.contains(DYNAMIC) || text.is_empty() {
            return None;
        }
        let text = if operand.word.glob {
            let cut = text.find(['*', '?', '[', '{']).unwrap_or(text.len());
            if text[cut..].split('/').any(|c| c == "..") {
                return None;
            }
            text[..cut]
                .rsplit_once('/')
                .map_or(".", |(dir, _)| dir)
                .to_owned()
        } else {
            text.clone()
        };
        let named = self.expand(if text.is_empty() { "/" } else { &text })?;
        let full = if named.is_absolute() {
            named
        } else {
            let bash::Cwd::Known(rel) = &operand.cwd else {
                return None;
            };
            let base = if rel.is_empty() {
                self.shell_cwd.to_path_buf()
            } else {
                let rel = self.expand(rel)?;
                if rel.is_absolute() {
                    rel
                } else {
                    self.shell_cwd.join(rel)
                }
            };
            base.join(named)
        };
        let lexical = lexical(&full);
        let shown = display(&lexical);
        let resolved = self.scope.locate(&shown).ok()?;
        let boundary = path_boundary(self.scope, &shown, write).ok()?;
        self.targets.borrow_mut().push((lexical.clone(), write));
        let mut paths = vec![posix(&lexical)];
        let real = posix(&resolved);
        if !paths.contains(&real) {
            paths.push(real);
        }
        Some(Located {
            paths,
            inside: boundary != Boundary::Outside,
            protected: boundary == Boundary::Protected,
        })
    }

    fn program_ok(&self, name: &str) -> bool {
        if let Some((_, _)) = self.resolved.borrow().iter().find(|(n, _)| n == name) {
            return true;
        }
        match self.programs.resolve(self.scope, name) {
            Some(path) => {
                self.resolved.borrow_mut().push((name.to_owned(), path));
                true
            }
            None => false,
        }
    }

    fn path_context(&self) -> PathContext<'_> {
        self.places.context()
    }

    fn critical_context(&self) -> CriticalContext<'_> {
        CriticalContext {
            home: &self.places.home_posix,
            root: &self.places.root_posix,
            cwd: &self.shell_cwd_posix,
            fold_case: self.places.fold,
        }
    }
}

/// Bash: analysis, rules, read-only list and Accept edits commands.
pub(super) fn bash_call(rules: &RuleSet, facts: &BashFacts<'_>, text: &str) -> Assessment {
    let analysis = bash::analyze(text);
    let judgment = bash::judge(&analysis, rules, facts);
    let mut input = judgment.input(PermissionMode::Default);
    if let Some(hit) = input.deny.take() {
        (input.enterprise, input.deny) = split_hit(hit);
    }
    let offered = if judgment.ask.is_none() && !judgment.tainted {
        bash::suggestions(judgment.missing.iter().map(|&i| &analysis.commands[i]))
    } else {
        Vec::new()
    };
    let programs = facts
        .resolved
        .borrow()
        .iter()
        .filter(|(n, _)| judgment.programs.contains(n))
        .cloned()
        .collect();
    Assessment {
        input,
        rules: offered,
        programs,
        targets: facts.targets.take(),
    }
}
