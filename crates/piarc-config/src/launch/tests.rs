use std::path::{Path, PathBuf};

use super::*;

/// A scratch directory removed at the end of the test.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("piarc launch {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(root: &Path, file: &str, text: &str) {
    let path = root.join(file);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    std::fs::write(path, text).expect("write");
}

fn one(text: &str) -> LaunchConfig {
    let parsed = parse(text, LaunchSource::Piarc);
    assert!(parsed.issues.is_empty(), "{:?}", parsed.issues);
    parsed.configs.into_iter().next().expect("a configuration")
}

#[test]
fn jsonc_comments_and_trailing_commas_parse() {
    let text = r#"{
  // the web app
  "version": "0.0.1", /* not read */
  "configurations": [
    {
      "name": "web", // dev server
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev",],
      "url": "http://localhost:5173/",
    },
  ],
  "autoVerify": false,
}"#;
    let parsed = parse(text, LaunchSource::Piarc);
    assert!(parsed.issues.is_empty(), "{:?}", parsed.issues);
    assert_eq!(parsed.auto_verify, Some(false));
    let config = &parsed.configs[0];
    assert_eq!(config.name, "web");
    assert_eq!(config.runtime_args, ["run", "dev"]);
    assert_eq!(config.port(), 5173);
}

#[test]
fn comment_markers_inside_strings_stay() {
    let config = one(
        r#"{"configurations":[{"name":"a // b","program":"/* x */.js","url":"http://localhost:8080//x"}]}"#,
    );
    assert_eq!(config.name, "a // b");
    assert_eq!(config.program.as_deref(), Some("/* x */.js"));
    assert_eq!(config.url.as_deref(), Some("http://localhost:8080//x"));
}

#[test]
fn syntax_errors_carry_their_place() {
    let text = "{\n  // comment\n  \"configurations\": [\n    { \"name\": \"web\" \"program\": \"x\" }\n  ]\n}";
    let parsed = parse(text, LaunchSource::Claude);
    assert_eq!(parsed.issues.len(), 1, "{:?}", parsed.issues);
    let issue = &parsed.issues[0];
    assert_eq!(issue.file, CLAUDE_LAUNCH);
    assert_eq!(issue.at.map(|(line, _)| line), Some(4));
    assert!(!issue.message.contains(" at line "), "{}", issue.message);
}

#[test]
fn wrong_fields_point_at_their_configuration() {
    let text = "{\n  \"configurations\": [\n    { \"name\": \"ok\", \"program\": \"a.js\" },\n    { \"name\": \"bad\", \"port\": \"x\", \"program\": \"b.js\" },\n    { \"program\": \"c.js\" }\n  ]\n}";
    let parsed = parse(text, LaunchSource::Piarc);
    assert_eq!(parsed.configs.len(), 1);
    assert_eq!(parsed.issues.len(), 2, "{:?}", parsed.issues);
    assert_eq!(parsed.issues[0].at, Some((4, 5)));
    assert!(parsed.issues[0].message.contains("\"port\""));
    assert_eq!(parsed.issues[1].at, Some((5, 5)));
    assert!(parsed.issues[1].message.contains("\"name\" is missing"));
}

