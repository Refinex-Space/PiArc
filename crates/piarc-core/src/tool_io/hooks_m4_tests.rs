//! T41 through the real Core: a blocking `ConfigChange` hook pins the layer for the session's
//! hooks too, policy settings cannot be blocked (A06), and the watch list keeps at most
//! [`MAX_WATCH_PATHS`](super::super::hooks_m4::MAX_WATCH_PATHS) files (A07).
use super::*;

#[cfg(unix)]
#[tokio::test]
async fn a_blocked_config_change_pins_the_layer_and_policy_settings_cannot_be_blocked() {
    let f = Fixture::new(Setup {
        project: json!({
            "ConfigChange": group("", &[
                command(&records("config")),
                prints(&json!({"decision": "block", "reason": "frozen"})),
            ]),
            "UserPromptSubmit": group("", &[command("echo 'from the project'")]),
        }),
        ..Setup::default()
    })
    .await;
    let cancel = CancellationToken::new();
    assert_eq!(
        f.io.user_prompt_submit(SESSION, "go", &cancel).await,
        Ok(Some("from the project".to_owned()))
    );
    let file = f.work.join(".claude/settings.json");

    // Enterprise settings (T47) run the hooks but the block does not hold.
    assert!(
        !f.io
            .config_change(SESSION, "policy", &file, Some(json!({})))
            .await
    );
    assert_eq!(f.log("config")[0]["source"], "policy_settings");
    assert_eq!(
        f.io.user_prompt_submit(SESSION, "go", &cancel).await,
        Ok(Some("from the project".to_owned()))
    );

    // The project layer keeps its earlier value (no hooks) for this session's hooks.
    assert!(
        f.io.config_change(
            SESSION,
            piarc_config::ids::CLAUDE_PROJECT,
            &file,
            Some(json!({}))
        )
        .await
    );
    assert_eq!(f.log("config")[1]["source"], "project_settings");
    assert_eq!(
        f.io.user_prompt_submit(SESSION, "go", &cancel).await,
        Ok(None)
    );
    let notices = f.notices().await;
    assert!(notices.iter().any(|n| n["event"] == "ConfigChange"
        && n["message"] == "The project_settings change is not applied in this session: frozen"));
}

#[tokio::test]
async fn the_watch_list_keeps_at_most_64_files_and_tells_the_user() {
    let f = Fixture::new(Setup::default()).await;
    let paths: Vec<String> = (0..70).map(|n| format!("w{n:02}.txt")).collect();
    f.io.set_watch_paths(SESSION, &paths).await;
    let s = f.io.session(SESSION).expect("session");
    let watched = lock(&s.file_watch)
        .watch
        .as_ref()
        .map(|w| w.paths.clone())
        .unwrap_or_default();
    assert_eq!(watched.len(), 64);
    assert!(watched[63].ends_with("w63.txt"));
    let notices = f.notices().await;
    assert!(notices.iter().any(|n| n["event"] == "FileChanged"
        && n["level"] == "error"
        && n["message"] == "FileChanged watches at most 64 files; 6 were not watched."));
}
