//! Attachments (ADR-0030, ADR-0009 rule 8): the kinds and limits the composer accepts, defined
//! once here and given to the client by [`super::info`], and the store that keeps an
//! attachment's bytes in `<data>/sessions/<session id>/attachments/<sha256>.<ext>`.
//!
//! The store checks the declared type against the file's first bytes, so a renamed file of
//! another kind is refused; writes go to a temporary name and are renamed into place, and the
//! same content stored twice is one file. The session's tool scope reads that directory
//! without asking (the model can `Read` an attached PDF's other pages).

use std::io::Write;
use std::path::{Path, PathBuf};

use piarc_protocol::ErrorKind;
use piarc_protocol::fs::{BlobRef, MAX_BLOB_BYTES};
use piarc_protocol::input::{AttachmentKind, InputAttachment};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{feature, invalid};
use crate::error::{Error, Result};

/// The directory under a session's directory that holds its attachments.
pub const ATTACHMENTS_DIR: &str = "attachments";

/// The most attachments one input carries.
pub const MAX_ATTACHMENTS: usize = 10;

/// The largest image: within what the providers accept for one image.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// The largest PDF: what `fs/pdf` reads.
pub const MAX_PDF_BYTES: u64 = MAX_BLOB_BYTES;

/// The longest file name kept for display, in characters.
const MAX_NAME_CHARS: usize = 200;

/// Accepted media types: kind, type, file extension.
const TYPES: &[(AttachmentKind, &str, &str)] = &[
    (AttachmentKind::Image, "image/png", "png"),
    (AttachmentKind::Image, "image/jpeg", "jpg"),
    (AttachmentKind::Image, "image/gif", "gif"),
    (AttachmentKind::Image, "image/webp", "webp"),
    (AttachmentKind::Pdf, "application/pdf", "pdf"),
];

/// The limits as the client reads them.
#[must_use]
pub fn limits() -> Value {
    let types = |kind: AttachmentKind| -> Vec<&str> {
        TYPES
            .iter()
            .filter(|(k, _, _)| *k == kind)
            .map(|(_, mime, _)| *mime)
            .collect()
    };
    json!({
        "maxCount": MAX_ATTACHMENTS,
        "kinds": [
            { "kind": "image", "mimeTypes": types(AttachmentKind::Image), "maxBytes": MAX_IMAGE_BYTES },
            { "kind": "pdf", "mimeTypes": types(AttachmentKind::Pdf), "maxBytes": MAX_PDF_BYTES },
        ],
    })
}

/// Stores `bytes` (declared as `mime_type`, named `name`) in `dir` and describes it.
///
/// # Errors
///
/// `invalidParams` with `details.reason` `type` (not an accepted type, or the content is not
/// of that type), `size` (empty or over the kind's limit) or `content` (a PDF that cannot be
/// read); `ioError` when the file cannot be written.
pub fn store(dir: &Path, name: &str, mime_type: &str, bytes: &[u8]) -> Result<InputAttachment> {
    let Some(&(kind, mime, extension)) = TYPES.iter().find(|(_, mime, _)| *mime == mime_type)
    else {
        return Err(refused(
            "type",
            &format!("{mime_type} files cannot be attached"),
        ));
    };
    let size = bytes.len() as u64;
    let max = match kind {
        AttachmentKind::Image => MAX_IMAGE_BYTES,
        AttachmentKind::Pdf => MAX_PDF_BYTES,
    };
    if size == 0 || size > max {
        return Err(refused(
            "size",
            &format!("{name} has {size} bytes; attachments of this kind may have 1 to {max}"),
        ));
    }
    if !content_is(mime, bytes) {
        return Err(refused("type", &format!("{name} is not a {mime} file")));
    }
    let sha256 = hex(&Sha256::digest(bytes));
    let path = dir.join(format!("{sha256}.{extension}"));
    let page_count = match kind {
        AttachmentKind::Pdf => Some(
            piarc_fs::pdf_page_count_bytes(&path, bytes)
                .map_err(|e| refused("content", &e.to_string()))?,
        ),
        AttachmentKind::Image => None,
    };
    if page_count == Some(0) {
        return Err(refused("content", &format!("{name} has no pages")));
    }
    if !path.exists() {
        write_new(dir, &path, bytes)?;
    }
    Ok(InputAttachment {
        kind,
        name: display_name(name),
        mime_type: mime.to_owned(),
        blob: BlobRef {
            path: piarc_fs::display(&path),
            sha256,
            size,
        },
        page_count,
    })
}

/// Checks attachments an input refers to: at most [`MAX_ATTACHMENTS`], each a stored file of
/// this session (`dir`) with a matching name, type and kind.
///
/// # Errors
///
/// [`Error::InvalidArgument`] for `attachments`.
pub fn check_refs(attachments: &[InputAttachment], dir: &Path) -> Result<()> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(invalid(
            "attachments",
            &format!("at most {MAX_ATTACHMENTS} per message"),
        ));
    }
    for attachment in attachments {
        let path = PathBuf::from(&attachment.blob.path);
        let typed = TYPES.iter().find(|(kind, mime, extension)| {
            *kind == attachment.kind
                && *mime == attachment.mime_type
                && path.file_name().and_then(|n| n.to_str())
                    == Some(format!("{}.{extension}", attachment.blob.sha256).as_str())
        });
        let well_formed = attachment.blob.sha256.len() == 64
            && attachment
                .blob
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
        if typed.is_none() || !well_formed || path.parent() != Some(dir) {
            return Err(invalid(
                "attachments",
                "an attachment must be one this session stored",
            ));
        }
    }
    Ok(())
}

