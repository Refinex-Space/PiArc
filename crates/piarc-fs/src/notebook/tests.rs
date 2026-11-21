//! The shared vectors in `tests/notebook/` (the Agent Host runs the same cases).
use std::path::PathBuf;

use super::*;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/notebook")
}

fn error_name(e: &NotebookError) -> &'static str {
    match e {
        NotebookError::Invalid(_) => "invalid",
        NotebookError::CellNotFound(_) => "cellNotFound",
        NotebookError::MissingCellId(_) => "missingCellId",
        NotebookError::MissingCellType => "missingCellType",
    }
}

#[test]
fn shared_cases() {
    let cases: Value =
        serde_json::from_str(&std::fs::read_to_string(dir().join("cases.json")).expect("cases"))
            .expect("JSON");
    let update = std::env::var_os("PIARC_UPDATE_NOTEBOOK").is_some();
    let list = cases["cases"].as_array().expect("cases");
    assert!(list.len() >= 12);
    for case in list {
        let name = case["name"].as_str().expect("name");
        let input = std::fs::read_to_string(dir().join(case["notebook"].as_str().expect("file")))
            .expect("notebook");
        let e = &case["edit"];
        let edit_call = CellEdit {
            mode: match e["mode"].as_str() {
                Some("insert") => EditMode::Insert,
                Some("delete") => EditMode::Delete,
                _ => EditMode::Replace,
            },
            cell_id: e["cellId"].as_str(),
            new_source: e["newSource"].as_str().unwrap_or_default(),
            cell_type: match e["cellType"].as_str() {
                Some("code") => Some(CellType::Code),
                Some("markdown") => Some(CellType::Markdown),
                _ => None,
            },
            seed: e["seed"].as_str().unwrap_or_default(),
        };
        let result = edit(&input, &edit_call);
        match (case["expected"].as_str(), case["error"].as_str()) {
            (Some(file), _) => {
                let got = result.unwrap_or_else(|e| panic!("{name}: {e}"));
                let path = dir().join(file);
                if update {
                    std::fs::write(&path, &got).expect("write expected");
                }
                let want = std::fs::read_to_string(&path).expect("expected file");
                assert_eq!(got, want, "{name}");
                // The result is still a notebook.
                let parsed: Value = serde_json::from_str(&got).expect("valid JSON");
                assert!(parsed["cells"].is_array(), "{name}");
            }
            (None, Some(kind)) => {
                let error = result.expect_err(name);
                assert_eq!(error_name(&error), kind, "{name}: {error}");
            }
            _ => panic!("{name}: neither expected nor error"),
        }
    }
}

#[test]
fn new_ids_avoid_existing_ones() {
    let first = new_cell_id("call", &[]);
    assert_eq!(first.len(), 8);
    let second = new_cell_id("call", &[first.as_str()]);
    assert_ne!(first, second);
}
