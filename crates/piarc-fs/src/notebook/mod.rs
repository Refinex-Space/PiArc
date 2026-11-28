//! Cell edits of a Jupyter notebook's text (T42, `NotebookEdit`), keeping every byte outside the
//! edited cell: the notebook is not parsed and serialized again (that would rewrite the whole
//! file in another style), the edit replaces the byte range of one cell, inserts one or removes
//! one. Core computes the approved result with this (the card's diff, the write's check); the
//! Agent Host's tool has the same algorithm in TypeScript, and both run the shared vectors in
//! `tests/notebook/`.
//!
//! - **Locating.** `cell_id` is a cell's `id`; a notebook without ids (nbformat before 4.5) is
//!   addressed by position, `cell-N` or `N` (0-based). Insert puts the new cell after the named
//!   cell, or first without one.
//! - **The edited cell** is written again in the file's style (indent unit, line endings,
//!   separators), its keys in nbformat's sorted order: `cell_type`, `execution_count`, `id`,
//!   `metadata`, `outputs`, `source`; keys it does not change (`id`, `metadata`, `attachments`)
//!   keep their text. Replacing a code cell's source clears its `outputs` and `execution_count`
//!   (they no longer match the code); a markdown cell has neither.
//! - **New cells** get an `id` when the notebook uses ids: [`new_cell_id`] derives it from the
//!   tool call (so Core and the Agent Host agree) and avoids the ids present.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// What a cell edit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMode {
    /// Replace the cell's source (and type, when given).
    Replace,
    /// Insert a new cell after the named one (first without one).
    Insert,
    /// Delete the named cell.
    Delete,
}

/// A cell's type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellType {
    Code,
    Markdown,
}

impl CellType {
    fn name(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Markdown => "markdown",
        }
    }
}

/// One `NotebookEdit` call.
#[derive(Debug, Clone)]
pub struct CellEdit<'a> {
    pub mode: EditMode,
    pub cell_id: Option<&'a str>,
    pub new_source: &'a str,
    pub cell_type: Option<CellType>,
    /// Seed of a new cell's id (the tool call id).
    pub seed: &'a str,
}

/// Why an edit cannot be made; the message is for the model.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotebookError {
    #[error("The file is not a valid Jupyter notebook: {0}")]
    Invalid(String),
    #[error(
        "Cell {0} was not found. Use a cell's id, or cell-N for the N-th cell (counting from 0) when the notebook has no ids; Read the notebook to see them."
    )]
    CellNotFound(String),
    #[error("cell_id is required to {0} a cell.")]
    MissingCellId(&'static str),
    #[error("cell_type is required to insert a cell.")]
    MissingCellType,
}

/// A parsed JSON value with its byte span.
#[derive(Debug)]
enum Node {
    Object {
        start: usize,
        end: usize,
        members: Vec<Member>,
    },
    Array {
        start: usize,
        end: usize,
        items: Vec<Node>,
    },
    Scalar {
        start: usize,
        end: usize,
    },
}

#[derive(Debug)]
struct Member {
    key: String,
    /// Where the key's opening quote is.
    key_start: usize,
    value: Node,
}

impl Node {
    fn span(&self) -> (usize, usize) {
        match self {
            Self::Object { start, end, .. }
            | Self::Array { start, end, .. }
            | Self::Scalar { start, end } => (*start, *end),
        }
    }

    fn member(&self, key: &str) -> Option<&Member> {
        match self {
            Self::Object { members, .. } => members.iter().find(|m| m.key == key),
            _ => None,
        }
    }
}

/// A recursive-descent scanner over the notebook text: spans, not values.
struct Scanner<'a> {
    text: &'a [u8],
    at: usize,
}

