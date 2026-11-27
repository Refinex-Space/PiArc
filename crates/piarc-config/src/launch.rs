//! Launch configurations (ADR-0092, design addendum `docs/architecture/addenda/browser.md` B4.1):
//! the development servers a project describes in `.piarc/launch.json` and, read only,
//! `.claude/launch.json`.
//!
//! - **Format** (the fields Claude Desktop reads): JSON with comments and trailing commas; a
//!   top-level `configurations` array of `{ name, runtimeExecutable?, runtimeArgs?, program?,
//!   args?, cwd?, env?, port?, autoPort?, url? }` and a top-level `autoVerify` (default true).
//!   `${workspaceFolder}` in `program`, `args`, `runtimeArgs`, `cwd`, `env` and `url` is the
//!   project root. The command is `runtimeExecutable` (default `node` when there is a
//!   `program`), then `runtimeArgs`, then `program`, then `args`.
//! - **Merge**: configurations are named; a `.piarc` one hides a `.claude` one of the same name
//!   ([`Launch::hidden`]), and within a file the first of a name wins (the second is a
//!   problem). `autoVerify`
//!   comes from `.piarc` when it says, else from `.claude`.
//! - **Problems** carry the file and, when there is a place, its line and column: a syntax
//!   error where the parser stopped, a wrong field at the start of its configuration.
//! - **Port**: `port`, else the port of `url`, else `env.PORT`, else `--port`/`--port=`/`-p` in
//!   the arguments, else 3000 ([`LaunchConfig::port`]). [`LaunchConfig::on_port`] gives the
//!   configuration moved to another port (`autoPort`): the port arguments, `PORT` and the `url`.
//! - **Fingerprint**: SHA-256 over the command, arguments, directory, environment and port
//!   ([`LaunchConfig::fingerprint`]). The agent's start is approved per fingerprint; the trust
//!   inventory names each configuration with it, so changing what runs is a new item.
//!
//! Reading needs no trust; running does (Core checks it, ADR-0025).

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// `.piarc/launch.json`, relative to the project.
pub const PIARC_LAUNCH: &str = ".piarc/launch.json";
/// `.claude/launch.json`, relative to the project.
pub const CLAUDE_LAUNCH: &str = ".claude/launch.json";
/// The port when nothing names one.
pub const DEFAULT_PORT: u16 = 3000;
/// The largest launch file read.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Configurations one file may hold.
pub const MAX_CONFIGS: usize = 50;

const WORKSPACE_FOLDER: &str = "${workspaceFolder}";

/// The file a configuration comes from.
pub use piarc_protocol::dev_server::LaunchSource;

/// The relative path of `source`'s file.
#[must_use]
pub fn file_of(source: LaunchSource) -> &'static str {
    match source {
        LaunchSource::Piarc => PIARC_LAUNCH,
        LaunchSource::Claude => CLAUDE_LAUNCH,
    }
}

/// One configuration as written, `${workspaceFolder}` not yet replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchConfig {
    pub name: String,
    pub source: LaunchSource,
    pub runtime_executable: Option<String>,
    pub runtime_args: Vec<String>,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub port: Option<u16>,
    pub auto_port: bool,
    pub url: Option<String>,
}

/// A problem of a launch file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchIssue {
    /// [`PIARC_LAUNCH`] or [`CLAUDE_LAUNCH`].
    pub file: &'static str,
    /// 1-based line and column, when the problem has a place.
    pub at: Option<(u64, u64)>,
    pub message: String,
}

impl LaunchIssue {
    /// The protocol's form.
    #[must_use]
    pub fn view(&self) -> piarc_protocol::dev_server::LaunchIssue {
        piarc_protocol::dev_server::LaunchIssue {
            file: self.file.to_owned(),
            line: self.at.map(|(line, _)| line),
            column: self.at.map(|(_, column)| column),
            message: self.message.clone(),
        }
    }
}

/// The project's configurations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    /// `.piarc` ones first, in file order.
    pub configs: Vec<LaunchConfig>,
    /// `autoVerify`: `None` when neither file says.
    pub auto_verify: Option<bool>,
    pub issues: Vec<LaunchIssue>,
    /// `.claude` configurations a `.piarc` one of the same name hides.
    pub hidden: Vec<LaunchConfig>,
    /// The files that exist.
    pub files: Vec<&'static str>,
}

