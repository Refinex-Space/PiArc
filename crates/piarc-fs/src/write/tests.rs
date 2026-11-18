use std::sync::Arc;

use super::*;
use crate::testing::TempTree;

struct Fixture {
    tree: TempTree,
    scope: Scope,
    states: Mutex<FileStates>,
    locks: PathLocks,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let tree = TempTree::new(name);
        tree.dir("ws");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        Self {
            tree,
            scope,
            states: Mutex::default(),
            locks: PathLocks::default(),
        }
    }

    fn put(&self, rel: &str, bytes: &[u8]) {
        let path = self.tree.path(&format!("ws/{rel}"));
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, bytes).expect("written");
    }

    fn bytes(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.tree.path(&format!("ws/{rel}"))).expect("reads")
    }

    fn read(&self, rel: &str) {
        stat_for_read(&self.scope, &self.states, rel, false, ReadRange::default()).expect("read");
    }

    fn write(&self, rel: &str, text: &str, line_endings: LineEndings) -> Result<Written> {
        write(
            &self.scope,
            &self.states,
            &self.locks,
            &WriteSpec {
                requested: rel,
                text,
                append: false,
                line_endings,
            },
        )
    }
}

#[test]
fn an_existing_file_must_be_read_first_and_unchanged_since() {
    let f = Fixture::new("write-fresh");
    f.put("a.txt", b"one\n");
    let error = f
        .write("a.txt", "two\n", LineEndings::AsWritten)
        .expect_err("not read");
    assert!(matches!(error, Error::NotRead { .. }), "{error}");
    assert_eq!(error.kind(), piarc_protocol::ErrorKind::FileNotRead);
    assert_eq!(f.bytes("a.txt"), b"one\n");
    assert!(matches!(
        check_fresh(&f.scope, &f.states, "a.txt"),
        Err(Error::NotRead { .. })
    ));

    f.read("a.txt");
    check_fresh(&f.scope, &f.states, "a.txt").expect("fresh");
    f.put("a.txt", b"changed elsewhere\n");
    let error = f
        .write("a.txt", "two\n", LineEndings::AsWritten)
        .expect_err("modified");
    assert!(matches!(error, Error::Modified { .. }), "{error}");
    assert_eq!(f.bytes("a.txt"), b"changed elsewhere\n");

    f.read("a.txt");
    let written = f
        .write("a.txt", "two\n", LineEndings::AsWritten)
        .expect("written");
    assert_eq!(written.before.as_deref(), Some("changed elsewhere\n"));
    assert_eq!(written.after, "two\n");
    // The session's own write keeps the file fresh for it.
    f.write("a.txt", "three\n", LineEndings::AsWritten)
        .expect("written again");
    assert_eq!(f.bytes("a.txt"), b"three\n");
}

#[test]
fn a_new_file_needs_no_read_and_is_utf8_without_a_bom() {
    let f = Fixture::new("write-new");
    let written = f
        .write(
            "dir 目录/new.txt",
            "\u{feff}中文\r\n",
            LineEndings::MatchFile,
        )
        .expect_err("no parent");
    let _ = written;
    f.tree.dir("ws/dir 目录");
    let written = f
        .write(
            "dir 目录/new.txt",
            "\u{feff}中文\r\n",
            LineEndings::MatchFile,
        )
        .expect("created");
    assert_eq!(written.before, None);
    assert_eq!(f.bytes("dir 目录/new.txt"), "中文\r\n".as_bytes());
    assert_eq!(written.label, "dir 目录/new.txt");
}

#[test]
fn keeps_crlf_bom_and_legacy_encodings() {
    let f = Fixture::new("write-fidelity");
    f.put("crlf.txt", b"a\r\nb\r\n");
    f.put("bom.txt", b"\xEF\xBB\xBFx\n");
    let gbk = TextEncoding::Legacy(encoding_rs::GBK);
    f.put(
        "gbk.txt",
        &encode(gbk, "第一行中文内容，用国标编码保存。\r\n第二行\r\n").expect("GBK"),
    );
    f.put(
        "utf16.txt",
        &encode(TextEncoding::Utf16 { big_endian: false }, "\u{feff}u\r\n").expect("16"),
    );
    for rel in ["crlf.txt", "bom.txt", "gbk.txt", "utf16.txt"] {
        f.read(rel);
    }
    // A Write's new content takes the file's line endings ...
    f.write("crlf.txt", "a\nB\nc\n", LineEndings::MatchFile)
        .expect("crlf");
    assert_eq!(f.bytes("crlf.txt"), b"a\r\nB\r\nc\r\n");
    // ... an edit's derived text is written as it is.
    f.write("crlf.txt", "a\r\nB\nc\r\n", LineEndings::AsWritten)
        .expect("as written");
    assert_eq!(f.bytes("crlf.txt"), b"a\r\nB\nc\r\n");
    f.write("bom.txt", "y\n", LineEndings::MatchFile)
        .expect("bom");
    assert_eq!(f.bytes("bom.txt"), b"\xEF\xBB\xBFy\n");
    let written = f
        .write(
            "gbk.txt",
            "第一行中文内容，已修改。\n第二行\n",
            LineEndings::MatchFile,
        )
        .expect("gbk");
    assert_eq!(written.encoding, gbk);
    assert_eq!(reported_encoding(&written).as_deref(), Some("GBK"));
    assert_eq!(
        f.bytes("gbk.txt"),
        encode(gbk, "第一行中文内容，已修改。\r\n第二行\r\n").expect("GBK")
    );
    f.write("utf16.txt", "v\n", LineEndings::MatchFile)
        .expect("utf16");
    assert_eq!(
        f.bytes("utf16.txt"),
        encode(TextEncoding::Utf16 { big_endian: false }, "v\r\n").expect("16")
    );
}

