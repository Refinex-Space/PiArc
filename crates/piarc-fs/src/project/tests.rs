use super::*;
use crate::testing::TempTree;
use base64::prelude::*;
use piarc_protocol::fs::MAX_BLOB_BYTES;

// Core's extra read-only paths (Claude configuration) are covered by the session integration test.
fn read(scope: &Scope, path: &str, force: bool) -> Result<Value> {
    super::read(scope, path, force, |_| false)
}
fn save(
    scope: &Scope,
    locks: &PathLocks,
    path: &str,
    text: &str,
    revision: Option<&str>,
) -> Result<Value> {
    super::save(scope, locks, path, text, revision, |_| false)
}

#[test]
fn lists_and_previews_without_accepting_an_escape_or_writing_protected_files() {
    let tree = TempTree::new("project-files-boundary");
    tree.file("ws/src/hello.md", "hello\n");
    tree.file("ws/node_modules/vendor.js", "");
    tree.file("ws/.claude/settings.json", "{}");
    tree.file("private/key", "private");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let rows = list(&scope, "", None).unwrap();
    assert_eq!(rows["entries"].as_array().unwrap().len(), 2);
    let view = read(&scope, "src/hello.md", false).unwrap();
    assert_eq!(view["text"], "hello\n");
    assert_eq!(
        read(&scope, ".claude/settings.json", false).unwrap()["editable"],
        false
    );
    assert!(
        save(
            &scope,
            &PathLocks::default(),
            ".claude/settings.json",
            "new",
            view["revision"].as_str()
        )
        .is_err()
    );
    for path in ["../private/key", "/etc/hosts", "C:/bad", "a/../../bad"] {
        assert!(read(&scope, path, false).is_err(), "{path}");
    }
    #[cfg(unix)]
    {
        tree.symlink("../private", "ws/other");
        tree.symlink("lost", "ws/broken");
        tree.symlink("self", "ws/self");
        let links = list(&scope, "", None).unwrap();
        let state = |name: &str| {
            links["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .unwrap()["link"]["state"]
                .as_str()
                .unwrap()
        };
        assert_eq!(state("other"), "external");
        assert_eq!(state("broken"), "dangling");
        assert_eq!(state("self"), "cycle");
        assert!(read(&scope, "other/key", false).is_err());
        assert!(save(&scope, &PathLocks::default(), "broken", "no", None).is_err());
    }
}

#[test]
fn editor_detects_conflicts_and_preserves_bom_and_line_endings() {
    let tree = TempTree::new("project-files-editor");
    tree.dir("ws");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let locks = PathLocks::default();
    let bytes = [0xff, 0xfe, b'a', 0, 13, 0, 10, 0];
    std::fs::write(tree.path("ws/a.txt"), bytes).unwrap();
    let doc = read(&scope, "a.txt", false).unwrap();
    assert_eq!(doc["text"], "a\r\n");
    let saved = save(&scope, &locks, "a.txt", "b\n", doc["revision"].as_str()).unwrap();
    assert_ne!(doc["revision"], saved["revision"]);
    assert_eq!(
        std::fs::read(tree.path("ws/a.txt")).unwrap(),
        [0xff, 0xfe, b'b', 0, 13, 0, 10, 0]
    );
    assert!(save(&scope, &locks, "a.txt", "stale", doc["revision"].as_str()).is_err());
    tree.file("ws/a.txt", "external edit");
    assert!(save(&scope, &locks, "a.txt", "stale", saved["revision"].as_str()).is_err());
    assert_eq!(read(&scope, "new.txt", false).unwrap()["kind"], "missing");
    save(&scope, &locks, "new.txt", "created", None).unwrap();
    assert!(save(&scope, &locks, "new.txt", "overwrite", None).is_err());
    assert!(save(&scope, &locks, "missing/dir/new", "", None).is_err());
    assert_eq!(
        std::fs::read_to_string(tree.path("ws/a.txt")).unwrap(),
        "external edit"
    );
}

#[test]
fn search_returns_utf16_offsets_and_stops_on_cancel() {
    let tree = TempTree::new("project-files-search");
    tree.file("ws/src/first.ts", "🐱Hello world\nHelloWorld\n");
    tree.file("ws/.gitignore", "ignore/\n");
    tree.file("ws/ignore/secret", "hello");
    tree.file("ws/src/.gitignore", "generated*.ts\n");
    tree.file("ws/src/generated.ts", "hello");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let options = SearchOptions {
        match_case: false,
        whole_word: true,
        regexp: true,
    };
    let result = search(&scope, "h.llo", true, options, &|| false).unwrap();
    let rows = result["results"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["path"], "src/first.ts");
    assert_eq!(rows[0]["line"], 1);
    assert_eq!(rows[0]["column"], 3);
    assert_eq!(rows[0]["ranges"], serde_json::json!([[2, 7]]));
    assert!(search(&scope, "[", true, options, &|| false).is_err());
    assert!(search(&scope, "x", false, options, &|| true).is_err());
}

#[test]
fn download_retains_bytes_and_large_previews_return_only_metadata() {
    let tree = TempTree::new("project-files-export");
    tree.dir("ws");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let value = [0xff, 0x00, 0x02, 0x03];
    std::fs::write(tree.path("ws/data.dat"), value).unwrap();
    let binary = read(&scope, "data.dat", false).unwrap();
    assert_eq!(binary["kind"], "binary");
    let forced = read(&scope, "data.dat", true).unwrap();
    assert_eq!(forced["editable"], false);
    assert!(
        save(
            &scope,
            &PathLocks::default(),
            "data.dat",
            "overwrite",
            forced["revision"].as_str()
        )
        .is_err()
    );
    assert_eq!(
        export(&scope, "data.dat").unwrap()["base64"],
        BASE64_STANDARD.encode(value)
    );
    std::fs::File::create(tree.path("ws/big.md"))
        .unwrap()
        .set_len(MAX_BLOB_BYTES + 1)
        .unwrap();
    assert_eq!(read(&scope, "big.md", false).unwrap()["kind"], "tooLarge");
    assert!(export(&scope, "big.md").is_err());
}

#[test]
fn create_cannot_replace_a_file_that_arrived_while_the_new_contents_were_staged() {
    use std::io::Write as _;
    let tree = TempTree::new("project-files-create-race");
    tree.dir("ws");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let bound = scope.bind("note", Access::Write).unwrap();
    let result = crate::atomic::create_bound(&bound, |file| {
        file.write_all(b"first write")?;
        std::fs::write(tree.path("ws/note"), b"created by another writer")
    });
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(tree.path("ws/note")).unwrap(),
        b"created by another writer"
    );
    assert_eq!(std::fs::read_dir(tree.path("ws")).unwrap().count(), 1);
}

