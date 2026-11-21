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

/// Build (or reuse) the rule set of a call. `turn` holds the `allowed-tools` of the skills
/// and commands invoked in the current turn (T37): allow rules of source `skill`, after the
/// session's.
pub(super) fn rule_set(
    lists: &[PermissionLists],
    session: &[String],
    turn: &[String],
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
    (session, turn, &root_anchor).hash(&mut hasher);
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
    add("skill", root_anchor.clone(), None, turn);
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

/// `Tool(key:value)` deny and ask rules (I82): matched against the call's top-level scalar
/// arguments; they add to what the tool's own facts found and never allow.
pub(super) fn param_rules(
    rules: &RuleSet,
    tool: &str,
    input: &serde_json::Map<String, Value>,
    ladder: &mut Input,
) {
    let args: Vec<(&str, String)> = input
        .iter()
        .filter_map(|(key, value)| {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Bool(flag) => flag.to_string(),
                Value::Number(number) => number.to_string(),
                _ => return None,
            };
            Some((key.as_str(), text))
        })
        .collect();
    if ladder.deny.is_none()
        && ladder.enterprise.is_none()
        && let Some(hit) = rules.find_param(Behavior::Deny, tool, &args)
    {
        (ladder.enterprise, ladder.deny) = split_hit(hit);
    }
    if ladder.ask.is_none()
        && let Some(hit) = rules.find_param(Behavior::Ask, tool, &args)
    {
        ladder.ask = Some(MustAsk {
            step: "askRule",
            hit: Some(hit),
        });
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
    // Redirections write or read files the rule's command text does not name (R3).
    let compound = text.contains([
        ';', '|', '&', '\n', '\r', '`', '(', ')', '{', '}', '$', '@', '>', '<',
    ]);
    if compound && input.allowed {
        input.allow = rules.exact_allow("PowerShell", text).into_iter().collect();
        input.allowed = !input.allow.is_empty();
    }
    // A wildcard rule takes the command text, not the paths in it (ADR-0047).
    if input.allowed
        && input.allow.iter().any(|hit| hit.rule.contains('*'))
        && powershell_names_outside(places, text)
    {
        input.allow = rules.exact_allow("PowerShell", text).into_iter().collect();
        input.allowed = !input.allow.is_empty();
        input.outside = !input.allowed;
    }
    input.write = true;
    let rules_offered = if input.ask.is_none() {
        vec![format!("PowerShell({text})")]
    } else {
        Vec::new()
    };
    Assessment::new(input, rules_offered)
}

/// Whether a word of a PowerShell command that looks like a path (`C:\\x`, `\\\\server`, `~\\x`,
/// `..\\x`, anything with a separator, or the value of `-Name:value`) lies outside the
/// workspace, judged lexically (PowerShell is not parsed, architecture section 6.2.2); a word
/// with a variable cannot be placed.
fn powershell_names_outside(places: &Places, text: &str) -> bool {
    text.split_whitespace().skip(1).any(|word| {
        let word = word.trim_matches(['"', '\'']);
        let value = match word.strip_prefix('-') {
            Some(option) => match option.split_once(':') {
                Some((_, value)) => value,
                None => return false,
            },
            None => word,
        };
        if value.contains('$') {
            return true;
        }
        let pathlike = value.contains(['/', '\\'])
            || value.starts_with('~')
            || value == ".."
            || value.as_bytes().get(1) == Some(&b':');
        pathlike && !lexically_inside(places, value)
    })
}

fn lexically_inside(places: &Places, value: &str) -> bool {
    let slashed = value.replace('\\', "/");
    let absolute = match slashed.as_bytes() {
        [drive, b':', rest @ ..] if drive.is_ascii_alphabetic() => format!(
            "/{}{}",
            char::from(*drive).to_ascii_lowercase(),
            String::from_utf8_lossy(rest)
        ),
        [b'/', ..] => slashed.clone(),
        [b'~', rest @ ..] => format!("{}{}", places.home_posix, String::from_utf8_lossy(rest)),
        _ => format!("{}/{slashed}", places.cwd_posix),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in absolute.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let path = format!("/{}", parts.join("/"));
    let (path, root) = if places.fold {
        (path.to_lowercase(), places.root_posix.to_lowercase())
    } else {
        (path, places.root_posix.clone())
    };
    path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

/// A tool that needs the user on every call (an MCP tool's `requiresUserInteraction`, T36):
/// step 4 asks unless a deny or ask rule already decided, and nothing is offered to save.
pub(super) fn requires_user_interaction(assessment: &mut Assessment) {
    if assessment.input.ask.is_none() {
        assessment.input.ask = Some(MustAsk {
            step: "requiresUserInteraction",
            hit: None,
        });
    }
    assessment.rules.clear();
}

/// Tools matched by name, domain or type (MCP, WebFetch, Agent, Skill, others).
pub(super) fn other_call(
    rules: &RuleSet,
    places: &Places,
    tool: &str,
    input: &serde_json::Map<String, Value>,
) -> Assessment {
    let field = |k: &str| input.get(k).and_then(Value::as_str);
    // The parser `web/fetch` connects with (T29): the rule's host is the fetched host.
    let host = field("url").and_then(piarc_web::rule_host);
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
        // form of AskUserQuestion is shown by the tool itself (`ui/ask`) in every mode. `Agent`
        // (T31) only starts a subagent, whose own calls are each decided here; `Agent(<type>)`
        // deny and ask rules still apply to it.
        // `ToolSearch` (T36) only loads tool definitions into the conversation, `Skill` (T37)
        // a skill's instructions; `Skill(<name>)` deny and ask rules still apply.
        "TodoWrite" | "EnterPlanMode" | "SuggestNextSteps" | "AskUserQuestion" | "Agent"
        | "KillShell" | "ToolSearch" | "Skill" => {
            ladder.read_only = true;
            return Assessment::new(ladder, Vec::new());
        }
        "ExitPlanMode" => {
            ladder.exit_plan = true;
            return Assessment::new(ladder, Vec::new());
        }
        _ => {}
    }
    // A WebFetch call without a fetchable host offers no rule: `WebFetch` alone would allow
    // every domain.
    let offered = if ladder.ask.is_none()
        && !(tool == "WebFetch" && host.is_none())
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
    /// `Bash`, or `Monitor` (T32): whose rules apply.
    pub tool: &'static str,
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
    fn tool(&self) -> &str {
        self.tool
    }

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

/// Bash: analysis, rules, read-only list and Accept edits commands. A Monitor command (T32,
/// ADR-0049 rule 7) gets the same analysis and rules, but neither the read-only list nor
/// Accept edits lets it run unasked: only allow rules covering its other parts do.
pub(super) fn bash_call(rules: &RuleSet, facts: &BashFacts<'_>, text: &str) -> Assessment {
    let analysis = bash::analyze(text);
    let judgment = bash::judge(&analysis, rules, facts);
    let mut input = judgment.input(PermissionMode::Default);
    if facts.tool == "Monitor" {
        input.read_only = false;
        input.accept_edit = false;
        if input.allow.is_empty() {
            input.allowed = false;
        }
    }
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

#[cfg(test)]
mod tests {
    use piarc_policy::rules::{Behavior, RuleSet, Source};

    use super::{Places, powershell_call};

    fn places() -> Places {
        Places {
            home: "/home/u".into(),
            home_posix: "/home/u".into(),
            root_posix: "/home/u/proj".into(),
            cwd_posix: "/home/u/proj".into(),
            fold: true,
        }
    }

    /// R3 (review P11): a wildcard PowerShell allow rule takes the whole command, so a
    /// redirection (`>`, `>>`, `<`) must make it need an exact rule, like the other compound
    /// characters: `Get-Content a > C:\Users\me\x` writes a file.
    #[test]
    fn a_wildcard_powershell_allow_does_not_take_a_redirection() {
        let mut rules = RuleSet::default();
        rules.add_source(
            Source {
                id: "user".into(),
                anchor: "/home/u".into(),
            },
            [(Behavior::Allow, "PowerShell(Get-Content *)")],
        );
        let plain = powershell_call(&rules, &places(), "Get-Content notes.txt");
        assert!(plain.input.allowed, "{:?}", plain.input);
        for command in [
            r"Get-Content a > C:\Users\me\x",
            r"Get-Content a >> C:\Users\me\x",
            r"Get-Content < C:\secret",
        ] {
            let assessed = powershell_call(&rules, &places(), command);
            assert!(!assessed.input.allowed, "{command}: {:?}", assessed.input);
        }
    }

    /// ADR-0047: a wildcard PowerShell allow rule does not take a path outside the
    /// workspace; the call asks as outside. An exact rule still allows.
    #[test]
    fn a_wildcard_powershell_allow_does_not_take_an_outside_path() {
        let mut rules = RuleSet::default();
        rules.add_source(
            Source {
                id: "user".into(),
                anchor: "/home/u".into(),
            },
            [
                (Behavior::Allow, "PowerShell(Get-Content *)"),
                (Behavior::Allow, r"PowerShell(Get-Content C:\notes\a.txt)"),
            ],
        );
        for command in [
            r"Get-Content src\main.rs",
            "Get-Content ./notes.txt",
            r"Get-Content C:\notes\a.txt",
        ] {
            let assessed = powershell_call(&rules, &places(), command);
            assert!(assessed.input.allowed, "{command}: {:?}", assessed.input);
        }
        for command in [
            r"Get-Content C:\Users\me\.ssh\id_rsa",
            r"Get-Content ..\other\x",
            r"Get-Content ~\.aws\credentials",
            r"Get-Content -Path:C:\x",
        ] {
            let assessed = powershell_call(&rules, &places(), command);
            assert!(
                !assessed.input.allowed && assessed.input.outside,
                "{command}: {:?}",
                assessed.input
            );
        }
    }
}
