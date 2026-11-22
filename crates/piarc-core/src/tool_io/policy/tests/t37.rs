//! T37 through the real Core preflight: the `Skill` tool's approval and load, `allowed-tools`
//! for the turn only (deny and ask still first), an untrusted project's skills granting nothing
//! and running no hooks, skill directories readable without asking, `/name` expansion and
//! `paths` matches.
use super::*;

fn fixed_path() -> super::super::super::CommandEnv {
    super::super::super::CommandEnv::Fixed(vec![("PATH".into(), "/usr/bin:/bin".into())])
}

impl Fixture {
    fn skill(&self, relative: &str, text: &str) {
        let path = self.work.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }

    async fn trust_now(&self) {
        let trust = &self.io.services().expect("policy").trust;
        let view = trust.view(&self.work).await.expect("view");
        trust
            .decide(&self.work, true, &view.version)
            .await
            .expect("trust");
    }

    async fn skills(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        self.io
            .skills_request(
                &self.work,
                method,
                params.as_object().expect("params").clone(),
                &self.peer,
            )
            .await
    }

    /// The `Skill` call `call` for `name`: approved (read-only) and loaded.
    async fn invoke(&self, call: &str, name: &str, args: &str) -> Value {
        let approved = self
            .evaluate(call, "Skill", json!({"skill": name, "args": args}))
            .await;
        assert_eq!(approved["allowed"], true, "{approved}");
        self.skills(
            "skills/invoke",
            json!({"sessionId": SESSION, "toolCallId": call, "name": name, "arguments": args}),
        )
        .await
        .expect("loaded")
    }
}

const ENV_SKILL: &str = "---\ndescription: Shows the environment\nallowed-tools: Bash(printenv *)\narguments: var\n---\nPrint $var from ${CLAUDE_SKILL_DIR}.\n";

/// T37-A04 (Core): `allowed-tools` allow their tools in the invoking turn only; deny and ask
/// rules still come first; the next turn asks again.
#[tokio::test]
async fn allowed_tools_apply_to_the_invoking_turn_only() {
    let f = Fixture::with_env(fixed_path()).await;
    f.skill(".claude/skills/env/SKILL.md", ENV_SKILL);
    f.skill(
        ".piarc/settings.local.json",
        r#"{"permissions":{"deny":["Bash(printenv SECRET*)"],"ask":["Bash(printenv PATH)"]}}"#,
    );
    f.trust_now().await;
    f.asks("Bash", json!({"command": "printenv HOME"})).await;
    let loaded = f.invoke("s1", "env", "HOME").await;
    let dir = f
        .work
        .join(".claude/skills/env")
        .canonicalize()
        .expect("canonical");
    assert_eq!(
        loaded["content"],
        format!("Print HOME from {}.", dir.display())
    );
    assert_eq!(loaded["allowedTools"], json!(["Bash(printenv *)"]));
    let allowed = f
        .evaluate("b1", "Bash", json!({"command": "printenv HOME"}))
        .await;
    assert_eq!(allowed["allowed"], true, "{allowed}");
    let denied = f
        .evaluate("b2", "Bash", json!({"command": "printenv SECRET_TOKEN"}))
        .await;
    assert_eq!(denied["allowed"], false, "deny first: {denied}");
    f.asks("Bash", json!({"command": "printenv PATH"})).await;
    // The turn ends: the next one asks again.
    f.io.clear_approvals(SESSION, Cleanup::Completed("turn-1"));
    f.asks("Bash", json!({"command": "printenv HOME"})).await;
    // A load needs its own approved call.
    let unapproved = f
        .skills(
            "skills/invoke",
            json!({"sessionId": SESSION, "toolCallId": "never", "name": "env"}),
        )
        .await;
    assert!(unapproved.is_err());
}