impl Launch {
    /// `autoVerify`, true when neither file says.
    #[must_use]
    pub fn auto_verify(&self) -> bool {
        self.auto_verify.unwrap_or(true)
    }

    /// The configuration called `name`.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&LaunchConfig> {
        self.configs.iter().find(|c| c.name == name)
    }

    /// The ports the configurations declare.
    #[must_use]
    pub fn ports(&self) -> Vec<u16> {
        let mut ports: Vec<u16> = self.configs.iter().map(LaunchConfig::port).collect();
        ports.sort_unstable();
        ports.dedup();
        ports
    }
}

/// What one file holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub configs: Vec<LaunchConfig>,
    pub auto_verify: Option<bool>,
    pub issues: Vec<LaunchIssue>,
}

/// Reads the launch files of the project at `root`.
#[must_use]
pub fn load(root: &Path) -> Launch {
    let mut launch = Launch::default();
    for source in [LaunchSource::Piarc, LaunchSource::Claude] {
        let file = file_of(source);
        let Some(text) = read(root, file, &mut launch.issues) else {
            continue;
        };
        launch.files.push(file);
        let parsed = parse(&text, source);
        launch.issues.extend(parsed.issues);
        if launch.auto_verify.is_none() {
            launch.auto_verify = parsed.auto_verify;
        }
        for config in parsed.configs {
            if launch.configs.iter().any(|c| c.name == config.name) {
                launch.hidden.push(config);
            } else {
                launch.configs.push(config);
            }
        }
    }
    launch
}

fn read(root: &Path, file: &'static str, issues: &mut Vec<LaunchIssue>) -> Option<String> {
    let path = root.join(file);
    let problem = |message: String| LaunchIssue {
        file,
        at: None,
        message,
    };
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_FILE_BYTES => {
            issues.push(problem(format!(
                "larger than {} KiB; not read",
                MAX_FILE_BYTES / 1024
            )));
            None
        }
        Ok(_) => match std::fs::read(&path) {
            Ok(bytes) => {
                let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
                match String::from_utf8(bytes.to_vec()) {
                    Ok(text) => Some(text),
                    Err(_) => {
                        issues.push(problem("not UTF-8 text".to_owned()));
                        None
                    }
                }
            }
            Err(error) => {
                issues.push(problem(format!("cannot read: {error}")));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            issues.push(problem(format!("cannot read: {error}")));
            None
        }
    }
}

/// Parses one launch file's text.
#[must_use]
pub fn parse(text: &str, source: LaunchSource) -> Parsed {
    let file = file_of(source);
    let plain = strip_jsonc(text);
    let value: Value = match serde_json::from_str(&plain) {
        Ok(value) => value,
        Err(error) => {
            let message = error.to_string();
            let message = message
                .split(" at line ")
                .next()
                .unwrap_or(&message)
                .to_owned();
            return Parsed {
                issues: vec![LaunchIssue {
                    file,
                    at: Some((
                        u64::try_from(error.line()).unwrap_or(0),
                        u64::try_from(error.column()).unwrap_or(0),
                    )),
                    message,
                }],
                ..Parsed::default()
            };
        }
    };
    let mut parsed = Parsed::default();
    let issue = |at: Option<usize>, message: String| LaunchIssue {
        file,
        at: at.map(|offset| line_column(text, offset)),
        message,
    };
    let Value::Object(top) = value else {
        parsed.issues.push(issue(
            Some(0),
            "the file must hold a JSON object".to_owned(),
        ));
        return parsed;
    };
    match top.get("autoVerify") {
        None => {}
        Some(Value::Bool(on)) => parsed.auto_verify = Some(*on),
        Some(_) => parsed.issues.push(issue(
            key_offset(&plain, "autoVerify"),
            "\"autoVerify\" must be true or false".to_owned(),
        )),
    }
    let starts = element_offsets(&plain, "configurations");
    match top.get("configurations") {
        None => {}
        Some(Value::Array(list)) => {
            for (index, entry) in list.iter().enumerate() {
                let at = starts.get(index).copied();
                if index >= MAX_CONFIGS {
                    parsed.issues.push(issue(
                        at,
                        format!("more than {MAX_CONFIGS} configurations; the rest are ignored"),
                    ));
                    break;
                }
                match config(entry, source) {
                    Ok(config) if parsed.configs.iter().any(|c| c.name == config.name) => {
                        parsed.issues.push(issue(
                            at,
                            format!("a second configuration is named \"{}\"", config.name),
                        ));
                    }
                    Ok(config) => parsed.configs.push(config),
                    Err(message) => parsed
                        .issues
                        .push(issue(at, format!("configurations[{index}]: {message}"))),
                }
            }
        }
        Some(_) => parsed.issues.push(issue(
            key_offset(&plain, "configurations"),
            "\"configurations\" must be an array".to_owned(),
        )),
    }
    parsed
}

