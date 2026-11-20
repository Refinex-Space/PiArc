//! A response body as text for the extraction model: HTML becomes Markdown, other text types
//! are decoded as they are, binary types are refused.
use encoding_rs::Encoding;

use crate::FetchError;

/// How the text in [`Content::text`] was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Converted from HTML.
    Markdown,
    /// Text the server sent (plain text, Markdown, JSON, XML…).
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Content {
    pub text: String,
    pub format: Format,
    /// Characters before the cut to `max_chars`.
    pub total_chars: usize,
    pub truncated: bool,
}

/// Elements whose content is never page text.
const SKIPPED: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "head",
];

fn media_type(content_type: Option<&str>) -> (String, Option<String>) {
    let Some(value) = content_type else {
        return (String::new(), None);
    };
    let mut parts = value.split(';');
    let mime = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let charset = parts.find_map(|p| {
        let (key, v) = p.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| v.trim().trim_matches('"').to_owned())
    });
    (mime, charset)
}

fn is_html(mime: &str) -> bool {
    matches!(mime, "text/html" | "application/xhtml+xml")
}

fn is_text(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/ecmascript"
                | "application/x-javascript"
                | "application/yaml"
                | "application/x-yaml"
                | "application/toml"
                | "application/x-sh"
        )
}

/// A `<meta charset>` or `http-equiv` charset within the first 1,024 bytes.
fn meta_charset(body: &[u8]) -> Option<&'static Encoding> {
    let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_ascii_lowercase();
    let start = head.find("charset=")? + "charset=".len();
    let label: String = head[start..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    Encoding::for_label(label.as_bytes())
}

fn looks_like_html(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(512)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

fn looks_binary(body: &[u8]) -> bool {
    body[..body.len().min(1024)].contains(&0)
}

/// `body` as text of at most `max_chars` characters.
pub fn convert(
    content_type: Option<&str>,
    body: &[u8],
    max_chars: usize,
) -> Result<Content, FetchError> {
    let (mime, charset) = media_type(content_type);
    let html = is_html(&mime) || (mime.is_empty() && looks_like_html(body));
    if !html && !(is_text(&mime) || mime.is_empty() && !looks_binary(body)) {
        return Err(FetchError::UnsupportedContent(if mime.is_empty() {
            "binary data".into()
        } else {
            mime
        }));
    }
    let encoding = charset
        .as_deref()
        .and_then(|c| Encoding::for_label(c.as_bytes()))
        .or_else(|| html.then(|| meta_charset(body)).flatten())
        .unwrap_or(encoding_rs::UTF_8);
    let (decoded, _, _) = encoding.decode(body);
    let (text, format) = if html {
        let converter = htmd::HtmlToMarkdown::builder()
            .skip_tags(SKIPPED.to_vec())
            .build();
        let markdown = converter
            .convert(decoded.as_ref())
            .map_err(|e| FetchError::Conversion(e.to_string()))?;
        (markdown, Format::Markdown)
    } else {
        (decoded.into_owned(), Format::Text)
    };
    let total_chars = text.chars().count();
    let truncated = total_chars > max_chars;
    let text = if truncated {
        text.chars().take(max_chars).collect()
    } else {
        text
    };
    Ok(Content {
        text,
        format,
        total_chars,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_markdown_without_scripts() {
        let page = "<html><head><title>T</title><style>p{}</style></head><body>\
            <h1>Release notes</h1><p>Version <b>2</b> adds <a href=\"/x\">links</a>.</p>\
            <script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>";
        let content = convert(Some("text/html; charset=utf-8"), page.as_bytes(), 100_000).unwrap();
        assert_eq!(content.format, Format::Markdown);
        assert!(content.text.contains("# Release notes"), "{}", content.text);
        assert!(content.text.contains("**2**"));
        assert!(content.text.contains("[links](/x)"));
        assert!(content.text.contains("one"));
        assert!(!content.text.contains("alert"));
        assert!(!content.text.contains("p{}"));
    }

    #[test]
    fn charset_from_header_and_meta() {
        let (gbk, _, _) = encoding_rs::GBK.encode("<p>中文页面</p>");
        let content = convert(Some("text/html; charset=gbk"), &gbk, 100).unwrap();
        assert!(content.text.contains("中文页面"));
        let page = [
            b"<html><head><meta charset=\"gbk\"></head><body>".as_slice(),
            &gbk,
        ]
        .concat();
        let content = convert(Some("text/html"), &page, 100).unwrap();
        assert!(content.text.contains("中文页面"));
    }

    #[test]
    fn text_types_pass_and_binary_is_refused() {
        let content = convert(Some("application/json"), b"{\"a\":1}", 100).unwrap();
        assert_eq!(
            (content.text.as_str(), content.format),
            ("{\"a\":1}", Format::Text)
        );
        assert!(matches!(
            convert(Some("image/png"), b"\x89PNG", 100),
            Err(FetchError::UnsupportedContent(m)) if m == "image/png"
        ));
        assert!(convert(None, b"\0\x01binary", 100).is_err());
        assert_eq!(
            convert(None, b"plain words", 100).unwrap().text,
            "plain words"
        );
        assert_eq!(
            convert(None, b"<!DOCTYPE html><p>hi</p>", 100)
                .unwrap()
                .format,
            Format::Markdown
        );
    }

    #[test]
    fn long_text_is_cut_on_a_character() {
        let content = convert(Some("text/plain"), "中文字".repeat(10).as_bytes(), 7).unwrap();
        assert_eq!(content.text.chars().count(), 7);
        assert_eq!(content.total_chars, 30);
        assert!(content.truncated);
    }
}
