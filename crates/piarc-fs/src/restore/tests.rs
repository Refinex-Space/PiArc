use std::sync::Mutex;

use piarc_checkpoint::{ObjectStore, hash_of};
use piarc_protocol::fs::{LineEndings, ReadRange};

use super::*;
use crate::state::Freshness;
use crate::testing::TempTree;
use crate::write::{WriteSpec, stat_for_read, write};

struct Fixture {
    tree: TempTree,
    scope: Scope,
    states: Mutex<FileStates>,
    locks: PathLocks,
    store: ObjectStore,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let tree = TempTree::new(name);
        tree.dir("ws");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        let store = ObjectStore::open(&tree.path("objects")).expect("store");
        Self {
            tree,
            scope,
            states: Mutex::default(),
            locks: PathLocks::default(),
            store,
        }
    }

    fn put(&self, rel: &str, bytes: &[u8]) {
        let path = self.tree.path(&format!("ws/{rel}"));
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, bytes).expect("written");
    }

    fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        std::fs::read(self.tree.path(&format!("ws/{rel}"))).ok()
    }

    fn read(&self, rel: &str) {
        let range = ReadRange::default();
        stat_for_read(
            &self.scope,
            &self.states,
            rel,
            false,
            range.clone(),
            "c",
            false,
        )
        .expect("inspect");
        self.states.lock().expect("states").delivered_read("c");
        stat_for_read(&self.scope, &self.states, rel, false, range, "c", true).expect("read");
    }

    fn replace(
        &self,
        rel: &str,
        expected: Option<&[u8]>,
        content: Option<&[u8]>,
    ) -> Result<Replaced> {
        replace(
            &self.scope,
            &self.states,
            &self.locks,
            &Replacement {
                requested: rel,
                expected: expected.map(hash_of),
                content,
                snapshots: &self.store,
            },
        )
    }

    fn freshness(&self, rel: &str) -> Freshness {
        let path = self.scope.locate(rel).expect("path");
        let current = hash_of(&self.bytes(rel).expect("file"));
        self.states
            .lock()
            .expect("states")
            .freshness(&self.scope.key(&path), &current)
    }
}

#[test]
fn recorded_bytes_go_back_exactly_and_the_session_must_read_again() {
    let f = Fixture::new("restore-exact");
    let crlf_bom: &[u8] = b"\xEF\xBB\xBFline one\r\nline two\r\n";
    let gbk: &[u8] = b"\xD6\xD0\xCE\xC4\r\n";
    f.put("src/a 中文.txt", b"edited\n");
    f.put("gbk.txt", b"changed\n");
    f.read("src/a 中文.txt");
    assert_eq!(f.freshness("src/a 中文.txt"), Freshness::Fresh);
    let done = f
        .replace("src/a 中文.txt", Some(b"edited\n"), Some(crlf_bom))
        .expect("restored");
    assert!(done.changed);
    assert_eq!(done.label, "src/a 中文.txt");
    assert_eq!(done.before_sha256, Some(hash_of(b"edited\n")));
    assert_eq!(done.after_sha256, Some(hash_of(crlf_bom)));
    assert_eq!(f.bytes("src/a 中文.txt").as_deref(), Some(crlf_bom));
    assert_eq!(f.freshness("src/a 中文.txt"), Freshness::NotRead);
    // The replaced content is in the store: the rewind can be undone.
    let pin = done.snapshot.expect("snapshot");
    assert_eq!(f.store.get(&pin.hash()).expect("stored"), b"edited\n");
    f.replace("gbk.txt", Some(b"changed\n"), Some(gbk))
        .expect("restored");
    assert_eq!(f.bytes("gbk.txt").as_deref(), Some(gbk));
}

#[test]
fn a_file_that_is_not_as_expected_is_left_alone() {
    let f = Fixture::new("restore-changed");
    f.put("a.txt", b"changed by bash\n");
    let error = f
        .replace("a.txt", Some(b"what the session wrote\n"), Some(b"old\n"))
        .expect_err("changed");
    assert!(matches!(error, Error::Changed { .. }), "{error}");
    assert_eq!(error.kind(), piarc_protocol::ErrorKind::FileModified);
    assert_eq!(f.bytes("a.txt").as_deref(), Some(&b"changed by bash\n"[..]));
    assert!(matches!(
        f.replace("missing.txt", Some(b"x"), None),
        Err(Error::Changed { .. })
    ));
    assert_eq!(f.store.count().expect("count"), 0, "nothing was stored");
}

