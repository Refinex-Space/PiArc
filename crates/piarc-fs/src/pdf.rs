//! The text of a PDF's pages, behind `fs/pdf` (the `Read` tool's PDF support, architecture
//! section 6.1.4).
//!
//! Small documents (at most [`MAX_PAGES_WITHOUT_RANGE`] pages) are read whole; larger ones need
//! a page range, and one request returns at most [`MAX_PAGES_PER_READ`] pages. Text comes from
//! `lopdf`'s extraction (font encodings and `ToUnicode` maps, text operators in content order),
//! with a cap on how much each page's streams may inflate to. A panic inside the parser is
//! caught and reported as an unreadable PDF. Encrypted documents open only without a password.
//!
//! `pdf-extract` gives better spacing but depends on lopdf 0.42, which pulls in the
//! unmaintained `ttf-parser` (RUSTSEC-2026-0192); lopdf 0.46 without default features does
//! not.

use std::io::Read as _;
use std::ops::RangeInclusive;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use lopdf::Document;
use piarc_protocol::fs::{FsPdfResult, MAX_BLOB_BYTES, PdfPage};

use crate::access::Access;
use crate::content::{open_file, too_large};
use crate::error::{Error, Result};
use crate::scope::{Scope, display};

/// The most pages a document may have to be read without a page range.
pub const MAX_PAGES_WITHOUT_RANGE: u64 = 10;

/// The most pages one request returns.
pub const MAX_PAGES_PER_READ: u64 = 20;

/// The most bytes one page's content streams may inflate to.
const MAX_PAGE_INFLATED_BYTES: usize = 64 * 1024 * 1024;

/// The text of the pages `pages` names (`3`, `1-5`, `10-`), or of every page of a small
/// document.
///
/// # Errors
///
/// The path needs approval, does not exist or is over [`MAX_BLOB_BYTES`] (`EFBIG`); it is not
/// a readable PDF (`EINVAL`); the page range is malformed, out of range, too long, or missing
/// for a large document ([`Error::InvalidRequest`]).
pub fn read_pdf(scope: &Scope, requested: &str, pages: Option<&str>) -> Result<FsPdfResult> {
    let bound = scope.bind(requested, Access::Read)?;
    let path = bound.path();
    let file = bound.open_file()?;
    let size = file.metadata().map_err(|e| Error::io(path, e))?.len();
    if size > MAX_BLOB_BYTES {
        return Err(too_large(path, size));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BLOB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(path, e))?;
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err(too_large(path, bytes.len() as u64));
    }
    bound.verify()?;
    let unreadable =
        |detail: &str| Error::coded(path, "EINVAL", &format!("not a readable PDF: {detail}"));
    let extracted = catch_unwind(AssertUnwindSafe(|| -> Result<FsPdfResult> {
        let mut document = Document::load_mem(&bytes).map_err(|e| unreadable(&e.to_string()))?;
        if document.is_encrypted() && document.decrypt("").is_err() {
            return Err(unreadable("it is encrypted with a password"));
        }
        let page_count = document.get_pages().len() as u64;
        let range = page_range(path, pages, page_count)?;
        let mut texts = Vec::new();
        for number in range {
            let page = u32::try_from(number).map_err(|_| unreadable("too many pages"))?;
            let text = document
                .extract_text_with_limit(&[page], MAX_PAGE_INFLATED_BYTES)
                .map_err(|e| unreadable(&e.to_string()))?;
            texts.push(PdfPage {
                number,
                text: text.trim_end().to_owned(),
            });
        }
        Ok(FsPdfResult {
            path: display(path),
            page_count,
            pages: texts,
        })
    }));
    extracted.unwrap_or_else(|_| Err(unreadable("its content could not be parsed")))
}

/// How many pages the PDF at `path` has (an attachment Core stores, ADR-0030). The caller
/// chose the path; there is no scope to check.
///
/// # Errors
///
/// The file cannot be read, is over [`MAX_BLOB_BYTES`] (`EFBIG`), is not a readable PDF or is
/// protected by a password (`EINVAL`).
pub fn pdf_page_count(path: &Path) -> Result<u64> {
    let size = open_file(path)?
        .metadata()
        .map_err(|e| Error::io(path, e))?
        .len();
    if size > MAX_BLOB_BYTES {
        return Err(too_large(path, size));
    }
    let bytes = std::fs::read(path).map_err(|e| Error::io(path, e))?;
    pdf_page_count_bytes(path, &bytes)
}

/// Counts pages before publishing a validated attachment.
///
/// # Errors
///
/// Returns the same size and document errors as [`pdf_page_count`].
pub fn pdf_page_count_bytes(path: &Path, bytes: &[u8]) -> Result<u64> {
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err(too_large(path, bytes.len() as u64));
    }
    let unreadable =
        |detail: &str| Error::coded(path, "EINVAL", &format!("not a readable PDF: {detail}"));
    let counted = catch_unwind(AssertUnwindSafe(|| -> Result<u64> {
        let mut document = Document::load_mem(bytes).map_err(|e| unreadable(&e.to_string()))?;
        if document.is_encrypted() && document.decrypt("").is_err() {
            return Err(unreadable("it is encrypted with a password"));
        }
        Ok(document.get_pages().len() as u64)
    }));
    counted.unwrap_or_else(|_| Err(unreadable("its content could not be parsed")))
}

/// The pages `spec` names in a document of `count` pages.
fn page_range(path: &Path, spec: Option<&str>, count: u64) -> Result<RangeInclusive<u64>> {
    let invalid = |message: String| Error::InvalidRequest { message };
    let Some(spec) = spec.map(str::trim) else {
        if count > MAX_PAGES_WITHOUT_RANGE {
            return Err(invalid(format!(
                "{} has {count} pages, more than can be read at once. Read it in parts of at \
                 most {MAX_PAGES_PER_READ} pages with the pages parameter, for example pages: \
                 \"1-{MAX_PAGES_PER_READ}\".",
                display(path)
            )));
        }
        // An empty document gives an empty range.
        return Ok(1..=count);
    };
    let malformed = || {
        invalid(format!(
            "pages must be a page number or a range such as \"3\", \"1-5\" or \"10-\"; got \
             {spec:?}."
        ))
    };
    let number = |text: &str| text.trim().parse::<u64>().ok().filter(|n| *n >= 1);
    let (first, last) = match spec.split_once('-') {
        None => {
            let n = number(spec).ok_or_else(malformed)?;
            (n, n)
        }
        Some((first, "")) => (number(first).ok_or_else(malformed)?, count),
        Some((first, last)) => (
            number(first).ok_or_else(malformed)?,
            number(last).ok_or_else(malformed)?,
        ),
    };
    if first > count {
        return Err(invalid(format!(
            "{} has {count} pages; page {first} does not exist.",
            display(path)
        )));
    }
    if last < first {
        return Err(malformed());
    }
    let last = last.min(count);
    if last - first + 1 > MAX_PAGES_PER_READ {
        return Err(invalid(format!(
            "pages {spec} covers {} pages; read at most {MAX_PAGES_PER_READ} pages at a time.",
            last - first + 1
        )));
    }
    Ok(first..=last)
}

#[cfg(test)]
mod tests;
