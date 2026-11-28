//! Data export (settings, Data management): every session in one ZIP archive, written once the
//! user picked a place in the main process's save dialog. Each session is there twice: its
//! conversation as Markdown (the current branch: messages, a line per tool call, summaries) and
//! its original Pi records; `sessions.json` indexes them. Subagent sessions belong to their
//! parent and are left out; a file outside `pi/sessions/` is never read. The archive is written
//! one session at a time, so a large history never sits in memory at once.

use std::collections::{HashMap, HashSet};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use piarc_protocol::ErrorKind;
use piarc_telemetry::zip::ArchiveWriter;
use serde::Deserialize;
use serde_json::{Value, json};

use super::Hub;
use crate::error::{Error, Result};

/// The words of the Markdown in the client's language, and its clock's offset from UTC.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportLabels {
    pub user: String,
    pub assistant: String,
    pub tool: String,
    pub summary: String,
    pub project: String,
    pub created: String,
    pub updated: String,
    pub archived: String,
    pub untitled: String,
    /// Minutes east of UTC, for the times in the Markdown.
    pub offset_minutes: i32,
}

/// Longest label accepted (characters).
const MAX_LABEL: usize = 64;
/// Longest tool call argument shown in the Markdown (characters).
const MAX_ARGUMENT: usize = 120;
/// Longest file name stem in the archive (characters).
const MAX_NAME: usize = 80;

impl ExportLabels {
    /// Parses and checks the client's labels.
    ///
    /// # Errors
    ///
    /// Malformed JSON, a label that is empty or longer than [`MAX_LABEL`], an offset past ±14 h.
    pub fn parse(json: &str) -> Result<Self> {
        let invalid = |reason: &str| Error::InvalidArgument {
            field: "labels",
            reason: reason.into(),
        };
        let labels: Self = serde_json::from_str(json).map_err(|_| invalid("a labels object"))?;
        let texts = [
            &labels.user,
            &labels.assistant,
            &labels.tool,
            &labels.summary,
            &labels.project,
            &labels.created,
            &labels.updated,
            &labels.archived,
            &labels.untitled,
        ];
        if texts
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > MAX_LABEL)
        {
            return Err(invalid("labels of 1 to 64 characters"));
        }
        if !(-840..=840).contains(&labels.offset_minutes) {
            return Err(invalid("an offset within 14 hours"));
        }
        Ok(labels)
    }
}

/// What the export needs of one session.
#[derive(Debug, Clone)]
pub struct ExportSession {
    pub id: String,
    pub title: Option<String>,
    pub workspace: Option<String>,
    pub cwd: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub archived: bool,
    pub pinned: bool,
    pub model: Option<String>,
    pub file: PathBuf,
}

fn io_error(error: &std::io::Error) -> Error {
    Error::Feature {
        kind: ErrorKind::IoError,
        retryable: false,
        message: format!("cannot write the data export: {error}"),
        details: None,
    }
}

impl Hub {
    /// Writes every session to `path` (absolute) as a ZIP archive and answers
    /// `{path, bytes, sessions}`.
    pub(crate) async fn export_sessions(
        &self,
        path: PathBuf,
        labels: ExportLabels,
    ) -> Result<Value> {
        let records = self.ctx.storage.run(|store| store.sessions()).await??;
        let root = self.ctx.storage.dirs().pi_sessions().to_owned();
        let sessions: Vec<ExportSession> = records
            .into_iter()
            .filter(|r| r.meta.subagent_parent.is_none())
            .map(|r| ExportSession {
                title: r.title().map(str::to_owned),
                workspace: r.workspace_path.clone(),
                cwd: r.meta.cwd.clone(),
                created_at: r.meta.created_at,
                updated_at: r.meta.updated_at,
                archived: r.archived,
                pinned: r.pinned,
                model: r
                    .meta
                    .model_provider
                    .as_ref()
                    .zip(r.meta.model_id.as_ref())
                    .map(|(p, m)| format!("{p}/{m}")),
                file: PathBuf::from(&r.file_path),
                id: r.id,
            })
            .collect();
        let target = path.clone();
        let count = sessions.len();
        tokio::task::spawn_blocking(move || {
            write_export(&target, &root, &sessions, &labels, SystemTime::now())
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("the data export task failed: {e}"),
        })?
        .map_err(|e| io_error(&e))?;
        let bytes = std::fs::metadata(&path).map_or(0, |m| m.len());
        tracing::info!(target: "piarc_core", bytes, sessions = count, "data exported");
        Ok(json!({ "path": path, "bytes": bytes, "sessions": count }))
    }
}

