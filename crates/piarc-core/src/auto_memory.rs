//! Auto memory (T47, design addendum `docs/architecture/addenda/T47-auto-memory-and-managed-settings.md`,
//! sections 1–4): the agent's notes across sessions, one directory per repository.
//!
//! - **Place.** `<data>/auto-memory/<key>/`: the key is the main checkout's directory name
//!   (`[A-Za-z0-9._-]`, at most 40 characters) and 12 hexadecimal digits of the SHA-256 of its
//!   path, so every worktree of a repository shares the directory and two repositories never
//!   do ([`project_dir`]). Only Core reads and writes it; the Agent Host's sandbox profile does
//!   not allow writing there.
//! - **Format.** One topic file per memory, `<name>.md` with a frontmatter Core writes
//!   (`name`, `description`, `type`, `modified`, `session`), and the index `MEMORY.md`, which
//!   Core generates from the topics after every change (newest first, one line each). The
//!   model never writes the index.
//! - **Limits.** [`MAX_TOPIC_BYTES`] per body, [`MAX_TOPICS`] per project, descriptions of one
//!   line up to [`MAX_DESCRIPTION_CHARS`]; the index goes into a new session's system prompt up
//!   to [`INDEX_LINES`] lines or [`INDEX_BYTES`] bytes ([`Store::injected`]).
//! - **Claude Code.** [`Store::import_claude`] copies the topic files of Claude Code's memory
//!   directory for the same repository once, on the user's request; Claude Code's files are only
//!   read.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The directory of every project's memory, under the data directory.
pub const ROOT_DIR: &str = "auto-memory";

/// The generated index of a project's memory.
pub const INDEX_FILE: &str = "MEMORY.md";

/// Names the repository a memory directory belongs to.
pub const PROJECT_FILE: &str = "project.json";

/// The longest body of one memory, in UTF-8 bytes.
pub const MAX_TOPIC_BYTES: usize = 16 * 1024;

/// The most memories one project keeps.
pub const MAX_TOPICS: usize = 200;

/// The longest description, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 200;

/// The most index lines a new session's system prompt gets.
pub const INDEX_LINES: usize = 200;

/// The most index bytes a new session's system prompt gets.
pub const INDEX_BYTES: usize = 25 * 1024;

/// The kinds of memory (Claude Code's four).
pub const TYPES: [&str; 4] = ["user", "feedback", "project", "reference"];

/// Serializes writes of every project's memory: one save, delete or import at a time, so a
/// topic and the index it is listed in change together.
static WRITER: Mutex<()> = Mutex::new(());

/// Why a memory operation was refused.
#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    /// The name is not 1–64 of `[a-z0-9_-]` starting with a letter or digit.
    #[error("{0:?} is not a memory name: use 1 to 64 lowercase letters, digits, - or _")]
    Name(String),
    /// The type is not one of [`TYPES`].
    #[error("{0:?} is not a memory type (user, feedback, project or reference)")]
    Type(String),
    /// The description is empty, longer than one line or over the limit.
    #[error("the description must be one line of 1 to {MAX_DESCRIPTION_CHARS} characters")]
    Description,
    /// The body is over [`MAX_TOPIC_BYTES`].
    #[error("the memory is {0} bytes; keep it under {MAX_TOPIC_BYTES} bytes")]
    TooLarge(usize),
    /// The project already keeps [`MAX_TOPICS`] memories.
    #[error("this project already keeps {MAX_TOPICS} memories: merge or delete some first")]
    Full,
    /// No memory has this name.
    #[error("no memory is named {0:?}")]
    Missing(String),
    /// Reading or writing failed.
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// One memory.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    /// Its name (the file name without `.md`).
    pub name: String,
    /// The line of the index.
    pub description: String,
    /// `user`, `feedback`, `project` or `reference`.
    #[serde(rename = "type")]
    pub kind: String,
    /// When it was last written (UTC, ISO 8601).
    pub modified: String,
    /// Who wrote it last: a session id, `user` (the settings page) or `import`.
    pub session: String,
    /// The body.
    pub body: String,
}

