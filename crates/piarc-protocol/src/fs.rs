//! File operations the Agent Host delegates to Core (`fs/*`, Agent Host → Core).
//!
//! The Agent Host's tools never touch the workspace themselves (ADR-0004): reading, writing,
//! listing and searching go to Core, which resolves the path against the session's working
//! directory and keeps the file tools' invariants (architecture sections 6.1.2 and 6.1.3,
//! ADR-0027).
//!
//! # Paths
//!
//! - `path` is absolute, or relative to the session's working directory. Core normalizes it and
//!   resolves symlinks of the part that exists. Reading is allowed inside the session's
//!   directories (the workspace root and added directories) and its temporary directory;
//!   writing inside the session's directories, except protected paths (`.git/`, `.piarc/`,
//!   `.claude/`, `.pi/`, shell configuration files). Anything else needs the user's approval:
//!   until approvals exist (T20) the request fails with `permissionDenied` and the target is
//!   not touched.
//! - Paths in results are absolute, in the platform's usual form (no `\\?\` prefix), with
//!   symlinks resolved, unless a member says otherwise.
//!
//! # File state
//!
//! Core keeps a table per session: the files the session read (with the `Read` call's range)
//! or wrote, with their content hash. `fs/stat` with `read` records a read; replacing an
//! existing file with `fs/write` requires an entry whose hash still matches the file
//! (`fileNotRead`, `fileModified`) and records the write.
//!
//! # Content transfer
//!
//! - Text travels inline as strings. `fs/read` returns at most [`MAX_READ_CHUNK`] file bytes
//!   per request and never splits a character; larger files are read by range (`offset`,
//!   `length`). Files that are not UTF-8 are decoded from their detected encoding (UTF-16 with
//!   a byte order mark, or a legacy encoding such as GBK); invalid sequences become U+FFFD. A
//!   byte order mark is kept as U+FEFF at the start of the text.
//! - `fs/write` writes the whole new text at once: to a temporary file in the same directory,
//!   renamed over the target. A large text comes in pieces of one upload (`upload`), written
//!   when the last piece arrives. Writing keeps an existing file's encoding and byte order mark
//!   and, with [`LineEndings::MatchFile`], its line ending style.
//! - Binary content (images) does not travel over AHP (ADR-0009 rule 8): `fs/read` in
//!   [`ReadMode::Blob`] mode copies the file into the session's blob directory under Core's
//!   data directory and returns a [`BlobRef`] (path, SHA-256 and size) that the Agent Host
//!   reads. Files over [`MAX_BLOB_BYTES`] are refused (`ioError`, `EFBIG`).
//!
//! # Errors
//!
//! `notFound` (the path does not exist), `permissionDenied` (the path needs approval),
//! `fileNotRead`, `fileModified`, `unencodableText`, `ioError` (any other operating system
//! error; `details.code` is a POSIX-style code such as `EACCES`), `sessionNotFound` (Core
//! knows no such session) and `invalidParams`. Messages are written for the model: what
//! happened and what to do next.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::diff::FileDiff;
use crate::method::request;
use crate::session::SessionId;
use crate::tool_call::ToolOrigin;

/// Largest number of bytes one `fs/read` returns in text mode: 1 MiB. Even if every byte had
/// to be escaped as `\u00XX`, the response stays below the 8 MiB frame limit.
pub const MAX_READ_CHUNK: u64 = 1024 * 1024;

/// Largest file `fs/read` copies in blob mode, and largest PDF `fs/pdf` reads: 32 MiB.
pub const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;

/// Largest text one upload (`fs/write`, `fs/spill`) collects before it is written: 64 MiB of
/// UTF-8.
pub const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// What a path names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// A regular file.
    File,
    /// A directory.
    Directory,
    /// Anything else: a device, socket or pipe.
    Other,
}

/// Parameters of `fs/stat`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsStatParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The path to inspect; symlinks are followed.
    pub path: String,
    /// Also sniff the first bytes of a regular file for a supported image type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detect_image: Option<bool>,
    /// Begin observing this file version and range for the Read tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadRange>,
    /// Commit the pending observation after successful content delivery and interpretation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete_read: Option<bool>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// The part of a file a `Read` call asked for, as the call wrote it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadRange {
    /// First line, 1-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Lines at most.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// Pages of a PDF, for example `3` or `1-5`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
}

/// Result of `fs/stat`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    /// The resolved path.
    pub path: String,
    /// What the path names.
    pub kind: FileKind,
    /// Size in bytes (0 for directories on some platforms).
    pub size: u64,
    /// Last modification, in milliseconds since the Unix epoch, when the platform reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    /// Whether the file has no write permission at all.
    pub readonly: bool,
    /// `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/bmp` when
    /// `detectImage` was set and the content is such an image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mime_type: Option<String>,
    /// With `read`: true when the session's previous read of this file asked for the same
    /// range and the content has not changed since (the earlier result still holds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchanged: Option<bool>,
}