/// Writes the archive of `sessions` to `path` (through a temporary file beside it, so a failed
/// export leaves nothing there). Files outside `root` are listed but not read.
///
/// # Errors
///
/// The I/O error of writing the archive, or an archive past the ZIP format's limits.
pub fn write_export(
    path: &Path,
    root: &Path,
    sessions: &[ExportSession],
    labels: &ExportLabels,
    now: SystemTime,
) -> std::io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("the export path has no file name"))?;
    let temp = path.with_file_name(format!(".{}.partial", name.to_string_lossy()));
    let result = (|| {
        let file = std::fs::File::create(&temp)?;
        let mut out = BufWriter::new(file);
        let mut archive = ArchiveWriter::new(&mut out, now);
        let mut names = HashSet::new();
        let mut index = Vec::with_capacity(sessions.len());
        for session in sessions {
            let records = if session.file.starts_with(root) {
                std::fs::read(&session.file).ok()
            } else {
                None
            };
            let mut entry = json!({
                "id": session.id,
                "title": session.title,
                "project": session.workspace,
                "cwd": session.cwd,
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
                "archived": session.archived,
                "pinned": session.pinned,
                "model": session.model,
            });
            if let Some(records) = records {
                let raw = format!("raw/{}.jsonl", session.id);
                archive.add(&raw, &records)?;
                let markdown = unique(&mut names, &markdown_path(session, labels));
                archive.add(&markdown, render(session, &records, labels).as_bytes())?;
                entry["raw"] = json!(raw);
                entry["markdown"] = json!(markdown);
            } else {
                entry["missing"] = json!(true);
            }
            index.push(entry);
        }
        let index = serde_json::to_vec_pretty(&json!({ "version": 1, "sessions": index }))
            .map_err(std::io::Error::other)?;
        archive.add("sessions.json", &index)?;
        archive.finish()?;
        let file = out.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `markdown/<project>/<date> <title>.md`, with names safe on every file system.
fn markdown_path(session: &ExportSession, labels: &ExportLabels) -> String {
    let project = session
        .workspace
        .as_deref()
        .or(session.cwd.as_deref())
        .and_then(|p| Path::new(p).file_name())
        .map_or_else(|| "_".to_owned(), |n| safe_name(&n.to_string_lossy()));
    let date = session
        .created_at
        .map(|ms| local_time(ms, labels.offset_minutes))
        .map_or_else(String::new, |t| format!("{} ", t.get(..10).unwrap_or(&t)));
    let title = session.title.as_deref().unwrap_or(&labels.untitled);
    format!(
        "markdown/{project}/{}.md",
        safe_name(&format!("{date}{title}"))
    )
}

/// `name` without path separators, reserved characters or control characters, trimmed and
/// shortened to [`MAX_NAME`] characters; `_` when nothing is left.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(MAX_NAME)
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "_".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `path`, or `path` with ` (2)`, ` (3)` … before its extension when the archive has it.
fn unique(names: &mut HashSet<String>, path: &str) -> String {
    if names.insert(path.to_owned()) {
        return path.to_owned();
    }
    let (stem, extension) = path.rsplit_once('.').unwrap_or((path, ""));
    (2..)
        .map(|n| format!("{stem} ({n}).{extension}"))
        .find(|candidate| names.insert(candidate.clone()))
        .unwrap_or_else(|| path.to_owned())
}

/// `YYYY-MM-DD HH:MM` of `ms` (Unix milliseconds) at `offset_minutes` east of UTC.
fn local_time(ms: i64, offset_minutes: i32) -> String {
    let minutes = ms.div_euclid(60_000) + i64::from(offset_minutes);
    let (year, month, day) = piarc_telemetry::rotation::civil_from_days(minutes.div_euclid(1440));
    let in_day = minutes.rem_euclid(1440);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        in_day / 60,
        in_day % 60
    )
}

/// The Markdown of one session: a head with its project and times, then the current branch.
fn render(session: &ExportSession, records: &[u8], labels: &ExportLabels) -> String {
    let title = session.title.as_deref().unwrap_or(&labels.untitled);
    let mut out = format!("# {title}\n\n");
    if let Some(project) = session.workspace.as_deref().or(session.cwd.as_deref()) {
        out.push_str(&format!("- {}: {project}\n", labels.project));
    }
    let time = |ms: Option<i64>| ms.map(|ms| local_time(ms, labels.offset_minutes));
    if let Some(created) = time(session.created_at) {
        out.push_str(&format!("- {}: {created}\n", labels.created));
    }
    if let Some(updated) = time(session.updated_at) {
        out.push_str(&format!("- {}: {updated}\n", labels.updated));
    }
    if session.archived {
        out.push_str(&format!("- {}\n", labels.archived));
    }
    for entry in current_branch(records) {
        render_entry(&mut out, &entry, labels);
    }
    out
}

/// The entries on the path from the root to the last entry (Pi files are trees: rewinding
/// and branching keep the old entries).
fn current_branch(records: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(records);
    let mut entries: HashMap<String, Value> = HashMap::new();
    let mut last: Option<String> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            last = Some(id.to_owned());
            entries.insert(id.to_owned(), entry);
        }
    }
    let mut branch = Vec::new();
    let mut seen = HashSet::new();
    let mut next = last;
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(entry) = entries.remove(&id) else {
            break;
        };
        next = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        branch.push(entry);
    }
    branch.reverse();
    branch
}