/// T37-A05: an untrusted project's skills and commands grant no tools and run no hooks; once
/// trusted, both apply (the hooks from the invocation on).
#[tokio::test]
async fn an_untrusted_project_skill_grants_nothing_and_runs_no_hooks() {
    let f = Fixture::with_hooks(fixed_path()).await;
    f.skill(".claude/skills/env/SKILL.md", ENV_SKILL);
    f.skill(
        ".claude/skills/guard/SKILL.md",
        "---\ndescription: Guards reads\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: echo blocked by the skill >&2; exit 2\n---\nGuard.\n",
    );
    f.skill(
        ".claude/commands/show.md",
        "---\nallowed-tools: Bash(printenv *)\n---\nShow $1.\n",
    );
    f.skill("known", "text");
    // The new skills are new executable items: the project is not trusted until confirmed.
    let list = f
        .skills("skills/list", json!({"sessionId": SESSION}))
        .await
        .expect("list");
    let warnings = |name: &str| {
        list["skills"]
            .as_array()
            .expect("skills")
            .iter()
            .find(|s| s["name"] == name)
            .map(|s| s["warnings"].clone())
            .expect("listed")
    };
    assert_eq!(warnings("env")[0]["kind"], "untrusted");
    let loaded = f.invoke("s1", "env", "HOME").await;
    assert_eq!(loaded["warnings"][0]["kind"], "untrusted");
    assert!(loaded.get("allowedTools").is_none());
    f.asks("Bash", json!({"command": "printenv HOME"})).await;
    let guard = f.invoke("s2", "guard", "").await;
    assert!(guard.get("hooks").is_none());
    let read = f.evaluate("r1", "Read", json!({"path": "known"})).await;
    assert_eq!(read["allowed"], true, "no hook ran: {read}");
    let expanded =
        f.io.expand_command(SESSION, "/show HOME")
            .await
            .expect("expanded")
            .expect("a command");
    assert_eq!(expanded.text, "Show HOME.");
    assert!(expanded.grant.is_none());
    f.asks("Bash", json!({"command": "printenv HOME"})).await;
    // Trusted: the grant and the hooks apply.
    f.trust_now().await;
    let guard = f.invoke("s3", "guard", "").await;
    assert_eq!(guard["hooks"], true);
    let read = f.evaluate("r2", "Read", json!({"path": "known"})).await;
    assert_eq!(read["allowed"], false, "{read}");
    assert!(
        read["reason"]
            .as_str()
            .expect("reason")
            .contains("blocked by the skill")
    );
    let expanded =
        f.io.expand_command(SESSION, "/show HOME")
            .await
            .expect("expanded")
            .expect("a command");
    assert!(expanded.grant.is_some());
    assert_eq!(expanded.command.input, "/show HOME");
    let allowed = f
        .evaluate("b1", "Bash", json!({"command": "printenv HOME"}))
        .await;
    assert_eq!(allowed["allowed"], true, "{allowed}");
    // A withdrawn grant (the input waited in the queue) allows nothing.
    f.io.revoke_turn_grant(SESSION, expanded.grant.expect("grant"));
    f.asks("Bash", json!({"command": "printenv HOME"})).await;
}

/// R4 E1: the trust of the main checkout covers its own skill files, the ones its trust
/// manifest lists. A worktree's own `.claude/skills` (another branch's files) and files of
/// directories above the root are instructions only: no `allowed-tools`, no hooks.
#[tokio::test]
async fn a_worktrees_own_skills_grant_nothing_under_the_main_checkouts_trust() {
    let f = Fixture::with_env(fixed_path()).await;
    f.trust_now().await;
    f.skill(".piarc/worktrees/w/.claude/skills/wenv/SKILL.md", ENV_SKILL);
    let tree = f
        .work
        .join(".piarc/worktrees/w")
        .canonicalize()
        .expect("tree");
    f.io.open_session_in("wt", &f.work, &tree, &tree)
        .expect("worktree session");
    let approved =
        f.io.dispatch(
            "policy/evaluate",
            json!({"sessionId": "wt", "toolCallId": "s1", "tool": "Skill",
                   "input": {"skill": "wenv", "args": "HOME"}})
            .as_object()
            .expect("params")
            .clone(),
            f.peer.clone(),
        )
        .await
        .expect("preflight");
    assert_eq!(approved["allowed"], true, "{approved}");
    let loaded = f
        .skills(
            "skills/invoke",
            json!({"sessionId": "wt", "toolCallId": "s1", "name": "wenv", "arguments": "HOME"}),
        )
        .await
        .expect("loaded");
    assert!(loaded.get("allowedTools").is_none(), "{loaded}");
    assert_eq!(loaded["warnings"][0]["kind"], "untrusted", "{loaded}");
}