/// How `fs/read` returns the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReadMode {
    /// Inline UTF-8 text, at most [`MAX_READ_CHUNK`] bytes per request.
    Text,
    /// The whole file by reference ([`BlobRef`]); `offset` and `length` do not apply.
    Blob,
}

/// Parameters of `fs/read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsReadParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The file to read.
    pub path: String,
    /// First byte to read (text mode); 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Bytes to read at most (text mode); [`MAX_READ_CHUNK`] when absent or larger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
    /// Text when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ReadMode>,
    /// Fail with `fileNotRead` or `fileModified` unless the session read or wrote this file
    /// and its content has not changed since (the `Edit` tool reads this way).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_fresh: Option<bool>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
    /// Without `origin`: reads a file the session already read or wrote, to give its current
    /// content back after a compaction (T27, ADR-0043). Only files in the session's file state
    /// table that it may read without approval; it changes nothing in the table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<bool>,
}

/// A copy of a file's content kept by Core (ADR-0009 rule 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    /// Absolute path of the copy, under Core's data directory.
    pub path: String,
    /// SHA-256 of the content, lowercase hex.
    pub sha256: String,
    /// Size in bytes.
    pub size: u64,
}

/// Result of `fs/read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsReadResult {
    /// The resolved path.
    pub path: String,
    /// Size of the file in bytes when it was opened.
    pub size: u64,
    /// The offset the content starts at.
    pub offset: u64,
    /// Number of file bytes the content covers; the next range starts at `offset +
    /// bytesRead`.
    pub bytes_read: u64,
    /// Whether the content reaches the end of the file.
    pub eof: bool,
    /// The content, in text mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The content's copy, in blob mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<BlobRef>,
    /// The file's encoding when it is not UTF-8 (text mode), for example `GBK` or `UTF-16LE`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

/// How `fs/write` treats the line breaks of the new text when it replaces an existing file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LineEndings {
    /// Write them as they are (the text was derived from the file, as an edit is).
    AsWritten,
    /// Convert them to the file's style, LF or CRLF (new content for the file, as a `Write`
    /// is). Without line breaks in the old file, as written.
    MatchFile,
}

/// One piece of a text sent in several requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadPart {
    /// Names the upload; unique among the session's unfinished uploads.
    pub id: String,
    /// Whether this is the last piece: the collected text is used now.
    pub last: bool,
}

/// Parameters of `fs/write`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The file to write; its parent directory must exist.
    pub path: String,
    /// The new text of the file (or the next piece of it, with `upload`).
    pub content: String,
    /// Append the text to the file's current text; false when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append: Option<bool>,
    /// [`LineEndings::AsWritten`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_endings: Option<LineEndings>,
    /// Set when the text comes in several requests: pieces before the last are collected, the
    /// last writes the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload: Option<UploadPart>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// Result of `fs/write`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteResult {
    /// The resolved path.
    pub path: String,
    /// Bytes written to the file (0 for a collected piece).
    pub bytes_written: u64,
    /// Set for a piece that was collected, not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    /// The change, once the file is written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<FileDiff>,
    /// The encoding the file was written in when it is not UTF-8.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

/// Parameters of `fs/spill`: a tool result too long for the model's context, kept in the
/// session's temporary directory (`tool-results/<name>.txt`) for the model to read in parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsSpillParams {
    /// The session whose temporary directory receives the file.
    pub session_id: SessionId,
    /// File name without extension, normally the tool call id; characters other than ASCII
    /// letters, digits, `-` and `_` are replaced.
    pub name: String,
    /// The text (or the next piece of it, with `upload`).
    pub content: String,
    /// Set when the text comes in several requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload: Option<UploadPart>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// Result of `fs/spill`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsSpillResult {
    /// The file as the model is told about it: below the home directory as `~/…` (no user
    /// name), otherwise absolute. The `Read` tool accepts it.
    pub path: String,
    /// Set for a piece that was collected, not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    /// Bytes written (UTF-8).
    pub bytes_written: u64,
}

/// Parameters of `fs/pdf`: the text of a PDF's pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsPdfParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The PDF file.
    pub path: String,
    /// Pages to extract, for example `3`, `1-5` or `10-`; all pages when absent, which only
    /// small documents allow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// The text of one PDF page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
    /// 1-based page number.
    pub number: u64,
    /// The page's text in reading order, as well as the PDF allows.
    pub text: String,
}

