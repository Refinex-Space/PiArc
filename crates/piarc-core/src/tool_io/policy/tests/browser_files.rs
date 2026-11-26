//! ADR-0089, design addendum B2.6.6: uploads and saved downloads of the agent's browser go
//! through Core's read and write decisions.
use super::*;
use tokio_util::sync::CancellationToken;

const CALL: &str = "browser-1";

fn running(f: &Fixture) -> CancellationToken {
    let token = CancellationToken::new();
    let session = f.io.session(SESSION).expect("registered");
    lock(&session.running).insert(format!("browser:{CALL}"), token.clone());
    token
}

fn download(f: &Fixture, name: &str, bytes: &[u8]) -> String {
    let dir = f.io.browser_downloads_dir(SESSION).expect("downloads");
    std::fs::create_dir_all(&dir).expect("downloads dir");
    let file = dir.join(name);
    std::fs::write(&file, bytes).expect("download");
    piarc_fs::display(&file)
}

#[tokio::test]
async fn a_workspace_file_is_staged_under_its_own_name() {
    let f = Fixture::new().await;
    let _run = running(&f);
    std::fs::write(f.work.join("report 报告.pdf"), b"%PDF-1.7").expect("file");
    let staged =
        f.io.stage_browser_upload(
            SESSION,
            CALL,
            &["report 报告.pdf".to_owned()],
            Duration::from_secs(5),
        )
        .await
        .expect("staged");
    assert_eq!(staged.len(), 1);
    let copy = std::path::PathBuf::from(&staged[0]);
    assert!(copy.ends_with("report 报告.pdf"), "{}", staged[0]);
    assert!(copy.to_string_lossy().contains("uploads"));
    assert_eq!(std::fs::read(&copy).expect("copy"), b"%PDF-1.7");
}

#[tokio::test]
async fn a_file_outside_the_workspace_asks_and_a_deny_rule_refuses() {
    let f = Fixture::new().await;
    let _run = running(&f);
    let outside = f.root.join("outside.txt");
    std::fs::write(&outside, b"secret").expect("file");
    let asking = {
        let io = f.io.clone();
        let path = piarc_fs::display(&outside);
        tokio::spawn(async move {
            io.stage_browser_upload(SESSION, CALL, &[path], Duration::from_secs(5))
                .await
        })
    };
    let card = f.pending().await;
    assert_eq!(card.tool, "BrowserUpload");
    f.io.answer_approval(answer(&card, ApprovalDecision::AllowOnce))
        .await
        .expect("answer");
    assert_eq!(asking.await.expect("task").expect("staged").len(), 1);
    std::fs::write(
        f.root.join("data/settings.json"),
        json!({ "permissions": { "deny": ["Read(**/*.env)"] } }).to_string(),
    )
    .expect("settings");
    std::fs::write(f.work.join("app.env"), b"KEY=1").expect("env");
    let refused =
        f.io.stage_browser_upload(
            SESSION,
            CALL,
            &["app.env".to_owned()],
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn a_later_upload_of_the_same_name_keeps_the_earlier_copy() {
    let f = Fixture::new().await;
    let _run = running(&f);
    std::fs::create_dir_all(f.work.join("a")).expect("a");
    std::fs::create_dir_all(f.work.join("b")).expect("b");
    std::fs::write(f.work.join("a/report.txt"), b"first").expect("first");
    std::fs::write(f.work.join("b/report.txt"), b"second").expect("second");
    let mut copies = Vec::new();
    for path in ["a/report.txt", "b/report.txt"] {
        let staged =
            f.io.stage_browser_upload(SESSION, CALL, &[path.to_owned()], Duration::from_secs(5))
                .await
                .expect("staged");
        copies.push(staged[0].clone());
    }
    assert_ne!(copies[0], copies[1]);
    assert_eq!(std::fs::read(&copies[0]).expect("first copy"), b"first");
    assert_eq!(std::fs::read(&copies[1]).expect("second copy"), b"second");
    assert!(copies.iter().all(|c| c.ends_with("report.txt")));
}

#[tokio::test]
async fn nothing_moves_without_a_running_call() {
    let f = Fixture::new().await;
    std::fs::write(f.work.join("a.txt"), b"a").expect("file");
    let refused =
        f.io.stage_browser_upload(SESSION, CALL, &["a.txt".to_owned()], Duration::from_secs(5))
            .await
            .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn saving_asks_in_manual_mode_and_never_replaces_a_file() {
    let f = Fixture::new().await;
    let _run = running(&f);
    let source = download(&f, "guid-invoice.pdf", b"invoice");
    let saving = {
        let io = f.io.clone();
        let source = source.clone();
        tokio::spawn(async move {
            io.save_browser_download(
                SESSION,
                CALL,
                &source,
                "docs/invoice.pdf",
                Duration::from_secs(5),
            )
            .await
        })
    };
    let card = f.pending().await;
    assert_eq!(card.tool, "BrowserSave");
    f.io.answer_approval(answer(&card, ApprovalDecision::AllowOnce))
        .await
        .expect("answer");
    saving.await.expect("task").expect("saved");
    assert_eq!(
        std::fs::read(f.work.join("docs/invoice.pdf")).expect("saved"),
        b"invoice"
    );
    let again =
        f.io.save_browser_download(
            SESSION,
            CALL,
            &source,
            "docs/invoice.pdf",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
    assert_eq!(again.data.kind, ErrorKind::InvalidParams);
    // Only the session's own downloads can be saved.
    std::fs::write(f.work.join("elsewhere.bin"), b"x").expect("file");
    let foreign =
        f.io.save_browser_download(
            SESSION,
            CALL,
            &piarc_fs::display(&f.work.join("elsewhere.bin")),
            "copy.bin",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
    assert_eq!(foreign.data.kind, ErrorKind::InvalidParams);
}

#[tokio::test]
async fn plan_mode_refuses_and_accept_edits_saves_inside_the_workspace() {
    let f = Fixture::new().await;
    let _run = running(&f);
    let source = download(&f, "guid-a.csv", b"a,b");
    f.io.session_mode(SESSION, PermissionMode::Plan)
        .expect("plan");
    let refused =
        f.io.save_browser_download(SESSION, CALL, &source, "a.csv", Duration::from_secs(5))
            .await
            .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::PermissionDenied);
    f.io.session_mode(SESSION, PermissionMode::AcceptEdits)
        .expect("accept edits");
    f.io.save_browser_download(SESSION, CALL, &source, "a.csv", Duration::from_secs(5))
        .await
        .expect("saved without a card");
    assert_eq!(std::fs::read(f.work.join("a.csv")).expect("saved"), b"a,b");
}
