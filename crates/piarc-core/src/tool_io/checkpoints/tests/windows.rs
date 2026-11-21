//! W2-A05: rewinds on Windows - a file another program holds, a path longer than 260
//! characters, two spellings of one file on a case-insensitive volume, and a recorded
//! file's directory replaced by a junction.
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;

use super::*;

/// R3's check for W2: the recorded file's directory is replaced by a junction to a directory
/// outside the workspace (a `mklink /J` from Bash, say). The rewind does not write the file
/// the junction now leads to.
#[tokio::test]
async fn a_rewind_does_not_write_through_a_junction_that_replaced_the_directory() {
    let f = Fixture::new("junction");
    f.put("sub 目录/a.txt", b"original\r\n");
    f.read("sub 目录/a.txt").await;
    f.write("turn-1", "sub 目录/a.txt", "agent\n")
        .await
        .expect("write");
    let outside = f.root.join("outside 外部");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(outside.join("a.txt"), b"not the workspace's\r\n").expect("outside file");
    std::fs::remove_dir_all(f.file("sub 目录")).expect("remove");
    junction(&f.file("sub 目录"), &outside);
    let preview = f.preview("turn-1").await;
    let choices = preview
        .files
        .iter()
        .filter(|p| p.action == RewindAction::Conflict)
        .map(|p| ConflictChoice {
            path: p.path.clone(),
            version: p.version.clone(),
            overwrite: true,
        })
        .collect();
    let report = f.io.rewind_code(S, "turn-1", choices).await;
    assert_eq!(
        std::fs::read(outside.join("a.txt")).expect("outside"),
        b"not the workspace's\r\n",
        "{report:?}"
    );
    assert!(report.is_err() || report.is_ok_and(|r| !r.completed));
    std::fs::remove_dir(f.file("sub 目录")).expect("remove the junction");
}

fn junction(link: &Path, target: &Path) {
    let out = std::process::Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .expect("cmd runs");
    assert!(out.status.success(), "mklink /J: {out:?}");
}

/// A file another program holds without sharing: the preview and the rewind say which file
/// and why, and nothing is written; once it is free the old bytes come back as they were.
#[tokio::test]
async fn a_file_another_program_holds_is_named_and_left_whole() {
    let f = Fixture::new("locked");
    let name = "held 文件.txt";
    f.put(name, b"one\r\ntwo\r\n");
    f.read(name).await;
    f.write("turn-1", name, "one\nTWO\n").await.expect("write");
    let after = f.bytes(name).expect("after");
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.file(name))
        .expect("held");
    let preview = f.io.rewind_preview(S, "turn-1").await.expect_err("held");
    let rewind =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect_err("held");
    drop(held);
    for error in [&preview, &rewind] {
        assert_eq!(error.data.kind, ErrorKind::IoError);
        assert!(error.message.contains(name), "{}", error.message);
        assert!(error.message.contains("(os error 32)"), "{}", error.message);
    }
    assert_eq!(f.bytes(name), Some(after), "nothing was written");
    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("free again");
    assert_eq!(outcomes(&report), [(name, FileOutcome::Restored)]);
    assert_eq!(f.bytes(name).as_deref(), Some(&b"one\r\ntwo\r\n"[..]));
}

/// A path longer than 260 characters and two spellings of one file: one record each,
/// labelled as on disk, restored byte for byte.
#[tokio::test]
async fn long_paths_and_other_spellings_rewind_to_the_old_bytes() {
    let f = Fixture::new("long");
    let deep: Vec<String> = (0..5)
        .map(|i| format!("{i}{}很长的目录", "d".repeat(44)))
        .collect();
    let long = format!("{}/file 文件.txt", deep.join("/"));
    assert!(f.file(&long).as_os_str().len() > 260);
    f.put(&long, b"long\r\n");
    f.put("Mixed/Name.txt", b"name\r\n");
    f.read(&long).await;
    f.read("Mixed/Name.txt").await;
    f.write("turn-1", &long, "LONG\n")
        .await
        .expect("long write");
    f.write("turn-1", "Mixed/Name.txt", "first\n")
        .await
        .expect("write");
    f.read("mixed/name.TXT").await;
    f.write("turn-2", "mixed/name.TXT", "second\n")
        .await
        .expect("other spelling");
    let preview = f.preview("turn-1").await;
    assert_eq!(
        actions(&preview),
        [
            (long.as_str(), RewindAction::Restore),
            ("Mixed/Name.txt", RewindAction::Restore)
        ]
    );
    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("rewind");
    assert!(report.completed, "{report:?}");
    assert_eq!(f.bytes(&long).as_deref(), Some(&b"long\r\n"[..]));
    assert_eq!(f.bytes("Mixed/Name.txt").as_deref(), Some(&b"name\r\n"[..]));
}