/// Result of `fs/pdf`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsPdfResult {
    /// The resolved path.
    pub path: String,
    /// Pages in the document.
    pub page_count: u64,
    /// The requested pages, in order.
    pub pages: Vec<PdfPage>,
}

/// Parameters of `fs/mkdir`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMkdirParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The directory to create, with any missing parents.
    pub path: String,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// Result of `fs/mkdir`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMkdirResult {
    /// The resolved path.
    pub path: String,
    /// False when the directory already existed.
    pub created: bool,
}

/// Parameters of `fs/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsListParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The directory to list.
    pub path: String,
    /// Entries to return at most; Core caps it at 10,000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// One directory entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// The entry's file name.
    pub name: String,
    /// What it names; symlinks are followed (a dangling one is `other`).
    pub kind: FileKind,
}

/// Result of `fs/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsListResult {
    /// The resolved path of the directory.
    pub path: String,
    /// Entries in file name order, dotfiles included.
    pub entries: Vec<DirEntry>,
    /// Whether the limit cut the listing short.
    pub truncated: bool,
}

/// Parameters of `fs/glob`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsGlobParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The directory to search.
    pub path: String,
    /// Glob pattern. Without `/` it matches the file name at any depth; with `/` it matches
    /// the path relative to the searched directory, as if prefixed with `**/`.
    pub pattern: String,
    /// Glob patterns of paths to leave out, relative to the searched directory, for example
    /// `**/node_modules/**`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude: Option<Vec<String>>,
    /// Matches to return at most; Core caps it at 100,000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// Result of `fs/glob`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsGlobResult {
    /// The resolved path of the searched directory.
    pub path: String,
    /// Matching files and directories relative to the searched directory, `/`-separated,
    /// directories with a trailing `/`, in path order. Hidden entries are included; entries
    /// ignored by `.gitignore`, `.ignore` or `exclude` are not.
    pub matches: Vec<String>,
    /// Whether the limit cut the matches short.
    pub truncated: bool,
}

/// Parameters of `fs/grep`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsGrepParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// The directory or file to search.
    pub path: String,
    /// Regular expression (ripgrep syntax), or a literal string with `literal`.
    pub pattern: String,
    /// Only search files matching this glob, relative to the searched directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
    /// Match case-insensitively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_case: Option<bool>,
    /// Treat `pattern` as a literal string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal: Option<bool>,
    /// Lines of context before and after each match; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    /// Matches to return at most; 100 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// One line of grep output: a match or a context line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrepLine {
    /// The file: relative to the searched directory and `/`-separated, or the file name when
    /// a single file was searched.
    pub path: String,
    /// 1-based line number.
    pub line_number: u64,
    /// The line without its terminator; lines over 4,096 characters are cut there.
    pub text: String,
    /// Whether the line matches (false for context lines).
    pub is_match: bool,
}

/// Result of `fs/grep`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsGrepResult {
    /// The resolved path of the searched directory or file.
    pub path: String,
    /// Whether a directory was searched.
    pub is_directory: bool,
    /// Matches and context lines, by file in path order, then by line.
    pub lines: Vec<GrepLine>,
    /// Number of matching lines returned.
    pub match_count: u64,
    /// Whether more matches exist beyond the limit.
    pub limit_reached: bool,
}

request!(
    /// Method marker for `fs/stat` (Agent Host → Core).
    FsStat, "fs/stat", FsStatParams, FileStat
);
request!(
    /// Method marker for `fs/read` (Agent Host → Core).
    FsRead, "fs/read", FsReadParams, FsReadResult
);
request!(
    /// Method marker for `fs/write` (Agent Host → Core).
    FsWrite, "fs/write", FsWriteParams, FsWriteResult
);
request!(
    /// Method marker for `fs/spill` (Agent Host → Core).
    FsSpill, "fs/spill", FsSpillParams, FsSpillResult
);
request!(
    /// Method marker for `fs/pdf` (Agent Host → Core).
    FsPdf, "fs/pdf", FsPdfParams, FsPdfResult
);
request!(
    /// Method marker for `fs/mkdir` (Agent Host → Core).
    FsMkdir, "fs/mkdir", FsMkdirParams, FsMkdirResult
);
request!(
    /// Method marker for `fs/list` (Agent Host → Core).
    FsList, "fs/list", FsListParams, FsListResult
);
request!(
    /// Method marker for `fs/glob` (Agent Host → Core).
    FsGlob, "fs/glob", FsGlobParams, FsGlobResult
);
request!(
    /// Method marker for `fs/grep` (Agent Host → Core).
    FsGrep, "fs/grep", FsGrepParams, FsGrepResult
);
