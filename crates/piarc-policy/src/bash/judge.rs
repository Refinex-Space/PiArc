//! Rules and the mode defaults applied to an analyzed Bash command.
//!
//! - Deny and ask: any command (shadows included) that a rule matches, any path target an
//!   `Edit` or `Read` rule matches. A rule that matches only for some run-time value asks.
//! - Allow: every primary command is allowed by a rule or is a read-only command whose
//!   program Core verified and whose path operands are inside the session's directories, and
//!   every redirection or `tee` target is allowed (an `Edit` rule, or Accept edits inside the
//!   workspace for writes; inside or a `Read` rule for reads). Accept edits also takes the
//!   literal `mkdir`, `touch`, `mv`, `cp` commands.
//! - A wildcard allow rule takes the command text, not the paths in it: when an argument of a
//!   command it allows names a path outside the session's directories (or one Core cannot
//!   place), the call asks as outside the workspace (ADR-0047). An exact rule names the paths
//!   itself and still allows.

use super::readonly::BUILTINS;
use super::wrappers::EXEC_RUNNERS;
use super::{
    Analysis, Class, Command, CriticalContext, Operand, Unresolved, classify, is_critical_delete,
};
use crate::decision::{Input, MustAsk};
use crate::paths::PathContext;
use crate::rules::{Behavior, Certainty, Hit, RuleSet, Subject};
use piarc_protocol::policy::PermissionMode;

/// A path target as Core resolved it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    /// POSIX forms to match rules against (the path as named and as resolved).
    pub paths: Vec<String>,
    /// Inside the session's directories.
    pub inside: bool,
    /// A protected path (`.git/`, `.piarc/`, ...) when written.
    pub protected: bool,
}

/// What Core knows about the call's environment.
pub trait Facts {
    /// Resolve an operand; `None` when it cannot be resolved statically.
    fn locate(&self, operand: &Operand, write: bool) -> Option<Located>;
    /// Whether `name` resolves to a program Core can pin for this command.
    fn program_ok(&self, name: &str) -> bool;
    /// The directories path rules are anchored at.
    fn path_context(&self) -> PathContext<'_>;
    /// The directories critical deletions are judged against.
    fn critical_context(&self) -> CriticalContext<'_>;
    /// The tool whose rules apply: `Bash`, or `Monitor` (T32: `Bash(…)` rules cover Monitor
    /// commands, `Monitor(…)` rules only Monitor).
    fn tool(&self) -> &str {
        "Bash"
    }
}

/// Why a command needs the user regardless of allow rules and modes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskCause {
    /// A critical path deletion.
    Critical,
    /// The text cannot be judged statically.
    Unresolved(Unresolved),
    /// An ask rule matched, or a deny rule may match a run-time value.
    Rule(Hit),
    /// An invalid deny or ask rule names Bash.
    InvalidRule(Hit),
}

/// The rule and default outcome for a Bash command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Judgment {
    /// A deny rule that matches for certain.
    pub deny: Option<Hit>,
    /// The first reason to ask.
    pub ask: Option<AskCause>,
    /// An assignment changes how commands resolve; no automatic allow.
    pub tainted: bool,
    /// Nothing is written (plan mode).
    pub read_only: bool,
    /// A write target is protected.
    pub protected: bool,
    /// Allowed without the mode's help, with the allow rules used (empty: read-only only).
    pub manual: Option<Vec<Hit>>,
    /// Allowed in Accept edits.
    pub accept: bool,
    /// Programs the automatic allowance depends on (pinned at execution).
    pub programs: Vec<String>,
    /// Indices into [`Analysis::commands`] of primary commands no rule or default allows.
    pub missing: Vec<usize>,
    /// A command allowed only by a wildcard rule names a path outside (ADR-0047).
    pub outside: bool,
}

impl Judgment {
    /// The decision ladder's input for this command in `mode`.
    #[must_use]
    pub fn input(&self, mode: PermissionMode) -> Input {
        let ask = self.ask.as_ref().map(|cause| match cause {
            AskCause::Critical => MustAsk {
                step: "criticalPath",
                hit: None,
            },
            AskCause::Unresolved(_) => MustAsk {
                step: "unresolved",
                hit: None,
            },
            AskCause::Rule(hit) => MustAsk {
                step: "askRule",
                hit: Some(hit.clone()),
            },
            AskCause::InvalidRule(hit) => MustAsk {
                step: "invalidRule",
                hit: Some(hit.clone()),
            },
        });
        Input {
            mode,
            deny: self.deny.clone(),
            ask,
            write: !self.read_only,
            protected: self.protected,
            tainted: self.tainted,
            allow: self.manual.clone().unwrap_or_default(),
            allowed: self.manual.is_some(),
            outside: self.outside,
            accept_edit: self.accept,
            ..Input::default()
        }
    }
}

struct Targets {
    /// Path operands of the command itself.
    operands: Vec<Operand>,
    /// Input redirections.
    inputs: Vec<Operand>,
    /// Output redirections and `tee` files.
    writes: Vec<Operand>,
}

