//! The diff shown on a file approval card.
use super::*;

pub(super) fn file_preview(
    tool: &str,
    call: &str,
    input: &serde_json::Map<String, Value>,
    target: &Path,
    label: &str,
    binding: &piarc_fs::DirectoryBinding,
) -> Result<piarc_protocol::diff::FileDiff, ErrorObject> {
    Ok(match tool {
        "Write" => {
            let new = input
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| denied("The proposed file content is missing."))?;
            let old = original_text(target, binding)?;
            piarc_diff::file_diff(label, old.as_deref(), new)
        }
        "NotebookEdit" => {
            let old = original_text(target, binding)?
                .ok_or_else(|| denied("The notebook does not exist."))?;
            // An edit that cannot be made fails in the tool with the same message; the card
            // still shows what was asked.
            match notebook::proposed(&old, input, call) {
                Ok(new) => piarc_diff::file_diff(label, Some(&old), &new),
                Err(error) => {
                    piarc_diff::file_diff(label, Some(&old), &format!("{old}\n# {error}"))
                }
            }
        }
        _ => {
            let edits = input
                .get("edits")
                .and_then(Value::as_array)
                .ok_or_else(|| denied("Missing proposed edits."))?;
            if let Some(old) = original_text(target, binding)?
                && let Some(new) = edit::proposed(
                    &old,
                    edits,
                    input.get("replaceAll").and_then(Value::as_bool) == Some(true),
                )
            {
                return Ok(piarc_diff::file_diff(label, Some(&old), &new));
            }
            // Invalid edits retain Pi's detailed matching error when the user permits the attempt.
            let mut before = Vec::new();
            let mut after = Vec::new();
            for edit in edits {
                before.push(
                    edit["oldText"]
                        .as_str()
                        .ok_or_else(|| denied("Missing original text."))?,
                );
                after.push(
                    edit["newText"]
                        .as_str()
                        .ok_or_else(|| denied("Missing replacement text."))?,
                );
            }
            piarc_diff::file_diff(label, Some(&before.join("\n")), &after.join("\n"))
        }
    })
}

pub(super) fn original_text(
    target: &Path,
    binding: &piarc_fs::DirectoryBinding,
) -> Result<Option<String>, ErrorObject> {
    use std::io::Read as _;
    let file = match binding.open_file(target) {
        Ok(file) => file,
        Err(piarc_fs::Error::NotFound { .. }) => return Ok(None),
        Err(error) => return Err(denied(format!("Cannot inspect the file: {error}"))),
    };
    let metadata = file
        .metadata()
        .map_err(|e| denied(format!("Cannot inspect the file: {e}")))?;
    let max = piarc_protocol::fs::MAX_UPLOAD_BYTES;
    if !metadata.is_file() || metadata.len() > max {
        return Err(denied("This target cannot be previewed as a regular file."));
    }
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| denied(format!("Cannot preview the file: {e}")))?;
    if bytes.len() as u64 > max {
        return Err(denied("The target grew beyond the preview limit."));
    }
    Ok(Some(piarc_fs::encoding::decode(
        piarc_fs::encoding::detect(&bytes),
        &bytes,
    )))
}
