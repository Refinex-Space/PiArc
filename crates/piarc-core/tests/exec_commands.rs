//! T17: shell commands through `ToolIo` without an Agent Host. The working directory carried
//! between commands and reset outside the workspace (A03), timeouts cut to the maximum (A04),
//! the output budget with the full text on disk (A05), 50 MB per pipe (A06), the meaning of
//! exit codes (A07), the environment without PiArc's variables (A08), and `exec/shells`.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{CommandEnv, ToolIo, ToolIoConfig};
use serde_json::{Map, Value, json};

struct Fixture {
    root: PathBuf,
    io: ToolIo,
}

impl Fixture {
    /// A workspace `ws 工作区` with `src/`, sibling directory `outside`, session `s`.
    fn new(name: &str, env: CommandEnv) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc exec {name} 中文 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        for dir in ["ws 工作区/src", "outside", "data"] {
            std::fs::create_dir_all(root.join(dir)).expect("dir created");
        }
        let io = ToolIo::new(ToolIoConfig {
            command_env: env,
            ..ToolIoConfig::new(root.join("data"))
        });
        let ws = root.join("ws 工作区");
        io.open_session("s", &ws, &ws).expect("session opens");
        Self { root, io }
    }

    fn ws(&self) -> PathBuf {
        std::fs::canonicalize(self.root.join("ws 工作区")).expect("canonical")
    }

    async fn run(&self, params: Value) -> Value {
        let (peer, mut frames) = Peer::channel(64);
        // Keep the live view flowing.
        let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });
        let mut params = object(params);
        params.insert("sessionId".into(), json!("s"));
        params
            .entry("requestId")
            .or_insert_with(|| json!(format!("r-{}", rand_suffix())));
        let result = self
            .io
            .dispatch("exec/run", params, peer)
            .await
            .expect("exec/run answers");
        drain.abort();
        result
    }

    async fn bash(&self, command: &str) -> Value {
        self.run(json!({ "command": command })).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("params must be an object: {other}"),
    }
}

fn head(result: &Value) -> String {
    result["output"]["head"]
        .as_str()
        .expect("output head")
        .to_owned()
}

/// How Core reports `path`: without the `\\?\` prefix canonical Windows paths carry.
fn shown(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\")
        .map_or(text.clone(), str::to_owned)
}

fn base_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            ["PATH", "HOME", "SystemRoot", "ProgramFiles", "TEMP", "TMP"]
                .iter()
                .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .collect()
}

#[tokio::test]
async fn cd_carries_over_inside_the_workspace_and_resets_outside() {
    let f = Fixture::new("cwd", CommandEnv::Fixed(base_env()));
    let ws = f.ws();
    let first = f.bash("cd src && echo moved").await;
    assert_eq!(first["cwd"], shown(&ws));
    assert!(first.get("cwdReset").is_none());
    // Git Bash's `pwd -P` may name a mount (`/tmp` is `%TEMP%`); `pwd -W` prints `C:/…`.
    let second = f
        .bash(if cfg!(windows) { "pwd -W" } else { "pwd -P" })
        .await;
    assert_eq!(second["cwd"], shown(&ws.join("src")));
    assert_eq!(head(&second).trim_end(), bash_pwd(&ws.join("src")));
    // Leaving the workspace: the next command starts at the root, and the result says why.
    let outside = f.bash("cd ../../outside").await;
    let reset = &outside["cwdReset"];
    assert_eq!(reset["reason"], "outsideWorkspace");
    assert_eq!(reset["resetTo"], shown(&ws));
    assert!(
        reset["endedIn"]
            .as_str()
            .expect("endedIn")
            .ends_with("outside"),
        "{reset}"
    );
    let back = f.bash("pwd -P").await;
    assert_eq!(back["cwd"], shown(&ws));
    // An explicit cwd runs there and does not move the remembered directory.
    let explicit = f
        .run(json!({ "command": "cd ..; pwd", "cwd": "src" }))
        .await;
    assert_eq!(explicit["cwd"], shown(&ws.join("src")));
    assert!(explicit.get("cwdReset").is_none());
    assert_eq!(f.bash("true").await["cwd"], shown(&ws));
    // A remembered directory that disappeared sends the next command to the root.
    f.bash("mkdir gone && cd gone").await;
    std::fs::remove_dir(ws.join("gone")).expect("removed");
    let missing = f.bash("pwd").await;
    assert_eq!(missing["cwdReset"]["reason"], "missing");
    assert_eq!(missing["cwd"], shown(&ws));
}

/// How bash prints `dir` with `pwd -P` (Git Bash: `/c/…`).
fn bash_pwd(dir: &std::path::Path) -> String {
    let text = shown(dir);
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text
    }
}