fn render_entry(out: &mut String, entry: &Value, labels: &ExportLabels) {
    match entry.get("type").and_then(Value::as_str) {
        Some("message") => {
            let Some(message) = entry.get("message") else {
                return;
            };
            let when = message
                .get("timestamp")
                .and_then(Value::as_i64)
                .map(|ms| format!(" · {}", local_time(ms, labels.offset_minutes)))
                .unwrap_or_default();
            match message.get("role").and_then(Value::as_str) {
                Some("user") => {
                    let text = message_text(message.get("content"));
                    if !text.is_empty() {
                        out.push_str(&format!("\n## {}{when}\n\n{text}\n", labels.user));
                    }
                }
                Some("assistant") => render_assistant(out, message, &when, labels),
                _ => {}
            }
        }
        Some("compaction" | "branch_summary") => {
            if let Some(summary) = entry.get("summary").and_then(Value::as_str) {
                out.push_str(&format!("\n> **{}**\n", labels.summary));
                for line in summary.lines() {
                    out.push_str(&format!("> {line}\n"));
                }
            }
        }
        _ => {}
    }
}

fn render_assistant(out: &mut String, message: &Value, when: &str, labels: &ExportLabels) {
    let mut body = String::new();
    for block in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str)
                    && !text.trim().is_empty()
                {
                    body.push_str(text.trim_end());
                    body.push_str("\n\n");
                }
            }
            Some("toolCall") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("?");
                let argument = block
                    .get("arguments")
                    .map(first_argument)
                    .unwrap_or_default();
                body.push_str(&format!("> {}: `{name}`", labels.tool));
                if !argument.is_empty() {
                    body.push_str(&format!(" {argument}"));
                }
                body.push_str("\n\n");
            }
            _ => {}
        }
    }
    if !body.is_empty() {
        out.push_str(&format!(
            "\n## {}{when}\n\n{}\n",
            labels.assistant,
            body.trim_end()
        ));
    }
}

/// The text of a message's content: a string, or its text blocks.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_owned(),
        _ => String::new(),
    }
}

/// A tool call's first string argument on one line, shortened (a path, a command, a query).
fn first_argument(arguments: &Value) -> String {
    let Some(text) = arguments
        .as_object()
        .and_then(|a| a.values().find_map(Value::as_str))
    else {
        return String::new();
    };
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = line.chars().take(MAX_ARGUMENT).collect();
    let ellipsis = if line.chars().count() > MAX_ARGUMENT {
        "…"
    } else {
        ""
    };
    format!("`{}{ellipsis}`", short.replace('`', "'"))
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
