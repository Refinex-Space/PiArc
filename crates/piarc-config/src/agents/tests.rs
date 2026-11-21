use std::fs;
use std::path::Path;

use piarc_protocol::models::EffortLevel;
use piarc_protocol::policy::PermissionMode;
use piarc_protocol::subagent::{AgentSource, AgentWarningKind};
use serde_json::{Value, json};

use super::{AgentDirs, load, parse};

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    fs::write(path, text).expect("write");
}

/// A temporary root (with a space and Chinese in its name), removed on drop.
struct Temp(std::path::PathBuf);

impl Temp {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp() -> Temp {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir().join(format!(
        "piarc-config agents 定义 {} {}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp root");
    Temp(root)
}

const FULL: &str = "---
name: reviewer
description: Reviews a change.
tools: Read, Grep, Bash(git diff *)
disallowedTools:
  - Bash(rm *)
  - Write
model: sonnet
permissionMode: plan
maxTurns: 12
skills: [lint]
mcpServers:
  - github
  - local: { command: node }
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo hi
isolation: worktree
background: true
effort: high
color: purple
memory: project
initialPrompt: hello
---

Review the diff carefully.
";

#[test]
fn every_supported_field_is_read() {
    let path = Path::new("/w/.claude/agents/reviewer.md");
    let definition = parse(path, AgentSource::ProjectClaude, FULL).expect("parses");
    let view = &definition.view;
    assert_eq!(view.name, "reviewer");
    assert_eq!(view.description, "Reviews a change.");
    assert_eq!(view.prompt, "Review the diff carefully.");
    assert_eq!(
        view.tools.as_deref(),
        Some(&["Read".to_owned(), "Grep".to_owned(), "Bash".to_owned()][..])
    );
    assert_eq!(view.disallowed_tools, ["Bash", "Write"]);
    assert_eq!(view.model.as_deref(), Some("sonnet"));
    assert_eq!(view.permission_mode, Some(PermissionMode::Plan));
    assert_eq!(view.max_turns, Some(12));
    assert_eq!(view.skills, ["lint"]);
    assert_eq!(view.mcp_servers, ["github", "local"]);
    // `mcpServers` applies since T36: the inline definition is kept for Core to check.
    assert_eq!(
        Value::Object(definition.mcp_inline.clone()),
        json!({"local": {"command": "node"}})
    );
    assert!(view.hooks);
    assert_eq!(view.isolation.as_deref(), Some("worktree"));
    assert!(view.background);
    assert_eq!(view.effort, Some(EffortLevel::High));
    assert_eq!(view.color.as_deref(), Some("purple"));
    assert_eq!(
        definition.hooks,
        Some(
            json!({"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]})
        )
    );
    let kinds: Vec<_> = view
        .warnings
        .iter()
        .map(|w| (w.kind, w.field.clone().unwrap_or_default(), w.task.clone()))
        .collect();
    assert_eq!(
        kinds,
        [
            (
                AgentWarningKind::InactiveField,
                "skills".into(),
                Some("T48".into())
            ),
            (AgentWarningKind::IgnoredField, "initialPrompt".into(), None),
            (AgentWarningKind::IgnoredField, "memory".into(), None),
        ]
    );
}

#[test]
fn errors_name_the_file_line() {
    let path = Path::new("/w/a.md");
    let cases = [
        ("no frontmatter\n", 1, "no YAML frontmatter"),
        ("---\ndescription: d\n---\nbody", 1, "name is required"),
        (
            "---\nname: a\ndescription: d\nmaxTurns: -1\n---\n",
            4,
            "maxTurns",
        ),
        (
            "---\nname: a\ndescription: d\ntools: 5\n---\n",
            4,
            "tools must be a list",
        ),
        ("---\nname: a\n\ndescription: [x\n---\n", 4, "invalid YAML"),
        ("---\nname: a:b\ndescription: d\n---\n", 2, "without \":\""),
        (
            "---\nname: a\ndescription: d\npermissionMode: yolo\n---\n",
            4,
            "permissionMode",
        ),
        (
            "---\nname: a\ndescription: d\nisolation: remote\n---\n",
            4,
            "worktree",
        ),
        (
            "---\nname: a\ndescription: d\neffort: off\n---\n",
            4,
            "effort",
        ),
    ];
    for (text, line, message) in cases {
        let error = parse(path, AgentSource::User, text).expect_err(text);
        assert_eq!(error.path, "/w/a.md");
        assert_eq!(error.line, Some(line), "{text}: {error:?}");
        assert!(error.message.contains(message), "{text}: {}", error.message);
    }
}

#[test]
fn invalid_yaml_is_one_line_with_the_files_line() {
    // The parser's own text has a source snippet over several lines and counts lines from the
    // frontmatter; the settings page shows one line with the file's line number.
    let text = "---\nname: a\n\ndescription: [x\n---\n";
    let error = parse(Path::new("/w/a.md"), AgentSource::User, text).expect_err("invalid");
    assert_eq!(error.line, Some(4));
    assert!(!error.message.contains('\n'), "{}", error.message);
    assert!(!error.message.contains("<input>"), "{}", error.message);
    assert!(error.message.contains("line 4"), "{}", error.message);
}

#[test]
fn a_project_file_cannot_raise_the_mode() {
    for mode in ["bypassPermissions", "auto"] {
        let text = format!("---\nname: a\ndescription: d\npermissionMode: {mode}\n---\n");
        let project = parse(Path::new("/w/a.md"), AgentSource::ProjectPiarc, &text).expect("ok");
        assert_eq!(project.view.permission_mode, Some(PermissionMode::Default));
        assert_eq!(
            project.view.warnings[0].kind,
            AgentWarningKind::ProjectModeIgnored
        );
        assert_eq!(project.view.warnings[0].value.as_deref(), Some(mode));
    }
    let text = "---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\n";
    let user = parse(Path::new("/u/a.md"), AgentSource::UserClaude, text).expect("ok");
    assert_eq!(
        user.view.permission_mode,
        Some(PermissionMode::BypassPermissions)
    );
    let text = "---\nname: a\ndescription: d\npermissionMode: dontAsk\n---\n";
    let user = parse(Path::new("/u/a.md"), AgentSource::User, text).expect("ok");
    assert_eq!(user.view.permission_mode, None);
    assert_eq!(
        user.view.warnings[0].kind,
        AgentWarningKind::UnsupportedMode
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture tree with every source, asserted together"
)]
fn sources_merge_by_name_nearest_project_first() {
    let root = temp();
    let home = root.path().join("home 家");
    let data = root.path().join("data");
    let repo = root.path().join("repo");
    let cwd = repo.join("pkg").join("sub");
    fs::create_dir_all(&cwd).expect("cwd");
    let def = |name: &str, description: &str| {
        format!("---\nname: {name}\ndescription: {description}\n---\nbody of {description}\n")
    };
    write(
        &home.join(".claude/agents/shared.md"),
        &def("shared", "home claude"),
    );
    write(
        &home.join(".claude/agents/only-home.md"),
        &def("only-home", "home claude"),
    );
    write(&data.join("agents/shared.md"), &def("shared", "user piarc"));
    write(
        &repo.join(".claude/agents/shared.md"),
        &def("shared", "repo claude"),
    );
    write(
        &repo.join(".claude/agents/nested/deep.md"),
        &def("deep", "repo claude nested"),
    );
    write(
        &repo.join("pkg/.claude/agents/x.md"),
        &def("shared", "pkg claude"),
    );
    write(
        &repo.join(".piarc/agents/other-name.md"),
        &def("shared", "repo piarc"),
    );
    write(
        &repo.join(".claude/agents/broken.md"),
        "---\nname: [\n---\n",
    );
    write(
        &repo.join(".claude/agents/.hidden.md"),
        &def("hidden", "hidden"),
    );
    let loaded = load(&AgentDirs {
        cwd: &cwd,
        data: Some(&data),
        home: Some(&home),
    });
    let names: Vec<_> = loaded
        .definitions
        .iter()
        .map(|d| {
            (
                d.view.name.as_str(),
                d.view.description.as_str(),
                d.view.source,
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("shared", "repo piarc", AgentSource::ProjectPiarc),
            ("deep", "repo claude nested", AgentSource::ProjectClaude),
            ("only-home", "home claude", AgentSource::UserClaude),
        ]
    );
    let shared = loaded.get("shared").expect("shared");
    let overridden: Vec<_> = shared
        .view
        .overrides
        .iter()
        .map(|p| {
            Path::new(p)
                .strip_prefix(root.path())
                .expect("in root")
                .to_owned()
        })
        .collect();
    assert_eq!(
        overridden,
        [
            Path::new("repo/pkg/.claude/agents/x.md"),
            Path::new("repo/.claude/agents/shared.md"),
            Path::new("data/agents/shared.md"),
            Path::new("home 家/.claude/agents/shared.md"),
        ]
    );
    assert_eq!(loaded.issues.len(), 1);
    assert!(loaded.issues[0].path.ends_with("broken.md"));
    assert_eq!(loaded.issues[0].line, Some(2));
}

#[test]
fn the_home_directory_is_only_the_user_level() {
    let root = temp();
    let home = root.path().join("home");
    let cwd = home.join("project");
    fs::create_dir_all(&cwd).expect("cwd");
    write(
        &home.join(".claude/agents/a.md"),
        "---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\n",
    );
    let loaded = load(&AgentDirs {
        cwd: &cwd,
        data: None,
        home: Some(&home),
    });
    assert_eq!(loaded.definitions.len(), 1);
    let only = &loaded.definitions[0].view;
    assert_eq!(only.source, AgentSource::UserClaude);
    assert_eq!(
        only.permission_mode,
        Some(PermissionMode::BypassPermissions)
    );
}

#[test]
fn crlf_files_parse() {
    let text = "---\r\nname: a\r\ndescription: d\r\ntools: [Read]\r\n---\r\nBody\r\n";
    let definition = parse(Path::new("/a.md"), AgentSource::User, text).expect("crlf");
    assert_eq!(definition.view.prompt, "Body");
    assert_eq!(
        definition.view.tools.as_deref(),
        Some(&["Read".to_owned()][..])
    );
}