#[tokio::test]
async fn timeouts_report_the_limit_and_a_cut_request() {
    let f = Fixture::new("timeout", CommandEnv::Fixed(base_env()));
    let default = f.bash("true").await;
    assert_eq!(default["timeout"], json!({ "ms": 120_000 }));
    let cut = f
        .run(json!({ "command": "true", "timeoutMs": 900_000 }))
        .await;
    assert_eq!(
        cut["timeout"],
        json!({ "ms": 600_000, "requestedMs": 900_000 })
    );
    let started = Instant::now();
    let short = f
        .run(json!({ "command": "echo partial; sleep 30", "timeoutMs": 1000 }))
        .await;
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(short["timedOut"], true);
    assert_eq!(short["outcome"], "failure");
    assert_eq!(head(&short), "partial\n");
}

#[tokio::test]
async fn long_output_is_saved_and_previewed() {
    let f = Fixture::new("spill", CommandEnv::Fixed(base_env()));
    let lines = "for i in $(seq 1 4000); do printf 'line %05d 中文\\n' $i; done";
    let ok = f
        .run(json!({ "command": lines, "origin": { "tool": "Bash", "toolCallId": "toolu_long" } }))
        .await;
    let output = &ok["output"];
    assert_eq!(ok["outcome"], "success");
    assert_eq!(output["totalChars"], 4000 * 14);
    let preview = head(&ok) + output["tail"].as_str().expect("tail");
    assert!(
        preview.chars().count() <= 2000,
        "{}",
        preview.chars().count()
    );
    assert!(head(&ok).starts_with("line 00001 中文\n"));
    assert!(
        output["tail"]
            .as_str()
            .expect("tail")
            .ends_with("line 04000 中文\n")
    );
    let path = output["fullOutputPath"].as_str().expect("saved");
    assert!(path.ends_with("toolu_long.txt"), "{path}");
    let file = f
        .root
        .join("data/sessions/s/tmp/tool-results/toolu_long.txt");
    let full = std::fs::read_to_string(&file).expect("full output");
    assert_eq!(full.lines().count(), 4000);
    assert!(full.starts_with("line 00001 中文\n") && full.ends_with("line 04000 中文\n"));
    // A failure keeps a longer start and end.
    let failed = f.bash(&format!("{lines}; exit 3")).await;
    assert_eq!(failed["outcome"], "failure");
    let kept = head(&failed).chars().count()
        + failed["output"]["tail"]
            .as_str()
            .expect("tail")
            .chars()
            .count();
    assert!(kept > 25_000 && kept <= 30_000, "{kept}");
    // Short output stays whole and is not saved.
    let short = f.bash("echo short").await;
    assert_eq!(head(&short), "short\n");
    assert!(short["output"].get("fullOutputPath").is_none());
}

#[tokio::test]
async fn fifty_megabytes_on_each_pipe_finish() {
    let f = Fixture::new("50mb", CommandEnv::Fixed(base_env()));
    let mb50 = 50 * 1024 * 1024;
    let started = Instant::now();
    let result = f
        .run(json!({
            "command": format!("head -c {mb50} /dev/zero | tr '\\0' o & head -c {mb50} /dev/zero | tr '\\0' e >&2 & wait"),
            "origin": { "tool": "Bash", "toolCallId": "toolu_big" },
        }))
        .await;
    println!("100 MB through Core in {:?}", started.elapsed());
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["output"]["totalChars"], 2 * mb50);
    let file = f
        .root
        .join("data/sessions/s/tmp/tool-results/toolu_big.txt");
    assert_eq!(
        std::fs::metadata(file).expect("saved").len(),
        2 * mb50 as u64
    );
}

#[tokio::test]
async fn exit_codes_are_read_by_what_they_mean() {
    let f = Fixture::new("meaning", CommandEnv::Fixed(base_env()));
    std::fs::write(f.ws().join("a.txt"), "one\n").expect("a");
    std::fs::write(f.ws().join("b.txt"), "two\n").expect("b");
    let none = f.bash("grep missing a.txt").await;
    assert_eq!(
        (&none["exitCode"], &none["outcome"]),
        (&json!(1), &json!("success"))
    );
    assert_eq!(none["meaning"], "no matches");
    let differ = f.bash("diff a.txt b.txt").await;
    assert_eq!(differ["outcome"], "success");
    assert_eq!(differ["meaning"], "files differ");
    let broken = f.bash("grep missing no-such-file.txt").await;
    assert_eq!(
        (&broken["exitCode"], &broken["outcome"]),
        (&json!(2), &json!("failure"))
    );
    assert!(broken.get("meaning").is_none());
    let piped = f.bash("cat a.txt | grep missing").await;
    assert_eq!(piped["outcome"], "failure");
}

/// A command of about 21,000 characters with quotes and brackets reaches bash whole. Git
/// Bash parses its Windows command line itself and cut a 12,000-character `-c` argument short
/// (T25 hook, CI), so the command does not travel on the command line there.
#[tokio::test]
async fn a_long_command_with_quotes_and_brackets_runs_whole() {
    let f = Fixture::new("long", CommandEnv::Fixed(base_env()));
    let payload = format!("{{\"text\": \"{}\"}}", "quoted [x] (y) ".repeat(1400));
    let command = format!("printf '%s' '{payload}'; echo \" [${{PIARC_COMMAND:-unset}}]\"");
    assert!(command.len() > 20_000);
    let result = f.bash(&command).await;
    assert_eq!(result["exitCode"], 0, "{}", head(&result));
    assert_eq!(head(&result).trim_end(), format!("{payload} [unset]"));
}

