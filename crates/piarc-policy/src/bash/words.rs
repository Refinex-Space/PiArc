//! Word values: quote removal, escapes, and [`DYNAMIC`] for anything the shell computes when
//! the command runs. Command and process substitutions found on the way are walked as
//! commands in a subshell scope.

use tree_sitter::Node;

use super::walk::{Scope, Walker, named};
use super::wrappers::Assignment;
use super::{Command, Word};
use crate::pattern::DYNAMIC;

struct Builder {
    text: String,
    glob: bool,
}

impl Builder {
    fn dynamic(&mut self) {
        if !self.text.ends_with(DYNAMIC) {
            self.text.push(DYNAMIC);
        }
    }
}

impl Walker<'_> {
    /// The value of a word node.
    pub(super) fn word(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) -> Word {
        let mut b = Builder {
            text: String::new(),
            glob: false,
        };
        self.part(node, scope, level, &mut b);
        Word {
            text: b.text,
            source: self.text(node).to_owned(),
            glob: b.glob,
        }
    }

    pub(super) fn assignment(
        &mut self,
        node: Node<'_>,
        scope: &mut Scope,
        level: usize,
    ) -> Assignment {
        let name = node
            .child_by_field_name("name")
            .map(|n| self.text(n).to_owned())
            .unwrap_or_default();
        let value = node
            .child_by_field_name("value")
            .map(|v| self.word(v, scope, level + 1));
        let text = format!("{name}={}", value.as_ref().map_or("", |v| v.text.as_str()));
        Assignment {
            name,
            word: Word {
                text,
                source: self.text(node).to_owned(),
                glob: false,
            },
        }
    }

    fn part(&mut self, node: Node<'_>, scope: &mut Scope, level: usize, b: &mut Builder) {
        if !self.enter(node, level) {
            b.dynamic();
            return;
        }
        let next = level + 1;
        match node.kind() {
            "command_name" | "translated_string" => {
                for child in named(node) {
                    self.part(child, scope, next, b);
                }
            }
            "word" => unquoted(self.text(node), b),
            "string" => self.double_quoted(node, scope, next, b),
            "raw_string" => {
                let raw = self.text(node);
                b.text.push_str(
                    raw.strip_prefix('\'')
                        .and_then(|r| r.strip_suffix('\''))
                        .unwrap_or(raw),
                );
            }
            "ansi_c_string" => ansi_c(self.text(node), b),
            "number"
            | "variable_name"
            | "special_variable_name"
            | "regex"
            | "test_operator"
            | "heredoc_content"
            | "string_content" => {
                if node.named_child_count() == 0 {
                    b.text.push_str(self.text(node));
                } else {
                    self.substitutions(node, scope, next);
                    b.dynamic();
                }
            }
            "concatenation" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'_>> = node.children(&mut cursor).collect();
                // `{a,b}` arrives as the words `{`, `a,b`, `}`: a brace expansion.
                if children.iter().any(|c| self.text(*c) == "{")
                    && children.iter().any(|c| self.text(*c).starts_with('}'))
                {
                    b.glob = true;
                }
                for child in children {
                    self.part(child, scope, next, b);
                }
            }
            "extglob_pattern" | "brace_expression" => {
                b.glob = true;
                b.text.push_str(self.text(node));
            }
            "command_substitution" | "process_substitution" => {
                self.substitution(node, scope, next);
                b.dynamic();
            }
            _ => {
                self.substitutions(node, scope, next);
                b.dynamic();
            }
        }
    }

    fn double_quoted(&mut self, node: Node<'_>, scope: &mut Scope, level: usize, b: &mut Builder) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "\"" => {}
                "string_content" => double_quoted_text(self.text(child), b),
                _ if child.is_named() => {
                    if matches!(
                        child.kind(),
                        "command_substitution" | "process_substitution"
                    ) {
                        self.substitution(child, scope, level);
                    } else {
                        self.substitutions(child, scope, level);
                    }
                    b.dynamic();
                }
                _ => b.text.push_str(self.text(child)),
            }
        }
    }

    /// The statements of `$(…)`, `` `…` ``, `<(…)` or `>(…)`, run in a subshell.
    fn substitution(&mut self, node: Node<'_>, scope: &Scope, level: usize) {
        let mut inner = Scope {
            cwd: scope.cwd.clone(),
            shadow: scope.shadow,
            redirects: Vec::new(),
        };
        let mut redirects = Vec::new();
        for child in named(node) {
            if child.kind() == "file_redirect" {
                self.redirect(child, &mut inner, level, &mut redirects);
            } else {
                self.statement(child, &mut inner, level);
            }
        }
        // `$(< file)` reads the file without a command: judge it as `:` with that redirect.
        if !redirects.is_empty() {
            self.out.commands.push(Command {
                argv: vec![Word::literal(":")],
                wrappers: Vec::new(),
                unsafe_env: Vec::new(),
                shadow: inner.shadow,
                cwd: inner.cwd.clone(),
                redirects,
                exec_wrapper: false,
            });
        }
    }

    /// Walk an expansion or expression for substitutions inside it.
    fn substitutions(&mut self, node: Node<'_>, scope: &mut Scope, level: usize) {
        for child in named(node) {
            if !self.enter(child, level) {
                return;
            }
            match child.kind() {
                "command_substitution" | "process_substitution" => {
                    self.substitution(child, scope, level + 1);
                }
                _ => self.substitutions(child, scope, level + 1),
            }
        }
    }
}

fn unquoted(raw: &str, b: &mut Builder) {
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('\n') | None => {}
                Some(escaped) => b.text.push(escaped),
            },
            '*' | '?' | '[' => {
                b.glob = true;
                b.text.push(c);
            }
            _ => b.text.push(c),
        }
    }
}

fn double_quoted_text(raw: &str, b: &mut Builder) {
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('$' | '`' | '"' | '\\') => {
                    if let Some(next) = chars.next() {
                        b.text.push(next);
                    }
                }
                Some('\n') => {
                    chars.next();
                }
                _ => b.text.push(c),
            }
        } else {
            b.text.push(c);
        }
    }
}

/// `$'…'` with the escapes Bash documents; an escape PiArc does not decode is dynamic.
fn ansi_c(raw: &str, b: &mut Builder) {
    let body = raw
        .strip_prefix("$'")
        .and_then(|r| r.strip_suffix('\''))
        .unwrap_or(raw);
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            b.text.push(c);
            continue;
        }
        let decoded = match chars.next() {
            Some('n') => '\n',
            Some('t') => '\t',
            Some('r') => '\r',
            Some('a') => '\u{7}',
            Some('b') => '\u{8}',
            Some('e' | 'E') => '\u{1b}',
            Some('f') => '\u{c}',
            Some('v') => '\u{b}',
            Some(c @ ('\\' | '\'' | '"' | '?')) => c,
            _ => {
                b.dynamic();
                continue;
            }
        };
        b.text.push(decoded);
    }
}
