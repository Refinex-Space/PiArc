//! Wildcard text patterns of command and name rules: `*` stands for any text, including
//! spaces. A trailing ` *` that is the only wildcard also matches the bare prefix, and a
//! trailing `:*` is the same as ` *` (architecture section 6.2.2, Claude Code semantics).
//!
//! Command text may contain [`DYNAMIC`] for a part the shell expands at run time (a variable,
//! a command substitution). Only a `*` of the pattern covers it: [`Pattern::covers`] holds for
//! every possible expansion, [`Pattern::may_match`] for at least one.

/// Stands for text the shell computes at run time. Inputs that contain this private-use
/// character are rejected by the analyzer, so it never appears literally.
pub const DYNAMIC: char = '\u{E000}';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Char(char),
    Star,
}

/// A parsed wildcard pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    tokens: Vec<Token>,
    /// The bare command a trailing ` *` also matches.
    bare: Option<Vec<Token>>,
    fold_case: bool,
}

impl Pattern {
    /// Parse a command or name pattern. `fold_case` compares letters without case
    /// (PowerShell).
    #[must_use]
    pub fn new(text: &str, fold_case: bool) -> Self {
        let text = text
            .strip_suffix(":*")
            .map_or_else(|| text.to_owned(), |prefix| format!("{prefix} *"));
        let fold = |c: char| {
            if fold_case {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                c
            }
        };
        let tokens: Vec<Token> = text
            .chars()
            .map(|c| {
                if c == '*' {
                    Token::Star
                } else {
                    Token::Char(fold(c))
                }
            })
            .collect();
        let stars = tokens.iter().filter(|t| **t == Token::Star).count();
        let bare = (stars == 1 && text.ends_with(" *") && text.len() > 2)
            .then(|| tokens[..tokens.len() - 2].to_vec());
        Self {
            tokens,
            bare,
            fold_case,
        }
    }

    /// Whether the pattern has no wildcard and so names one exact text.
    #[must_use]
    pub fn is_exact(&self) -> bool {
        !self.tokens.contains(&Token::Star)
    }

    /// The literal text before the first `*`.
    #[must_use]
    pub fn literal_prefix(&self) -> String {
        self.tokens
            .iter()
            .map_while(|t| match t {
                Token::Char(c) => Some(*c),
                Token::Star => None,
            })
            .collect()
    }

    fn prepare(&self, text: &str) -> Vec<char> {
        if self.fold_case {
            text.chars()
                .map(|c| c.to_lowercase().next().unwrap_or(c))
                .collect()
        } else {
            text.chars().collect()
        }
    }

    /// The pattern matches `text` for every expansion of its [`DYNAMIC`] parts.
    #[must_use]
    pub fn covers(&self, text: &str) -> bool {
        let text = self.prepare(text);
        covers(&self.tokens, &text) || self.bare.as_deref().is_some_and(|b| covers(b, &text))
    }

    /// The pattern matches `text` for at least one expansion of its [`DYNAMIC`] parts.
    #[must_use]
    pub fn may_match(&self, text: &str) -> bool {
        let text = self.prepare(text);
        if !text.contains(&DYNAMIC) {
            return covers(&self.tokens, &text)
                || self.bare.as_deref().is_some_and(|b| covers(b, &text));
        }
        intersects(&self.tokens, &text)
            || self.bare.as_deref().is_some_and(|b| intersects(b, &text))
    }
}