fn targets(command: &Command, class: &Class) -> Targets {
    let (operands, mut writes) = match class {
        Class::ReadOnly { reads, writes } | Class::FileEdit { reads, writes } => {
            (reads.clone(), writes.clone())
        }
        Class::Other => (Vec::new(), Vec::new()),
    };
    let mut inputs = Vec::new();
    for r in &command.redirects {
        let operand = Operand {
            word: r.target.clone(),
            cwd: command.cwd.clone(),
        };
        if r.write {
            writes.push(operand);
        } else {
            inputs.push(operand);
        }
    }
    Targets {
        operands,
        inputs,
        writes,
    }
}

/// Apply the rules to an analysis.
#[must_use]
pub fn judge(analysis: &Analysis, rules: &RuleSet, facts: &dyn Facts) -> Judgment {
    let mut j = Judgment {
        tainted: !analysis.unsafe_assignments.is_empty(),
        read_only: true,
        ..Judgment::default()
    };
    let mut causes = Vec::new();
    if let Some(reason) = analysis.unresolved.first() {
        causes.push(AskCause::Unresolved(reason.clone()));
    }
    if let Some(hit) = rules.invalid_for(facts.tool()) {
        causes.push(AskCause::InvalidRule(hit));
    }
    let ctx = facts.path_context();
    let mut manual = Some(Vec::new());
    let mut accept = true;
    for (index, command) in analysis.commands.iter().enumerate() {
        let class = classify(command);
        let targets = targets(command, &class);
        check_command(command, rules, facts, &mut j, &mut causes);
        let located = check_targets(&targets, rules, &ctx, facts, &mut j, &mut causes);
        if command.shadow {
            continue;
        }
        j.tainted |= !command.unsafe_env.is_empty();
        j.read_only &= matches!(class, Class::ReadOnly { .. }) && targets.writes.is_empty();
        let mut allowed = allowance(command, &class, rules, facts, &mut j.programs);
        if allowed
            .rule
            .as_ref()
            .is_some_and(|hit| is_wildcard(&hit.rule) && names_outside(command, facts))
        {
            allowed.rule = rules.exact_allow(facts.tool(), &command.full_text());
            j.outside |= allowed.rule.is_none();
        }
        let (reads_ok, writes_manual, writes_accept) =
            target_status(&located, &allowed, rules, &ctx);
        let command_manual = allowed.rule.is_some() || allowed.read_only;
        if command_manual && reads_ok && writes_manual {
            if let (Some(hits), Some(hit)) = (manual.as_mut(), allowed.rule) {
                hits.push(hit);
            }
        } else {
            manual = None;
        }
        accept &= (command_manual || allowed.file_edit) && reads_ok && writes_accept;
        if !command_manual {
            j.missing.push(index);
        }
    }
    j.manual = manual;
    j.accept = accept;
    // Report the strongest reason first.
    causes.sort_by_key(|c| match c {
        AskCause::Critical => 0,
        AskCause::Unresolved(_) => 1,
        AskCause::Rule(_) => 2,
        AskCause::InvalidRule(_) => 3,
    });
    j.ask = causes.into_iter().next();
    j
}

/// Whether the reads, the writes without the mode's help, and the writes in Accept edits are
/// allowed. A rule allows the command, not the files it is redirected from or to.
fn target_status(
    located: &LocatedTargets,
    allowed: &Allowance,
    rules: &RuleSet,
    ctx: &PathContext<'_>,
) -> (bool, bool, bool) {
    let allowed_by = |tool: &str, l: &Located| {
        rules
            .find(Behavior::Allow, tool, Subject::Paths(&l.paths), Some(ctx))
            .is_some()
    };
    let read_ok = |l: &Option<Located>| {
        l.as_ref()
            .is_some_and(|l| l.inside || allowed_by("Read", l))
    };
    let reads_ok = located.inputs.iter().all(read_ok)
        && (allowed.rule.is_some() || located.operands.iter().all(read_ok));
    let edit_allowed = |l: &Option<Located>| l.as_ref().is_some_and(|l| allowed_by("Edit", l));
    let writes_manual = located.writes.iter().all(edit_allowed);
    let writes_accept = located
        .writes
        .iter()
        .all(|l| edit_allowed(l) || l.as_ref().is_some_and(|l| l.inside && !l.protected));
    (reads_ok, writes_manual, writes_accept)
}

/// Whether a rule matches more than one text (`*`, or the `:*` form).
fn is_wildcard(rule: &str) -> bool {
    rule.contains('*')
}

