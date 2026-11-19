//! A bounded, noninteractive opening snapshot. Project-configured programs must not run
//! when an untrusted workspace supplies context.
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_exec::{CommandRunner, CommandSpec, OutputChunk, ProcessTreeSpawner, Stream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const LIMIT: usize = 32 * 1024;

pub(super) async fn snapshot(root: PathBuf, cwd: PathBuf) -> String {
    let directory = cwd.clone();
    match tokio::task::spawn_blocking(move || piarc_git::resolve(&directory)).await {
        Ok(Ok(checkout)) if checkout.kind == piarc_git::CheckoutKind::NotGit => {
            return "Not a Git working tree.".into();
        }
        Ok(Ok(_)) => {}
        _ => return "Git status unavailable (repository metadata could not be read).".into(),
    }
    let Some(program) = git_program(&root) else {
        return "Git status unavailable (git executable not found).".into();
    };
    let config = [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(process|clean)$",
    ];
    let Some((exit, keys, false)) = run(&program, &cwd, config.map(OsString::from).to_vec()).await
    else {
        return "Git status unavailable (could not inspect Git filters).".into();
    };
    if !matches!(exit, 0 | 1) {
        return "Git status unavailable (invalid Git configuration).".into();
    }
    let mut args: Vec<OsString> = vec![];
    for key in keys.split('\0').filter(|key| !key.is_empty()) {
        args.extend(["-c".into(), format!("{key}=").into()]);
        if let Some((driver, _)) = key.rsplit_once('.') {
            args.extend(["-c".into(), format!("{driver}.required=false").into()]);
        }
    }
    args.extend(
        [
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.quotePath=false",
            "status",
            "--short",
            "--branch",
            "--ignore-submodules=all",
            "--no-ahead-behind",
        ]
        .map(Into::into),
    );
    match run(&program, &cwd, args).await {
        Some((0, status, truncated)) => {
            let mut text = status.trim_end().to_owned();
            if truncated {
                text.push_str("\n[Git status truncated]");
            }
            text
        }
        _ => "Git status unavailable (git status did not complete).".into(),
    }
}

fn git_program(root: &Path) -> Option<PathBuf> {
    let root = piarc_git::strip_verbatim(root.to_owned());
    let path = std::env::var_os("PATH")?;
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .filter_map(|dir| piarc_git::canonical(&dir.join(name)).ok())
        .find(|p| p.is_file() && !p.starts_with(&root))
}

async fn run(program: &Path, cwd: &Path, args: Vec<OsString>) -> Option<(i32, String, bool)> {
    let mut env: Vec<_> = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|v| (key.into(), v)))
        .collect();
    env.extend(
        [
            ("GIT_CONFIG_NOSYSTEM", "1"),
            (
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            ),
            ("GIT_OPTIONAL_LOCKS", "0"),
            ("GIT_NO_LAZY_FETCH", "1"),
            ("GIT_ALLOW_PROTOCOL", ""),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("LC_ALL", "C"),
        ]
        .map(|(k, v)| (k.into(), v.into())),
    );
    let spec = CommandSpec {
        program: program.to_owned(),
        args,
        cwd: cwd.to_owned(),
        env,
        launcher: None,
        timeout: Some(Duration::from_secs(3)),
        kill_grace: Duration::from_millis(100),
    };
    let runner = CommandRunner::new(Arc::new(ProcessTreeSpawner));
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(8);
    let collect = async {
        let mut output = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = rx.recv().await {
            if chunk.stream == Stream::Stdout {
                let n = chunk.bytes.len().min(LIMIT - output.len());
                output.extend_from_slice(&chunk.bytes[..n]);
                truncated |= n < chunk.bytes.len();
            }
        }
        (output, truncated)
    };
    let (exit, (out, truncated)) =
        tokio::join!(runner.run(spec, tx, CancellationToken::new()), collect);
    let exit = exit.ok()?;
    if exit.killed || exit.timed_out {
        return None;
    }
    Some((
        exit.status.code?,
        String::from_utf8_lossy(&out).into_owned(),
        truncated,
    ))
}
