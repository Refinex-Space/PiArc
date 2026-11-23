use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;

struct Temp(PathBuf);

impl Temp {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc auto memory 记忆 {name} {}-{}",
            std::process::id(),
            crate::storage::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir.canonicalize().expect("canonical"))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn new<'a>(name: &'a str, description: &'a str, body: &'a str) -> NewTopic<'a> {
    NewTopic {
        name,
        description,
        kind: "feedback",
        body,
    }
}

#[test]
fn save_read_list_delete_and_the_generated_index() {
    let t = Temp::new("store");
    let store = Store::new(&t.0.join("data"), &t.0.join("repo"));
    assert!(store.index().unwrap().is_none());
    assert!(store.injected().unwrap().is_none());
    let saved = store
        .save(
            &new(
                "prefers-pnpm",
                "Use pnpm in this repo",
                "npm lockfiles get rejected.",
            ),
            "s-1",
        )
        .unwrap();
    assert!(saved.created);
    assert!(
        saved
            .line
            .starts_with("- [prefers-pnpm](prefers-pnpm.md) (feedback, ")
    );
    let again = store
        .save(
            &new(
                "prefers-pnpm",
                "Use pnpm, never npm",
                "Lockfile: pnpm-lock.yaml.\n\n",
            ),
            "s-2",
        )
        .unwrap();
    assert!(!again.created);
    store
        .save(
            &NewTopic {
                name: "deploy",
                description: "Staging deploys use the release script",
                kind: "project",
                body: "scripts/release.sh staging",
            },
            "user",
        )
        .unwrap();
    let topic = store.read("prefers-pnpm").unwrap().unwrap();
    assert_eq!(topic.description, "Use pnpm, never npm");
    assert_eq!(topic.body, "Lockfile: pnpm-lock.yaml.");
    assert_eq!(topic.session, "s-2");
    assert_eq!(topic.modified.len(), 20);
    let file = std::fs::read_to_string(store.dir().join("prefers-pnpm.md")).unwrap();
    assert!(file.starts_with(
        "---\nname: prefers-pnpm\ndescription: \"Use pnpm, never npm\"\ntype: feedback\n"
    ));
    let index = std::fs::read_to_string(store.index_path()).unwrap();
    assert!(
        index.starts_with("# Auto memory\n\n- [deploy](deploy.md) (project, "),
        "{index}"
    );
    assert_eq!(index.lines().count(), 4);
    assert!(store.dir().join(PROJECT_FILE).is_file());
    assert_eq!(store.list().unwrap().len(), 2);
    let deleted = store.delete("deploy").unwrap();
    assert_eq!(deleted.kind, "project");
    assert!(matches!(
        store.delete("deploy"),
        Err(MemoryError::Missing(_))
    ));
    assert_eq!(
        std::fs::read_to_string(store.index_path())
            .unwrap()
            .lines()
            .count(),
        3
    );
}

#[test]
fn names_types_descriptions_and_sizes_are_checked() {
    let t = Temp::new("checks");
    let store = Store::new(&t.0, &t.0.join("repo"));
    for name in ["", "Upper", "../up", "a/b", "-dash", &"x".repeat(65)] {
        assert!(
            matches!(
                store.save(&new(name, "d", "b"), "s"),
                Err(MemoryError::Name(_))
            ),
            "{name}"
        );
    }
    assert!(matches!(
        store.save(
            &NewTopic {
                kind: "secret",
                ..new("a", "d", "b")
            },
            "s"
        ),
        Err(MemoryError::Type(_))
    ));
    for description in ["", "two\nlines", &"d".repeat(201)] {
        assert!(matches!(
            store.save(&new("a", description, "b"), "s"),
            Err(MemoryError::Description)
        ));
    }
    let big = "x".repeat(MAX_TOPIC_BYTES + 1);
    assert!(matches!(
        store.save(&new("a", "d", &big), "s"),
        Err(MemoryError::TooLarge(_))
    ));
    assert!(store.read("../x").is_err());
    // Nothing was written by the refusals.
    assert!(!store.dir().exists());
}

