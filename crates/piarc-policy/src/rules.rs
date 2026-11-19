//! Permission rules: `Tool` or `Tool(specifier)` in the `deny`, `ask` and `allow` lists of each
//! settings source (architecture section 6.2.2).
//!
//! - Evaluation order is deny → ask → allow; the first hit decides and an allow cannot carve
//!   a hole in a deny. Sources only decide which hit is reported (highest first).
//! - Tool-name globs: deny and ask accept `*` anywhere (`*`, `mcp__*`); allow accepts a glob
//!   only after a literal `mcp__<server>__`.
//! - A rule that cannot be parsed is never dropped silently. An invalid allow rule is
//!   ignored. An invalid deny or ask rule makes every call of the tool it names ask (every
//!   call of any tool when no name is readable), and is reported with the source.

use crate::paths::{PathContext, PathPattern, list_matches};
use crate::pattern::Pattern;

/// The list a rule is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Behavior {
    /// `permissions.deny`.
    Deny,
    /// `permissions.ask`.
    Ask,
    /// `permissions.allow`.
    Allow,
}

impl Behavior {
    /// The settings key of the list.
    #[must_use]
    pub fn key(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Ask => "ask",
            Self::Allow => "allow",
        }
    }
}

/// How a rule names its tool.
#[derive(Debug, Clone)]
pub enum ToolMatch {
    /// One canonical name.
    Name(String),
    /// A glob over the full tool name.
    Glob(Pattern),
    /// `mcp__server`: every tool of the server.
    Server(String),
}

/// What the specifier constrains.
#[derive(Debug, Clone)]
pub enum Spec {
    /// Bash and PowerShell command text.
    Command(Pattern),
    /// A `Read` or `Edit` path.
    Path(PathPattern),
    /// A `WebFetch` host.
    Domain(String),
    /// An `Agent` type or `Skill` name.
    Name(Pattern),
    /// Accepted but never matches (for example `Write(path)`; use `Edit(path)`).
    Inert,
}

/// A parsed rule.
#[derive(Debug, Clone)]
pub struct Rule {
    /// The rule as written.
    pub text: String,
    /// Its tool part.
    pub tool: ToolMatch,
    /// `None` for every use of the tool.
    pub spec: Option<Spec>,
}

/// Why a rule was not usable.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidRule {
    /// The source id.
    pub source: String,
    /// The list.
    pub behavior: Behavior,
    /// The rule as written.
    pub rule: String,
    /// What is wrong.
    pub message: String,
    /// The tool every call of which now asks (deny and ask only); `*` for every tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asks_for: Option<String>,
}

/// A rule that decided a call, with its source for the audit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// The rule as written.
    pub rule: String,
    /// The source id (`session`, `projectLocal`, `project`, `user`, ...).
    pub source: String,
    /// The list.
    pub behavior: Behavior,
}

/// Which built-in tools a rule's tool name covers.
#[must_use]
pub fn covered_tools(name: &str) -> &'static [&'static str] {
    match name {
        "Read" => &["Read", "Glob", "Grep"],
        "Edit" => &["Edit", "Write", "NotebookEdit"],
        "Bash" => &["Bash", "Monitor"],
        _ => &[],
    }
}

fn names_tool(rule_tool: &str, tool: &str) -> bool {
    rule_tool == tool || covered_tools(rule_tool).contains(&tool)
}

/// Parse a rule for a list.
///
/// # Errors
///
/// The message for the settings page and the audit.
pub fn parse(text: &str, behavior: Behavior) -> Result<Rule, String> {
    let trimmed = text.trim();
    let (name, spec) = match trimmed.find('(') {
        Some(open) => {
            let inner = trimmed[open + 1..]
                .strip_suffix(')')
                .ok_or("a specifier must end with \")\"")?;
            (&trimmed[..open], Some(inner))
        }
        None => (trimmed, None),
    };
    if name.is_empty() {
        return Err("missing tool name".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '*' | '.'))
    {
        return Err(format!("invalid tool name {name:?}"));
    }
    let tool = tool_match(name, behavior)?;
    let spec = match spec {
        None => None,
        // `Bash(*)` is `Bash`. A path `*` keeps its gitignore meaning (below the cwd).
        Some(s)
            if s.trim() == "*"
                && !name.starts_with("mcp__")
                && !matches!(name, "Read" | "Edit") =>
        {
            None
        }
        Some(s) if s.trim().is_empty() => return Err("empty specifier".into()),
        Some(s) => Some(specifier(name, s, behavior)?),
    };
    Ok(Rule {
        text: trimmed.to_owned(),
        tool,
        spec,
    })
}

