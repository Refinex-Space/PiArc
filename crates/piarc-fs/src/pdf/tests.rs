use lopdf::content::{Content, Operation};
use lopdf::{Object, Stream, dictionary};

use super::*;
use crate::testing::TempTree;

/// A PDF with one line of text per page.
pub(crate) fn make_pdf(pages: &[&str]) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });
    let mut kids = Vec::new();
    for text in pages {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let stream = Stream::new(dictionary! {}, content.encode().expect("content encodes"));
        let content_id = doc.add_object(stream);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
        });
        kids.push(page_id.into());
    }
    let count = i64::try_from(kids.len()).expect("few pages");
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("saved");
    bytes
}

fn fixture(name: &str, pages: &[&str]) -> (TempTree, Scope) {
    let tree = TempTree::new(name);
    tree.dir("ws");
    std::fs::write(tree.path("ws/doc 文档.pdf"), make_pdf(pages)).expect("written");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
    (tree, scope)
}

#[test]
fn reads_every_page_of_a_small_document_and_a_range_of_any() {
    let (_tree, scope) = fixture("pdf-small", &["First page", "Second page", "Third page"]);
    let all = read_pdf(&scope, "doc 文档.pdf", None).expect("read");
    assert_eq!(all.page_count, 3);
    let texts: Vec<_> = all
        .pages
        .iter()
        .map(|p| (p.number, p.text.trim()))
        .collect();
    assert_eq!(
        texts,
        [(1, "First page"), (2, "Second page"), (3, "Third page")]
    );
    let some = read_pdf(&scope, "doc 文档.pdf", Some("2-")).expect("read");
    assert_eq!(
        some.pages.iter().map(|p| p.number).collect::<Vec<_>>(),
        [2, 3]
    );
    let one = read_pdf(&scope, "doc 文档.pdf", Some("3")).expect("read");
    assert_eq!(one.pages[0].text.trim(), "Third page");
}

#[test]
fn a_large_document_needs_a_range_of_at_most_twenty_pages() {
    let names: Vec<String> = (1..=25).map(|n| format!("Page {n}")).collect();
    let pages: Vec<&str> = names.iter().map(String::as_str).collect();
    let (_tree, scope) = fixture("pdf-large", &pages);
    let error = read_pdf(&scope, "doc 文档.pdf", None).expect_err("needs a range");
    assert!(error.to_string().contains("25 pages"), "{error}");
    assert!(error.to_string().contains("pages: \"1-20\""), "{error}");
    let error = read_pdf(&scope, "doc 文档.pdf", Some("1-21")).expect_err("too many");
    assert!(error.to_string().contains("21 pages"), "{error}");
    let error = read_pdf(&scope, "doc 文档.pdf", Some("30")).expect_err("no such page");
    assert!(
        error.to_string().contains("page 30 does not exist"),
        "{error}"
    );
    for bad in ["0", "a-b", "5-2", "-3"] {
        let error = read_pdf(&scope, "doc 文档.pdf", Some(bad)).expect_err("malformed");
        assert!(
            matches!(error, Error::InvalidRequest { .. }),
            "{bad}: {error}"
        );
    }
    let tail = read_pdf(&scope, "doc 文档.pdf", Some("21-")).expect("read");
    assert_eq!(tail.pages.len(), 5);
    assert_eq!(tail.pages[4].text.trim(), "Page 25");
}

#[test]
fn a_file_that_is_not_a_pdf_is_reported_as_unreadable() {
    let tree = TempTree::new("pdf-bad");
    tree.file("ws/fake.pdf", "%PDF-1.4 this is not really a PDF");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
    let error = read_pdf(&scope, "fake.pdf", None).expect_err("bad");
    assert_eq!(error.code(), Some("EINVAL"));
    assert!(error.to_string().contains("not a readable PDF"), "{error}");
}

#[test]
fn counts_the_pages_of_an_attachment_and_refuses_what_is_not_a_pdf() {
    let tree = TempTree::new("pdf-count");
    tree.file("placeholder", "");
    let pdf = tree.path("a 中文.pdf");
    std::fs::write(&pdf, make_pdf(&["one", "two", "three"])).expect("written");
    assert_eq!(pdf_page_count(&pdf).expect("counted"), 3);
    let fake = tree.path("fake.pdf");
    std::fs::write(&fake, "%PDF-1.5 but nothing else").expect("written");
    let error = pdf_page_count(&fake).expect_err("not a PDF");
    assert!(error.to_string().contains("not a readable PDF"), "{error}");
}