/// A memory to save.
#[derive(Debug, Clone)]
pub struct NewTopic<'a> {
    /// Its name.
    pub name: &'a str,
    /// The line of the index.
    pub description: &'a str,
    /// Its type.
    pub kind: &'a str,
    /// The body.
    pub body: &'a str,
}

/// What a save did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    /// The memory did not exist before.
    pub created: bool,
    /// Its index line.
    pub line: String,
    /// SHA-256 of the body as written (for the audit).
    pub sha256: String,
}

/// What an import did.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The memories copied.
    pub imported: Vec<String>,
    /// Names that exist already, left as they are.
    pub skipped: Vec<String>,
    /// Files that are not memories PiArc can keep, with the reason.
    pub refused: Vec<(String, String)>,
}

/// The project key of the repository whose main checkout is `checkout` (canonical).
#[must_use]
pub fn project_key(checkout: &Path) -> String {
    let shown = piarc_git::strip_verbatim(checkout.to_owned());
    let text = shown.to_string_lossy();
    let hashed = if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.into_owned()
    };
    let digest = Sha256::digest(hashed.as_bytes());
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let name: String = shown
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(40)
        .collect();
    let name = name.trim_start_matches('.');
    if name.is_empty() {
        hex
    } else {
        format!("{name}-{hex}")
    }
}

/// `<data>/auto-memory/<key>`.
#[must_use]
pub fn project_dir(data: &Path, checkout: &Path) -> PathBuf {
    data.join(ROOT_DIR).join(project_key(checkout))
}

/// Claude Code's memory directory for the same repository: `<home>/.claude/projects/<key>/memory`,
/// its key being the path with every character other than a letter or digit replaced by `-`.
#[must_use]
pub fn claude_dir(home: &Path, checkout: &Path) -> PathBuf {
    let key: String = piarc_git::strip_verbatim(checkout.to_owned())
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home.join(".claude")
        .join("projects")
        .join(key)
        .join("memory")
}

/// Whether `name` is a memory name.
#[must_use]
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The memory of one repository.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
    checkout: PathBuf,
}

impl Store {
    /// The memory of the repository whose main checkout is `checkout`; nothing is read yet.
    #[must_use]
    pub fn new(data: &Path, checkout: &Path) -> Self {
        Self {
            dir: project_dir(data, checkout),
            checkout: checkout.to_owned(),
        }
    }