fn config(entry: &Value, source: LaunchSource) -> Result<LaunchConfig, String> {
    let Value::Object(map) = entry else {
        return Err("must be an object".to_owned());
    };
    let text = |key: &str| -> Result<Option<String>, String> {
        match map.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.clone())),
            Some(_) => Err(format!("\"{key}\" must be a non-empty string")),
        }
    };
    let list = |key: &str| -> Result<Vec<String>, String> {
        match map.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::String(s) => Ok(s.clone()),
                    Value::Number(n) => Ok(n.to_string()),
                    _ => Err(format!("\"{key}\" must be a list of strings")),
                })
                .collect(),
            Some(_) => Err(format!("\"{key}\" must be a list of strings")),
        }
    };
    let name = text("name")?.ok_or_else(|| "\"name\" is missing".to_owned())?;
    if name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err("\"name\" must be at most 100 characters without control characters".into());
    }
    let env = env_of(map.get("env"))?;
    let port = match map.get("port") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(
            n.as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p > 0)
                .ok_or_else(|| "\"port\" must be a number from 1 to 65535".to_owned())?,
        ),
        Some(_) => return Err("\"port\" must be a number from 1 to 65535".to_owned()),
    };
    let auto_port = match map.get("autoPort") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("\"autoPort\" must be true or false".to_owned()),
    };
    let config = LaunchConfig {
        name,
        source,
        runtime_executable: text("runtimeExecutable")?,
        runtime_args: list("runtimeArgs")?,
        program: text("program")?,
        args: list("args")?,
        cwd: text("cwd")?,
        env,
        port,
        auto_port,
        url: text("url")?,
    };
    if config.runtime_executable.is_none() && config.program.is_none() {
        return Err("needs \"runtimeExecutable\" or \"program\"".to_owned());
    }
    if let Some(url) = &config.url
        && !(url.starts_with("http://")
            || url.starts_with("https://")
            || url.contains(WORKSPACE_FOLDER))
    {
        return Err("\"url\" must start with http:// or https://".to_owned());
    }
    Ok(config)
}

/// A configuration's `env`: names to strings (numbers and booleans as written).
fn env_of(value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    match value {
        None | Some(Value::Null) => {}
        Some(Value::Object(vars)) => {
            for (key, value) in vars {
                let value = match value {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => return Err(format!("\"env.{key}\" must be a string")),
                };
                if key.is_empty() || key.contains('=') || key.contains('\0') {
                    return Err(format!("\"env\" has an invalid name \"{key}\""));
                }
                env.insert(key.clone(), value);
            }
        }
        Some(_) => return Err("\"env\" must be an object".to_owned()),
    }
    Ok(env)
}

impl LaunchConfig {
    /// The program and its arguments, `${workspaceFolder}` replaced by `root`.
    #[must_use]
    pub fn command(&self, root: &Path) -> Vec<String> {
        let root = root.to_string_lossy();
        let expand = |s: &String| s.replace(WORKSPACE_FOLDER, &root);
        let mut command = vec![
            self.runtime_executable
                .as_ref()
                .map_or_else(|| "node".to_owned(), expand),
        ];
        command.extend(self.runtime_args.iter().map(expand));
        command.extend(self.program.iter().map(expand));
        command.extend(self.args.iter().map(expand));
        command
    }

    /// The working directory as written, relative to the project (`.` when absent).
    #[must_use]
    pub fn cwd(&self, root: &Path) -> String {
        self.cwd.as_ref().map_or_else(
            || ".".to_owned(),
            |cwd| cwd.replace(WORKSPACE_FOLDER, &root.to_string_lossy()),
        )
    }

    /// The environment it adds, `${workspaceFolder}` replaced.
    #[must_use]
    pub fn env(&self, root: &Path) -> BTreeMap<String, String> {
        let root = root.to_string_lossy();
        self.env
            .iter()
            .map(|(k, v)| (k.clone(), v.replace(WORKSPACE_FOLDER, &root)))
            .collect()
    }

