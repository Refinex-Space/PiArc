use super::*;

fn texts(input: &str) -> Vec<String> {
    analyze(input)
        .commands
        .iter()
        .map(|c| c.text().replace(DYNAMIC, "…"))
        .collect()
}

fn words(input: &str) -> Vec<Word> {
    analyze(input).commands.remove(0).argv
}

#[test]
fn heredoc_lines_and_pipelines_after_the_marker() {
    assert_eq!(
        texts("cat <<EOF | grep x\nrm -rf /\nEOF"),
        ["grep x", "cat"]
    );
    assert_eq!(
        texts("cat <<EOF && rm -rf x\nbody\nEOF"),
        ["rm -rf x", "cat"]
    );
    assert_eq!(
        texts("cat <<EOF\n$(rm -rf x) body\nEOF"),
        ["rm -rf x", "cat"]
    );
    assert_eq!(texts("cat <<'EOF'\n$(rm -rf x)\nEOF"), ["cat"]);
    assert_eq!(texts("grep x <<< \"$(id)\""), ["id", "grep x"]);
}

#[test]
fn directories_follow_cd() {
    let a = analyze("cd a && ls; (cd b; ls) ; ls; cd $X; ls");
    let cwds: Vec<Cwd> = a.commands.iter().map(|c| c.cwd.clone()).collect();
    assert_eq!(
        cwds,
        [
            Cwd::start(),
            Cwd::Known("a".into()),
            Cwd::Known("a".into()),
            Cwd::Known("a/b".into()),
            Cwd::Known("a".into()),
            Cwd::Known("a".into()),
            Cwd::Unknown
        ]
    );
    let either = analyze("cd a || cd b; ls");
    assert_eq!(either.commands[2].cwd, Cwd::Unknown);
    assert_eq!(analyze("cd; ls").commands[1].cwd, Cwd::Known("~".into()));
}

#[test]
fn words_keep_their_values() {
    let w = words("echo $'a\\tb' \"x\"y'z' {a,b} *.ts ~/q \"$HOME\"");
    let values: Vec<&str> = w.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(values[1], "a\tb");
    assert_eq!(values[2], "xyz");
    assert!(w[3].glob && w[4].glob && !w[5].glob);
    assert_eq!(values[5], "~/q");
    assert!(!w[6].is_static());
    assert_eq!(w[6].source, "\"$HOME\"");
}

#[test]
fn assignments_and_declarations() {
    let a = analyze("export PATH=/tmp:$PATH; unset IFS; x=1; for HOME in a; do :; done");
    assert_eq!(a.unsafe_assignments, ["PATH", "IFS", "HOME"]);
    assert_eq!(
        texts("export A=1 && declare -x B"),
        ["export A=1", "declare -x B"]
    );
    let env = analyze("GIT_DIR=x git status");
    assert_eq!(env.commands[0].unsafe_env, ["GIT_DIR=x"]);
    assert!(analyze("A=1").commands.is_empty());
}

#[test]
fn wrappers_and_shadows() {
    let a = analyze("env FOO=1 TZ=UTC npm test");
    assert_eq!(a.commands[0].text(), "env FOO=1 TZ=UTC npm test");
    assert!(a.commands[0].exec_wrapper);
    assert_eq!(
        (a.commands[1].text().as_str(), a.commands[1].shadow),
        ("npm test", true)
    );
    let safe = analyze("env TZ=UTC npm test");
    assert_eq!(safe.commands[0].text(), "npm test");
    assert_eq!(safe.commands[0].wrappers, ["env"]);
    let x = analyze("xargs -0 rm -f");
    assert!(x.commands[0].exec_wrapper && x.commands[1].shadow);
    assert_eq!(x.commands[1].text(), "rm -f");
    let find = analyze(r"find . -exec chmod 600 {} \; -print");
    assert_eq!(find.commands[1].text(), "chmod 600 {}");
    assert_eq!(
        analyze("timeout --weird 5 ls").unresolved,
        [Unresolved::WrapperOptions("timeout".into())]
    );
    assert_eq!(texts("command -v git"), ["command -v git"]);
    assert_eq!(texts("/bin/rm -rf x"), ["/bin/rm -rf x"]);
}

#[test]
fn prefixes_for_always_allow() {
    let prefix = |s: &str| rule_prefix(&words(s));
    assert_eq!(prefix("git commit -m 'msg'").as_deref(), Some("git commit"));
    assert_eq!(
        prefix("npm run build -- --watch").as_deref(),
        Some("npm run build")
    );
    assert_eq!(
        prefix("cargo test -p piarc-policy").as_deref(),
        Some("cargo test")
    );
    assert_eq!(
        prefix("python3 scripts/gen.py --check").as_deref(),
        Some("python3 scripts/gen.py")
    );
    assert_eq!(
        prefix("python -m pytest -q").as_deref(),
        Some("python -m pytest")
    );
    assert_eq!(prefix("gh pr view 12").as_deref(), Some("gh pr view"));
    assert_eq!(prefix("pytest tests/").as_deref(), Some("pytest"));
    for exact in [
        "python -c 'print(1)'",
        "rm -rf build",
        "git -C x push",
        "curl https://x",
    ] {
        assert_eq!(prefix(exact), None, "{exact}");
    }
    let rules = |s: &str| {
        let a = analyze(s);
        suggestions(a.primary())
    };
    assert_eq!(
        rules("npm test && git commit -m x"),
        ["Bash(npm test *)", "Bash(git commit *)"]
    );
    assert_eq!(rules("npm test && npm test -- -u"), ["Bash(npm test *)"]);
    assert_eq!(rules("rm -rf build"), ["Bash(rm -rf build)"]);
    assert_eq!(rules("watch -n 1 ls"), ["Bash(watch -n 1 ls)"]);
    assert!(rules("rm -rf $DIR").is_empty());
    assert!(rules("a; b; c; d; e; f").is_empty());
    // Every suggestion allows the command it came from.
    for input in [
        "git commit -m 'a b'",
        "npm run lint -- --fix",
        "make -j8 all",
    ] {
        let a = analyze(input);
        let rule = suggestions(a.primary()).remove(0);
        let parsed = crate::rules::parse(&rule, crate::rules::Behavior::Allow).expect("rule");
        let Some(crate::rules::Spec::Command(p)) = parsed.spec else {
            panic!("{rule}")
        };
        assert!(p.covers(&a.commands[0].text()), "{rule} / {input}");
    }
}

#[test]
fn critical_targets() {
    let ctx = CriticalContext {
        home: "/h",
        root: "/w",
        cwd: "/w/src",
        fold_case: false,
    };
    let critical = |s: &str| {
        analyze(s)
            .commands
            .iter()
            .any(|c| is_critical_delete(c, &ctx))
    };
    for yes in [
        "rm -rf /",
        "rm -rf /*",
        "rm -r -f ~",
        "rm -fr ~/",
        "rm --recursive $HOME",
        "rm -rf \"${HOME}\"/",
        "rm -rf ..",
        "rm -rf ../",
        "rm -rf /w",
        "rm -rf /usr/lib",
        "rm -rf /etc",
        "rmdir /w",
        "sudo rm -rf /",
        "rm -Rf ~/*",
        "/bin/rm -rf /",
        "rm ~/*",
        "rm -rf /h/..",
    ] {
        assert!(critical(yes), "{yes}");
    }
    for no in [
        "rm -rf build",
        "rm -rf ./dist",
        "rm -f /",
        "rm -rf /w/src/x",
        "rm -rf $DIR",
        "rm -rf ~/proj/tmp",
    ] {
        assert!(!critical(no), "{no}");
    }
}
