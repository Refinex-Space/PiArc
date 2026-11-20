use std::collections::HashSet;

use super::*;
use crate::testing::TempDir;

#[test]
fn equal_contents_are_stored_once_in_their_bucket() {
    let dir = TempDir::new("dedupe");
    let store = ObjectStore::open(&dir.path().join("objects")).expect("store");
    let a = store.put(b"fn main() {}\n").expect("put a");
    let again = store.put(b"fn main() {}\n").expect("put again");
    let b = store.put("其他内容\r\n".as_bytes()).expect("put b");
    assert_eq!(a.hash(), again.hash());
    assert_ne!(a.hash(), b.hash());
    assert_eq!(store.count().expect("count"), 2);
    let hex = to_hex(&a.hash());
    assert!(
        dir.path()
            .join("objects")
            .join(&hex[..2])
            .join(&hex)
            .is_file()
    );
    assert_eq!(store.get(&a.hash()).expect("get"), b"fn main() {}\n");
    assert!(store.put(b"").is_ok(), "an empty file is an object too");
    assert_eq!(store.count().expect("count"), 3);
}

#[test]
fn reads_verify_the_hash() {
    let dir = TempDir::new("verify");
    let store = ObjectStore::open(dir.path()).expect("store");
    let pin = store.put(b"original").expect("put");
    let hex = to_hex(&pin.hash());
    std::fs::write(dir.path().join(&hex[..2]).join(&hex), b"tampered").expect("tamper");
    assert!(matches!(store.get(&pin.hash()), Err(Error::Corrupt { .. })));
    let missing = hash_of(b"never stored");
    assert!(matches!(store.get(&missing), Err(Error::Missing { .. })));
    assert_eq!(
        store.get(&missing).unwrap_err().kind(),
        piarc_protocol::ErrorKind::NotFound
    );
}

#[test]
fn hex_round_trips_and_rejects_other_text() {
    let hash = hash_of(b"x");
    assert_eq!(from_hex(&to_hex(&hash)), Some(hash));
    assert_eq!(from_hex(&to_hex(&hash).to_uppercase()), Some(hash));
    assert_eq!(from_hex("abc"), None);
    assert_eq!(from_hex(&"g".repeat(64)), None);
    assert_eq!(from_hex(&"中".repeat(22)), None);
}

#[test]
fn collection_keeps_referenced_and_pinned_objects() {
    let dir = TempDir::new("collect");
    let store = ObjectStore::open(dir.path()).expect("store");
    let referenced = store.put(b"referenced").expect("put").hash();
    let pinned = store.put(b"pinned").expect("put");
    let garbage = store.put(b"garbage").expect("put").hash();
    let collected = store
        .collect_garbage(&HashSet::from([referenced]))
        .expect("collect");
    assert_eq!(collected.removed, 1);
    assert_eq!(collected.kept, 2);
    assert!(store.contains(&referenced));
    assert!(store.contains(&pinned.hash()));
    assert!(!store.contains(&garbage));
    let hash = pinned.hash();
    drop(pinned);
    store.collect_garbage(&HashSet::new()).expect("collect");
    assert!(!store.contains(&hash), "unpinned and unreferenced");
    assert_eq!(store.count().expect("count"), 0);
}

#[test]
fn a_put_after_collection_stores_the_object_again() {
    let dir = TempDir::new("reput");
    let store = ObjectStore::open(dir.path()).expect("store");
    let hash = store.put(b"content").expect("put").hash();
    // Pinned before the collection looks: kept.
    let early = store.pin(hash);
    store.collect_garbage(&HashSet::new()).expect("collect");
    assert!(store.contains(&hash));
    drop(early);
    store.collect_garbage(&HashSet::new()).expect("collect");
    assert!(!store.contains(&hash));
    // A put that pins after the removal finds no file and writes it.
    let pin = store.put(b"content").expect("put");
    assert!(store.contains(&pin.hash()));
}

#[test]
fn only_stale_temporary_files_are_removed() {
    let dir = TempDir::new("temps");
    let store = ObjectStore::open(dir.path()).expect("store");
    let pin = store.put(b"x").expect("put");
    let bucket = dir.path().join(&to_hex(&pin.hash())[..2]);
    let fresh = bucket.join(".tmp-1-1");
    std::fs::write(&fresh, b"partial").expect("temp");
    let collected = store
        .collect_garbage(&HashSet::from([pin.hash()]))
        .expect("collect");
    assert_eq!(collected.temporary, 0);
    assert!(fresh.exists(), "a write may still be in progress");
    assert_eq!(
        store.count().expect("count"),
        1,
        "temporary files are not objects"
    );
}

#[test]
fn an_object_released_after_the_references_were_read_is_kept() {
    // R3: Core reads the referenced snapshots, then walks the store. A write that stores its
    // old bytes, records them in the index and releases its pin in between must not lose the
    // object: the references Core read do not have the new row yet.
    let dir = TempDir::new("race");
    let store = ObjectStore::open(dir.path()).expect("store");
    let collection = store.begin_collection();
    let referenced = HashSet::new();
    let pin = store.put(b"the file before the write").expect("put");
    let hash = pin.hash();
    drop(pin);
    let collected = collection.collect(&referenced).expect("collect");
    assert!(
        store.contains(&hash),
        "recorded by a write during the collection"
    );
    assert_eq!(collected.kept, 1);
    // The next collection reads references that include the row (or not, if it was deleted).
    store
        .begin_collection()
        .collect(&HashSet::new())
        .expect("collect");
    assert!(!store.contains(&hash));
}