#[test]
fn a_new_session_gets_at_most_the_index_limits() {
    let t = Temp::new("limits");
    let store = Store::new(&t.0, &t.0.join("repo"));
    let description = "d".repeat(MAX_DESCRIPTION_CHARS);
    for i in 0..MAX_TOPICS {
        store
            .save(&new(&format!("m{i:03}"), &description, "b"), "s")
            .unwrap();
    }
    assert!(matches!(
        store.save(&new("one-more", "d", "b"), "s"),
        Err(MemoryError::Full)
    ));
    let injected = store.injected().unwrap().unwrap();
    assert!(injected.len() <= INDEX_BYTES, "{}", injected.len());
    assert!(injected.lines().count() <= INDEX_LINES + 4);
    assert!(injected.contains("more memories are not listed here"));
    // The file keeps every line.
    let full = store.index().unwrap().unwrap();
    assert_eq!(full.lines().count(), MAX_TOPICS + 2);
}

/// T47-A04: every worktree of a repository shares one memory; two repositories never do.
#[test]
fn worktrees_share_and_repositories_are_isolated() {
    let t = Temp::new("worktrees");
    let git = |dir: &Path, args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    let repo = t.0.join("repo 一");
    let other = t.0.join("repo 二");
    for dir in [&repo, &other] {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(
            dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
    }
    let worktree = repo.join(".piarc").join("worktrees").join("feature");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "piarc/feature",
            worktree.to_str().unwrap(),
        ],
    );
    let checkout = |dir: &Path| piarc_git::resolve(dir).expect("resolve").main;
    let data = t.0.join("data");
    let main = Store::new(&data, &checkout(&repo));
    let linked = Store::new(&data, &checkout(&worktree));
    let isolated = Store::new(&data, &checkout(&other));
    assert_eq!(main.dir(), linked.dir());
    assert_ne!(main.dir(), isolated.dir());
    linked
        .save(&new("shared", "Saved from the worktree", "b"), "s")
        .unwrap();
    assert!(main.read("shared").unwrap().is_some());
    assert!(isolated.read("shared").unwrap().is_none());
    let key = project_key(&checkout(&repo));
    assert!(key.starts_with("repo-"), "{key}");
    assert_eq!(key.len(), "repo-".len() + 12);
}

/// T47-A06 (import): Claude Code's memory is copied once and its files stay as they are.
#[test]
fn claude_code_memory_is_imported_without_writing_to_it() {
    let t = Temp::new("import");
    let home = t.0.join("home");
    let checkout = t.0.join("repo");
    let source = claude_dir(&home, &checkout);
    assert!(source.starts_with(home.join(".claude").join("projects")));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("MEMORY.md"), "# index\n- [x](x.md)\n").unwrap();
    std::fs::write(
        source.join("user_role.md"),
        "---\nname: user role\ndescription: The user is a backend engineer\ntype: user\n---\n\nPrefers Rust.\n",
    )
    .unwrap();
    std::fs::write(
        source.join("notes.md"),
        "# Build notes\n\nRun make first.\n",
    )
    .unwrap();
    std::fs::write(source.join("existing.md"), "---\ndescription: d\n---\nb\n").unwrap();
    let before: Vec<(PathBuf, Vec<u8>)> = std::fs::read_dir(&source)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            let bytes = std::fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect();
    let store = Store::new(&t.0.join("data"), &checkout);
    store.save(&new("existing", "Mine", "kept"), "s").unwrap();
    let imported = store.import_claude(&source).unwrap();
    assert_eq!(
        imported.imported,
        vec!["notes".to_owned(), "user-role".to_owned()]
    );
    assert_eq!(imported.skipped, vec!["existing".to_owned()]);
    let role = store.read("user-role").unwrap().unwrap();
    assert_eq!(
        (role.kind.as_str(), role.session.as_str()),
        ("user", "import")
    );
    assert_eq!(
        store.read("notes").unwrap().unwrap().description,
        "Build notes"
    );
    assert_eq!(store.read("existing").unwrap().unwrap().body, "kept");
    for (path, bytes) in before {
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{}", path.display());
    }
    assert_eq!(std::fs::read_dir(&source).unwrap().count(), 4);
}