#[test]
fn a_directory_page_can_reveal_a_child_beyond_its_normal_limit() {
    let tree = TempTree::new("project-files-reveal-page");
    for i in 0..550 {
        tree.file(&format!("ws/file-{i:04}"), "");
    }
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let page = list(&scope, "", Some("file-0549")).unwrap();
    assert_eq!(page["truncated"], true);
    let rows = page["entries"].as_array().unwrap();
    assert_eq!(rows.len(), 500);
    assert_eq!(rows[499]["name"], "file-0549");
}

#[test]
fn package_manifests_allow_ordinary_edits_and_guard_hook_changes_on_create_and_replace() {
    let tree = TempTree::new("project-files-package");
    tree.dir("ws");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let locks = PathLocks::default();
    assert!(
        save(
            &scope,
            &locks,
            "package.json",
            r#"{"husky":{"hooks":{}}}"#,
            None
        )
        .is_err()
    );
    tree.file("ws/package.json", r#"{"husky":{},"name":"old"}"#);
    tree.dir("ws/.claude");
    assert_eq!(
        read(&scope, ".claude/new.json", false).unwrap()["editable"],
        false
    );
    assert!(matches!(
        save(&scope, &locks, ".claude/new.json", "{}", None),
        Err(Error::NeedsApproval { .. })
    ));
    let revision = read(&scope, "package.json", false).unwrap()["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        save(
            &scope,
            &locks,
            "package.json",
            r#"{"name":"old"}"#,
            Some(&revision)
        )
        .is_err()
    );
    save(
        &scope,
        &locks,
        "package.json",
        r#"{"husky":{},"name":"new"}"#,
        Some(&revision),
    )
    .unwrap();
}

#[test]
fn media_seeks_into_a_large_file_and_each_range_is_bound_to_the_same_version() {
    use std::io::{Seek as _, Write as _};
    let tree = TempTree::new("project-files-ranges");
    tree.dir("ws");
    let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).unwrap();
    let at = MAX_BLOB_BYTES + 1024;
    let path = tree.path("ws/clip.mp4");
    let mut file = std::fs::File::create(&path).unwrap();
    file.seek(std::io::SeekFrom::Start(at)).unwrap();
    file.write_all(b"the end").unwrap();
    drop(file);
    let info = read(&scope, "clip.mp4", false).unwrap();
    assert_eq!(info["kind"], "video");
    assert_eq!(info["size"], at + 7);
    assert!(info.get("base64").is_none());
    let head = chunk(&scope, "clip.mp4", 0, 0, None).unwrap();
    let token = head["revision"].as_str().unwrap();
    let part = chunk(&scope, "clip.mp4", at, 1024, Some(token)).unwrap();
    assert_eq!(part["base64"], BASE64_STANDARD.encode("the end"));
    assert_eq!(part["size"], at + 7);
    assert!(chunk(&scope, "clip.mp4", at, 1024 * 1024 + 1, Some(token)).is_err());
    std::fs::rename(&path, tree.path("ws/moved.mp4")).unwrap();
    tree.file("ws/clip.mp4", "new");
    assert!(matches!(
        chunk(&scope, "clip.mp4", 0, 1, Some(token)),
        Err(Error::Changed { .. })
    ));
}
