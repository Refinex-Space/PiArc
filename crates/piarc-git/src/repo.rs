//! The repository of a session's file root and the two ways the panel runs git in it
//! (ADR-0085 rules 1 to 3): [`Reader`] for the queries the panel makes on its own, with every
//! program-running key overridden on the command line, and [`Writer`] for operations the user
//! clicked, with the user's configuration.

use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::exec::{ExecOptions, ExecOutput, READ_TIMEOUT};
use crate::git::{Git, GitError};

/// The null device: `core.hooksPath` pointing at it finds no hook.
#[must_use]
pub fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// Command-line overrides on every read-only query: they rank above the repository's own
/// configuration and its includes.
fn fixed_overrides() -> Vec<OsString> {
    let hooks = format!("core.hooksPath={}", null_device());
    let keys = [
        "core.fsmonitor=false",
        hooks.as_str(),
        "log.showSignature=false",
        "core.pager=cat",
        "gc.auto=0",
        "maintenance.auto=false",
        "core.quotePath=false",
    ];
    keys.iter()
        .flat_map(|key| [OsString::from("-c"), OsString::from(*key)])
        .collect()
}

/// Where a working tree's repository lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// The top level of the working tree.
    pub root: PathBuf,
    /// This working tree's git directory.
    pub git_dir: PathBuf,
    /// The repository's common git directory (the main one for a linked worktree).
    pub common_dir: PathBuf,
}

impl Repo {
    /// Changes when `HEAD`, the index, refs, the reflog, a fetch or an operation in progress
    /// change; read from file metadata without starting git.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let mut out = String::new();
        let local = [
            "HEAD",
            "index",
            "ORIG_HEAD",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
        ];
        let local_more = ["REVERT_HEAD", "logs/HEAD", "rebase-merge", "rebase-apply"];
        for name in local.iter().chain(local_more.iter()) {
            stamp(&mut out, &self.git_dir.join(name));
        }
        for name in [
            "packed-refs",
            "FETCH_HEAD",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ] {
            stamp(&mut out, &self.common_dir.join(name));
        }
        out
    }
}

fn stamp(out: &mut String, path: &Path) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            let _ = write!(out, "{}:{modified};", meta.len());
        }
        Err(_) => out.push_str("-;"),
    }
}

/// Runs the panel's read-only queries in one repository.
#[derive(Debug, Clone)]
pub struct Reader {
    git: Git,
    /// The repository.
    pub repo: Repo,
    overrides: Vec<OsString>,
}

impl Reader {
    /// The repository containing `cwd`, with the filter drivers of its configuration
    /// neutralized; `None` outside a working tree.
    ///
    /// # Errors
    ///
    /// The runner's errors; [`GitError::Failed`] when git refuses the repository (for
    /// example its ownership).
    pub async fn open(git: Git, cwd: &Path) -> Result<Option<Self>, GitError> {
        let fixed = fixed_overrides();
        let Some(repo) = discover(&git, cwd, &fixed).await? else {
            return Ok(None);
        };
        let mut overrides = fixed.clone();
        overrides.extend(filter_overrides(&git, &repo.root, &fixed).await?);
        Ok(Some(Self {
            git,
            repo,
            overrides,
        }))
    }

    /// Runs `git <overrides> <args>` in the top level.
    ///
    /// # Errors
    ///
    /// The errors of [`Git::exec`].
    pub async fn run<S: AsRef<OsStr>>(
        &self,
        args: &[S],
        mut options: ExecOptions,
    ) -> Result<ExecOutput, GitError> {
        options.timeout.get_or_insert(READ_TIMEOUT);
        let full: Vec<OsString> = self
            .overrides
            .iter()
            .cloned()
            .chain(args.iter().map(|a| a.as_ref().to_owned()))
            .collect();
        self.git.exec(&self.repo.root, &full, options).await
    }

    /// Runs `args` and returns stdout when git exits with 0.
    ///
    /// # Errors
    ///
    /// The errors of [`Reader::run`] and [`GitError::Failed`].
    pub async fn ok<S: AsRef<OsStr>>(&self, args: &[S]) -> Result<Vec<u8>, GitError> {
        let output = self.run(args, ExecOptions::default()).await?;
        if output.success() {
            Ok(output.stdout)
        } else {
            Err(failed(args, &output))
        }
    }
}

impl Reader {
    /// The commit `HEAD` names; `None` before the first commit.
    ///
    /// # Errors
    ///
    /// The runner's errors.
    pub async fn repo_head(&self) -> Result<Option<String>, GitError> {
        let out = self
            .run(
                &["rev-parse", "--verify", "--quiet", "HEAD"],
                ExecOptions::default(),
            )
            .await?;
        Ok(out
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()))
    }

    /// Which of `paths` `HEAD` has.
    ///
    /// # Errors
    ///
    /// The runner's errors.
    pub async fn in_head(
        &self,
        paths: &[String],
    ) -> Result<std::collections::HashSet<String>, GitError> {
        let mut found = std::collections::HashSet::new();
        if self.repo_head().await?.is_none() {
            return Ok(found);
        }
        for chunk in paths.chunks(200) {
            let mut args = vec!["ls-tree", "-r", "-z", "--name-only", "HEAD", "--"];
            args.extend(chunk.iter().map(String::as_str));
            let out = self.ok(&args).await?;
            found.extend(
                String::from_utf8_lossy(&out)
                    .split('\0')
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned),
            );
        }
        Ok(found)
    }

    /// The commit of remote-tracking branch `remote/branch`, the lease of a force push.
    ///
    /// # Errors
    ///
    /// The runner's errors.
    pub async fn tracking_oid(
        &self,
        remote: &str,
        branch: &str,
    ) -> Result<Option<String>, GitError> {
        let reference = format!("refs/remotes/{remote}/{branch}");
        let out = self
            .run(
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    &reference,
                ],
                ExecOptions::default(),
            )
            .await?;
        Ok(out
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()))
    }

    /// Tracked files whose working tree or index differs from `HEAD`.
    ///
    /// # Errors
    ///
    /// The runner's errors.
    pub async fn changed_tracked(&self) -> Result<Vec<String>, GitError> {
        if self.repo_head().await?.is_none() {
            return Ok(Vec::new());
        }
        let out = self
            .ok(&[
                "diff",
                "--name-only",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
            ])
            .await?;
        Ok(String::from_utf8_lossy(&out)
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect())
    }
}

