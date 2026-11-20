//! The tree-sitter walk: statements, simple commands, redirections and `cd` tracking.

use std::cell::RefCell;

use tree_sitter::{Node, Parser};

use super::wrappers::{self, Assignment};
use super::{Analysis, Command, Cwd, Redirect, Unresolved, Word};

/// Nesting deeper than this stops the walk (the analysis must not exhaust a worker stack).
const MAX_LEVEL: usize = 200;
/// Nodes visited before the walk gives up.
const MAX_NODES: usize = 100_000;
/// `sh -c` scripts analyzed inside each other.
const MAX_SCRIPT_DEPTH: u8 = 3;

thread_local! {
    static PARSER: RefCell<Option<Parser>> = const { RefCell::new(None) };
}

/// Variables whose assignment changes how later commands resolve or run.
pub(super) fn is_special_variable(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "PATH",
        "IFS",
        "CDPATH",
        "HOME",
        "ENV",
        "BASH_ENV",
        "SHELLOPTS",
        "BASHOPTS",
        "GLOBIGNORE",
        "PS4",
        "PROMPT_COMMAND",
        "BASH_XTRACEFD",
        "EDITOR",
        "VISUAL",
        "PAGER",
        "MANPAGER",
        "LESSOPEN",
        "LESSCLOSE",
        "BROWSER",
        "SHELL",
        "SSH_ASKPASS",
        "SUDO_ASKPASS",
        "TMPDIR",
    ];
    const PREFIXES: &[&str] = &[
        "LD_",
        "DYLD_",
        "BASH_FUNC_",
        "GIT_",
        "NPM_CONFIG_",
        "PYTHON",
        "PERL",
        "RUBY",
        "NODE_",
        "JAVA_",
        "_JAVA_",
        "GCONV_",
    ];
    let upper = name.to_ascii_uppercase();
    NAMES.contains(&upper.as_str()) || PREFIXES.iter().any(|p| upper.starts_with(p))
}

pub(super) struct Scope {
    pub cwd: Cwd,
    pub shadow: bool,
    pub redirects: Vec<Redirect>,
}

impl Scope {
    fn sub(&self) -> Self {
        Self {
            cwd: self.cwd.clone(),
            shadow: self.shadow,
            redirects: self.redirects.clone(),
        }
    }
}

pub(super) struct Walker<'s> {
    pub src: &'s str,
    pub out: Analysis,
    depth: u8,
    nodes: usize,
}

/// Parse and walk `source`; `depth` counts enclosing `sh -c` scripts.
pub(super) fn run(source: &str, depth: u8) -> Analysis {
    let tree = PARSER.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let mut parser = Parser::new();
            parser
                .set_language(&tree_sitter_bash::LANGUAGE.into())
                .ok()?;
            *slot = Some(parser);
        }
        slot.as_mut()?.parse(source, None)
    });
    let mut walker = Walker {
        src: source,
        out: Analysis::default(),
        depth,
        nodes: 0,
    };
    let Some(tree) = tree else {
        walker.flag(Unresolved::ParseError);
        return walker.out;
    };
    let root = tree.root_node();
    if root.has_error() {
        walker.flag(Unresolved::ParseError);
    }
    let mut scope = Scope {
        cwd: Cwd::start(),
        shadow: false,
        redirects: Vec::new(),
    };
    walker.statement(root, &mut scope, 0);
    walker.out
}

fn is_statement(kind: &str) -> bool {
    matches!(
        kind,
        "program"
            | "list"
            | "pipeline"
            | "subshell"
            | "compound_statement"
            | "do_group"
            | "negated_command"
            | "redirected_statement"
            | "command"
            | "variable_assignment"
            | "variable_assignments"
            | "declaration_command"
            | "unset_command"
            | "test_command"
            | "for_statement"
            | "c_style_for_statement"
            | "while_statement"
            | "if_statement"
            | "elif_clause"
            | "else_clause"
            | "case_statement"
            | "case_item"
            | "function_definition"
            | "comment"
    )
}

