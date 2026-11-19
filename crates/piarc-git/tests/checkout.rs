//! T13-A09 (piarc-git part): trust keys from real git repositories: a linked worktree shares
//! its repository's main checkout; a submodule and a non-git directory are their own.

use std::path::{Path, PathBuf};
use std::process::Command;

use piarc_git::{CheckoutKind, canonical, resolve};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piarc-git {name} 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Runs git with a configuration that does not depend on the machine's.
fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=PiArc Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repo(dir: &Path) {
    std::fs::create_dir_all(dir).expect("repo dir");
    git(dir, &["init", "-q"]);
    std::fs::write(dir.join("README.md"), "# fixture\r\n").expect("file");
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "initial"]);
}

#[test]
fn worktrees_share_the_main_checkout_and_submodules_do_not() {
    let root = temp_dir("checkout");
    let main = root.join("main repo 主");
    repo(&main);
    std::fs::create_dir_all(main.join("src").join("深 层")).expect("nested");

    let linked = root.join("linked tree 树");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            linked.to_str().expect("utf-8"),
            "-b",
            "feature",
        ],
    );

    let library = root.join("library 库");
    repo(&library);
    git(
        &main,
        &[
            "submodule",
            "add",
            "-q",
            library.to_str().expect("utf-8"),
            "vendor/lib",
        ],
    );

    let plain = root.join("plain dir 普通");
    std::fs::create_dir_all(plain.join("sub")).expect("plain");

    let main_key = canonical(&main).expect("main");

    let at_root = resolve(&main).expect("main root");
    assert_eq!(
        (at_root.main.clone(), at_root.kind),
        (main_key.clone(), CheckoutKind::Repository)
    );
    let nested = resolve(&main.join("src").join("深 层")).expect("nested");
    assert_eq!(nested.main, main_key);
    assert_eq!(nested.root, main_key);

    let worktree = resolve(&linked).expect("linked worktree");
    assert_eq!(worktree.kind, CheckoutKind::LinkedWorktree);
    assert_eq!(
        worktree.main, main_key,
        "a linked worktree shares the main checkout"
    );
    assert_eq!(worktree.root, canonical(&linked).expect("linked"));

    let submodule = resolve(&main.join("vendor").join("lib")).expect("submodule");
    assert_eq!(submodule.kind, CheckoutKind::Independent);
    assert_eq!(
        submodule.main,
        canonical(&main.join("vendor").join("lib")).expect("sub")
    );
    assert_ne!(submodule.main, main_key, "a submodule is its own project");

    let outside = resolve(&plain.join("sub")).expect("plain");
    assert_eq!(outside.kind, CheckoutKind::NotGit);
    assert_eq!(outside.main, canonical(&plain.join("sub")).expect("plain"));

    // A symbolic link to the worktree resolves to the same key.
    #[cfg(unix)]
    {
        let link = root.join("link to tree");
        std::os::unix::fs::symlink(&linked, &link).expect("symlink");
        assert_eq!(resolve(&link).expect("through the link").main, main_key);
    }

    // On a case-insensitive file system another spelling is the same project.
    let shouted = PathBuf::from(main.to_string_lossy().to_uppercase());
    if shouted != main && shouted.exists() {
        assert_eq!(resolve(&shouted).expect("other case").main, main_key);
    }

    let canonical_text = main_key.to_string_lossy();
    assert!(!canonical_text.starts_with(r"\\?\"), "{canonical_text}");
    // A checkout moved without git worktree repair has stale registration.
    let moved = root.join("moved checkout");
    std::fs::rename(&linked, &moved).expect("move checkout");
    assert_ne!(resolve(&moved).ok().map(|c| c.main), Some(main_key));
    std::fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn a_missing_directory_and_a_malformed_git_file_are_errors() {
    let root = temp_dir("errors");
    assert!(resolve(&root.join("missing")).is_err());
    let odd = root.join("odd");
    std::fs::create_dir_all(&odd).expect("dir");
    std::fs::write(odd.join(".git"), "not a gitdir line\n").expect("file");
    let error = resolve(&odd).expect_err("malformed");
    assert!(
        error.to_string().contains("not a valid .git file"),
        "{error}"
    );
    std::fs::remove_dir_all(root).expect("cleanup");
}