#[test]
fn a_configuration_needs_something_to_run() {
    let parsed = parse(r#"{"configurations":[{"name":"x"}]}"#, LaunchSource::Piarc);
    assert!(parsed.configs.is_empty());
    assert!(parsed.issues[0].message.contains("runtimeExecutable"));
}

#[test]
fn port_inference_order() {
    let base = r#""name":"s","runtimeExecutable":"npm""#;
    let port = |fields: &str| one(&format!(r#"{{"configurations":[{{{base}{fields}}}]}}"#)).port();
    assert_eq!(
        port(
            r#","port":4000,"url":"http://localhost:5000","env":{"PORT":"6000"},"args":["--port","7000"]"#
        ),
        4000
    );
    assert_eq!(
        port(
            r#","url":"http://localhost:5000/app","env":{"PORT":"6000"},"args":["--port","7000"]"#
        ),
        5000
    );
    assert_eq!(
        port(r#","env":{"PORT":"6000"},"args":["--port","7000"]"#),
        6000
    );
    assert_eq!(port(r#","args":["--port","7000"]"#), 7000);
    assert_eq!(port(r#","args":["--port=7001"]"#), 7001);
    assert_eq!(port(r#","runtimeArgs":["run","dev","-p","7002"]"#), 7002);
    assert_eq!(port(r#","url":"http://[::1]:7003/""#), 7003);
    assert_eq!(port(""), DEFAULT_PORT);
    assert_eq!(port(r#","url":"http://localhost/""#), DEFAULT_PORT);
}

#[test]
fn auto_port_rewrites_arguments_env_and_url() {
    let config = one(
        r#"{"configurations":[{"name":"s","runtimeExecutable":"npx","runtimeArgs":["vite","--port","5173"],"args":["--port=5173","-p","5173"],"url":"http://localhost:5173/x","autoPort":true}]}"#,
    );
    let moved = config.on_port(5174);
    assert_eq!(moved.runtime_args, ["vite", "--port", "5174"]);
    assert_eq!(moved.args, ["--port=5174", "-p", "5174"]);
    assert_eq!(moved.env.get("PORT").map(String::as_str), Some("5174"));
    assert_eq!(moved.url.as_deref(), Some("http://localhost:5174/x"));
    assert_eq!(moved.port(), 5174);
    assert_ne!(moved.fingerprint(), config.fingerprint());
}

#[test]
fn command_and_workspace_folder() {
    let root = Path::new("/work/my app");
    let config = one(
        r#"{"configurations":[{"name":"s","program":"${workspaceFolder}/server.js","args":["--root","${workspaceFolder}"],"cwd":"${workspaceFolder}/web","env":{"DIR":"${workspaceFolder}"}}]}"#,
    );
    assert_eq!(
        config.command(root),
        ["node", "/work/my app/server.js", "--root", "/work/my app"]
    );
    assert_eq!(config.cwd(root), "/work/my app/web");
    assert_eq!(
        config.env(root).get("DIR").map(String::as_str),
        Some("/work/my app")
    );
    assert_eq!(
        config.display(root),
        "node '/work/my app/server.js' --root '/work/my app'"
    );
}

#[test]
fn fingerprint_follows_what_runs() {
    let text = |env: &str| {
        format!(
            r#"{{"configurations":[{{"name":"s","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"env":{{"A":"{env}"}}}}]}}"#
        )
    };
    let a = one(&text("1"));
    let renamed = LaunchConfig {
        name: "other".into(),
        ..a.clone()
    };
    assert_eq!(a.fingerprint(), one(&text("1")).fingerprint());
    assert_eq!(
        a.fingerprint(),
        renamed.fingerprint(),
        "the name does not run"
    );
    assert_ne!(a.fingerprint(), one(&text("2")).fingerprint());
    assert_eq!(a.fingerprint().len(), 64);
}

#[test]
fn piarc_hides_claude_and_auto_verify_falls_back() {
    let dir = Scratch::new("merge");
    write(
        dir.path(),
        CLAUDE_LAUNCH,
        r#"{"autoVerify": false, "configurations":[{"name":"web","runtimeExecutable":"yarn"},{"name":"api","program":"api.js"}]}"#,
    );
    write(
        dir.path(),
        PIARC_LAUNCH,
        "{\r\n  \"configurations\": [{ \"name\": \"web\", \"runtimeExecutable\": \"pnpm\" }]\r\n}\r\n",
    );
    let launch = load(dir.path());
    let names: Vec<_> = launch.configs.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["web", "api"]);
    assert_eq!(launch.configs[0].source, LaunchSource::Piarc);
    assert_eq!(
        launch.configs[0].runtime_executable.as_deref(),
        Some("pnpm")
    );
    assert!(!launch.auto_verify());
    assert!(launch.issues.is_empty(), "{:?}", launch.issues);
    assert_eq!(launch.hidden.len(), 1);
    assert_eq!(launch.hidden[0].runtime_executable.as_deref(), Some("yarn"));
    assert_eq!(launch.files, [PIARC_LAUNCH, CLAUDE_LAUNCH]);
}

#[test]
fn no_files_no_configs_and_verify_defaults_on() {
    let dir = Scratch::new("empty");
    let launch = load(dir.path());
    assert!(launch.configs.is_empty() && launch.issues.is_empty() && launch.files.is_empty());
    assert!(launch.hidden.is_empty());
    assert!(launch.auto_verify());
}

#[test]
fn paths_with_spaces_and_chinese_load() {
    let dir = Scratch::new("中文");
    let root = dir.path().join("项目 一");
    write(
        &root,
        PIARC_LAUNCH,
        "\u{feff}{\"configurations\":[{\"name\":\"站点\",\"program\":\"服务.js\",\"port\":8080}]}",
    );
    let launch = load(&root);
    assert!(launch.issues.is_empty(), "{:?}", launch.issues);
    assert_eq!(launch.configs[0].name, "站点");
    assert_eq!(launch.ports(), [8080]);
}

#[test]
fn quoting() {
    assert_eq!(quote("npm"), "npm");
    assert_eq!(quote("--port=3000"), "--port=3000");
    assert_eq!(quote("a b"), "'a b'");
    assert_eq!(quote("it's"), r"'it'\''s'");
    assert_eq!(quote(""), "''");
}