#[test]
fn created_files_are_removed_and_removed_files_come_back_with_their_directories() {
    let f = Fixture::new("restore-create-delete");
    f.put("new/made.txt", b"made\n");
    let gone = f
        .replace("new/made.txt", Some(b"made\n"), None)
        .expect("removed");
    assert!(gone.changed);
    assert_eq!(gone.after_sha256, None);
    assert_eq!(f.bytes("new/made.txt"), None);
    let again = f
        .replace("new/made.txt", None, None)
        .expect("nothing to do");
    assert!(!again.changed);
    // A command removed the file and its directories: they are created again.
    let back = f
        .replace("deep/er/back.txt", None, Some(b"back\n"))
        .expect("recreated");
    assert!(back.changed);
    assert_eq!(f.bytes("deep/er/back.txt").as_deref(), Some(&b"back\n"[..]));
}

#[test]
fn content_already_in_place_is_not_written_or_stored() {
    let f = Fixture::new("restore-noop");
    f.put("same.txt", b"same\n");
    let done = f
        .replace("same.txt", Some(b"same\n"), Some(b"same\n"))
        .expect("noop");
    assert!(!done.changed);
    assert!(done.snapshot.is_none());
    assert_eq!(f.store.count().expect("count"), 0);
}

#[test]
fn protected_paths_need_approval() {
    let f = Fixture::new("restore-protected");
    f.put(".git/config", b"x");
    assert!(matches!(
        f.replace(".git/config", Some(b"x"), Some(b"y")),
        Err(Error::NeedsApproval { .. })
    ));
}

#[test]
fn current_content_reports_missing_files_and_large_ones_by_hash() {
    let f = Fixture::new("restore-current");
    f.put("a.txt", b"0123456789");
    assert_eq!(
        current_sha256(&f.scope, "a.txt").expect("hash"),
        Some(hash_of(b"0123456789"))
    );
    assert_eq!(current_sha256(&f.scope, "none.txt").expect("hash"), None);
    assert_eq!(current_sha256(&f.scope, "no/dir/x").expect("hash"), None);
    assert_eq!(
        read_current(&f.scope, "a.txt", 10).expect("read"),
        Current::Bytes(b"0123456789".to_vec())
    );
    assert_eq!(
        read_current(&f.scope, "a.txt", 9).expect("read"),
        Current::TooLarge {
            size: 10,
            sha256: hash_of(b"0123456789")
        }
    );
    assert_eq!(
        read_current(&f.scope, "none.txt", 9).expect("read"),
        Current::Missing
    );
}

#[test]
fn writes_store_the_old_bytes_once_per_content() {
    let f = Fixture::new("write-snapshots");
    f.put("a.txt", b"same old\n");
    f.put("b.txt", b"same old\n");
    f.read("a.txt");
    f.read("b.txt");
    let spec = |requested| WriteSpec {
        requested,
        text: "new\n",
        append: false,
        line_endings: LineEndings::AsWritten,
        snapshots: Some(&f.store),
    };
    let a = write(&f.scope, &f.states, &f.locks, &spec("a.txt")).expect("a");
    let b = write(&f.scope, &f.states, &f.locks, &spec("b.txt")).expect("b");
    let created = write(&f.scope, &f.states, &f.locks, &spec("c.txt")).expect("c");
    assert_eq!(a.before_sha256, Some(hash_of(b"same old\n")));
    assert_eq!(a.after_sha256, hash_of(b"new\n"));
    assert_eq!(
        a.snapshot.as_ref().map(Pin::hash),
        b.snapshot.as_ref().map(Pin::hash)
    );
    assert_eq!(created.before_sha256, None);
    assert!(created.snapshot.is_none(), "a new file has no old bytes");
    assert_eq!(
        f.store.count().expect("count"),
        1,
        "equal contents stored once"
    );
}