fn tool_match(name: &str, behavior: Behavior) -> Result<ToolMatch, String> {
    if !name.contains('*') {
        if let Some(server) = name.strip_prefix("mcp__")
            && !server.is_empty()
            && !server.contains("__")
        {
            return Ok(ToolMatch::Server(server.to_owned()));
        }
        return Ok(ToolMatch::Name(name.to_owned()));
    }
    if behavior == Behavior::Allow {
        let anchored = name.strip_prefix("mcp__").and_then(|rest| {
            let (server, _) = rest.split_once("__")?;
            (!server.is_empty() && !server.contains('*')).then_some(())
        });
        if anchored.is_none() {
            return Err(
                "an allow rule accepts a tool-name wildcard only after mcp__<server>__".into(),
            );
        }
    }
    Ok(ToolMatch::Glob(Pattern::new(name, false)))
}

fn specifier(name: &str, spec: &str, behavior: Behavior) -> Result<Spec, String> {
    let deny_like = behavior != Behavior::Allow;
    Ok(match name {
        _ if name.starts_with("mcp__") || name.contains('*') => {
            return Err("MCP and wildcard tool rules take no specifier".into());
        }
        "Bash" | "Monitor" => Spec::Command(Pattern::new(spec, false)),
        "PowerShell" => Spec::Command(Pattern::new(spec, true)),
        "Read" | "Edit" => Spec::Path(PathPattern::parse(spec, deny_like)?),
        "Write" | "NotebookEdit" | "Glob" | "Grep" => Spec::Inert,
        "WebFetch" => {
            let host = spec
                .strip_prefix("domain:")
                .ok_or("a WebFetch rule needs domain:<host>")?
                .trim()
                .trim_end_matches('.')
                .to_ascii_lowercase();
            if host.is_empty() || host.contains(['/', ' ', ':']) {
                return Err(format!("invalid domain {host:?}"));
            }
            Spec::Domain(host)
        }
        "Agent" | "Skill" => Spec::Name(Pattern::new(spec, false)),
        _ => Spec::Inert,
    })
}