    /// The port: `port`, the `url`'s, `env.PORT`, `--port`/`-p`, or [`DEFAULT_PORT`].
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
            .or_else(|| self.url.as_deref().and_then(url_port))
            .or_else(|| self.env.get("PORT").and_then(|p| p.trim().parse().ok()))
            .or_else(|| arg_port(&self.runtime_args).or_else(|| arg_port(&self.args)))
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_PORT)
    }

    /// The address to open: `url`, or `http://localhost:<port>/`.
    #[must_use]
    pub fn url(&self, root: &Path) -> String {
        self.url.as_ref().map_or_else(
            || format!("http://localhost:{}/", self.port()),
            |url| url.replace(WORKSPACE_FOLDER, &root.to_string_lossy()),
        )
    }

    /// The same configuration on `port` (`autoPort` found the declared one busy): the port
    /// arguments, `PORT` and the `url` follow.
    #[must_use]
    pub fn on_port(&self, port: u16) -> Self {
        let mut moved = self.clone();
        let from = self.port();
        moved.port = Some(port);
        moved.runtime_args = with_port_args(&self.runtime_args, port);
        moved.args = with_port_args(&self.args, port);
        moved.env.insert("PORT".to_owned(), port.to_string());
        moved.url = self
            .url
            .as_ref()
            .map(|url| replace_url_port(url, from, port));
        moved
    }

    /// SHA-256 over what runs: the command, the directory, the environment and the port,
    /// lowercase hex.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        let mut part = |label: &str, value: &str| {
            hash.update(label.as_bytes());
            hash.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_le_bytes());
            hash.update(value.as_bytes());
        };
        part("runtime", self.runtime_executable.as_deref().unwrap_or(""));
        for arg in &self.runtime_args {
            part("runtimeArg", arg);
        }
        part("program", self.program.as_deref().unwrap_or(""));
        for arg in &self.args {
            part("arg", arg);
        }
        part("cwd", self.cwd.as_deref().unwrap_or(""));
        for (key, value) in &self.env {
            part("envKey", key);
            part("envValue", value);
        }
        part("port", &self.port().to_string());
        part("autoPort", if self.auto_port { "1" } else { "0" });
        hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The command line for reading: each part quoted when it needs to be.
    #[must_use]
    pub fn display(&self, root: &Path) -> String {
        self.command(root)
            .iter()
            .map(|part| quote(part))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// `part` as a POSIX shell word: unchanged when it has only safe characters, otherwise in
/// single quotes.
#[must_use]
pub fn quote(part: &str) -> String {
    let safe = !part.is_empty()
        && part.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '-' | '_' | '.' | '/' | ':' | '=' | '@' | '%' | '+' | ',')
        });
    if safe {
        part.to_owned()
    } else {
        format!("'{}'", part.replace('\'', r"'\''"))
    }
}

fn url_port(url: &str) -> Option<u16> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let port = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split_once("]:").map(|(_, port)| port)
    } else {
        host_port.rsplit_once(':').map(|(_, port)| port)
    };
    port.and_then(|p| p.parse().ok())
}

fn replace_url_port(url: &str, from: u16, to: u16) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let authority = match authority.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().ok() == Some(from) && !host.ends_with('[') => {
            format!("{host}:{to}")
        }
        Some((_, port)) if port.parse::<u16>().is_ok() => authority.to_owned(),
        _ => format!("{authority}:{to}"),
    };
    format!("{scheme}://{authority}{path}")
}

fn arg_port(args: &[String]) -> Option<u16> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--port=") {
            return value.parse().ok();
        }
        if arg == "--port" || arg == "-p" {
            return iter.next().and_then(|v| v.parse().ok());
        }
    }
    None
}

fn with_port_args(args: &[String], port: u16) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut next_is_port = false;
    for arg in args {
        if next_is_port {
            out.push(port.to_string());
            next_is_port = false;
        } else if arg.starts_with("--port=") {
            out.push(format!("--port={port}"));
        } else {
            next_is_port = arg == "--port" || arg == "-p";
            out.push(arg.clone());
        }
    }
    out
}

