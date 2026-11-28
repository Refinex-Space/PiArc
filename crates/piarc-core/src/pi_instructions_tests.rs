use super::*;

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc pi 指令 {}",
            crate::sessions::new_session_id().expect("id")
        ));
        fs::create_dir_all(&dir).expect("home");
        Self(dir.canonicalize().expect("canonical home"))
    }

    fn agent(&self, name: &str) -> PathBuf {
        agent_dir(&self.0).join(name)
    }

    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.agent(name);
        fs::create_dir_all(path.parent().expect("parent")).expect("agent dir");
        fs::write(path, bytes).expect("write");
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_missing_file_is_created_as_agents_md_with_its_directory() {
    let home = Home::new();
    let empty = view(&home.0).expect("view");
    assert_eq!(
        empty,
        View {
            path: piarc_fs::display(&home.agent("AGENTS.md")),
            exists: false,
            content: String::new(),
            hash: None,
        }
    );
    let saved = save(&home.0, "# Rules\nBe brief.\n", None).expect("save");
    assert!(saved.exists);
    assert_eq!(
        fs::read(home.agent("AGENTS.md")).expect("read"),
        b"# Rules\nBe brief.\n"
    );
    assert_eq!(
        saved.hash.as_deref(),
        Some(hash(b"# Rules\nBe brief.\n").as_str())
    );
}

#[test]
fn the_page_edits_the_file_pi_loads() {
    let home = Home::new();
    home.write("CLAUDE.md", b"claude");
    assert_eq!(view(&home.0).expect("view").content, "claude");
    home.write("AGENTS.override.md", b"override");
    let shown = view(&home.0).expect("view");
    assert_eq!(shown.content, "override");
    save(&home.0, "changed", shown.hash.as_deref()).expect("save");
    assert_eq!(
        fs::read(home.agent("AGENTS.override.md")).expect("read"),
        b"changed"
    );
    assert_eq!(fs::read(home.agent("CLAUDE.md")).expect("read"), b"claude");
}

#[test]
fn a_save_on_a_changed_file_is_refused_and_leaves_it_alone() {
    let home = Home::new();
    home.write("AGENTS.md", b"first");
    let shown = view(&home.0).expect("view");
    home.write("AGENTS.md", b"edited in Pi");
    let error = save(&home.0, "mine", shown.hash.as_deref()).expect_err("stale");
    assert_eq!(error.kind(), ErrorKind::FileModified);
    assert_eq!(
        fs::read(home.agent("AGENTS.md")).expect("read"),
        b"edited in Pi"
    );
    // A file created after a view of a missing one is a change too.
    let other = Home::new();
    let _ = view(&other.0).expect("view");
    other.write("AGENTS.md", b"new");
    let error = save(&other.0, "mine", None).expect_err("created meanwhile");
    assert_eq!(error.kind(), ErrorKind::FileModified);
}

#[test]
fn bom_and_crlf_are_kept() {
    let home = Home::new();
    home.write("AGENTS.md", b"\xEF\xBB\xBFone\r\ntwo\r\n");
    let shown = view(&home.0).expect("view");
    assert_eq!(shown.content, "one\r\ntwo\r\n");
    save(&home.0, "one\ntwo\nthree\n", shown.hash.as_deref()).expect("save");
    assert_eq!(
        fs::read(home.agent("AGENTS.md")).expect("read"),
        b"\xEF\xBB\xBFone\r\ntwo\r\nthree\r\n"
    );
}

#[test]
fn oversized_content_is_refused() {
    let home = Home::new();
    let big = "x".repeat(MAX_BYTES + 1);
    assert_eq!(
        save(&home.0, &big, None).expect_err("too large").kind(),
        ErrorKind::InvalidParams
    );
    assert!(!home.agent("AGENTS.md").exists());
}

#[cfg(unix)]
#[test]
fn a_linked_file_is_written_through_its_link() {
    let home = Home::new();
    let dotfiles = home.0.join("dotfiles");
    fs::create_dir_all(&dotfiles).expect("dotfiles");
    fs::write(dotfiles.join("AGENTS.md"), b"linked").expect("target");
    fs::create_dir_all(agent_dir(&home.0)).expect("agent dir");
    std::os::unix::fs::symlink(dotfiles.join("AGENTS.md"), home.agent("AGENTS.md")).expect("link");
    let shown = view(&home.0).expect("view");
    assert_eq!(shown.content, "linked");
    save(&home.0, "through", shown.hash.as_deref()).expect("save");
    assert!(
        fs::symlink_metadata(home.agent("AGENTS.md"))
            .expect("meta")
            .is_symlink()
    );
    assert_eq!(
        fs::read(dotfiles.join("AGENTS.md")).expect("read"),
        b"through"
    );
}