impl Scanner<'_> {
    fn error(&self, what: &str) -> NotebookError {
        NotebookError::Invalid(format!("{what} at byte {}", self.at))
    }

    fn skip_space(&mut self) {
        while self
            .text
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), NotebookError> {
        self.skip_space();
        if self.text.get(self.at) == Some(&byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(self.error(&format!("expected '{}'", byte as char)))
        }
    }

    fn string_end(&mut self) -> Result<usize, NotebookError> {
        // At the opening quote.
        self.at += 1;
        while let Some(&b) = self.text.get(self.at) {
            match b {
                b'\\' => self.at += 2,
                b'"' => {
                    self.at += 1;
                    return Ok(self.at);
                }
                _ => self.at += 1,
            }
        }
        Err(self.error("unterminated string"))
    }

    fn value(&mut self, depth: usize) -> Result<Node, NotebookError> {
        if depth > 128 {
            return Err(self.error("nesting too deep"));
        }
        self.skip_space();
        let start = self.at;
        match self.text.get(self.at) {
            Some(b'{') => self.object(start, depth),
            Some(b'[') => self.array(start, depth),
            Some(b'"') => {
                let end = self.string_end()?;
                Ok(Node::Scalar { start, end })
            }
            Some(_) => {
                while self.text.get(self.at).is_some_and(|b| {
                    !matches!(b, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
                }) {
                    self.at += 1;
                }
                if self.at == start {
                    return Err(self.error("expected a value"));
                }
                Ok(Node::Scalar {
                    start,
                    end: self.at,
                })
            }
            None => Err(self.error("unexpected end")),
        }
    }

    fn object(&mut self, start: usize, depth: usize) -> Result<Node, NotebookError> {
        self.at += 1;
        let mut members = Vec::new();
        self.skip_space();
        if self.text.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Node::Object {
                start,
                end: self.at,
                members,
            });
        }
        loop {
            self.skip_space();
            if self.text.get(self.at) != Some(&b'"') {
                return Err(self.error("expected a key"));
            }
            let key_start = self.at;
            let key_end = self.string_end()?;
            let key: String = serde_json::from_slice(&self.text[key_start..key_end])
                .map_err(|e| NotebookError::Invalid(e.to_string()))?;
            self.expect(b':')?;
            let value = self.value(depth + 1)?;
            members.push(Member {
                key,
                key_start,
                value,
            });
            self.skip_space();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Node::Object {
                        start,
                        end: self.at,
                        members,
                    });
                }
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self, start: usize, depth: usize) -> Result<Node, NotebookError> {
        self.at += 1;
        let mut items = Vec::new();
        self.skip_space();
        if self.text.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Node::Array {
                start,
                end: self.at,
                items,
            });
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_space();
            match self.text.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Node::Array {
                        start,
                        end: self.at,
                        items,
                    });
                }
                _ => return Err(self.error("expected ',' or ']'")),
            }
        }
    }
}

/// The file's style, read from the text around the cells.
struct Style {
    newline: &'static str,
    /// Indent unit; `None` for a notebook on one line.
    unit: Option<String>,
    /// `": "` or `":"`.
    colon: &'static str,
    /// `", "` or `","` between members on one line.
    comma: &'static str,
}

/// The whitespace at the start of the line holding byte `at`.
fn line_indent(text: &str, at: usize) -> &str {
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let line = &text[line_start..at];
    let trimmed = line.trim_start_matches([' ', '\t']);
    &line[..line.len() - trimmed.len()]
}

fn style_of(text: &str, root: &Node, cells: &Node) -> Style {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (root_start, root_end) = root.span();
    let body = &text[root_start..root_end];
    let colon = if body.contains("\": ") { ": " } else { ":" };
    let comma = if body.contains(", \"") { ", " } else { "," };
    // The unit: a cell member's indent minus its cell's, else the root members' indent.
    let mut unit = None;
    if let Node::Array { items, .. } = cells
        && let Some(cell @ Node::Object { members, .. }) = items.first()
        && let Some(first) = members.first()
    {
        let (start, _) = cell.span();
        let outer = line_indent(text, start);
        let inner = line_indent(text, first.key_start);
        if text[start..first.key_start].contains('\n') && inner.len() > outer.len() {
            unit = Some(inner[outer.len()..].to_owned());
        }
    }
    if unit.is_none()
        && let Node::Object { members, .. } = root
        && let Some(first) = members.first()
        && text[root_start..first.key_start].contains('\n')
    {
        let indent = line_indent(text, first.key_start);
        if !indent.is_empty() {
            unit = Some(indent.to_owned());
        }
    }
    Style {
        newline,
        unit,
        colon,
        comma,
    }
}