/// `text` with `//` and `/* */` comments and trailing commas replaced by spaces: every other
/// byte, and every line break, stays where it was, so positions still point into `text`.
#[must_use]
pub fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    blank(&mut out, i);
                    i += 1;
                }
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let start = i;
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                let end = (i + 2).min(bytes.len());
                for j in start..end {
                    blank(&mut out, j);
                }
                i = end;
                continue;
            }
            b',' if matches!(next_significant(bytes, i + 1), Some(b'}' | b']')) => {
                out[i] = b' ';
            }
            _ => {}
        }
        i += 1;
    }
    // Comments and commas became spaces byte for byte, so the text is still UTF-8.
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// A comment byte becomes a space; line breaks stay. A multi-byte character becomes one
/// space per byte, which keeps both the offsets and UTF-8.
fn blank(out: &mut [u8], i: usize) {
    if out[i] != b'\n' && out[i] != b'\r' {
        out[i] = b' ';
    }
}

/// The next byte after `from` that is neither whitespace nor inside a comment.
fn next_significant(bytes: &[u8], mut from: usize) -> Option<u8> {
    while from < bytes.len() {
        let b = bytes[from];
        if b.is_ascii_whitespace() {
            from += 1;
        } else if b == b'/' && bytes.get(from + 1) == Some(&b'/') {
            while from < bytes.len() && bytes[from] != b'\n' {
                from += 1;
            }
        } else if b == b'/' && bytes.get(from + 1) == Some(&b'*') {
            from += 2;
            while from < bytes.len() && !(bytes[from] == b'*' && bytes.get(from + 1) == Some(&b'/'))
            {
                from += 1;
            }
            from += 2;
        } else {
            return Some(b);
        }
    }
    None
}

/// 1-based line and column (in characters) of byte `offset` of `text`.
fn line_column(text: &str, offset: usize) -> (u64, u64) {
    let before = text.get(..offset.min(text.len())).unwrap_or(text);
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit_once('\n')
        .map_or(before, |(_, last)| last)
        .chars()
        .count()
        + 1;
    (
        u64::try_from(line).unwrap_or(u64::MAX),
        u64::try_from(column).unwrap_or(u64::MAX),
    )
}

/// The offset of top-level key `key`'s value in comment-free JSON `plain`.
fn key_offset(plain: &str, key: &str) -> Option<usize> {
    top_level_values(plain)
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, at)| at)
}

/// The offsets of the elements of top-level array `key` in comment-free JSON `plain`.
fn element_offsets(plain: &str, key: &str) -> Vec<usize> {
    let Some(start) = key_offset(plain, key) else {
        return Vec::new();
    };
    let bytes = plain.as_bytes();
    if bytes.get(start) != Some(&b'[') {
        return Vec::new();
    }
    let mut offsets = Vec::new();
    let mut depth = 0usize;
    let mut i = start;
    let mut expect_element = false;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            if depth == 1 && expect_element {
                offsets.push(i);
                expect_element = false;
            }
            i = skip_string(bytes, i);
            continue;
        }
        match b {
            b'[' | b'{' => {
                if depth == 1 && expect_element {
                    offsets.push(i);
                    expect_element = false;
                }
                depth += 1;
                if depth == 1 {
                    expect_element = true;
                }
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            b',' if depth == 1 => expect_element = true,
            _ if depth == 1 && expect_element && !b.is_ascii_whitespace() => {
                offsets.push(i);
                expect_element = false;
            }
            _ => {}
        }
        i += 1;
    }
    offsets
}

/// The top-level keys of comment-free JSON `plain` with the offsets of their values.
fn top_level_values(plain: &str) -> Vec<(String, usize)> {
    let bytes = plain.as_bytes();
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    let mut pending_key: Option<String> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' {
            let end = skip_string(bytes, i);
            if depth == 1 && pending_key.is_none() {
                let raw = plain.get(i..end).unwrap_or("\"\"");
                if let Ok(key) = serde_json::from_str::<String>(raw) {
                    // A key when a colon follows.
                    if next_significant(bytes, end) == Some(b':') {
                        pending_key = Some(key);
                        i = end;
                        continue;
                    }
                }
            }
            i = end;
            continue;
        }
        match b {
            b':' if depth == 1 => {
                if let Some(key) = pending_key.take() {
                    let mut j = i + 1;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    found.push((key, j));
                }
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    found
}

/// The offset just past the string that starts at `start`.
fn skip_string(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

#[cfg(test)]
mod tests;