/// Whether an argument that looks like a path (`/x`, `~/x`, `./x`, `../x`, `..`, `C:\x`,
/// anything with a `/`, or the value of `--option=value`) lies outside the session's
/// directories or cannot be placed; a word computed at run time cannot be placed. Other words
/// (patterns, scripts, names) are not checked.
fn names_outside(command: &Command, facts: &dyn Facts) -> bool {
    command.argv.iter().skip(1).any(|word| {
        let text = word.text.as_str();
        let value = match text.strip_prefix('-') {
            Some(option) => match option.split_once('=') {
                Some((_, value)) => value,
                None => return false,
            },
            None => text,
        };
        let pathlike = value.contains('/')
            || value.starts_with('~')
            || value == ".."
            || value.contains('\\')
            || value.as_bytes().get(1) == Some(&b':');
        if word.source.starts_with("<(") || word.source.starts_with(">(") {
            // A process substitution is a pipe; its commands are judged on their own.
            return false;
        }
        if !word.is_static() {
            // `$FILE` could be any path.
            return true;
        }
        if !pathlike {
            return false;
        }
        let operand = Operand {
            word: super::Word {
                text: value.to_owned(),
                source: word.source.clone(),
                glob: word.glob,
            },
            cwd: command.cwd.clone(),
        };
        facts.locate(&operand, false).is_none_or(|l| !l.inside)
    })
}

struct Allowance {
    rule: Option<Hit>,
    read_only: bool,
    file_edit: bool,
}

fn allowance(
    command: &Command,
    class: &Class,
    rules: &RuleSet,
    facts: &dyn Facts,
    programs: &mut Vec<String>,
) -> Allowance {
    let text = command.full_text();
    let rule = if command.exec_wrapper {
        rules.exact_allow(facts.tool(), &text)
    } else {
        rules
            .find(Behavior::Allow, facts.tool(), Subject::Command(&text), None)
            .map(|(hit, _)| hit)
    };
    // Every program the command runs: stripped wrappers that exec, and the command itself
    // unless bash runs it as a builtin.
    let runners: Vec<&str> = command
        .wrappers
        .iter()
        .map(String::as_str)
        .filter(|w| EXEC_RUNNERS.contains(w))
        .collect();
    let name = command.program();
    let mut needed = runners.clone();
    if !BUILTINS.contains(&name) || !runners.is_empty() {
        needed.push(name);
    }
    let mut verified = || {
        needed.iter().all(|n| {
            let ok = facts.program_ok(n);
            if ok && !programs.iter().any(|p| p == n) {
                programs.push((*n).to_owned());
            }
            ok
        })
    };
    let (read_only, file_edit) = match class {
        _ if rule.is_some() => (false, false),
        Class::ReadOnly { .. } => (verified(), false),
        Class::FileEdit { .. } => (false, verified()),
        Class::Other => (false, false),
    };
    Allowance {
        rule,
        read_only,
        file_edit,
    }
}

fn check_command(
    command: &Command,
    rules: &RuleSet,
    facts: &dyn Facts,
    j: &mut Judgment,
    causes: &mut Vec<AskCause>,
) {
    let mut texts = vec![command.text()];
    if let Some(base) = command.program().rsplit('/').next()
        && command.program().contains('/')
        && !base.is_empty()
    {
        let mut words: Vec<&str> = vec![base];
        words.extend(command.argv[1..].iter().map(|w| w.text.as_str()));
        texts.push(words.join(" "));
    }
    for text in &texts {
        match rules.find(Behavior::Deny, facts.tool(), Subject::Command(text), None) {
            Some((hit, Certainty::Certain)) => {
                if j.deny.is_none() {
                    j.deny = Some(hit);
                }
            }
            Some((hit, Certainty::Possible)) => causes.push(AskCause::Rule(hit)),
            None => {}
        }
        if let Some((hit, _)) =
            rules.find(Behavior::Ask, facts.tool(), Subject::Command(text), None)
        {
            causes.push(AskCause::Rule(hit));
        }
    }
    if is_critical_delete(command, &facts.critical_context()) {
        causes.push(AskCause::Critical);
    }
}

struct LocatedTargets {
    operands: Vec<Option<Located>>,
    inputs: Vec<Option<Located>>,
    writes: Vec<Option<Located>>,
}

/// Deny and ask through `Read` and `Edit` rules; a `Read` deny also covers writes.
fn check_targets(
    targets: &Targets,
    rules: &RuleSet,
    ctx: &PathContext<'_>,
    facts: &dyn Facts,
    j: &mut Judgment,
    causes: &mut Vec<AskCause>,
) -> LocatedTargets {
    let mut locate = |operands: &[Operand], write: bool| -> Vec<Option<Located>> {
        operands
            .iter()
            .map(|operand| {
                let located = facts.locate(operand, write);
                if let Some(l) = &located {
                    j.protected |= write && l.protected;
                    let tools: &[&str] = if write { &["Edit", "Read"] } else { &["Read"] };
                    for tool in tools {
                        if let Some((hit, _)) =
                            rules.find(Behavior::Deny, tool, Subject::Paths(&l.paths), Some(ctx))
                            && j.deny.is_none()
                        {
                            j.deny = Some(hit);
                        }
                    }
                    if let Some((hit, _)) =
                        rules.find(Behavior::Ask, tools[0], Subject::Paths(&l.paths), Some(ctx))
                    {
                        causes.push(AskCause::Rule(hit));
                    }
                }
                located
            })
            .collect()
    };
    LocatedTargets {
        operands: locate(&targets.operands, false),
        inputs: locate(&targets.inputs, false),
        writes: locate(&targets.writes, true),
    }
}