/// The tool name read from an invalid rule, if any.
fn named_tool(text: &str) -> Option<String> {
    let name = text.trim().split('(').next()?.trim();
    (!name.is_empty()
        && !name.contains('*')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
    .then(|| name.to_owned())
}

impl Rule {
    /// Whether the rule's tool part names `tool`.
    #[must_use]
    pub fn names(&self, tool: &str) -> bool {
        match &self.tool {
            ToolMatch::Name(name) => names_tool(name, tool),
            ToolMatch::Glob(pattern) => pattern.covers(tool),
            ToolMatch::Server(server) => tool
                .strip_prefix("mcp__")
                .and_then(|rest| rest.strip_prefix(server.as_str()))
                .is_some_and(|rest| rest.starts_with("__")),
        }
    }

    fn base_tool(&self) -> Option<&str> {
        match &self.tool {
            ToolMatch::Name(name) => Some(name),
            _ => None,
        }
    }
}

/// A rule source in precedence order (ADR-0005), with the directory `/path` patterns of its
/// rules are anchored at.
#[derive(Debug, Clone)]
pub struct Source {
    /// Stable id (`enterprise`, `session`, `projectLocal`, `project`, `claudeProjectLocal`,
    /// `claudeProject`, `user`, `claudeUser`).
    pub id: String,
    /// POSIX form of the anchor directory.
    pub anchor: String,
}

#[derive(Debug, Clone)]
struct Entry {
    rule: Rule,
    behavior: Behavior,
    source: usize,
}

/// The rules of one call: every source's lists, highest precedence first.
#[derive(Debug, Clone, Default)]
pub struct RuleSet {
    sources: Vec<Source>,
    entries: Vec<Entry>,
    invalid: Vec<InvalidRule>,
}

/// The facts a call is matched on.
#[derive(Debug, Clone, Copy)]
pub enum Subject<'a> {
    /// Any tool, by name only.
    Tool,
    /// A command text (one Bash subcommand, or a whole PowerShell command).
    Command(&'a str),
    /// Absolute POSIX paths the call touches.
    Paths(&'a [String]),
    /// The host of a fetch.
    Domain(&'a str),
    /// An agent type or skill name.
    Name(&'a str),
}

/// How sure a match is when the command contains text computed at run time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Certainty {
    /// Matches for every run-time value.
    Certain,
    /// Matches for some run-time value.
    Possible,
}

impl RuleSet {
    /// Add a source after the existing (higher precedence) ones, with its three lists.
    pub fn add_source<'a>(
        &mut self,
        source: Source,
        lists: impl IntoIterator<Item = (Behavior, &'a str)>,
    ) {
        let index = self.sources.len();
        for (behavior, text) in lists {
            match parse(text, behavior) {
                Ok(rule) => self.entries.push(Entry {
                    rule,
                    behavior,
                    source: index,
                }),
                Err(message) => {
                    let asks_for = (behavior != Behavior::Allow)
                        .then(|| named_tool(text).unwrap_or_else(|| "*".into()));
                    self.invalid.push(InvalidRule {
                        source: source.id.clone(),
                        behavior,
                        rule: text.to_owned(),
                        message,
                        asks_for,
                    });
                }
            }
        }
        self.sources.push(source);
    }

    /// Rules that could not be parsed.
    #[must_use]
    pub fn invalid(&self) -> &[InvalidRule] {
        &self.invalid
    }

    fn hit(&self, entry: &Entry) -> Hit {
        Hit {
            rule: entry.rule.text.clone(),
            source: self.sources[entry.source].id.clone(),
            behavior: entry.behavior,
        }
    }

    /// An invalid deny or ask rule covering `tool`, which makes the call ask.
    #[must_use]
    pub fn invalid_for(&self, tool: &str) -> Option<Hit> {
        self.invalid
            .iter()
            .find(|i| {
                i.asks_for
                    .as_deref()
                    .is_some_and(|t| t == "*" || names_tool(t, tool))
            })
            .map(|i| Hit {
                rule: i.rule.clone(),
                source: i.source.clone(),
                behavior: i.behavior,
            })
    }

    /// The first rule of `behavior` that names the whole tool (no specifier). A deny hit
    /// removes the tool from the model's tool list.
    #[must_use]
    pub fn whole_tool(&self, behavior: Behavior, tool: &str) -> Option<Hit> {
        self.entries
            .iter()
            .filter(|e| e.behavior == behavior && e.rule.spec.is_none())
            .find(|e| e.rule.names(tool))
            .map(|e| self.hit(e))
    }

    /// The first rule of `behavior` that matches the call, with how sure the match is.
    #[must_use]
    pub fn find(
        &self,
        behavior: Behavior,
        tool: &str,
        subject: Subject<'_>,
        ctx: Option<&PathContext<'_>>,
    ) -> Option<(Hit, Certainty)> {
        for entry in self.entries.iter().filter(|e| e.behavior == behavior) {
            if !entry.rule.names(tool) {
                continue;
            }
            let certainty = match (&entry.rule.spec, subject) {
                (None, _) => Some(Certainty::Certain),
                (Some(Spec::Command(p)), Subject::Command(text)) => {
                    if p.covers(text) {
                        Some(Certainty::Certain)
                    } else if behavior != Behavior::Allow && p.may_match(text) {
                        Some(Certainty::Possible)
                    } else {
                        None
                    }
                }
                (Some(Spec::Path(_)), Subject::Paths(paths)) => self
                    .path_hit(entry, paths, ctx)
                    .then_some(Certainty::Certain),
                (Some(Spec::Domain(rule)), Subject::Domain(host)) => {
                    domain_matches(rule, host).then_some(Certainty::Certain)
                }
                (Some(Spec::Name(p)), Subject::Name(name)) => {
                    p.covers(name).then_some(Certainty::Certain)
                }
                _ => None,
            };
            if let Some(certainty) = certainty {
                return Some((self.hit(entry), certainty));
            }
        }
        None
    }

    /// The first allow rule that is bare or names exactly this command: the only rules that
    /// allow an exec wrapper or `find` with an action.
    #[must_use]
    pub fn exact_allow(&self, tool: &str, text: &str) -> Option<Hit> {
        self.entries
            .iter()
            .filter(|e| e.behavior == Behavior::Allow && e.rule.names(tool))
            .find(|e| match &e.rule.spec {
                None => true,
                Some(Spec::Command(p)) => p.is_exact() && p.covers(text),
                _ => false,
            })
            .map(|e| self.hit(e))
    }

    /// Path rules use the source's whole list (negations). Deny and ask need any path to
    /// match; allow needs every path.
    fn path_hit(&self, entry: &Entry, paths: &[String], ctx: Option<&PathContext<'_>>) -> bool {
        let (Some(Spec::Path(pattern)), Some(ctx)) = (&entry.rule.spec, ctx) else {
            return false;
        };
        if paths.is_empty() || pattern.negated {
            return false;
        }
        let ctx = PathContext {
            anchor: &self.sources[entry.source].anchor,
            ..*ctx
        };
        let family = entry.rule.base_tool();
        let list: Vec<&PathPattern> = self
            .entries
            .iter()
            .filter(|e| {
                e.source == entry.source
                    && e.behavior == entry.behavior
                    && e.rule.base_tool() == family
            })
            .filter_map(|e| match &e.rule.spec {
                Some(Spec::Path(p)) => Some(p),
                _ => None,
            })
            .collect();
        let hit = |path: &String| {
            pattern.matches(path, &ctx) && list_matches(list.iter().copied(), path, &ctx)
        };
        if entry.behavior == Behavior::Allow {
            paths.iter().all(hit)
        } else {
            paths.iter().any(hit)
        }
    }

    /// Whether a rule text would be broad: a bare or `*` command rule, or a program-only
    /// prefix such as `Bash(git *)` (shown as a hint, not an error).
    #[must_use]
    pub fn is_broad(text: &str) -> bool {
        let Ok(rule) = parse(text, Behavior::Allow) else {
            return false;
        };
        match (&rule.tool, &rule.spec) {
            (ToolMatch::Name(name), None) => {
                matches!(
                    name.as_str(),
                    "Bash" | "PowerShell" | "Read" | "Edit" | "WebFetch"
                )
            }
            (_, Some(Spec::Command(p))) => {
                let prefix = p.literal_prefix();
                let words = prefix.split_whitespace().count();
                !p.is_exact() && (words <= 1 || (words == 2 && !prefix.ends_with(' ')))
            }
            (_, Some(Spec::Domain(host))) => host == "*",
            (_, Some(Spec::Path(_))) => {
                let spec = text
                    .split_once('(')
                    .map_or("", |(_, s)| s.trim_end_matches(')'));
                matches!(spec, "**" | "//**" | "~/**" | "/**" | "./**")
            }
            _ => false,
        }
    }
}

/// WebFetch hosts: case-insensitive, trailing dot ignored; `*.example.com` covers every
/// subdomain but not the apex; `*` covers every host; elsewhere `*` stays within a label.
#[must_use]
pub fn domain_matches(rule: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if rule == "*" {
        return true;
    }
    let host_labels: Vec<&str> = host.split('.').collect();
    if let Some(suffix) = rule.strip_prefix("*.") {
        let suffix: Vec<&str> = suffix.split('.').collect();
        return host_labels.len() > suffix.len()
            && suffix
                .iter()
                .zip(&host_labels[host_labels.len() - suffix.len()..])
                .all(|(r, h)| labels_match(r, h));
    }
    let rule_labels: Vec<&str> = rule.split('.').collect();
    rule_labels.len() == host_labels.len()
        && rule_labels
            .iter()
            .zip(&host_labels)
            .all(|(r, h)| labels_match(r, h))
}

fn labels_match(rule: &str, label: &str) -> bool {
    Pattern::new(rule, true).covers(label)
}

#[cfg(test)]
mod tests;
