use std::path::{Path, PathBuf};

use piarc_protocol::skills::{CommandKind, ResourceSource, ResourceWarningKind, SkillVisibility};
use serde_json::json;

use super::*;

/// A temporary tree: `home/`, `data/` and a workspace `work tree 中文/` with a subdirectory.
struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc-skills-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("work tree 中文").join("pkg")).unwrap();
        Self { root }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.path(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn load_from(&self, cwd: &str) -> Catalog {
        load(&ResourceDirs {
            cwd: &self.path(cwd),
            data: Some(&self.path("data")),
            home: Some(&self.path("home")),
        })
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn skill(description: &str) -> String {
    format!("---\ndescription: {description}\n---\nBody of {description}\n")
}

fn ends_with(path: &str, tail: &str) -> bool {
    Path::new(path).ends_with(tail)
}

/// T37-A01: every source is found, and a name resolves project before user, `.piarc` before
/// `.claude` before Pi, nearer directories first; the losers are listed on the winner.
#[test]
fn discovery_covers_every_source_and_resolves_names_by_precedence() {
    let t = Tree::new("discovery");
    let w = "work tree 中文";
    // One distinct skill per source.
    t.write(
        &format!("{w}/.piarc/skills/p-piarc/SKILL.md"),
        &skill("piarc project"),
    );
    t.write(
        &format!("{w}/.claude/skills/p-claude/SKILL.md"),
        &skill("claude project"),
    );
    t.write(
        &format!("{w}/pkg/.pi/skills/p-pi.md"),
        &skill("pi project file"),
    );
    t.write(
        &format!("{w}/.agents/skills/p-agents/SKILL.md"),
        &skill("agents project"),
    );
    t.write("data/skills/u-piarc/SKILL.md", &skill("piarc user"));
    t.write(
        "home/.claude/skills/u-claude/SKILL.md",
        &skill("claude user"),
    );
    t.write("data/pi/skills/u-pi/SKILL.md", &skill("pi user"));
    t.write(
        "home/.agents/skills/u-agents/SKILL.md",
        &skill("agents user"),
    );
    // The same name everywhere.
    for dir in [
        format!("{w}/pkg/.claude/skills/same"),
        format!("{w}/.piarc/skills/same"),
        format!("{w}/.claude/skills/same"),
        format!("{w}/.agents/skills/same"),
        "data/skills/same".to_owned(),
        "home/.claude/skills/same".to_owned(),
        "data/pi/skills/same".to_owned(),
    ] {
        t.write(&format!("{dir}/SKILL.md"), &skill(&dir));
    }
    // A skill whose frontmatter `name` differs from its directory.
    t.write(
        &format!("{w}/.claude/skills/dir-name/SKILL.md"),
        "---\nname: renamed\ndescription: by name\n---\nx\n",
    );
    let catalog = t.load_from(&format!("{w}/pkg"));
    assert!(catalog.issues.is_empty(), "{:?}", catalog.issues);
    let source_of = |name: &str| catalog.skill(name).map(|s| s.info.source);
    assert_eq!(source_of("p-piarc"), Some(ResourceSource::ProjectPiarc));
    assert_eq!(source_of("p-claude"), Some(ResourceSource::ProjectClaude));
    assert_eq!(source_of("p-pi"), Some(ResourceSource::ProjectPi));
    assert_eq!(source_of("p-agents"), Some(ResourceSource::ProjectPi));
    assert_eq!(source_of("u-piarc"), Some(ResourceSource::User));
    assert_eq!(source_of("u-claude"), Some(ResourceSource::UserClaude));
    assert_eq!(source_of("u-pi"), Some(ResourceSource::UserPi));
    assert_eq!(source_of("u-agents"), Some(ResourceSource::UserPi));
    assert_eq!(source_of("renamed"), Some(ResourceSource::ProjectClaude));
    assert_eq!(source_of("dir-name"), None);
    // `.piarc` of any level beats `.claude` of a nearer one (ADR-0054 rule 2).
    let same = catalog.skill("same").unwrap();
    assert_eq!(same.info.source, ResourceSource::ProjectPiarc);
    assert!(ends_with(&same.info.path, ".piarc/skills/same/SKILL.md"));
    let overrides: Vec<&str> = same.info.overrides.iter().map(String::as_str).collect();
    assert_eq!(overrides.len(), 6, "{overrides:?}");
    assert!(ends_with(overrides[0], "pkg/.claude/skills/same/SKILL.md"));
    assert!(ends_with(overrides[1], ".claude/skills/same/SKILL.md"));
    assert!(ends_with(overrides[5], "data/pi/skills/same/SKILL.md"));
    assert_eq!(same.body, format!("Body of {w}/.piarc/skills/same\n"));
}

#[test]
fn skill_frontmatter_fields() {
    let t = Tree::new("frontmatter");
    t.write(
        "work tree 中文/.claude/skills/fix/SKILL.md",
        "---\n\
         description: Fix an issue\n\
         when_to_use: When a bug is reported\n\
         argument-hint: \"[issue] [branch]\"\n\
         arguments: issue branch\n\
         disable-model-invocation: yes\n\
         user-invocable: false\n\
         allowed-tools: Bash(git add *) Read, Edit\n\
         paths: \"src/**/*.rs, docs/\"\n\
         hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo hi\n\
         context: fork\n\
         model: fast\n\
         license: MIT\n\
         ---\n\
         Fix $issue on $branch.\n\
         Context: !`git status`\n",
    );
    let catalog = t.load_from("work tree 中文");
    let fix = catalog.skill("fix").unwrap();
    let info = &fix.info;
    assert_eq!(info.description, "Fix an issue\nWhen a bug is reported");
    assert_eq!(info.argument_hint.as_deref(), Some("[issue] [branch]"));
    assert_eq!(info.arguments, ["issue", "branch"]);
    assert!(!info.model_invocable && !info.user_invocable);
    assert_eq!(info.allowed_tools, ["Bash(git add *)", "Read", "Edit"]);
    assert_eq!(info.paths, ["src/**/*.rs", "docs/"]);
    assert!(info.hooks && fix.hooks.is_some());
    let kinds: Vec<(ResourceWarningKind, Option<&str>, Option<&str>)> = info
        .warnings
        .iter()
        .map(|w| (w.kind, w.field.as_deref(), w.task.as_deref()))
        .collect();
    assert!(kinds.contains(&(
        ResourceWarningKind::UnsupportedField,
        Some("context"),
        Some("T48")
    )));
    assert!(kinds.contains(&(
        ResourceWarningKind::UnsupportedField,
        Some("model"),
        Some("T48")
    )));
    assert!(kinds.contains(&(ResourceWarningKind::IgnoredField, Some("license"), None)));
    // T37-A12: the dynamic command is flagged and stays in the body as written.
    assert!(kinds.contains(&(ResourceWarningKind::DynamicCommand, None, None)));
    assert!(fix.body.contains("Context: !`git status`"));
}

#[test]
fn invalid_yaml_still_loads_and_bad_names_are_issues() {
    let t = Tree::new("invalid");
    t.write(
        "work tree 中文/.claude/skills/broken/SKILL.md",
        "---\nname: [x\n---\n# Broken skill\nText\n",
    );
    t.write(
        "work tree 中文/.claude/skills/bad/SKILL.md",
        "---\nname: \"has space\"\n---\nx\n",
    );
    let catalog = t.load_from("work tree 中文");
    let broken = catalog.skill("broken").unwrap();
    assert_eq!(broken.info.description, "Broken skill");
    assert_eq!(
        broken.info.warnings[0].kind,
        ResourceWarningKind::InvalidFrontmatter
    );
    assert_eq!(catalog.issues.len(), 1);
    assert!(catalog.issues[0].message.contains("has space"));
}

#[test]
fn dynamic_command_detection() {
    assert!(has_dynamic_command("Branch: !`git branch`"));
    assert!(has_dynamic_command("!`date`"));
    assert!(has_dynamic_command("```!\nls\n```"));
    assert!(!has_dynamic_command("KEY=!`cmd`"));
    assert!(!has_dynamic_command("Wow!`not closed"));
    assert!(!has_dynamic_command("plain text"));
}

/// T37-A07: the merged list has the built-in commands, `.claude/commands` (namespaced by
/// subdirectory), Pi prompt templates and the skills the user may invoke; a built-in name
/// wins, then sources by precedence, a skill before a command file of the same source.
#[test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture with every kind of source and conflict"
)]
fn merged_command_list_and_conflicts() {
    let t = Tree::new("commands");
    let w = "work tree 中文";
    t.write(
        &format!("{w}/.claude/commands/review.md"),
        "---\ndescription: Review\nargument-hint: \"[file]\"\n---\nReview $1\n",
    );
    t.write(
        &format!("{w}/.claude/commands/frontend/component.md"),
        "Make a component named $ARGUMENTS\n",
    );
    t.write(
        &format!("{w}/.claude/commands/compact.md"),
        "Not the built-in\n",
    );
    t.write(
        &format!("{w}/.claude/commands/deploy.md"),
        "command deploy\n",
    );
    t.write(
        &format!("{w}/.claude/skills/deploy/SKILL.md"),
        &skill("skill deploy"),
    );
    t.write(
        &format!("{w}/.claude/skills/hidden/SKILL.md"),
        "---\ndescription: h\nuser-invocable: false\n---\nx\n",
    );
    t.write(
        &format!("{w}/.pi/prompts/pi-template.md"),
        "---\ndescription: From Pi\n---\nDo $@\n",
    );
    t.write("home/.claude/commands/review.md", "user review\n");
    t.write("data/pi/prompts/global.md", "global template\n");
    let catalog = t.load_from(w);
    let list = commands(&catalog);
    let names: Vec<(&str, CommandKind, ResourceSource)> = list
        .iter()
        .map(|c| (c.name.as_str(), c.kind, c.source))
        .collect();
    assert_eq!(
        names,
        [
            ("compact", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            ("clear", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            ("model", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            ("rewind", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            ("context", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            (
                "output-style",
                CommandKind::BuiltIn,
                ResourceSource::BuiltIn
            ),
            ("help", CommandKind::BuiltIn, ResourceSource::BuiltIn),
            ("deploy", CommandKind::Skill, ResourceSource::ProjectClaude),
            (
                "deploy",
                CommandKind::Command,
                ResourceSource::ProjectClaude
            ),
            (
                "frontend:component",
                CommandKind::Command,
                ResourceSource::ProjectClaude
            ),
            (
                "review",
                CommandKind::Command,
                ResourceSource::ProjectClaude
            ),
            (
                "pi-template",
                CommandKind::Command,
                ResourceSource::ProjectPi
            ),
            ("global", CommandKind::Command, ResourceSource::UserPi),
        ]
        .into_iter()
        .filter(|(name, kind, _)| !(*name == "deploy" && *kind == CommandKind::Command))
        .collect::<Vec<_>>()
    );
    let by_name = |name: &str| list.iter().find(|c| c.name == name).unwrap();
    assert!(ends_with(
        &by_name("compact").overrides[0],
        ".claude/commands/compact.md"
    ));
    assert!(ends_with(
        &by_name("deploy").overrides[0],
        ".claude/commands/deploy.md"
    ));
    assert_eq!(by_name("review").argument_hint.as_deref(), Some("[file]"));
    assert!(ends_with(
        &catalog.command("review").unwrap().info.overrides[0],
        "home/.claude/commands/review.md"
    ));
    assert_eq!(by_name("pi-template").description, "From Pi");
    assert_eq!(
        by_name("frontend:component").description,
        "Make a component named $ARGUMENTS"
    );
    assert_eq!(by_name("clear").aliases, ["reset", "new"]);
    assert!(list.iter().all(|c| c.name != "hidden"));
}

#[test]
fn skill_overrides_and_output_styles() {
    let t = Tree::new("styles");
    let w = "work tree 中文";
    for name in ["a", "b", "c", "d"] {
        t.write(&format!("{w}/.claude/skills/{name}/SKILL.md"), &skill(name));
    }
    t.write(
        &format!("{w}/.claude/output-styles/teacher.md"),
        "---\ndescription: Teaches\nkeep-coding-instructions: true\n---\nExplain every step.\n",
    );
    t.write("home/.claude/output-styles/teacher.md", "user teacher\n");
    t.write("data/output-styles/Concise.md", "My concise\n");
    let mut catalog = t.load_from(w);
    apply_visibility(
        &mut catalog.skills,
        Some(&json!({"a": "name-only", "b": "user-invocable-only", "c": "off", "d": "bogus"})),
    );
    let get = |name: &str| catalog.skill(name).unwrap().info.clone();
    assert_eq!(get("a").visibility, SkillVisibility::NameOnly);
    assert!(get("a").model_invocable);
    assert!(!get("b").model_invocable && get("b").user_invocable);
    assert!(!get("c").model_invocable && !get("c").user_invocable);
    assert_eq!(get("d").visibility, SkillVisibility::On);
    let list = commands(&catalog);
    assert!(list.iter().any(|c| c.name == "b") && !list.iter().any(|c| c.name == "c"));

    let all = styles(&catalog);
    let names: Vec<&str> = all.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        ["Default", "Concise", "Explanatory", "Proactive", "teacher"]
    );
    assert!(ends_with(
        &all[1].overrides[0],
        "data/output-styles/Concise.md"
    ));
    let teacher = &all[4];
    assert_eq!(teacher.instructions.as_deref(), Some("Explain every step."));
    assert!(ends_with(
        &teacher.overrides[0],
        "home/.claude/output-styles/teacher.md"
    ));
    assert_eq!(
        current_style(&all, Some(&json!("teacher"))),
        ("teacher".to_owned(), None)
    );
    assert_eq!(
        current_style(&all, Some(&json!("explanatory"))),
        ("Default".to_owned(), Some("explanatory".to_owned()))
    );
    assert_eq!(current_style(&all, None).0, "Default");
}

#[test]
fn slash_commands_and_tools() {
    assert_eq!(
        slash_command("/review src/a.rs  now"),
        Some(("review", "src/a.rs  now"))
    );
    assert_eq!(
        slash_command("  /frontend:component Button"),
        Some(("frontend:component", "Button"))
    );
    assert_eq!(slash_command("/"), None);
    assert_eq!(slash_command("no /slash"), None);
    assert_eq!(slash_command("/path/to/file"), None);
    assert_eq!(
        split_tools("Bash(git add *), Read Edit"),
        ["Bash(git add *)", "Read", "Edit"]
    );
}