#[tokio::test]
async fn the_environment_has_no_internal_variables() {
    let mut env = base_env();
    for (k, v) in [
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("NODE_OPTIONS", "--require /x.js"),
        ("PI_CODING_AGENT_DIR", "/data/pi"),
        ("PIARC_INTERNAL_PROBE", "1"),
        ("USER_OWN_VAR", "synthetic-secret"),
        ("LC_NUMERIC", "C"),
    ] {
        env.push((k.into(), v.into()));
    }
    let f = Fixture::new("env", CommandEnv::Fixed(env));
    let printed = head(&f.bash("env").await);
    for name in [
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "PI_CODING_AGENT_DIR",
        "PIARC_",
    ] {
        assert!(!printed.contains(name), "{name} in {printed}");
    }
    assert!(!printed.contains("USER_OWN_VAR="));
    assert!(!printed.contains("synthetic-secret"));
    assert!(printed.contains("LC_NUMERIC=C"));
}

/// An unsupported login shell forces the fallback on Unix. Windows directly uses the same
/// input as its process environment. The user's build locale survives either path.
#[tokio::test]
async fn inherited_private_variables_are_filtered_on_process_environment_fallback() {
    let mut base = base_env();
    base.extend([
        ("SHELL".into(), "unsupported-login-shell".into()),
        ("LC_NUMERIC".into(), "C".into()),
        ("R2_PRIVATE_SETTING".into(), "fixture-only".into()),
    ]);
    let f = Fixture::new("env-fallback", CommandEnv::LoginShell { base });
    let bash = f
        .bash(r#"printf '%s/%s' "$LC_NUMERIC" "${R2_PRIVATE_SETTING-unset}""#)
        .await;
    assert_eq!(head(&bash).trim(), "C/unset");

    #[cfg(windows)]
    {
        let powershell = f
            .run(json!({
                "shell":"powershell",
                "command":"Write-Output ($env:LC_NUMERIC + '/' + [bool]$env:R2_PRIVATE_SETTING)"
            }))
            .await;
        assert_eq!(head(&powershell).trim(), "C/False");
    }
}

/// The Agent Host asks while a session is still being created, before Core registered its
/// scope: the answer does not depend on a session (CI run 44116918422, Windows L4).
#[tokio::test]
async fn shells_are_reported_before_any_session_is_registered() {
    let f = Fixture::new("shells-early", CommandEnv::Fixed(base_env()));
    let (peer, _frames) = Peer::channel(4);
    let shells =
        f.io.dispatch(
            "exec/shells",
            object(json!({ "sessionId": "not-registered-yet" })),
            peer,
        )
        .await
        .expect("answers without a registered session");
    assert_eq!(shells["bash"], true);
    let (peer, _frames) = Peer::channel(4);
    let bare =
        f.io.dispatch("exec/shells", object(json!({})), peer)
            .await
            .expect("answers without a session id");
    assert_eq!(bare, shells);
}

#[tokio::test]
async fn shells_are_reported() {
    let f = Fixture::new("shells", CommandEnv::Fixed(base_env()));
    let (peer, _frames) = Peer::channel(4);
    let shells =
        f.io.dispatch("exec/shells", object(json!({ "sessionId": "s" })), peer)
            .await
            .expect("answers");
    assert_eq!(shells["bash"], true);
    assert_eq!(shells["powershell"], cfg!(windows));
    if !cfg!(windows) {
        let (peer, _frames) = Peer::channel(4);
        let error = f
            .io
            .dispatch(
                "exec/run",
                object(json!({ "sessionId": "s", "requestId": "ps", "command": "Get-Date", "shell": "powershell" })),
                peer,
            )
            .await
            .expect_err("no PowerShell");
        assert!(
            error.message.contains("only available on Windows"),
            "{error:?}"
        );
    }
}

#[cfg(windows)]
#[tokio::test]
async fn powershell_and_git_bash_print_chinese() {
    let f = Fixture::new("utf8", CommandEnv::Fixed(base_env()));
    let ps = f
        .run(json!({ "command": "Write-Output '中文输出'; [Console]::Error.WriteLine('错误')", "shell": "powershell" }))
        .await;
    println!("PowerShell: {ps}");
    assert_eq!(ps["outcome"], "success");
    assert!(head(&ps).contains("中文输出"), "{ps}");
    assert!(head(&ps).contains("错误"), "{ps}");
    let bash = f.bash("echo 中文输出; ls -d */").await;
    println!("Git Bash: {bash}");
    assert!(head(&bash).contains("中文输出"), "{bash}");
    // Git Bash prints `/c/...`: converted, the workspace subdirectory stays the cwd.
    f.bash("cd src").await;
    let inside = f.bash("pwd").await;
    assert_eq!(inside["cwd"], shown(&f.ws().join("src")));
    assert!(head(&inside).trim_end().starts_with('/'), "{inside}");
}
