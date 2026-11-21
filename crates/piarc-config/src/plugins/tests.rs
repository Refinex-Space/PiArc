use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use piarc_protocol::plugins::{PackageExecutableKind, PackageKind, PackageScope};
use serde_json::json;

use super::*;
use crate::{LayerTable, TrustState};

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc-plugins-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("工作区")).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.path(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A plugin with every kind of component, a mods module and an LSP file.
    fn plugin(&self, dir: &str) -> PathBuf {
        self.write(
            &format!("{dir}/.claude-plugin/plugin.json"),
            r#"{"name": "demo", "version": "1.2.0", "description": "Demo plugin"}"#,
        );
        self.write(
            &format!("{dir}/commands/hello.md"),
            "---\ndescription: Say hello\n---\nHello from ${CLAUDE_PLUGIN_ROOT}\n",
        );
        self.write(
            &format!("{dir}/commands/db/migrate.md"),
            "---\ndescription: Migrate\n---\nmigrate\n",
        );
        self.write(
            &format!("{dir}/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review code\n---\nUse ${CLAUDE_PLUGIN_DATA}/notes\n",
        );
        self.write(
            &format!("{dir}/agents/checker.md"),
            "---\nname: checker\ndescription: Checks\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo stop\n---\nYou check.\n",
        );
        self.write(
            &format!("{dir}/hooks/hooks.json"),
            r#"{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/guard.sh"}]}]}, "modules": ["./register.js"]}"#,
        );
        self.write(
            &format!("{dir}/.mcp.json"),
            r#"{"mcpServers": {"db": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/db.mjs"]}}}"#,
        );
        self.write(&format!("{dir}/.lsp.json"), "{}");
        self.path(dir)
    }

    fn pi_package(&self, dir: &str) -> PathBuf {
        self.write(
            &format!("{dir}/package.json"),
            r#"{"name": "@acme/pi-demo", "version": "0.3.0", "pi": {"extensions": ["./ext"], "skills": ["./skills"], "prompts": ["./prompts"], "themes": ["./themes"]}}"#,
        );
        self.write(&format!("{dir}/ext/index.ts"), "export default () => {};\n");
        self.write(
            &format!("{dir}/skills/lint/SKILL.md"),
            "---\nname: lint\ndescription: Lint\n---\nlint\n",
        );
        self.write(
            &format!("{dir}/prompts/fix.md"),
            "---\ndescription: Fix\n---\nfix\n",
        );
        self.write(&format!("{dir}/themes/dark.json"), "{}");
        self.path(dir)
    }

    fn settings(
        &self,
        user: serde_json::Value,
        project: serde_json::Value,
        trust: TrustState,
    ) -> Settings {
        self.write("data/settings.json", &user.to_string());
        self.write("工作区/.piarc/settings.json", &project.to_string());
        Settings::load(
            LayerTable::workspace(&self.path("data"), &self.path("工作区"), None),
            trust,
        )
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn names(executables: &[Executable], kind: PackageExecutableKind) -> Vec<String> {
    executables
        .iter()
        .filter(|e| e.kind == kind)
        .map(|e| e.name.clone())
        .collect()
}

#[test]
fn a_plugin_lists_its_components_executables_and_unsupported_parts() {
    let tree = Tree::new("plugin");
    let root = tree.plugin("插件 demo");
    let data = data_dir(&tree.path("data"), "demo");
    let manifest = read(&root, &data).expect("plugin");
    assert_eq!(manifest.kind, PackageKind::ClaudePlugin);
    assert_eq!(manifest.id, "demo");
    assert_eq!(manifest.version.as_deref(), Some("1.2.0"));
    assert_eq!(manifest.unsupported, ["mods", "lspServers"]);
    let components = manifest.components();
    assert_eq!(components.commands, ["demo:db:migrate", "demo:hello"]);
    assert_eq!(components.skills, ["demo:review"]);
    assert_eq!(components.agents, ["demo:checker"]);
    assert_eq!(components.hooks, ["PreToolUse"]);
    assert_eq!(components.mcp_servers, ["plugin_demo_db"]);
    let executables = manifest.executables();
    let root_text = root.to_string_lossy();
    assert_eq!(
        names(&executables, PackageExecutableKind::Hook),
        [format!("PreToolUse[Bash] {root_text}/guard.sh")]
    );
    assert_eq!(
        names(&executables, PackageExecutableKind::McpServer),
        [format!(
            "plugin_demo_db: node args=[\"{}\"]",
            root.join("db.mjs").to_string_lossy()
        )]
    );
    assert_eq!(
        names(&executables, PackageExecutableKind::AgentHook),
        ["demo:checker: Stop[*] echo stop"]
    );
}

#[test]
fn a_pi_package_lists_extensions_skills_prompts_and_themes_as_unsupported() {
    let tree = Tree::new("pi");
    let root = tree.pi_package("pi-demo");
    let manifest = read(&root, &tree.path("data")).expect("package");
    assert_eq!(manifest.kind, PackageKind::PiPackage);
    assert_eq!(manifest.id, "@acme/pi-demo");
    assert_eq!(manifest.unsupported, ["themes"]);
    let components = manifest.components();
    assert_eq!(components.extensions, ["ext/index.ts"]);
    assert_eq!(components.skills, ["lint"]);
    assert_eq!(components.commands, ["fix"]);
    assert_eq!(
        names(&manifest.executables(), PackageExecutableKind::PiExtension),
        ["ext/index.ts"]
    );
}

#[test]
fn a_directory_without_a_manifest_is_refused_and_names_are_checked() {
    let tree = Tree::new("none");
    tree.write("plain/readme.md", "x");
    assert!(read(&tree.path("plain"), &tree.path("data")).is_err());
    tree.write("bad/.claude-plugin/plugin.json", r#"{"name": "a b"}"#);
    assert!(read(&tree.path("bad"), &tree.path("data")).is_err());
    assert!(!valid_plugin_name("a__b"));
    assert!(!valid_plugin_name("x@y"));
    assert!(valid_plugin_name("my-plugin"));
    assert!(valid_package_name("@scope/name"));
    assert!(!valid_package_name("@scope"));
}

#[test]
fn settings_decide_scope_and_trust_and_only_confirmed_items_run() {
    let tree = Tree::new("active");
    let plugin = tree.plugin("plugins/demo");
    let pi = tree.pi_package("pi/pi-demo");
    let manifest = read(&plugin, &data_dir(&tree.path("data"), "demo")).expect("plugin");
    let hook = names(&manifest.executables(), PackageExecutableKind::Hook)[0].clone();
    let installed = vec![
        Installed {
            id: "demo".to_owned(),
            path: plugin.clone(),
            confirmed: BTreeSet::from([hook.clone()]),
        },
        Installed {
            id: "@acme/pi-demo".to_owned(),
            path: pi,
            confirmed: BTreeSet::new(),
        },
    ];
    let data = tree.path("data");
    // User scope for the plugin, project scope for the Pi package and a missing one.
    let user = json!({ "plugins": { "demo": true } });
    let project = json!({ "plugins": { "@acme/pi-demo": true, "gone": true } });
    let trusted = tree.settings(user.clone(), project.clone(), TrustState::Trusted);
    let packages = active(&trusted, &installed, &data);
    assert_eq!(packages.missing, ["gone"]);
    let scopes: Vec<(&str, PackageScope)> =
        packages.active.iter().map(|a| (a.id(), a.scope)).collect();
    assert_eq!(
        scopes,
        [
            ("@acme/pi-demo", PackageScope::Project),
            ("demo", PackageScope::User)
        ]
    );
    let demo = packages
        .active
        .iter()
        .find(|a| a.id() == "demo")
        .expect("demo");
    // The confirmed hook runs; the unconfirmed server and the agent's hook do not.
    assert!(demo.hooks().is_some());
    assert!(demo.mcp_servers().is_empty());
    assert_eq!(demo.pending().len(), 2);
    let pi_package = packages
        .active
        .iter()
        .find(|a| a.id() != "demo")
        .expect("pi");
    assert!(pi_package.extensions().is_empty());

    // An untrusted project's declarations are left out.
    let untrusted = tree.settings(user, project, TrustState::Untrusted);
    let ids: Vec<String> = active(&untrusted, &installed, &data)
        .active
        .iter()
        .map(|a| a.id().to_owned())
        .collect();
    assert_eq!(ids, ["demo"]);

    // A project can turn a user package off for itself.
    let off = tree.settings(
        json!({ "plugins": { "demo": true } }),
        json!({ "plugins": { "demo": false } }),
        TrustState::Trusted,
    );
    assert!(active(&off, &installed, &data).active.is_empty());
}

#[test]
fn package_components_come_after_other_sources_with_their_namespace() {
    let tree = Tree::new("catalog");
    let plugin = tree.plugin("plugins/demo");
    let data = tree.path("data");
    // The user's own `review` skill does not collide with `demo:review`; a user command
    // named like the Pi template wins.
    tree.write(
        "data/commands/fix.md",
        "---\ndescription: mine\n---\nmine\n",
    );
    let pi = tree.pi_package("pi/pi-demo");
    let packages: Vec<Active> = [(plugin, "demo"), (pi, "@acme/pi-demo")]
        .into_iter()
        .map(|(path, id)| Active {
            manifest: read(&path, &data_dir(&data, id)).expect("read"),
            scope: PackageScope::User,
            confirmed: BTreeSet::new(),
        })
        .collect();
    let catalog = crate::skills::load(&crate::skills::ResourceDirs {
        cwd: &tree.path("工作区"),
        data: Some(&data),
        home: None,
        packages: &packages,
    });
    let review = catalog.skill("demo:review").expect("plugin skill");
    assert_eq!(review.info.plugin.as_deref(), Some("demo"));
    assert!(
        review
            .body
            .contains(&data_dir(&data, "demo").to_string_lossy().into_owned())
    );
    let hello = catalog.command("demo:hello").expect("plugin command");
    assert!(!hello.body.contains("${CLAUDE_PLUGIN_ROOT}"));
    let fix = catalog.command("fix").expect("fix");
    assert_eq!(fix.info.plugin, None, "the user's command wins");
    assert_eq!(fix.info.overrides.len(), 1);

    let agents = crate::agents::load(&crate::agents::AgentDirs {
        cwd: &tree.path("工作区"),
        data: Some(&data),
        home: None,
        packages: &packages,
    });
    let checker = agents
        .definitions
        .iter()
        .find(|d| d.view.name == "demo:checker")
        .expect("plugin agent");
    assert_eq!(checker.view.plugin.as_deref(), Some("demo"));
    assert!(checker.hooks.is_none(), "its hook is not confirmed");
}

#[test]
fn filtering_keeps_only_named_handlers() {
    let hooks = json!({
        "Stop": [{"hooks": [{"type": "command", "command": "a"}, {"type": "command", "command": "b"}]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "c"}]}]
    });
    let kept = manifest::filter_hooks(Some(&hooks), &|name| name == "Stop[*] b").expect("one");
    assert_eq!(
        kept,
        json!({"Stop": [{"hooks": [{"type": "command", "command": "b"}]}]})
    );
    assert!(manifest::filter_hooks(Some(&hooks), &|_| false).is_none());
    assert_eq!(
        substitute_text("${CLAUDE_PLUGIN_ROOT}/x", Path::new("/r"), Path::new("/d")),
        "/r/x"
    );
}