impl<'s> Walker<'s> {
    pub(super) fn flag(&mut self, reason: Unresolved) {
        if !self.out.unresolved.contains(&reason) {
            self.out.unresolved.push(reason);
        }
    }

    pub(super) fn text(&self, node: Node<'_>) -> &'s str {
        self.src.get(node.byte_range()).unwrap_or("")
    }

    /// Count a node; false when the walk must stop.
    pub(super) fn enter(&mut self, node: Node<'_>, level: usize) -> bool {
        self.nodes += 1;
        if level > MAX_LEVEL || self.nodes > MAX_NODES {
            self.flag(Unresolved::TooDeep);
            return false;
        }
        if node.is_missing() || node.is_error() {
            self.flag(Unresolved::ParseError);
            return false;
        }
        true
    }

    pub(super) fn statement(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        if !self.enter(node, level) {
            return;
        }
        let next = level + 1;
        match node.kind() {
            "program" | "compound_statement" | "do_group" | "elif_clause" | "else_clause"
            | "case_item" => self.sequence(node, scope, next),
            "list" => self.list(node, scope, next),
            // Each part of a pipeline runs in its own subshell.
            "pipeline" => {
                for child in named(node) {
                    self.child(child, &mut scope.sub(), next);
                }
            }
            "subshell" => self.sequence(node, &mut scope.sub(), next),
            "negated_command" | "variable_assignments" => {
                for child in named(node) {
                    self.child(child, scope, next);
                }
            }
            "redirected_statement" => self.redirected(node, scope, next),
            "command" => self.command(node, scope, next),
            "variable_assignment" => {
                let assignment = self.assignment(node, scope, next);
                if is_special_variable(&assignment.name) {
                    self.out.unsafe_assignments.push(assignment.name);
                }
            }
            "declaration_command" | "unset_command" => self.declaration(node, scope, next),
            "test_command" => self.test(node, scope, next),
            "for_statement"
            | "c_style_for_statement"
            | "while_statement"
            | "if_statement"
            | "case_statement" => self.control(node, scope, next),
            "function_definition" => {
                let before = scope.cwd.clone();
                for child in named(node) {
                    if child.kind() != "word" {
                        self.child(child, scope, next);
                    }
                }
                // Calling the function later may change the directory.
                if scope.cwd != before {
                    scope.cwd = Cwd::Unknown;
                }
            }
            "comment" => {}
            other => self.flag(Unresolved::Unsupported(other.to_owned())),
        }
    }

    /// A statement, or a word whose substitutions run commands.
    fn child(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        if is_statement(node.kind()) {
            self.statement(node, scope, level);
        } else {
            let _ = self.word(node, scope, level);
        }
    }

    fn sequence(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut cursor = node.walk();
        let children: Vec<Node<'_>> = node.children(&mut cursor).collect();
        for (i, child) in children.iter().enumerate() {
            if !child.is_named() {
                continue;
            }
            let background = children.get(i + 1).is_some_and(|n| n.kind() == "&");
            if background {
                self.child(*child, &mut scope.sub(), level);
            } else {
                self.child(*child, scope, level);
            }
        }
    }

    fn list(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut cursor = node.walk();
        let children: Vec<Node<'_>> = node.children(&mut cursor).collect();
        let before = scope.cwd.clone();
        let mut either = false;
        for child in &children {
            if child.kind() == "||" {
                either = true;
            } else if child.is_named() {
                self.child(*child, scope, level);
            }
        }
        if either && scope.cwd != before {
            scope.cwd = Cwd::Unknown;
        }
    }

    fn control(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let before = scope.cwd.clone();
        if node.kind() == "for_statement"
            && let Some(var) = node.child_by_field_name("variable")
        {
            let name = self.text(var).to_owned();
            if is_special_variable(&name) {
                self.out.unsafe_assignments.push(name);
            }
        }
        for child in named(node) {
            self.child(child, scope, level);
        }
        if scope.cwd != before {
            scope.cwd = Cwd::Unknown;
        }
    }

    fn redirected(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut added = Vec::new();
        let mut body = None;
        let mut cursor = node.walk();
        for (i, child) in node.children(&mut cursor).enumerate() {
            match node.field_name_for_child(u32::try_from(i).unwrap_or(u32::MAX)) {
                Some("body") => body = Some(child),
                _ if child.is_named() => self.redirect(child, scope, level, &mut added),
                _ => {}
            }
        }
        let inherited = scope.redirects.len();
        scope.redirects.extend(added);
        match body {
            Some(body) => self.statement(body, scope, level),
            // `> file` alone truncates the file, as `: > file` does.
            None => self.out.commands.push(Command {
                argv: vec![Word::literal(":")],
                wrappers: Vec::new(),
                unsafe_env: Vec::new(),
                shadow: scope.shadow,
                cwd: scope.cwd.clone(),
                redirects: scope.redirects.clone(),
                exec_wrapper: false,
            }),
        }
        scope.redirects.truncate(inherited);
    }

    pub(super) fn redirect(
        &mut self,
        node: Node<'_>,
        scope: &mut Scope,
        level: usize,
        out: &mut Vec<Redirect>,
    ) {
        if !self.enter(node, level) {
            return;
        }
        match node.kind() {
            "file_redirect" => {
                let mut cursor = node.walk();
                let operator = node
                    .children(&mut cursor)
                    .find(|c| !c.is_named())
                    .map_or("", |c| self.text(c));
                let Some(target) = node.child_by_field_name("destination") else {
                    return;
                };
                let duplicate = operator.ends_with('&') && target.kind() == "number";
                let word = self.word(target, scope, level + 1);
                // Exact device names only: `/dev/fd/../x` is a path, and `-` closes a
                // descriptor only after `>&` or `<&` (elsewhere it names a file).
                let device = matches!(
                    word.text.as_str(),
                    "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/stdin" | "/dev/tty"
                ) || word
                    .text
                    .strip_prefix("/dev/fd/")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    || (operator.ends_with('&') && word.text == "-");
                if !duplicate && !device && target.kind() != "process_substitution" {
                    out.push(Redirect {
                        write: operator.contains('>'),
                        target: word,
                    });
                }
            }
            "heredoc_redirect" => {
                for child in named(node) {
                    match child.kind() {
                        "heredoc_body" => {
                            let _ = self.word(child, scope, level + 1);
                        }
                        "heredoc_start" | "heredoc_end" | "file_descriptor" => {}
                        // The rest of the line after the marker (`| grep x`, `&& …`).
                        "pipeline" => self.statement(child, &mut scope.sub(), level + 1),
                        kind if is_statement(kind) => self.statement(child, scope, level + 1),
                        _ => self.redirect(child, scope, level + 1, out),
                    }
                }
            }
            _ => {
                let _ = self.word(node, scope, level + 1);
            }
        }
    }

    fn command(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut assignments = Vec::new();
        let mut words = Vec::new();
        let mut redirects = scope.redirects.clone();
        let mut cursor = node.walk();
        let children: Vec<Node<'_>> = node.children(&mut cursor).collect();
        for (i, child) in children.into_iter().enumerate() {
            let field = node.field_name_for_child(u32::try_from(i).unwrap_or(u32::MAX));
            match (field, child.kind()) {
                (Some("name" | "argument"), _) => words.push(self.word(child, scope, level)),
                (Some("redirect"), _) => self.redirect(child, scope, level, &mut redirects),
                (_, "variable_assignment") => {
                    assignments.push(self.assignment(child, scope, level));
                }
                (_, "subshell") => self.statement(child, &mut scope.sub(), level),
                _ if child.is_named() => self.child(child, scope, level),
                _ => {}
            }
        }
        if words.is_empty() {
            for a in assignments {
                if is_special_variable(&a.name) {
                    self.out.unsafe_assignments.push(a.name);
                }
            }
            return;
        }
        self.emit(words, &assignments, scope, redirects, scope.shadow, 0);
    }

    /// Strip wrappers from one command, record it and the commands it runs.
    fn emit(
        &mut self,
        words: Vec<Word>,
        assignments: &[Assignment],
        scope: &mut Scope,
        redirects: Vec<Redirect>,
        shadow: bool,
        nesting: u8,
    ) {
        if nesting > 8 {
            self.flag(Unresolved::TooDeep);
            return;
        }
        let stripped = match wrappers::strip(words, assignments) {
            Ok(s) => s,
            Err(reason) => {
                self.flag(reason);
                return;
            }
        };
        let Some(program) = stripped.argv.first() else {
            return;
        };
        if !program.is_static() || program.glob {
            self.flag(Unresolved::DynamicCommand);
            return;
        }
        let name = program.text.clone();
        if name == "eval" {
            self.flag(Unresolved::Eval);
            return;
        }
        let cwd = scope.cwd.clone();
        for script in &stripped.scripts {
            self.script(script, scope);
        }
        self.track_cwd(&name, &stripped.argv, scope);
        let shadows = stripped.shadows.clone();
        self.out.commands.push(Command {
            argv: stripped.argv,
            wrappers: stripped.wrappers,
            unsafe_env: stripped.unsafe_env,
            shadow,
            cwd,
            redirects: redirects.clone(),
            exec_wrapper: stripped.exec_wrapper,
        });
        for inner in shadows {
            if !inner.is_empty() {
                self.emit(inner, &[], scope, redirects.clone(), true, nesting + 1);
            }
        }
    }

    fn track_cwd(&mut self, name: &str, argv: &[Word], scope: &mut Scope) {
        match name {
            "cd" | "pushd" => {
                let target = argv[1..]
                    .iter()
                    .find(|w| !w.text.starts_with('-') || w.text == "-");
                scope.cwd = match target {
                    None => scope.cwd.join("~"),
                    Some(w) if w.text == "-" || !w.is_static() || w.glob => Cwd::Unknown,
                    Some(w) => scope.cwd.join(&w.text),
                };
            }
            "popd" => scope.cwd = Cwd::Unknown,
            _ => {}
        }
    }

    /// Analyze the script of `sh -c`; its commands run as shadows of the shell command.
    fn script(&mut self, script: &str, scope: &Scope) {
        if self.depth >= MAX_SCRIPT_DEPTH {
            self.flag(Unresolved::TooDeep);
            return;
        }
        let inner = run(script, self.depth + 1);
        for reason in inner.unresolved {
            self.flag(reason);
        }
        self.out.unsafe_assignments.extend(inner.unsafe_assignments);
        for mut command in inner.commands {
            command.shadow = true;
            command.cwd = match (&scope.cwd, &command.cwd) {
                (Cwd::Known(_), Cwd::Known(inner)) => scope.cwd.join(inner),
                _ => Cwd::Unknown,
            };
            self.out.commands.push(command);
        }
    }

    fn declaration(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut cursor = node.walk();
        let mut words = Vec::new();
        for child in node.children(&mut cursor) {
            if !child.is_named() {
                words.push(Word::literal(self.text(child)));
                continue;
            }
            match child.kind() {
                "variable_assignment" => {
                    let a = self.assignment(child, scope, level);
                    if is_special_variable(&a.name) {
                        self.out.unsafe_assignments.push(a.name.clone());
                    }
                    words.push(a.word);
                }
                "variable_name" | "word" if node.kind() == "unset_command" => {
                    let w = self.word(child, scope, level);
                    if is_special_variable(&w.text) {
                        self.out.unsafe_assignments.push(w.text.clone());
                    }
                    words.push(w);
                }
                _ => words.push(self.word(child, scope, level)),
            }
        }
        let redirects = scope.redirects.clone();
        self.emit(words, &[], scope, redirects, scope.shadow, 0);
    }

    fn test(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        let mut cursor = node.walk();
        let open = node
            .children(&mut cursor)
            .next()
            .map_or("[[", |c| self.text(c))
            .to_owned();
        for child in named(node) {
            self.child(child, scope, level);
        }
        self.out.commands.push(Command {
            argv: vec![Word::literal(&open)],
            wrappers: Vec::new(),
            unsafe_env: Vec::new(),
            shadow: scope.shadow,
            cwd: scope.cwd.clone(),
            redirects: scope.redirects.clone(),
            exec_wrapper: false,
        });
    }
}

pub(super) fn named<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}
