//! T41-A01, A02, A03: the configuration diagnostics list every source PiArc reads for a
//! workspace besides settings files, one fixture per kind: `.mcp.json` (untrusted until the
//! project is trusted, an unsupported transport), memory files with an import that applies and
//! one waiting for approval, rules (one conditional), subagent definitions (one overriding the
//! user's, one ignored field, one invalid file), skills (an untrusted `allowed-tools`, one
//! overriding the user's), command files, output styles, and the enterprise place ("not
//! configured"); a change to a source while running refreshes the report.
use super::*;

fn write(root: &Path, files: &[(&str, &str)]) {
    for (relative, text) in files {
        let file = root.join(relative);
        std::fs::create_dir_all(file.parent().expect("parent")).expect("dir");
        std::fs::write(file, text).expect("write");
    }
}

fn of_kind<'a>(report: &'a Value, kind: &str) -> Vec<&'a Value> {
    report["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter(|f| f["kind"] == kind)
        .collect()
}

fn named<'a>(reports: &[&'a Value], end: &str) -> &'a Value {
    reports
        .iter()
        .find(|f| f["file"].as_str().is_some_and(|p| p.ends_with(end)))
        .unwrap_or_else(|| panic!("no report for {end}: {reports:?}"))
}

fn pointers(list: &Value) -> Vec<String> {
    list.as_array()
        .expect("list")
        .iter()
        .map(|k| k["pointer"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn fixture(ws: &Path, home: &Path) {
    write(
        ws,
        &[
            (
                ".mcp.json",
                r#"{"mcpServers":{"api":{"command":"node","args":["server.js"]},"feed":{"type":"sse","url":"http://127.0.0.1:9/sse"}}}"#,
            ),
            (
                "CLAUDE.md",
                "Use tabs.\n@docs/style.md\n@../outside-外部.md\n",
            ),
            ("docs/style.md", "Short names.\n"),
            (".claude/rules/always.md", "Always explain.\n"),
            (
                ".claude/rules/ts.md",
                "---\npaths:\n  - \"src/**/*.ts\"\n---\nStrict types.\n",
            ),
            (
                ".claude/agents/reviewer.md",
                "---\nname: reviewer\ndescription: Reviews changes\nfavourite: tea\n---\nReview.\n",
            ),
            (
                ".claude/agents/broken.md",
                "---\nname: [not, a, name]\n---\nBody\n",
            ),
            (
                ".claude/skills/deploy/SKILL.md",
                "---\ndescription: Deploy\nallowed-tools: Bash(npm run deploy)\n---\nDeploy now.\n",
            ),
            (".claude/commands/fix.md", "Fix $ARGUMENTS.\n"),
            (
                ".claude/output-styles/terse.md",
                "---\ndescription: Terse\n---\nBe brief.\n",
            ),
        ],
    );
    write(
        home,
        &[
            (
                ".claude/agents/reviewer.md",
                "---\nname: reviewer\ndescription: Old reviewer\n---\nOld.\n",
            ),
            (
                ".claude/skills/deploy/SKILL.md",
                "---\ndescription: Old deploy\n---\nOld.\n",
            ),
        ],
    );
    write(
        ws.parent().expect("parent"),
        &[("outside-外部.md", "Outside.\n")],
    );
}

#[test]
#[expect(clippy::too_many_lines, reason = "one fixture, every kind of source")]
fn every_source_is_reported_with_its_state_and_a_change_refreshes_it() {
    let f = Fixture::new("diagnostic sources");
    let ws = f.root.join("ws 来源");
    let home = f.root.join("home");
    fixture(&ws, &home);
    let rt = runtime();
    let (core, rx) = f.start();
    let settings = rt
        .block_on(core.open_settings(ws.clone()))
        .expect("settings open");
    let report = diagnostics(&core, &ws);

    // .mcp.json: executable, so untrusted as a whole until the project is trusted.
    let mcp = of_kind(&report, "mcpJson");
    assert_eq!(mcp[0]["status"], "untrusted", "{}", mcp[0]);
    assert!(pointers(&mcp[0]["ignored"]).contains(&"/mcpServers/api".to_owned()));

    // Memory: the root file, its import that applies and the one outside the workspace.
    let memory = of_kind(&report, "memory");
    let root_memory = named(&memory, "CLAUDE.md");
    assert_eq!(root_memory["status"], "loaded");
    assert!(pointers(&root_memory["effective"])[0].ends_with("style.md"));
    let waiting = &root_memory["ignored"][0];
    assert_eq!(waiting["reason"], "notApproved");
    assert!(
        waiting["pointer"]
            .as_str()
            .expect("pointer")
            .ends_with("outside-外部.md")
    );

    // Rules: an unconditional one applies, a conditional one waits for a matching file.
    let rules = of_kind(&report, "rule");
    assert_eq!(pointers(&named(&rules, "always.md")["effective"]), ["/"]);
    let ts = named(&rules, "ts.md");
    assert_eq!(ts["ignored"][0]["reason"], "conditional");
    assert_eq!(ts["ignored"][0]["detail"], "src/**/*.ts");

    // Subagents: the project's reviewer overrides the user's; a field PiArc ignores; an
    // invalid file with its line.
    let agents = of_kind(&report, "agent");
    let project_reviewer = named(&agents, "ws 来源/.claude/agents/reviewer.md");
    assert_eq!(pointers(&project_reviewer["effective"]), ["/reviewer"]);
    assert!(pointers(&project_reviewer["ignored"]).contains(&"/favourite".to_owned()));
    let user_reviewer = named(&agents, "home/.claude/agents/reviewer.md");
    assert_eq!(user_reviewer["status"], "ignored");
    assert_eq!(user_reviewer["overridden"][0]["pointer"], "/reviewer");
    assert!(
        user_reviewer["overridden"][0]["sourceFile"]
            .as_str()
            .expect("source file")
            .ends_with("ws 来源/.claude/agents/reviewer.md")
    );
    let broken = named(&agents, "broken.md");
    assert_eq!(broken["status"], "invalid");
    assert!(broken["issues"][0]["line"].is_number(), "{broken}");

    // Skills: untrusted allowed-tools, the user's skill of the same name overridden.
    let skills = of_kind(&report, "skill");
    let deploy = named(&skills, "ws 来源/.claude/skills/deploy/SKILL.md");
    assert_eq!(pointers(&deploy["effective"]), ["/deploy"]);
    assert!(
        deploy["ignored"]
            .as_array()
            .expect("ignored")
            .iter()
            .any(|k| k["reason"] == "untrusted")
    );
    assert_eq!(
        named(&skills, "home/.claude/skills/deploy/SKILL.md")["status"],
        "ignored"
    );
    assert_eq!(
        pointers(&named(&of_kind(&report, "command"), "fix.md")["effective"]),
        ["/fix"]
    );
    assert_eq!(
        pointers(&named(&of_kind(&report, "outputStyle"), "terse.md")["effective"]),
        ["/terse"]
    );

    // The enterprise place: reserved, not configured.
    let enterprise = of_kind(&report, "enterprise");
    assert_eq!(enterprise[0]["status"], "notConfigured");

    // Trusting the project: .mcp.json applies, its SSE server is unsupported.
    let trust = core.trust().expect("trust");
    rt.block_on(async { decide_current(&trust, &ws, true).await })
        .expect("trust");
    let report = diagnostics(&core, &ws);
    let mcp = of_kind(&report, "mcpJson");
    assert_eq!(mcp[0]["status"], "loaded");
    assert_eq!(pointers(&mcp[0]["effective"]), ["/mcpServers/api"]);
    assert_eq!(mcp[0]["ignored"][0]["reason"], "unsupported");
    let deploy = named(
        &of_kind(&report, "skill"),
        "ws 来源/.claude/skills/deploy/SKILL.md",
    );
    assert!(
        deploy["ignored"]
            .as_array()
            .expect("ignored")
            .iter()
            .all(|k| k["reason"] != "untrusted")
    );

    // A3: a new rule while running is reported on `core/settings`; the next report has it.
    write(&ws, &[(".claude/rules/new.md", "New rule.\n")]);
    wait_for(&rx, "rule added", |_| true);
    let deadline = Instant::now() + WAIT;
    loop {
        let report = diagnostics(&core, &ws);
        if of_kind(&report, "rule")
            .iter()
            .any(|r| r["file"].as_str().is_some_and(|p| p.ends_with("new.md")))
        {
            break;
        }
        assert!(Instant::now() < deadline, "the new rule never showed");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(settings);
    core.shutdown_blocking().expect("shutdown");
}
