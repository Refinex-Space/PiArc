//! `NotebookEdit` (T42): the approved result of one call, computed from the notebook's text and
//! the call's arguments with `piarc_fs::notebook` (the Agent Host's tool computes the same with
//! its copy of the algorithm). The approval card shows it as a diff; the write must equal it.
use piarc_fs::notebook::{CellEdit, CellType, EditMode};
use serde_json::{Map, Value};

/// The path argument (Claude Code's name).
pub(super) const PATH: &str = "notebook_path";

/// The notebook text this call may write: `before` with the call's cell edit, `seed` being the
/// tool call id (a new cell's id derives from it).
pub(super) fn proposed(
    before: &str,
    input: &Map<String, Value>,
    seed: &str,
) -> Result<String, piarc_fs::notebook::NotebookError> {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let edit = CellEdit {
        mode: match field("edit_mode") {
            Some("insert") => EditMode::Insert,
            Some("delete") => EditMode::Delete,
            _ => EditMode::Replace,
        },
        cell_id: field("cell_id"),
        new_source: field("new_source").unwrap_or_default(),
        cell_type: match field("cell_type") {
            Some("code") => Some(CellType::Code),
            Some("markdown") => Some(CellType::Markdown),
            _ => None,
        },
        seed,
    };
    piarc_fs::notebook::edit(before, &edit)
}
