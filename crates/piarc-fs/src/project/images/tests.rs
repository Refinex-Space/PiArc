use super::*;
use crate::testing::TempTree;
use image::ImageEncoder as _;

fn png(pixel: u8) -> Vec<u8> {
    let mut v = Vec::new();
    image::codecs::png::PngEncoder::new(&mut v)
        .write_image(
            &[pixel, pixel, pixel, 255],
            1,
            1,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    v
}
#[test]
fn imports_reuses_and_never_replaces_existing_images() {
    let tree = TempTree::new("md-image-import");
    tree.file("ws/docs/note.md", "# Note");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let prefs = Preferences::default();
    let add = |color| {
        import(
            &scope,
            &prefs,
            "docs/note.md",
            "mock (1)#图.png",
            &png(color),
            None,
            |_| false,
        )
        .unwrap()
    };
    assert_eq!(add(1)["href"], "./assets/mock%20%281%29%23%E5%9B%BE.png");
    assert_eq!(add(2)["href"], "./assets/mock%20%281%29%23%E5%9B%BE-2.png");
    assert_eq!(add(1)["href"], "./assets/mock%20%281%29%23%E5%9B%BE.png");
    assert_eq!(
        preview(
            &scope,
            &prefs,
            "docs/note.md",
            add(2)["href"].as_str().unwrap()
        )
        .unwrap()["base64"],
        BASE64_STANDARD.encode(png(2))
    );
    assert!(
        import(
            &scope,
            &prefs,
            "docs/note.md",
            "test.png",
            b"wrong",
            None,
            |_| false
        )
        .is_err()
    );
    assert!(folder("../etc", "note").is_err());
    assert!(folder("CON", "note").is_err());
    assert!(
        import(
            &scope,
            &Preferences {
                mode: Location::Relative,
                folder: ".git/data".into(),
                ..Default::default()
            },
            "docs/note.md",
            "test.png",
            &png(1),
            None,
            |_| false
        )
        .is_err()
    );
}
#[test]
fn an_external_directory_is_an_image_only_versioned_grant() {
    let tree = TempTree::new("md-image-folder");
    tree.file("ws/docs/note.md", "note");
    tree.dir("pictures");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let prefs = Preferences {
        mode: Location::Selected,
        directory: Some(Directory::selected(&tree.path("pictures")).unwrap()),
        ..Default::default()
    };
    let a = import(
        &scope,
        &prefs,
        "docs/note.md",
        "pic.jpg",
        &png(1),
        None,
        |_| false,
    )
    .unwrap();
    assert_eq!(a["href"], "../../pictures/pic.png");
    assert!(preview(&scope, &prefs, "docs/note.md", a["href"].as_str().unwrap()).is_ok());
    assert!(
        preview(
            &scope,
            &Preferences::default(),
            "docs/note.md",
            a["href"].as_str().unwrap()
        )
        .is_err()
    );
    assert!(
        preview(
            &scope,
            &prefs,
            "docs/note.md",
            "https://example.com/pic.png"
        )
        .is_err()
    );
    std::fs::rename(tree.path("pictures"), tree.path("old")).unwrap();
    tree.dir("pictures");
    std::fs::write(tree.path("pictures/pic.png"), png(2)).unwrap();
    assert!(preview(&scope, &prefs, "docs/note.md", "../../pictures/pic.png").is_err());
    assert!(
        import(
            &scope,
            &prefs,
            "docs/note.md",
            "pic.jpg",
            &png(1),
            None,
            |_| false
        )
        .is_err()
    );
}

#[test]
fn named_template_relative_absolute_and_reference_choices_round_trip() {
    let tree = TempTree::new("md-image-link-modes");
    tree.file("ws/docs/guide.md", "");
    tree.dir("ws/pictures");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let bytes = png(43);
    let original = scope.root().join("pictures/reference.png");
    std::fs::write(&original, &bytes).unwrap();
    let get = |p: &Preferences, src: Option<&Path>| {
        let inserted = import(
            &scope,
            p,
            "docs/guide.md",
            "reference.png",
            &bytes,
            src,
            |_| false,
        )
        .unwrap();
        let href = inserted["href"].as_str().unwrap();
        assert_eq!(
            preview(&scope, p, "docs/guide.md", href).unwrap()["base64"],
            BASE64_STANDARD.encode(&bytes)
        );
        href.to_owned()
    };
    for (mode, folder, expected) in [
        (Location::Document, "", "reference.png"),
        (Location::Named, "", "guide.assets/reference.png"),
        (
            Location::Relative,
            "img/${filename}",
            "img/guide/reference.png",
        ),
        (Location::Reference, "", "../pictures/reference.png"),
    ] {
        let prefs = Preferences {
            mode,
            folder: folder.into(),
            link: LinkStyle::Relative,
            ..Default::default()
        };
        assert_eq!(get(&prefs, Some(&original)), expected);
    }
    assert!(
        get(
            &Preferences {
                link: LinkStyle::Absolute,
                ..Default::default()
            },
            None
        )
        .starts_with("file:///")
    );
}