/// Whether `bytes` start like a file of type `mime`.
fn content_is(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        _ => false,
    }
}

fn write_new(dir: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let io = |e: std::io::Error| Error::Feature {
        kind: ErrorKind::IoError,
        retryable: true,
        message: format!("cannot store the attachment in {}: {e}", dir.display()),
        details: None,
    };
    std::fs::create_dir_all(dir).map_err(io)?;
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| Error::Internal {
        reason: format!("no randomness for a temporary name: {e}"),
    })?;
    let temporary = dir.join(format!(".{}.part", hex(&nonce)));
    let written = std::fs::File::create(&temporary)
        .and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()))
        .and_then(|()| std::fs::rename(&temporary, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(io(error));
    }
    Ok(())
}

/// The file name the user sees: its last component, without control characters, shortened.
fn display_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let clean: String = last
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        "attachment".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn refused(reason: &str, message: &str) -> Error {
    feature(
        ErrorKind::InvalidParams,
        message.to_owned(),
        &json!({ "reason": reason }),
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    /// A one-page PDF (no text).
    const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-core attachments {name} 测试 {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn reason(error: &Error) -> Option<String> {
        error
            .to_error_object()
            .data
            .details
            .and_then(|d| d.get("reason").and_then(Value::as_str).map(str::to_owned))
    }

    #[test]
    fn stores_by_content_hash_once_and_describes_the_attachment() {
        let dir = dir("store");
        let first = store(&dir, "/Users/x/截图 1.png", "image/png", PNG).expect("stored");
        let again = store(&dir, "again.png", "image/png", PNG).expect("stored");
        assert_eq!(first.blob, again.blob);
        assert_eq!(first.name, "截图 1.png");
        assert_eq!(first.kind, AttachmentKind::Image);
        assert!(
            first
                .blob
                .path
                .ends_with(&format!("{}.png", first.blob.sha256))
        );
        assert_eq!(std::fs::read(&first.blob.path).expect("read"), PNG);
        let pdf = store(&dir, "spec.pdf", "application/pdf", PDF).expect("stored");
        assert_eq!(pdf.page_count, Some(1));
        check_refs(&[first, pdf], &dir).expect("refs of this session");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_other_types_wrong_content_and_sizes() {
        let dir = dir("refuse");
        let wrong_type = store(&dir, "a.svg", "image/svg+xml", b"<svg/>").expect_err("type");
        assert_eq!(reason(&wrong_type).as_deref(), Some("type"));
        let renamed = store(&dir, "a.png", "image/png", b"GIF89a....").expect_err("content");
        assert_eq!(reason(&renamed).as_deref(), Some("type"));
        let empty = store(&dir, "a.png", "image/png", b"").expect_err("empty");
        assert_eq!(reason(&empty).as_deref(), Some("size"));
        let mut large = PNG.to_vec();
        large.resize(usize::try_from(MAX_IMAGE_BYTES).expect("fits") + 1, 0);
        let too_large = store(&dir, "big.png", "image/png", &large).expect_err("size");
        assert_eq!(reason(&too_large).as_deref(), Some("size"));
        let broken = store(&dir, "x.pdf", "application/pdf", b"%PDF-1.4 nothing").expect_err("pdf");
        assert_eq!(reason(&broken).as_deref(), Some("content"));
        assert!(
            !dir.exists() || dir.read_dir().expect("directory").next().is_none(),
            "a refused PDF must leave no copy"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_references_outside_the_session() {
        let dir = PathBuf::from("/data/sessions/s/attachments");
        let sha = "a".repeat(64);
        let mut attachment = InputAttachment {
            kind: AttachmentKind::Image,
            name: "a.png".into(),
            mime_type: "image/png".into(),
            blob: BlobRef {
                path: dir
                    .join(format!("{sha}.png"))
                    .to_string_lossy()
                    .into_owned(),
                sha256: sha.clone(),
                size: 1,
            },
            page_count: None,
        };
        check_refs(std::slice::from_ref(&attachment), &dir).expect("ours");
        attachment.blob.path = format!("/data/sessions/other/attachments/{sha}.png");
        assert!(check_refs(std::slice::from_ref(&attachment), &dir).is_err());
        attachment.blob.path = dir
            .join(format!("{sha}.png"))
            .to_string_lossy()
            .into_owned();
        attachment.kind = AttachmentKind::Pdf;
        assert!(check_refs(std::slice::from_ref(&attachment), &dir).is_err());
        let many = vec![attachment; MAX_ATTACHMENTS + 1];
        assert!(check_refs(&many, &dir).is_err());
    }
}