/// Jupyter's list of source lines: every line keeps its `\n` but the last.
fn source_lines(source: &str) -> Vec<String> {
    let mut lines: Vec<String> = source.split_inclusive('\n').map(str::to_owned).collect();
    if source.is_empty() {
        lines.clear();
    }
    lines
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

/// The id of a new cell: the first 8 hex digits of SHA-256 of `seed`, then of `seed-1`,
/// `seed-2`, … until it differs from every id in `existing`.
#[must_use]
pub fn new_cell_id(seed: &str, existing: &[&str]) -> String {
    let mut n = 0u32;
    loop {
        let input = if n == 0 {
            seed.to_owned()
        } else {
            format!("{seed}-{n}")
        };
        let digest = Sha256::digest(input.as_bytes());
        let id: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
        if !existing.contains(&id.as_str()) {
            return id;
        }
        n += 1;
    }
}

/// One member of a written cell: its key and its value text.
struct Written {
    key: String,
    value: String,
}

/// A cell object written in `style` at `indent` (the indent of its `{` line).
fn write_cell(style: &Style, indent: &str, members: &[Written]) -> String {
    let Some(unit) = &style.unit else {
        let inner: Vec<String> = members
            .iter()
            .map(|m| format!("{}{}{}", json_string(&m.key), style.colon, m.value))
            .collect();
        return format!("{{{}}}", inner.join(style.comma));
    };
    let nl = style.newline;
    let inner_indent = format!("{indent}{unit}");
    let lines: Vec<String> = members
        .iter()
        .map(|m| {
            format!(
                "{inner_indent}{}{}{}",
                json_string(&m.key),
                style.colon,
                m.value
            )
        })
        .collect();
    format!("{{{nl}{}{nl}{indent}}}", lines.join(&format!(",{nl}")))
}

/// The source value: a list of lines in `style` at `indent` (the indent of its key's line).
fn write_source(style: &Style, indent: &str, source: &str) -> String {
    let lines = source_lines(source);
    if lines.is_empty() {
        return "[]".to_owned();
    }
    let Some(unit) = &style.unit else {
        let items: Vec<String> = lines.iter().map(|l| json_string(l)).collect();
        return format!("[{}]", items.join(style.comma));
    };
    let nl = style.newline;
    let items: Vec<String> = lines
        .iter()
        .map(|l| format!("{indent}{unit}{}", json_string(l)))
        .collect();
    format!("[{nl}{}{nl}{indent}]", items.join(&format!(",{nl}")))
}

/// The members of an edited or new cell, sorted as nbformat writes them.
fn cell_members(
    text: &str,
    style: &Style,
    indent: &str,
    old: Option<&Node>,
    cell_type: CellType,
    source: &str,
    new_id: Option<String>,
) -> Vec<Written> {
    let unit = style.unit.clone().unwrap_or_default();
    let key_indent = format!("{indent}{unit}");
    let mut written: Vec<Written> = Vec::new();
    // Keys this edit does not decide keep their text.
    if let Some(Node::Object { members, .. }) = old {
        for m in members {
            if !matches!(
                m.key.as_str(),
                "cell_type" | "execution_count" | "outputs" | "source"
            ) {
                let (s, e) = m.value.span();
                written.push(Written {
                    key: m.key.clone(),
                    value: text[s..e].to_owned(),
                });
            }
        }
    }
    if let Some(id) = new_id {
        written.push(Written {
            key: "id".into(),
            value: json_string(&id),
        });
    }
    if !written.iter().any(|w| w.key == "metadata") {
        written.push(Written {
            key: "metadata".into(),
            value: "{}".into(),
        });
    }
    written.push(Written {
        key: "cell_type".into(),
        value: json_string(cell_type.name()),
    });
    if cell_type == CellType::Code {
        written.push(Written {
            key: "execution_count".into(),
            value: "null".into(),
        });
        written.push(Written {
            key: "outputs".into(),
            value: "[]".into(),
        });
    }
    written.push(Written {
        key: "source".into(),
        value: write_source(style, &key_indent, source),
    });
    written.sort_by(|a, b| a.key.cmp(&b.key));
    written
}

fn string_value(text: &str, node: Option<&Member>) -> Option<String> {
    let (s, e) = node?.value.span();
    serde_json::from_str::<Value>(&text[s..e])
        .ok()?
        .as_str()
        .map(str::to_owned)
}

/// The index of the cell `id` names among `cells`.
fn locate(text: &str, cells: &[Node], id: &str) -> Option<usize> {
    if let Some(i) = cells
        .iter()
        .position(|c| string_value(text, c.member("id")).as_deref() == Some(id))
    {
        return Some(i);
    }
    let number = id.strip_prefix("cell-").unwrap_or(id);
    number.parse::<usize>().ok().filter(|i| *i < cells.len())
}

/// The notebook text after `edit`.
///
/// # Errors
///
/// [`NotebookError`] when the text is not a notebook, the named cell is missing, or the edit
/// lacks what its mode needs.
pub fn edit(text: &str, edit: &CellEdit<'_>) -> Result<String, NotebookError> {
    let mut scanner = Scanner {
        text: text.as_bytes(),
        at: 0,
    };
    // A byte order mark stays where it is.
    if text.starts_with('\u{feff}') {
        scanner.at = 3;
    }
    let root = scanner.value(0)?;
    scanner.skip_space();
    if scanner.at != text.len() {
        return Err(scanner.error("trailing text"));
    }
    let Some(cells_member) = root.member("cells") else {
        return Err(NotebookError::Invalid("there is no cells list".into()));
    };
    let cells_node = &cells_member.value;
    let Node::Array { items: cells, .. } = cells_node else {
        return Err(NotebookError::Invalid("cells is not a list".into()));
    };
    if cells.iter().any(|c| !matches!(c, Node::Object { .. })) {
        return Err(NotebookError::Invalid("a cell is not an object".into()));
    }
    let style = style_of(text, &root, cells_node);
    let target = match edit.cell_id {
        Some(id) => Some(
            locate(text, cells, id).ok_or_else(|| NotebookError::CellNotFound(id.to_owned()))?,
        ),
        None => None,
    };
    match edit.mode {
        EditMode::Replace => {
            let index = target.ok_or(NotebookError::MissingCellId("replace"))?;
            replace(text, &style, &cells[index], index, edit)
        }
        EditMode::Insert => {
            let cell_type = edit.cell_type.ok_or(NotebookError::MissingCellType)?;
            let uses_ids =
                cells.iter().any(|c| c.member("id").is_some()) || minor_at_least(text, &root, 5);
            let new_id = uses_ids.then(|| {
                let existing: Vec<String> = cells
                    .iter()
                    .filter_map(|c| string_value(text, c.member("id")))
                    .collect();
                let existing: Vec<&str> = existing.iter().map(String::as_str).collect();
                new_cell_id(edit.seed, &existing)
            });
            insert(
                text,
                &style,
                cells_node,
                cells,
                cells_member,
                target,
                cell_type,
                edit.new_source,
                new_id,
            )
        }
        EditMode::Delete => {
            let index = target.ok_or(NotebookError::MissingCellId("delete"))?;
            Ok(delete(text, cells_node, cells, index))
        }
    }
}

/// `text` with cell `index` (`cell`) written again with `edit`'s source and type.
fn replace(
    text: &str,
    style: &Style,
    cell: &Node,
    index: usize,
    edit: &CellEdit<'_>,
) -> Result<String, NotebookError> {
    let (start, end) = cell.span();
    let current = match string_value(text, cell.member("cell_type")).as_deref() {
        Some("markdown") => CellType::Markdown,
        Some("code") => CellType::Code,
        _ => {
            return Err(NotebookError::Invalid(format!(
                "cell {index} is neither code nor markdown"
            )));
        }
    };
    let cell_type = edit.cell_type.unwrap_or(current);
    let indent = line_indent(text, start);
    let members = cell_members(
        text,
        style,
        indent,
        Some(cell),
        cell_type,
        edit.new_source,
        None,
    );
    let written = write_cell(style, indent, &members);
    Ok(format!("{}{}{}", &text[..start], written, &text[end..]))
}

fn minor_at_least(text: &str, root: &Node, minor: u64) -> bool {
    let major = root.member("nbformat").and_then(|m| {
        let (s, e) = m.value.span();
        text[s..e].trim().parse::<u64>().ok()
    });
    let found = root.member("nbformat_minor").and_then(|m| {
        let (s, e) = m.value.span();
        text[s..e].trim().parse::<u64>().ok()
    });
    major.is_some_and(|m| m > 4) || (major == Some(4) && found.is_some_and(|m| m >= minor))
}

/// The indent of a cell's `{` line: the first cell's, else the `cells` key's plus a unit.
fn cell_indent(text: &str, style: &Style, cells: &[Node], key: &Member) -> String {
    match cells.first() {
        Some(first) => line_indent(text, first.span().0).to_owned(),
        None => format!(
            "{}{}",
            line_indent(text, key.key_start),
            style.unit.clone().unwrap_or_default()
        ),
    }
}

#[expect(clippy::too_many_arguments, reason = "the parts of one insertion")]
fn insert(
    text: &str,
    style: &Style,
    cells_node: &Node,
    cells: &[Node],
    key: &Member,
    after: Option<usize>,
    cell_type: CellType,
    source: &str,
    new_id: Option<String>,
) -> Result<String, NotebookError> {
    let indent = cell_indent(text, style, cells, key);
    let members = cell_members(text, style, &indent, None, cell_type, source, new_id);
    let written = write_cell(style, &indent, &members);
    let (list_start, list_end) = cells_node.span();
    let between = match &style.unit {
        Some(_) => format!(",{}{indent}", style.newline),
        None => style.comma.to_owned(),
    };
    if cells.is_empty() {
        let closing = line_indent(text, key.key_start);
        let list = match &style.unit {
            Some(_) => format!("[{nl}{indent}{written}{nl}{closing}]", nl = style.newline),
            None => format!("[{written}]"),
        };
        return Ok(format!(
            "{}{}{}",
            &text[..list_start],
            list,
            &text[list_end..]
        ));
    }
    Ok(match after {
        Some(index) => {
            let (_, end) = cells[index].span();
            format!("{}{between}{written}{}", &text[..end], &text[end..])
        }
        None => {
            let (start, _) = cells[0].span();
            format!("{}{written}{between}{}", &text[..start], &text[start..])
        }
    })
}

fn delete(text: &str, cells_node: &Node, cells: &[Node], index: usize) -> String {
    let (start, end) = cells[index].span();
    if cells.len() == 1 {
        let (list_start, list_end) = cells_node.span();
        return format!("{}[]{}", &text[..list_start], &text[list_end..]);
    }
    if index + 1 < cells.len() {
        let (next, _) = cells[index + 1].span();
        format!("{}{}", &text[..start], &text[next..])
    } else {
        let (_, previous_end) = cells[index - 1].span();
        format!("{}{}", &text[..previous_end], &text[end..])
    }
}

#[cfg(test)]
mod tests;