/// Glob matching where a [`DYNAMIC`] character of the text is matched by a star only. Linear
/// backtracking over the last star, which is complete for patterns with `*` as the only
/// wildcard.
fn covers(pattern: &[Token], text: &[char]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some(Token::Char(c)) if *c == text[t] && text[t] != DYNAMIC => {
                p += 1;
                t += 1;
            }
            Some(Token::Star) => {
                star = Some((p, t));
                p += 1;
            }
            _ => match star {
                Some((sp, st)) => {
                    p = sp + 1;
                    t = st + 1;
                    star = Some((sp, st + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|t| *t == Token::Star)
}

/// Whether some text matches both the pattern and the text read as a pattern in which every
/// [`DYNAMIC`] character is a star.
fn intersects(pattern: &[Token], text: &[char]) -> bool {
    let (n, m) = (pattern.len(), text.len());
    // reach[i][j]: the prefixes pattern[..i] and text[..j] can produce a common string.
    let mut reach = vec![vec![false; m + 1]; n + 1];
    reach[0][0] = true;
    for i in 0..=n {
        for j in 0..=m {
            if !reach[i][j] {
                continue;
            }
            let p = pattern.get(i).copied();
            let t = text.get(j).copied();
            let p_star = p == Some(Token::Star);
            let t_star = t == Some(DYNAMIC);
            if p_star {
                reach[i + 1][j] = true;
                if t.is_some() && !t_star {
                    reach[i][j + 1] = true;
                }
            }
            if t_star {
                reach[i][j + 1] = true;
                if matches!(p, Some(Token::Char(_))) {
                    reach[i + 1][j] = true;
                }
            }
            if p_star && t_star {
                reach[i + 1][j + 1] = true;
            }
            if let (Some(Token::Char(a)), Some(b)) = (p, t)
                && a == b
                && !t_star
            {
                reach[i + 1][j + 1] = true;
            }
        }
    }
    reach[n][m]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> String {
        text.replace('$', &DYNAMIC.to_string())
    }

    #[test]
    fn documented_wildcard_shapes() {
        let cases: &[(&str, &[&str], &[&str])] = &[
            (
                "npm run build",
                &["npm run build"],
                &["npm run build --watch"],
            ),
            (
                "npm run *",
                &["npm run build", "npm run test --watch", "npm run"],
                &["npm install"],
            ),
            (
                "git log * main",
                &["git log --oneline main", "git log -5 main"],
                &["git log main", "git push origin main"],
            ),
            (
                "git * main",
                &["git merge main", "git push origin main"],
                &["git log"],
            ),
            ("* --version", &["node --version"], &["node -v"]),
            ("ls *", &["ls -la", "ls"], &["lsof"]),
            ("ls*", &["ls -la", "lsof"], &[]),
            ("* --help *", &["npm --help x"], &["npm --help"]),
            ("ls:*", &["ls", "ls -la"], &["lsof"]),
            ("git:* push", &["git:x push"], &["git push"]),
        ];
        for (rule, yes, no) in cases {
            let p = Pattern::new(rule, false);
            for text in *yes {
                assert!(p.covers(text), "{rule} should match {text}");
            }
            for text in *no {
                assert!(!p.covers(text), "{rule} should not match {text}");
            }
        }
    }

    #[test]
    fn dynamic_parts_need_a_star() {
        let p = Pattern::new("git status *", false);
        assert!(p.covers(&d("git status $")));
        assert!(!p.covers(&d("git $")));
        assert!(p.may_match(&d("git $")));
        assert!(!p.may_match(&d("npm $")));
        let push = Pattern::new("git push *", false);
        assert!(push.may_match(&d("git $ origin")));
        assert!(!push.covers(&d("git $ origin")));
        assert!(Pattern::new("echo *", false).covers(&d("echo a$b")));
        assert!(!Pattern::new("echo a", false).may_match(&d("echo b$")));
        assert!(Pattern::new("rm *", false).may_match(&d("rm$")));
    }

    #[test]
    fn folding_and_exactness() {
        let p = Pattern::new("Get-ChildItem *", true);
        assert!(p.covers("get-childitem -Force"));
        assert!(!Pattern::new("Get-ChildItem *", false).covers("get-childitem"));
        assert!(Pattern::new("npm test", false).is_exact());
        assert_eq!(
            Pattern::new("git commit *", false).literal_prefix(),
            "git commit "
        );
    }
}