/// The directories of the listed skills are readable without asking; writing there is not.
#[tokio::test]
async fn skill_directories_are_readable_without_asking() {
    let f = Fixture::new().await;
    let home = f.root.join("data");
    std::fs::create_dir_all(home.join("skills/notes")).expect("dir");
    std::fs::write(
        home.join("skills/notes/SKILL.md"),
        "---\ndescription: Notes\n---\nRead reference.md.\n",
    )
    .expect("skill");
    std::fs::write(home.join("skills/notes/reference.md"), "ref").expect("file");
    let reference = home.join("skills/notes/reference.md");
    // Before the list, the directory is outside the workspace: Read asks.
    let card = f
        .asks("Read", json!({"path": reference.display().to_string()}))
        .await;
    assert_eq!(card.tool, "Read");
    f.skills("skills/list", json!({"sessionId": SESSION}))
        .await
        .expect("list");
    // Only the fixture's skill: the walk up from the workspace also reaches the directories
    // above the temporary root, on Windows the real user's home with its own skills (W3).
    let real_root = piarc_git::strip_verbatim(std::fs::canonicalize(&f.root).expect("root"));
    let ours =
        f.io.skill_dirs(SESSION)
            .into_iter()
            .filter(|dir| dir.starts_with(&f.root) || dir.starts_with(&real_root))
            .count();
    assert_eq!(ours, 1);
    let read = f
        .evaluate(
            "r1",
            "Read",
            json!({"path": reference.display().to_string()}),
        )
        .await;
    assert_eq!(read["allowed"], true, "{read}");
    let write = f.asks(
        "Write",
        json!({"path": home.join("skills/notes/new.md").display().to_string(), "content": "x"}),
    );
    assert_eq!(write.await.tool, "Write");
}

/// `Skill(<name>)` deny hides a skill from the model and refuses its loads; `skillOverrides`
/// and `disable-model-invocation` keep it from the model too.
#[tokio::test]
async fn denied_and_user_only_skills_are_not_for_the_model() {
    let f = Fixture::new().await;
    f.skill(
        ".claude/skills/secret/SKILL.md",
        "---\ndescription: s\n---\nS\n",
    );
    f.skill(
        ".claude/skills/manual/SKILL.md",
        "---\ndescription: m\ndisable-model-invocation: true\n---\nM\n",
    );
    f.skill(
        ".piarc/settings.local.json",
        r#"{"permissions":{"deny":["Skill(secret)"]},"skillOverrides":{"manual":"name-only"}}"#,
    );
    let list = f
        .skills("skills/list", json!({"cwd": f.work.display().to_string()}))
        .await
        .expect("list");
    let secret = list["skills"]
        .as_array()
        .expect("skills")
        .iter()
        .find(|s| s["name"] == "secret")
        .expect("secret")
        .clone();
    assert_eq!(secret["modelInvocable"], false);
    assert_eq!(secret["warnings"][0]["kind"], "denied");
    let denied = f.evaluate("s1", "Skill", json!({"skill": "secret"})).await;
    assert_eq!(denied["allowed"], false);
    let approved = f.evaluate("s2", "Skill", json!({"skill": "manual"})).await;
    assert_eq!(approved["allowed"], true);
    let refused = f
        .skills(
            "skills/invoke",
            json!({"sessionId": SESSION, "toolCallId": "s2", "name": "manual"}),
        )
        .await
        .expect_err("user only");
    assert!(refused.message.contains("/manual"), "{refused:?}");
}

/// `paths` skills match the files a session touched, relative to the workspace root.
#[tokio::test]
async fn paths_skills_match_touched_files() {
    let f = Fixture::new().await;
    f.skill(
        ".claude/skills/rust-style/SKILL.md",
        "---\ndescription: r\npaths: \"src/**/*.rs\"\n---\nR\n",
    );
    f.skill(
        ".claude/skills/docs/SKILL.md",
        "---\ndescription: d\npaths: [docs/]\n---\nD\n",
    );
    let file = f.work.join("src/core/lib.rs").display().to_string();
    let matched = f
        .skills(
            "skills/match",
            json!({"sessionId": SESSION, "files": [file], "skills": ["rust-style", "docs"]}),
        )
        .await
        .expect("match");
    assert_eq!(matched["matched"], json!(["rust-style"]));
}