    /// The directory.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The index file.
    #[must_use]
    pub fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_FILE)
    }

    /// Every memory, newest first (files that are not memories are skipped).
    ///
    /// # Errors
    ///
    /// The directory cannot be read.
    pub fn list(&self) -> io::Result<Vec<Topic>> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut topics = Vec::new();
        for entry in entries {
            let path = entry?.path();
            let Some(name) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".md"))
            else {
                continue;
            };
            if !valid_name(name) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path)
                && let Some(topic) = parse(name, &text)
            {
                topics.push(topic);
            }
        }
        topics.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
        Ok(topics)
    }

    /// The memory named `name`.
    ///
    /// # Errors
    ///
    /// The file cannot be read.
    pub fn read(&self, name: &str) -> Result<Option<Topic>, MemoryError> {
        if !valid_name(name) {
            return Err(MemoryError::Name(name.to_owned()));
        }
        match std::fs::read_to_string(self.dir.join(format!("{name}.md"))) {
            Ok(text) => Ok(parse(name, &text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Writes `topic` (new, or replacing the memory of the same name) as written by `by`, and
    /// the index.
    ///
    /// # Errors
    ///
    /// The name, type, description or size is not acceptable, the project is full, or the
    /// write failed (the files are then unchanged).
    pub fn save(&self, topic: &NewTopic<'_>, by: &str) -> Result<Saved, MemoryError> {
        if !valid_name(topic.name) {
            return Err(MemoryError::Name(topic.name.to_owned()));
        }
        if !TYPES.contains(&topic.kind) {
            return Err(MemoryError::Type(topic.kind.to_owned()));
        }
        let description = topic.description.trim();
        if description.is_empty()
            || description.contains(['\n', '\r'])
            || description.chars().count() > MAX_DESCRIPTION_CHARS
        {
            return Err(MemoryError::Description);
        }
        let body = topic.body.trim_end();
        if body.len() > MAX_TOPIC_BYTES {
            return Err(MemoryError::TooLarge(body.len()));
        }
        let _writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner);
        let existing = self.list()?;
        let created = !existing.iter().any(|t| t.name == topic.name);
        if created && existing.len() >= MAX_TOPICS {
            return Err(MemoryError::Full);
        }
        let saved = Topic {
            name: topic.name.to_owned(),
            description: description.to_owned(),
            kind: topic.kind.to_owned(),
            modified: now_iso(),
            session: by.to_owned(),
            body: body.to_owned(),
        };
        self.prepare()?;
        replace(
            &self.dir.join(format!("{}.md", saved.name)),
            &render(&saved),
        )?;
        let mut topics: Vec<Topic> = existing
            .into_iter()
            .filter(|t| t.name != saved.name)
            .collect();
        topics.insert(0, saved.clone());
        replace(&self.index_path(), &index(&topics))?;
        Ok(Saved {
            created,
            line: line(&saved),
            sha256: sha256(&saved.body),
        })
    }

    /// Deletes the memory `name` and rewrites the index.
    ///
    /// # Errors
    ///
    /// No memory has the name, or a file operation failed.
    pub fn delete(&self, name: &str) -> Result<Topic, MemoryError> {
        let _writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner);
        let topic = self
            .read(name)?
            .ok_or_else(|| MemoryError::Missing(name.to_owned()))?;
        std::fs::remove_file(self.dir.join(format!("{name}.md")))?;
        let topics: Vec<Topic> = self.list()?;
        replace(&self.index_path(), &index(&topics))?;
        Ok(topic)
    }

    /// The whole index, as the file holds it (`None` without memories).
    ///
    /// # Errors
    ///
    /// The directory cannot be read.
    pub fn index(&self) -> io::Result<Option<String>> {
        let topics = self.list()?;
        Ok((!topics.is_empty()).then(|| index(&topics)))
    }

    /// The index for a new session's system prompt: at most [`INDEX_LINES`] lines and
    /// [`INDEX_BYTES`] bytes, with a closing line when entries were left out; `None` without
    /// memories.
    ///
    /// # Errors
    ///
    /// The directory cannot be read.
    pub fn injected(&self) -> io::Result<Option<String>> {
        let topics = self.list()?;
        if topics.is_empty() {
            return Ok(None);
        }
        let mut text = format!("{}\n\n", HEADING);
        let mut shown = 0;
        for topic in &topics {
            let next = format!("{}\n", line(topic));
            if shown >= INDEX_LINES || text.len() + next.len() > INDEX_BYTES - 120 {
                break;
            }
            text.push_str(&next);
            shown += 1;
        }
        if shown < topics.len() {
            text.push_str(&format!(
                "\n({} more memories are not listed here; read the full index with the Memory tool.)\n",
                topics.len() - shown
            ));
        }
        Ok(Some(text))
    }

    /// Copies the memories of Claude Code's directory `source` that PiArc does not have yet
    /// (section 1.4); `source` is only read.
    ///
    /// # Errors
    ///
    /// A file operation failed.
    pub fn import_claude(&self, source: &Path) -> Result<Imported, MemoryError> {
        let mut out = Imported::default();
        let entries = match std::fs::read_dir(source) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(error) => return Err(error.into()),
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension().is_some_and(|e| e == "md")
                    && p.file_name().is_some_and(|n| n != INDEX_FILE)
                    && p.is_file()
            })
            .collect();
        files.sort();
        for path in files {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) => {
                    out.refused.push((stem, error.to_string()));
                    continue;
                }
            };
            let topic = claude_topic(&stem, &text);
            if self.read(&topic.name).ok().flatten().is_some() {
                out.skipped.push(topic.name);
                continue;
            }
            let new = NewTopic {
                name: &topic.name,
                description: &topic.description,
                kind: &topic.kind,
                body: &topic.body,
            };
            match self.save(&new, "import") {
                Ok(_) => out.imported.push(topic.name),
                Err(error) => out.refused.push((stem, error.to_string())),
            }
        }
        Ok(out)
    }

    /// Creates the directory and its `project.json`.
    fn prepare(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let marker = self.dir.join(PROJECT_FILE);
        if !marker.exists() {
            let record = json!({ "checkout": piarc_fs::display(&self.checkout) });
            replace(&marker, &format!("{record:#}\n"))?;
        }
        Ok(())
    }
}