/// Runs the user's write operations in one repository (trusted projects only, decided by
/// Core).
#[derive(Debug, Clone)]
pub struct Writer {
    git: Git,
    /// The repository.
    pub repo: Repo,
}

impl Writer {
    /// A writer for `repo` with `git` (the user-mode environment).
    #[must_use]
    pub fn new(git: Git, repo: Repo) -> Self {
        Self { git, repo }
    }

    /// Runs `git -c core.quotePath=false <args>` in the top level.
    ///
    /// # Errors
    ///
    /// The errors of [`Git::exec`].
    pub async fn run<S: AsRef<OsStr>>(
        &self,
        args: &[S],
        options: ExecOptions,
    ) -> Result<ExecOutput, GitError> {
        let full: Vec<OsString> = ["-c", "core.quotePath=false"]
            .iter()
            .map(OsString::from)
            .chain(args.iter().map(|a| a.as_ref().to_owned()))
            .collect();
        self.git.exec(&self.repo.root, &full, options).await
    }

    /// The same writer with pathspec magic allowed, for commands that pass no path of the
    /// page's and use magic themselves (`stash push -u` cleans with `:/`).
    #[must_use]
    pub fn with_pathspec_magic(&self) -> Self {
        Self {
            git: self.git.clone().with_env("GIT_LITERAL_PATHSPECS", "0"),
            repo: self.repo.clone(),
        }
    }

    /// Like [`Writer::run`] for commands that reach a remote: the `ext::` transport (which
    /// runs a command) is refused whatever the configuration says.
    ///
    /// # Errors
    ///
    /// The errors of [`Git::exec`].
    pub async fn network<S: AsRef<OsStr>>(
        &self,
        args: &[S],
        options: ExecOptions,
    ) -> Result<ExecOutput, GitError> {
        let full: Vec<OsString> = ["-c", "protocol.ext.allow=never"]
            .iter()
            .map(OsString::from)
            .chain(args.iter().map(|a| a.as_ref().to_owned()))
            .collect();
        self.run(&full, options).await
    }
}

/// The failure of `args` given its output.
pub(crate) fn failed<S: AsRef<OsStr>>(args: &[S], output: &ExecOutput) -> GitError {
    GitError::Failed {
        command: crate::git::subcommand(args),
        code: output.code,
        stderr: output.stderr.clone(),
    }
}

async fn discover(git: &Git, cwd: &Path, fixed: &[OsString]) -> Result<Option<Repo>, GitError> {
    let mut args = fixed.to_vec();
    args.extend(
        [
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ]
        .map(OsString::from),
    );
    let output = git
        .exec(cwd, &args, ExecOptions::timeout(READ_TIMEOUT))
        .await?;
    if !output.success() {
        let stderr = output.stderr.to_ascii_lowercase();
        if stderr.contains("not a git repository") || stderr.contains("must be run in a work tree")
        {
            return Ok(None);
        }
        return Err(failed(&args, &output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let (Some(root), Some(git_dir), Some(common)) = (lines.next(), lines.next(), lines.next())
    else {
        return Ok(None);
    };
    let common = Path::new(common);
    let common = if common.is_absolute() {
        common.to_owned()
    } else {
        cwd.join(common)
    };
    let tidy = |path: PathBuf| crate::canonical(&path).unwrap_or(path);
    Ok(Some(Repo {
        root: tidy(PathBuf::from(root)),
        git_dir: tidy(PathBuf::from(git_dir)),
        common_dir: tidy(common),
    }))
}

/// `-c filter.<driver>.<clean|smudge|process>=` and `required=false` for every driver the
/// configuration (system, global, repository and includes) defines.
async fn filter_overrides(
    git: &Git,
    root: &Path,
    fixed: &[OsString],
) -> Result<Vec<OsString>, GitError> {
    let mut args = fixed.to_vec();
    args.extend(
        [
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process)$",
        ]
        .map(OsString::from),
    );
    let output = git
        .exec(root, &args, ExecOptions::timeout(READ_TIMEOUT))
        .await?;
    match output.code {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => return Err(failed(&args, &output)),
    }
    let mut overrides = Vec::new();
    let mut drivers: Vec<String> = Vec::new();
    for key in String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|key| !key.is_empty())
    {
        overrides.extend([OsString::from("-c"), OsString::from(format!("{key}="))]);
        if let Some((driver, _)) = key.rsplit_once('.')
            && !drivers.iter().any(|d| d == driver)
        {
            drivers.push(driver.to_owned());
        }
    }
    for driver in drivers {
        overrides.extend([
            OsString::from("-c"),
            OsString::from(format!("{driver}.required=false")),
        ]);
    }
    Ok(overrides)
}
