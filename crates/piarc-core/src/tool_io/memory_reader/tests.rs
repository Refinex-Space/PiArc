use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

// Fields drop in declaration order: the scope's directory handles close before the tree is
// removed. Windows refuses to delete a directory that is open without shared delete.
struct Tree {
    scope: Scope,
    root: TempRoot,
}

struct TempRoot(PathBuf);

impl std::ops::Deref for TempRoot {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove temporary tree");
    }
}

impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique id"));
        let ws = root.join("ws");
        let cwd = ws.join("current");
        fs::create_dir_all(&cwd).expect("workspace");
        let scope = Scope::new(&ws, &cwd).expect("scope");
        Self {
            scope,
            root: TempRoot(root),
        }
    }

    fn file(&self, name: &str, text: impl AsRef<[u8]>) {
        let path = self.root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn collect(&self, dirs: &[String], both: bool, decision: Option<ImportAccess>) -> Collection {
        collect(
            &self.scope,
            Some(&self.root.join("home")),
            &self.root.join("data"),
            dirs,
            both,
            |_| decision.clone(),
        )
        .expect("collect fixture memory")
    }

    fn source<'a>(&self, result: &'a Collection, name: &str) -> &'a str {
        let path = display(&self.root.join(name).canonicalize().unwrap());
        &result
            .files
            .iter()
            .find(|f| f.path == path)
            .expect("source")
            .content
    }
}

#[test]
fn user_and_project_sources_follow_precedence_and_nested_paths_load_once() {
    let tree = Tree::new();
    let names = [
        "home/.claude/CLAUDE.md",
        "data/MEMORY.md",
        "CLAUDE.md",
        "ws/CLAUDE.md",
        "ws/.claude/CLAUDE.md",
        "ws/AGENTS.md",
        "ws/CLAUDE.local.md",
        "ws/current/AGENTS.md",
        "ws/current/deep/CLAUDE.md",
        "ws/current/deep/child/AGENTS.md",
    ];
    for name in names {
        tree.file(name, name);
    }
    let ours = |result: Collection| {
        result
            .files
            .into_iter()
            .filter(|f| names.contains(&f.content.as_str()))
            .map(|f| f.content)
            .collect::<Vec<_>>()
    };
    let initial = tree.collect(&[], false, None);
    assert!(initial.pending.is_empty());
    assert_eq!(
        ours(initial),
        [
            names[0], names[1], names[2], names[3], names[4], names[6], names[7]
        ]
    );
    assert_eq!(
        ours(tree.collect(
            &["deep/child".into(), "deep".into(), "../".into()],
            true,
            None
        )),
        names
    );
}

#[test]
fn imports_expand_in_place_with_sources_and_stop_at_cycles_and_four_edges() {
    let tree = Tree::new();
    tree.file("ws/CLAUDE.md", "before @docs/one.md after");
    tree.file("ws/docs/one.md", "one: @../CLAUDE.md @two.md");
    tree.file("ws/docs/two.md", "two: @three.md");
    tree.file("ws/docs/three.md", "three: @four.md");
    tree.file("ws/docs/four.md", "four: @five.md");
    tree.file("ws/docs/five.md", "TOP-OF-FIFTH");
    let all = tree.collect(&[], false, None);
    let content = tree.source(&all, "ws/CLAUDE.md");
    assert!(content.starts_with("before ") && content.ends_with(" after"));
    for name in ["one", "two", "three", "four"] {
        assert_eq!(content.matches(&format!("{name}:")).count(), 1);
        let path = tree
            .root
            .join(format!("ws/docs/{name}.md"))
            .canonicalize()
            .unwrap();
        assert!(content.contains(&display(&path)));
    }
    assert!(!content.contains("TOP-OF-FIFTH"));
    assert_eq!(content.matches("before ").count(), 1);
}

#[test]
fn only_prose_imports_expand_and_block_comments_are_removed() {
    let input = concat!(
        "<!--\n@secret.md\nhidden -->\n",
        "Plain @one.md, then `@inline.md` and `a\n@multiline.md`.\n",
        "Inline <!-- @quiet.md --> remains.\n",
        "````rust\n@fenced.md\n```\n@still-code.md\n````\n",
        "> ~~~\n> @quoted.md\n> ~~~\n",
        "    @indented.md\n",
        "An unmatched ` still allows @two.md. mail@example.test and \\@escaped.md.\n",
        "@\"name with spaces.md\"",
    );
    let mut references = Vec::new();
    let rendered = markdown::expand(input, |p| {
        references.push(p.to_owned());
        Ok(Some("INSERT".into()))
    })
    .unwrap();
    assert_eq!(references, ["one.md", "two.md", "name with spaces.md"]);
    assert_eq!(rendered.matches("INSERT").count(), 3);
    assert!(!rendered.contains("hidden") && !rendered.contains("@secret"));
    assert!(rendered.contains("<!-- @quiet.md -->") && rendered.contains("`@inline.md`"));
}

