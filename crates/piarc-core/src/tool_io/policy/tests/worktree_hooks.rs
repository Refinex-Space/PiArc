//! Core owns the actual directory returned by the hook and never discards uninspected data.
use super::*;

const SETTINGS: &str = r#"{"hooks":{
    "WorktreeCreate":[{"hooks":[{"type":"command","command":"node worktree.mjs"}]}],
    "WorktreeRemove":[{"hooks":[{"type":"command","command":"node worktree.mjs"}]}]}}"#;

#[tokio::test]
async fn worktree_hooks_bind_a_directory_and_refuse_unsafe_or_failed_removal() {
    let f = Fixture::with_hooks(crate::tool_io::CommandEnv::process()).await;
    f.write_user_settings(SETTINGS);
    let project = piarc_git::canonical(&f.work()).unwrap();
    std::fs::write(
        project.join("worktree.mjs"),
        include_str!("../../../../../../tests/scenarios/fixtures/hooks/worktree.mjs.txt"),
    )
    .unwrap();
    assert!(f.io.offers_hook_worktree(&project).await);
    let create = |id| f.io.make_worktree(id, &project, "review", None, None, None);
    std::fs::write(project.join("fail-create"), "").unwrap();
    assert!(
        create("owner")
            .await
            .unwrap_err()
            .to_string()
            .contains("fixture create failed")
    );
    std::fs::remove_file(project.join("fail-create")).unwrap();
    let tree = create("owner").await.unwrap().worktree;
    assert_eq!(tree.path, project.join(".piarc/worktrees/isolated-review"));
    assert!(create("other").await.is_err());
    let remove = |owner, force| {
        f.io.remove_hook_worktree(owner, &project, &tree.path, force, false)
    };
    assert!(remove("other", true).await.is_err());
    assert!(remove("owner", false).await.is_err());
    std::fs::write(project.join("fail-remove"), "").unwrap();
    assert!(
        remove("owner", true)
            .await
            .unwrap_err()
            .to_string()
            .contains("fixture remove failed")
    );
    assert_eq!(
        std::fs::read_to_string(tree.path.join("created.txt")).unwrap(),
        "review"
    );
    std::fs::remove_file(project.join("fail-remove")).unwrap();
    let moved = tree.path.with_extension("moved");
    std::fs::rename(&tree.path, &moved).unwrap();
    std::fs::create_dir(&tree.path).unwrap();
    assert!(
        remove("owner", true)
            .await
            .unwrap_err()
            .to_string()
            .contains("identity changed")
    );
    std::fs::remove_dir(&tree.path).unwrap();
    std::fs::rename(moved, &tree.path).unwrap();
    f.write_user_settings("{}");
    assert!(remove("owner", true).await.is_err());
    f.write_user_settings(SETTINGS);
    assert!(remove("owner", true).await.unwrap());
    assert!(!tree.path.exists());
    // If recording the removal failed after the hook returned, the retry is idempotent.
    assert!(remove("owner", true).await.unwrap());
    assert!(f.io.hook_owner(&tree.path).await.unwrap().is_some());
    let reopened =
        f.io.make_worktree("owner", &project, "review", None, None, Some(&tree.path))
            .await
            .unwrap();
    assert_eq!(reopened.worktree.path, tree.path);
    assert!(
        f.io.remove_hook_worktree("owner", &project, &tree.path, true, true)
            .await
            .unwrap()
    );
    assert!(f.io.hook_owner(&tree.path).await.unwrap().is_none());
}
