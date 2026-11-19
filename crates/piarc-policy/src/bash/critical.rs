//! Critical path deletion: `rm` with a recursive flag (or a glob) or `rmdir` aimed at the
//! filesystem root, a top-level system directory, the home directory, the workspace root or
//! one of their ancestors (`.`, `..` and globs included). Such a command always asks, in every
//! mode and even when an allow rule matches.

use super::{Command, Cwd, Word};

/// The directories a deletion is judged against, in POSIX form.
#[derive(Debug, Clone, Copy)]
pub struct CriticalContext<'a> {
    /// The home directory.
    pub home: &'a str,
    /// The workspace root.
    pub root: &'a str,
    /// The directory the command text starts in.
    pub cwd: &'a str,
    /// Compare without case.
    pub fold_case: bool,
}

/// Whether the command deletes a critical path.
#[must_use]
pub fn is_critical_delete(cmd: &Command, ctx: &CriticalContext<'_>) -> bool {
    let program = cmd.program().rsplit('/').next().unwrap_or_default();
    let program = program.strip_suffix(".exe").unwrap_or(program);
    let args = &cmd.argv[1..];
    let targets: Vec<&Word> = match program {
        "rm" => {
            let mut recursive = false;
            let mut targets = Vec::new();
            let mut done = false;
            for arg in args {
                let t = arg.text.as_str();
                if !done && t == "--" {
                    done = true;
                } else if !done && t.starts_with("--") {
                    recursive |= t == "--recursive";
                } else if !done && t.starts_with('-') && t.len() > 1 {
                    recursive |= t.contains(['r', 'R']);
                } else {
                    targets.push(arg);
                }
            }
            // A glob at a critical directory deletes its files even without `-r`.
            targets.retain(|w| recursive || w.glob);
            targets
        }
        "rmdir" => args.iter().filter(|a| !a.text.starts_with('-')).collect(),
        _ => return false,
    };
    targets
        .into_iter()
        .any(|w| critical_target(w, &cmd.cwd, ctx))
}

fn critical_target(word: &Word, cwd: &Cwd, ctx: &CriticalContext<'_>) -> bool {
    if !word.is_static() {
        // `"$HOME"`, `${HOME}/`, `$HOME/*`.
        let source = word.source.replace(['"', '\''], "");
        let rest = source
            .strip_prefix("${HOME}")
            .or_else(|| source.strip_prefix("$HOME"));
        return rest
            .is_some_and(|r| matches!(r.trim_end_matches(['*', '.']).trim_end_matches('/'), ""));
    }
    let mut text = word.text.replace('\\', "/");
    if text.len() >= 2 && text.as_bytes()[1] == b':' && text.as_bytes()[0].is_ascii_alphabetic() {
        text = format!("/{}{}", text[..1].to_ascii_lowercase(), &text[2..]);
    }
    // A glob deletes what is inside its directory.
    let base = if word.glob {
        let cut = text.find(['*', '?', '[']).unwrap_or(text.len());
        match text[..cut].rfind('/') {
            Some(0) => "/".to_owned(),
            Some(i) => text[..i].to_owned(),
            None => ".".to_owned(),
        }
    } else {
        text
    };
    let Some(path) = absolute(&base, cwd, ctx) else {
        // An unknown directory with `.`, `..` or a glob could be anything.
        return base == "." || base == ".." || base.starts_with("./") || base.starts_with("../");
    };
    is_critical(&path, ctx)
}

fn absolute(text: &str, cwd: &Cwd, ctx: &CriticalContext<'_>) -> Option<String> {
    let expand = |t: &str| -> Option<String> {
        if t == "~" {
            Some(ctx.home.to_owned())
        } else if let Some(rest) = t.strip_prefix("~/") {
            Some(format!("{}/{rest}", ctx.home))
        } else if t.starts_with('~') {
            None
        } else {
            Some(t.to_owned())
        }
    };
    let text = expand(text)?;
    if text.starts_with('/') {
        return Some(normalize(&text));
    }
    let Cwd::Known(rel) = cwd else {
        return None;
    };
    let dir = if rel.is_empty() {
        ctx.cwd.to_owned()
    } else {
        let rel = expand(rel)?;
        if rel.starts_with('/') {
            rel
        } else {
            format!("{}/{rel}", ctx.cwd)
        }
    };
    Some(normalize(&format!("{dir}/{text}")))
}

fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

fn is_critical(path: &str, ctx: &CriticalContext<'_>) -> bool {
    let fold = |s: &str| {
        if ctx.fold_case {
            s.to_lowercase()
        } else {
            s.to_owned()
        }
    };
    let path = fold(path);
    let within = |dir: &str| {
        let dir = fold(&normalize(dir));
        path == "/" || dir == path || dir.starts_with(&format!("{path}/"))
    };
    if within(ctx.home) || within(ctx.root) {
        return true;
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    const SYSTEM: &[&str] = &[
        "usr",
        "etc",
        "bin",
        "sbin",
        "lib",
        "lib64",
        "var",
        "opt",
        "boot",
        "dev",
        "proc",
        "sys",
        "system",
        "library",
        "private",
        "applications",
        "users",
        "home",
        "root",
        "volumes",
    ];
    let windows_drive = cfg!(windows) && parts.first().is_some_and(|d| d.len() == 1);
    parts.len() <= 1
        || (parts.len() == 2
            && (SYSTEM.contains(&parts[0].to_lowercase().as_str()) || windows_drive))
}