/// The index's first line.
const HEADING: &str = "# Auto memory";

/// The index line of `topic`.
fn line(topic: &Topic) -> String {
    let day = topic.modified.get(..10).unwrap_or(&topic.modified);
    format!(
        "- [{name}]({name}.md) ({kind}, {day}) — {description}",
        name = topic.name,
        kind = topic.kind,
        description = topic.description
    )
}

/// The whole index of `topics` (newest first).
fn index(topics: &[Topic]) -> String {
    let mut text = format!("{HEADING}\n\n");
    for topic in topics {
        text.push_str(&line(topic));
        text.push('\n');
    }
    text
}

/// The file of `topic`: a frontmatter of JSON-quoted values (valid YAML), then the body.
fn render(topic: &Topic) -> String {
    let quoted = |text: &str| Value::String(text.to_owned()).to_string();
    format!(
        "---\nname: {}\ndescription: {}\ntype: {}\nmodified: {}\nsession: {}\n---\n\n{}\n",
        topic.name,
        quoted(&topic.description),
        topic.kind,
        topic.modified,
        quoted(&topic.session),
        topic.body
    )
}

/// A memory file PiArc wrote; `None` when its frontmatter lacks a field.
fn parse(name: &str, text: &str) -> Option<Topic> {
    let document = piarc_config::frontmatter::split(text);
    let fields = piarc_config::frontmatter::mapping(document.yaml?).ok()?;
    let field = |key: &str| fields.get(key).and_then(Value::as_str).map(str::to_owned);
    let kind = field("type").filter(|k| TYPES.contains(&k.as_str()))?;
    Some(Topic {
        name: name.to_owned(),
        description: field("description")?,
        kind,
        modified: field("modified").unwrap_or_default(),
        session: field("session").unwrap_or_default(),
        body: document.body.trim().to_owned(),
    })
}

/// A Claude Code memory file as a PiArc memory: its frontmatter's `name`, `description` and
/// `type` where usable, else the file name, the body's first line and `project`.
fn claude_topic(stem: &str, text: &str) -> Topic {
    let document = piarc_config::frontmatter::split(text);
    let fields: BTreeMap<String, Value> = document
        .yaml
        .and_then(|yaml| piarc_config::frontmatter::mapping(yaml).ok())
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    let field = |key: &str| fields.get(key).and_then(Value::as_str).map(str::trim);
    let body = document.body.trim().to_owned();
    let name = field("name")
        .map(slug)
        .filter(|n| valid_name(n))
        .unwrap_or_else(|| slug(stem));
    let description = field("description")
        .filter(|d| !d.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            body.lines()
                .map(|l| l.trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or(stem)
                .to_owned()
        });
    let description: String = description
        .replace(['\n', '\r'], " ")
        .chars()
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    Topic {
        name,
        description,
        kind: field("type")
            .filter(|k| TYPES.contains(k))
            .unwrap_or("project")
            .to_owned(),
        modified: String::new(),
        session: "import".to_owned(),
        body,
    }
}

/// `text` as a memory name: lowercase, other characters `-`.
fn slug(text: &str) -> String {
    let slug: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    slug.trim_matches('-').chars().take(64).collect()
}

fn replace(path: &Path, text: &str) -> io::Result<()> {
    piarc_config::write::replace_file(path, text.as_bytes())
        .map_err(|e| io::Error::other(e.to_string()))
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The current UTC time, `YYYY-MM-DDTHH:MM:SSZ`.
fn now_iso() -> String {
    let now = SystemTime::now();
    let seconds = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        piarc_telemetry::Day::of(now).label(),
        seconds / 3_600,
        seconds / 60 % 60,
        seconds % 60
    )
}

#[cfg(test)]
mod tests;