#[test]
fn text_the_encoding_cannot_hold_is_refused_and_the_file_kept() {
    let f = Fixture::new("write-unencodable");
    let gbk = TextEncoding::Legacy(encoding_rs::GBK);
    let original = encode(gbk, "这一行是用国标编码保存的中文文本。\n").expect("GBK");
    f.put("gbk.txt", &original);
    f.read("gbk.txt");
    let error = f
        .write("gbk.txt", "中文\n表情 🙂\n", LineEndings::AsWritten)
        .expect_err("emoji");
    assert!(
        matches!(
            &error,
            Error::Unencodable {
                line: 2,
                character: '🙂',
                ..
            }
        ),
        "{error}"
    );
    assert_eq!(f.bytes("gbk.txt"), original);
}

#[test]
fn a_failure_during_the_write_leaves_the_file_whole() {
    let f = Fixture::new("write-disk-full");
    f.put("a.txt", b"keep me\n");
    f.read("a.txt");
    let spec = WriteSpec {
        requested: "a.txt",
        text: "replacement text\n",
        append: false,
        line_endings: LineEndings::AsWritten,
    };
    let error = write_with(
        &f.scope,
        &f.states,
        &f.locks,
        &spec,
        |_, _| true,
        |file, bytes| {
            file.write_all(&bytes[..4])?;
            Err(io::Error::from(io::ErrorKind::StorageFull))
        },
    )
    .expect_err("disk full");
    assert_eq!(error.code(), Some("ENOSPC"));
    assert_eq!(f.bytes("a.txt"), b"keep me\n");
    // Nothing was recorded: the file is still fresh as read.
    check_fresh(&f.scope, &f.states, "a.txt").expect("fresh");
}

#[test]
fn approval_is_needed_outside_the_workspace_and_for_protected_paths() {
    let f = Fixture::new("write-approval");
    f.tree.dir("ws/.git");
    for rel in ["../outside.txt", ".git/config", ".zshrc"] {
        let error = f
            .write(rel, "x", LineEndings::AsWritten)
            .expect_err("approval");
        assert!(
            matches!(error, Error::NeedsApproval { .. }),
            "{rel}: {error}"
        );
        assert_eq!(error.kind(), piarc_protocol::ErrorKind::PermissionDenied);
    }
    assert!(!f.tree.path("outside.txt").exists());
    assert!(!f.tree.path("ws/.git/config").exists());
}

#[test]
fn concurrent_appends_to_one_file_are_serialized() {
    let f = Arc::new(Fixture::new("write-concurrent"));
    f.put("log.txt", b"");
    f.read("log.txt");
    let workers: Vec<_> = (0..8)
        .map(|n| {
            let f = Arc::clone(&f);
            std::thread::spawn(move || {
                for i in 0..20 {
                    let line = format!("{n}-{i}\n");
                    write(
                        &f.scope,
                        &f.states,
                        &f.locks,
                        &WriteSpec {
                            requested: "log.txt",
                            text: &line,
                            append: true,
                            line_endings: LineEndings::AsWritten,
                        },
                    )
                    .expect("append");
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().expect("worker");
    }
    let text = String::from_utf8(f.bytes("log.txt")).expect("utf8");
    assert_eq!(text.lines().count(), 160);
}

#[test]
fn a_read_under_another_spelling_counts_on_case_insensitive_volumes() {
    let f = Fixture::new("write-case");
    f.put("Notes.md", b"x\n");
    if !f.scope.case_insensitive() {
        return;
    }
    f.read("NOTES.MD");
    f.write("notes.md", "y\n", LineEndings::AsWritten)
        .expect("same file");
    assert_eq!(f.bytes("Notes.md"), b"y\n");
}

#[test]
fn a_read_only_file_or_a_directory_is_refused() {
    let f = Fixture::new("write-refused");
    f.tree.dir("ws/dir");
    let error = f
        .write("dir", "x", LineEndings::AsWritten)
        .expect_err("directory");
    assert_eq!(error.code(), Some("EISDIR"));
    f.put("ro.txt", b"r\n");
    let path = f.tree.path("ws/ro.txt");
    let mut permissions = std::fs::metadata(&path).expect("exists").permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions.clone()).expect("read-only");
    f.read("ro.txt");
    let error = f
        .write("ro.txt", "w\n", LineEndings::AsWritten)
        .expect_err("read-only");
    assert_eq!(error.code(), Some("EACCES"));
    #[expect(
        clippy::permissions_set_readonly_false,
        reason = "the test cleans up its own file"
    )]
    permissions.set_readonly(false);
    std::fs::set_permissions(&path, permissions).expect("writable again");
}