#[test]
fn external_import_decisions_are_bound_to_the_resolved_file() {
    let tree = Tree::new();
    tree.file("ws/CLAUDE.md", "@../outside.md");
    tree.file("outside.md", "outside-only-marker");
    let expected = tree.root.join("outside.md").canonicalize().unwrap();
    let pending = tree.collect(&[], false, None);
    assert_eq!(pending.pending, [expected]);
    assert!(
        tree.source(&pending, "ws/CLAUDE.md")
            .contains("Memory import not approved")
    );
    let denied = tree.collect(&[], false, Some(ImportAccess::Denied(None)));
    assert!(denied.pending.is_empty());
    assert!(
        tree.source(&denied, "ws/CLAUDE.md")
            .contains("Memory import denied")
    );
    for result in [&pending, &denied] {
        assert!(
            !tree
                .source(result, "ws/CLAUDE.md")
                .contains("outside-only-marker")
        );
    }
    let allowed = tree.collect(&[], false, Some(ImportAccess::Allowed));
    assert!(
        tree.source(&allowed, "ws/CLAUDE.md")
            .contains("outside-only-marker")
    );
}

#[cfg(unix)]
#[test]
fn conventional_names_and_lazy_directory_symlinks_do_not_bypass_approval() {
    use std::os::unix::fs::symlink;
    let tree = Tree::new();
    tree.file("other/CLAUDE.md", "outside-only-marker");
    symlink(
        tree.root.join("other/CLAUDE.md"),
        tree.root.join("ws/CLAUDE.md"),
    )
    .unwrap();
    symlink(tree.root.join("other"), tree.root.join("ws/current/link")).unwrap();
    let pending = tree.collect(&["link".into()], false, None);
    assert_eq!(
        pending.pending,
        [tree.root.join("other/CLAUDE.md").canonicalize().unwrap()]
    );
    assert!(
        pending
            .files
            .iter()
            .all(|file| !file.content.contains("outside-only-marker"))
    );
}

struct SkipLog(Arc<AtomicUsize>);
impl tracing::Subscriber for SkipLog {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let fields = event.metadata().fields();
        if fields.field("path").is_some() && fields.field("limit_bytes").is_some() {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[test]
fn four_mib_is_read_and_one_extra_byte_skips_the_file_and_logs_its_path() {
    let tree = Tree::new();
    tree.file("ws/CLAUDE.md", vec![b'x'; FILE_LIMIT as usize]);
    tree.file("ws/CLAUDE.local.md", vec![b'y'; FILE_LIMIT as usize + 1]);
    let logged = Arc::new(AtomicUsize::new(0));
    let result = tracing::subscriber::with_default(SkipLog(logged.clone()), || {
        tree.collect(&[], false, None)
    });
    assert_eq!(
        tree.source(&result, "ws/CLAUDE.md").len(),
        FILE_LIMIT as usize
    );
    assert!(
        result
            .files
            .iter()
            .all(|f| !f.path.ends_with("CLAUDE.local.md"))
    );
    assert_eq!(logged.load(Ordering::Relaxed), 1);
}

#[test]
fn adjacent_block_comments_do_not_load_their_imports() {
    let tree = Tree::new();
    tree.file(
        "ws/current/CLAUDE.md",
        "<!-- first --> <!-- @hidden.md -->Visible.\n",
    );
    tree.file("ws/current/hidden.md", "Hidden comment import");
    let result = tree.collect(&[], false, None);
    assert_eq!(
        tree.source(&result, "ws/current/CLAUDE.md").trim(),
        "Visible."
    );
}

#[test]
fn pending_consent_preserves_sources_already_read_at_session_open() {
    let tree = Tree::new();
    tree.file(
        "ws/current/CLAUDE.md",
        "Opening instructions. @../../guide.md",
    );
    tree.file("guide.md", "Approved guide.");
    let initial = tree.collect(&[], false, None);
    assert!(
        !tree
            .source(&initial, "ws/current/CLAUDE.md")
            .contains("Approved guide.")
    );
    tree.file("ws/current/CLAUDE.md", "Changed during approval.");
    let frozen = initial
        .inputs
        .expect("a deferred import")
        .expand(&tree.scope, Some(&tree.root.join("home")), |_| {
            Some(ImportAccess::Allowed)
        })
        .unwrap();
    let text = tree.source(&frozen, "ws/current/CLAUDE.md");
    assert!(text.contains("Opening instructions.") && text.contains("Approved guide."));
    assert!(!text.contains("Changed during approval."));
}

#[cfg(unix)]
#[test]
fn a_moved_import_directory_requires_a_new_decision() {
    let tree = Tree::new();
    tree.file("ws/current/CLAUDE.md", "@../../guide/note.md");
    tree.file("guide/note.md", "original guide");
    let initial = tree.collect(&[], false, None);
    let pending = initial.inputs.expect("deferred consent");
    fs::rename(tree.root.join("guide"), tree.root.join("old-guide")).expect("move directory");
    tree.file("guide/note.md", "new guide");
    assert!(
        pending
            .expand(&tree.scope, Some(&tree.root.join("home")), |_| Some(
                ImportAccess::Allowed
            ))
            .is_err()
    );
}
