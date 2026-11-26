//! The Git panel (ADR-0084, ADR-0085): what the desktop client asks Core's `gitRequest` and
//! what it answers, and the `core/git` events of long operations.
//!
//! Every request names a session; Core runs git in that session's file root (the worktree of a
//! worktree session, else the workspace). Paths are relative to the repository's top level
//! with `/` separators, as git prints them. A reply carries either the operation's result or a
//! [`GitFailure`]: expected outcomes such as a rejected push are failures with a kind the
//! client acts on, not transport errors.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::diff::FileDiff;

/// One call of `gitRequest`: an optional operation id (for progress and cancel) and the
/// request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCall {
    /// Names the operation in `core/git` events and `cancelGit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_id: Option<String>,
    /// What to do.
    pub request: GitRequest,
}

/// A range of changes the panel shows (ADR-0084 rule 1). The session scope is not a Git
/// range: the client reads it from `sessionChanges`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitScope {
    /// From the merge base of `base` and `HEAD` to the working tree, untracked files included.
    Branch {
        /// The branch to compare against; inferred when absent (ADR-0084 rule 2).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    /// From `HEAD` (the empty tree in a repository without commits) to the working tree.
    Uncommitted,
    /// One commit against its first parent.
    Commit {
        /// The full commit id.
        sha: String,
    },
}

/// Which content of a file to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitTextSource {
    /// The file in a commit (a full id, or `HEAD`).
    Commit {
        /// The commit.
        rev: String,
    },
    /// The file in the index.
    Index,
    /// The file on disk.
    Worktree,
}

/// Which side of a file's uncommitted change a hunk belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitStage {
    /// `HEAD` to the index.
    Staged,
    /// The index to the working tree.
    Unstaged,
}

/// Names one hunk the client showed (ADR-0085 rule 4): Core regenerates the patch and acts
/// only when every value still matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkRef {
    /// The file.
    pub path: String,
    /// The side the hunk was shown on.
    pub stage: GitStage,
    /// Its index in that side's hunks.
    pub index: u64,
    /// [`GitFileStages::hunk_hashes`] at that index.
    pub hash: String,
    /// [`GitFileStages::worktree_hash`] when it was shown.
    pub worktree_hash: String,
    /// [`GitFileStages::index_oid`] when it was shown.
    pub index_oid: String,
}

/// How a checkout treats local changes it would overwrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitCheckoutMode {
    /// Refuse and report the files.
    #[default]
    Normal,
    /// Stash them, check out, and restore them.
    Smart,
    /// Discard them (confirmed natively).
    Force,
}

/// How a pull integrates the upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitPullMode {
    /// Whatever the repository's `pull.rebase` and `pull.ff` say.
    Config,
    /// `--no-rebase`.
    Merge,
    /// `--rebase`.
    Rebase,
    /// `--ff-only`.
    FfOnly,
}

/// Where a first push goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitPushTarget {
    /// A configured remote's name.
    pub remote: String,
    /// The branch name on the remote.
    pub branch: String,
}

/// The language of a generated commit message (the client's interface language).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum GitLanguage {
    /// English.
    #[serde(rename = "en")]
    English,
    /// Simplified Chinese.
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
}

/// What a native confirmation describes before a destructive operation (ADR-0085 rule 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitDescribe {
    /// Rolling back files to `HEAD`.
    Rollback {
        /// The files.
        paths: Vec<String>,
    },
    /// Rolling back one unstaged hunk.
    RollbackHunk {
        /// The hunk.
        hunk: GitHunkRef,
    },
    /// Force-pushing the current branch.
    ForcePush {
        /// The target of a first push.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<GitPushTarget>,
    },
    /// Deleting a branch that is not fully merged.
    DeleteBranch {
        /// The branch.
        name: String,
    },
    /// A checkout that discards local changes.
    ForceCheckout {
        /// The branch or revision.
        target: String,
    },
}

/// A request of `gitRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitRequest {
    /// The repository's fingerprint: cheap, polled while the panel is visible.
    Probe,
    /// Branch, upstream, state and the changed files ([`GitStatus`]).
    Status,
    /// The files and diffs of a scope ([`GitChanges`]).
    Changes {
        /// The range.
        scope: GitScope,
        /// Ignore whitespace (`-w`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ignore_whitespace: Option<bool>,
    },
    /// One file's diff in a scope, when [`GitChanges::withheld`] left it out ([`GitFileChange`]).
    FileDiff {
        /// The range.
        scope: GitScope,
        /// The file.
        path: String,
        /// Its previous path, for a rename.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_path: Option<String>,
        /// Ignore whitespace.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ignore_whitespace: Option<bool>,
    },
    /// One file's complete text, to expand unchanged lines ([`GitText`]).
    FileText {
        /// Which content.
        source: GitTextSource,
        /// The file.
        path: String,
    },
    /// The commits of `base..HEAD` ([`GitCommits`]).
    Commits {
        /// The base branch; inferred when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    /// Local and remote branches ([`GitBranches`]).
    Branches,
    /// The staged and unstaged diffs of one file, for the commit view ([`GitFileStages`]).
    FileStages {
        /// The file.
        path: String,
    },
    /// Stage whole files.
    Stage {
        /// The files.
        paths: Vec<String>,
    },
    /// Unstage whole files.
    Unstage {
        /// The files.
        paths: Vec<String>,
    },
    /// Stage one unstaged hunk.
    StageHunk {
        /// The hunk.
        hunk: GitHunkRef,
    },
    /// Unstage one staged hunk.
    UnstageHunk {
        /// The hunk.
        hunk: GitHunkRef,
    },
    /// Roll back one unstaged hunk in the working tree (confirmed natively).
    RollbackHunk {
        /// The hunk.
        hunk: GitHunkRef,
    },
    /// Roll back files to `HEAD`, index and working tree (confirmed natively).
    Rollback {
        /// The files.
        paths: Vec<String>,
    },
    /// Undo a rollback ([`GitOpResult::restore_id`]).
    UndoRollback {
        /// The rollback.
        restore_id: String,
    },
    /// Commit the index.
    Commit {
        /// The message.
        message: String,
        /// Replace the last commit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amend: Option<bool>,
        /// Add a `Signed-off-by` trailer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signoff: Option<bool>,
    },
    /// The last commit's message and whether its upstream has it ([`GitLastCommit`]).
    LastCommit,
    /// Generate a commit message from the staged changes ([`GitCommitMessage`], ADR-0086).
    CommitMessage {
        /// The interface language; the main process fills it.
        language: GitLanguage,
        /// The commit instructions.
        instructions: String,
        /// Describe the last commit plus the staged changes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amend: Option<bool>,
    },
    /// Check out a branch or revision.
    Checkout {
        /// A local branch, a remote branch (`origin/x`), a tag or a commit.
        target: String,
        /// What to do with local changes in the way.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<GitCheckoutMode>,
    },
    /// Create a branch.
    CreateBranch {
        /// Its name.
        name: String,
        /// Where it starts; `HEAD` when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<String>,
        /// Check it out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkout: Option<bool>,
    },
    /// Rename a local branch.
    RenameBranch {
        /// The current name.
        from: String,
        /// The new name.
        to: String,
    },
    /// Delete a local branch; `force` deletes one that is not fully merged (confirmed
    /// natively).
    DeleteBranch {
        /// The branch.
        name: String,
        /// `-D`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        force: Option<bool>,
    },
    /// Recreate a deleted branch.
    RestoreBranch {
        /// The branch.
        name: String,
        /// The commit it pointed at.
        oid: String,
        /// Its upstream (`origin/x`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream: Option<String>,
    },
    /// Set (or, without `upstream`, unset) a local branch's upstream.
    SetUpstream {
        /// The local branch.
        branch: String,
        /// The remote branch (`origin/x`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream: Option<String>,
    },
    /// Fetch every remote, pruning.
    Fetch,
    /// Pull into the current branch.
    Pull {
        /// How to integrate; the user setting when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<GitPullMode>,
    },
    /// Push the current branch.
    Push {
        /// A first push's target.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<GitPushTarget>,
        /// Force with lease (confirmed natively).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        force: Option<bool>,
        /// The remote commit the confirmation showed ([`GitDescription::remote_oid`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect: Option<String>,
    },
    /// Continue the merge, rebase, cherry-pick or revert in progress.
    Continue,
    /// Abort it.
    Abort,
    /// Skip the current commit of a rebase.
    Skip,
    /// Mark conflicted files resolved.
    MarkResolved {
        /// The files.
        paths: Vec<String>,
    },
    /// The facts a native confirmation shows ([`GitDescription`]).
    Describe {
        /// The operation.
        action: GitDescribe,
    },
}

/// The status of a file in a diff or on one side of `git status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitFileStatus {
    /// New.
    Added,
    /// Changed.
    Modified,
    /// Removed.
    Deleted,
    /// Moved (with or without changes).
    Renamed,
    /// Copied.
    Copied,
    /// A file became a link or the reverse.
    TypeChanged,
    /// Not tracked.
    Untracked,
    /// Unmerged.
    Conflicted,
}

/// What the repository is in the middle of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitRepoState {
    /// Nothing.
    Clean,
    /// A merge stopped for conflicts or a commit.
    Merging {
        /// What is merged (`MERGE_MSG`'s branch, when known).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    /// A rebase.
    Rebasing {
        /// The branch being rebased.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        /// The commit it goes onto (short).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        onto: Option<String>,
        /// The current step, 1-based.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<u64>,
        /// The number of steps.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    /// A cherry-pick.
    CherryPicking {
        /// The commit (short).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
    },
    /// A revert.
    Reverting {
        /// The commit (short).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
    },
}

/// One entry of `git status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusFile {
    /// The file.
    pub path: String,
    /// Its previous path, for a rename or copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// The change from `HEAD` to the index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<GitFileStatus>,
    /// The change from the index to the working tree (`untracked` for an untracked file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstaged: Option<GitFileStatus>,
    /// The two-letter conflict code (`UU`, `AA`, `DU`…), for an unmerged file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// A submodule (gitlink): shown, not acted on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submodule: Option<bool>,
    /// Lines added from `HEAD` to the working tree; absent for binary files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    /// Lines removed from `HEAD` to the working tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u64>,
}

/// The branch a Git scope compares against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitBase {
    /// The branch as shown (`main`).
    pub name: String,
    /// The ref resolved (`refs/remotes/origin/main` or `refs/heads/main`).
    pub reference: String,
    /// The merge base with `HEAD`, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_base: Option<String>,
}

/// The repository of a session's file root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    /// The top level of the working tree, absolute.
    pub root: String,
    /// The current branch; absent on a detached `HEAD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The commit `HEAD` names; absent before the first commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// `HEAD` is detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    /// The branch's upstream (`origin/main`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits ahead of the upstream.
    pub ahead: u64,
    /// Commits behind the upstream.
    pub behind: u64,
    /// An operation in progress.
    pub state: GitRepoState,
    /// The configured remotes' names.
    pub remotes: Vec<String>,
    /// The inferred base branch of the branch scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<GitBase>,
    /// Write operations are allowed: the project is trusted (ADR-0085 rule 2).
    pub writable: bool,
    /// Protected from force pushes (the user setting).
    pub protected: bool,
    /// Lines added across the uncommitted changes.
    pub added: u64,
    /// Lines removed across them.
    pub removed: u64,
}

/// `status`: the repository and its uncommitted files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The repository; absent outside one (see [`GitFailure`] for why).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<GitRepository>,
    /// The changed files, conflicts first, then by path.
    pub files: Vec<GitStatusFile>,
    /// More than the limit of entries: the list stops there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// The repository fingerprint, as `probe` returns it.
    pub fingerprint: String,
}

/// `probe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    /// Changes when `HEAD`, the index, refs or an operation in progress change.
    pub fingerprint: String,
}

/// One file of a scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// The file.
    pub path: String,
    /// Its previous path, for a rename or copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// How it changed.
    pub status: GitFileStatus,
    /// Lines added; absent for binary files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    /// Lines removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u64>,
    /// Binary on either side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// The mode before (`100644`), when it changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_mode: Option<String>,
    /// The mode after, when it changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_mode: Option<String>,
    /// A submodule (gitlink).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submodule: Option<bool>,
    /// The diff; absent for binary files and when withheld.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<FileDiff>,
}

/// `changes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    /// The range answered (a branch scope names its base; a branch scope without a merge base
    /// becomes `uncommitted`).
    pub scope: GitScope,
    /// The base of a branch scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<GitBase>,
    /// The files in path order.
    pub files: Vec<GitFileChange>,
    /// Lines added across them.
    pub added: u64,
    /// Lines removed across them.
    pub removed: u64,
    /// Too many files, lines or bytes: diffs are left out, fetch each with `fileDiff`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withheld: Option<bool>,
    /// More files than the limit: the list stops there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// `fileText`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitText {
    /// The text (decoded as UTF-8, lossily); absent when the file does not exist there, is
    /// binary or too large.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// Larger than the limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub too_large: Option<bool>,
}

/// One commit of `commits`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRow {
    /// The full id.
    pub sha: String,
    /// The abbreviated id.
    pub short: String,
    /// The first line of the message.
    pub subject: String,
    /// The author's name.
    pub author: String,
    /// Commit time, Unix seconds.
    pub time: u64,
}

/// `commits`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommits {
    /// The base used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<GitBase>,
    /// The newest commits first, at most 100.
    pub commits: Vec<GitCommitRow>,
    /// How many commits `base..HEAD` has.
    pub total: u64,
}

/// A local branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalBranch {
    /// Its name.
    pub name: String,
    /// The commit it names.
    pub oid: String,
    /// Its upstream (`origin/x`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits ahead of the upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    /// Commits behind the upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    /// The upstream is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<bool>,
    /// The current branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
    /// Checked out in another worktree (its path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Last commit time, Unix seconds.
    pub time: u64,
}

/// A remote-tracking branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteBranch {
    /// The remote.
    pub remote: String,
    /// The branch name without the remote (`x` of `origin/x`).
    pub name: String,
    /// The commit it names.
    pub oid: String,
    /// Last commit time, Unix seconds.
    pub time: u64,
}

/// `branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    /// Local branches by name.
    pub local: Vec<GitLocalBranch>,
    /// Remote-tracking branches by remote and name (`HEAD` pointers left out).
    pub remote: Vec<GitRemoteBranch>,
    /// Recently checked-out local branches, newest first, the current one left out.
    pub recent: Vec<String>,
    /// The configured remotes.
    pub remotes: Vec<String>,
}

/// `fileStages`: one file's uncommitted change in two parts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStages {
    /// The file.
    pub path: String,
    /// `HEAD` to the index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<FileDiff>,
    /// The index to the working tree (for an untracked file: everything).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstaged: Option<FileDiff>,
    /// Hashes naming each staged hunk.
    pub staged_hashes: Vec<String>,
    /// Hashes naming each unstaged hunk.
    pub hunk_hashes: Vec<String>,
    /// SHA-256 of the file on disk (`absent` when there is none).
    pub worktree_hash: String,
    /// The index entry's object id (`absent` when not in the index).
    pub index_oid: String,
    /// Binary on some side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// Hunk actions are available (not binary, no filter attribute, not only a mode change).
    pub hunk_actions: bool,
}

/// `lastCommit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitLastCommit {
    /// The message; absent before the first commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The upstream already has the commit: amending it needs a force push.
    pub pushed: bool,
}

/// `commitMessage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitMessage {
    /// The message.
    pub text: String,
    /// The model that wrote it.
    pub model: String,
    /// The auxiliary model was unavailable and the session's model wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<bool>,
    /// Files sent by path only.
    pub withheld: Vec<String>,
}

/// A deleted branch, for "Restore".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitDeletedBranch {
    /// The branch.
    pub name: String,
    /// The commit it named.
    pub oid: String,
    /// Its upstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

/// What a write operation did.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    /// `HEAD` afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// The new commit's subject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// The rollback to undo with `undoRollback`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_id: Option<String>,
    /// The deleted branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<GitDeletedBranch>,
    /// A smart checkout's stash kept after conflicts (`stash@{0}` and its message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_stash: Option<String>,
    /// Files left conflicted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
    /// Output worth showing (hook messages), redacted and cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// `describe`: the facts a native confirmation shows, read by Core.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitDescription {
    /// The branch concerned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The remote concerned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The remote branch's commit the force push replaces (the lease).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_oid: Option<String>,
    /// The local commit pushed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_oid: Option<String>,
    /// Commits a deleted branch has that its upstream or `HEAD` lacks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmerged: Option<u64>,
    /// The files affected.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Refused before asking (a protected branch, nothing to do).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<GitFailure>,
}

/// Why an operation did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitFailureKind {
    /// The file root is not in a repository.
    NotRepo,
    /// No git program was found.
    GitMissing,
    /// The project is not trusted: write operations wait for trust.
    Untrusted,
    /// A session in the same file root is running a turn.
    SessionBusy,
    /// The file or index changed since the client showed it.
    Stale,
    /// Another git process holds the repository's lock.
    Busy,
    /// The remote refused the credentials, or git needed to ask for them.
    Auth,
    /// The remote has commits the local branch lacks.
    Rejected,
    /// The remote moved since the last fetch: the lease failed.
    StaleLease,
    /// Force pushes to this branch are not allowed.
    Protected,
    /// Local changes would be overwritten (`paths`).
    LocalChanges,
    /// Untracked files would be overwritten (`paths`).
    UntrackedOverwritten,
    /// The operation stopped with conflicts (`paths`).
    Conflict,
    /// The branch has no upstream.
    NoUpstream,
    /// The branches diverged and no pull strategy is configured.
    ChoosePullMode,
    /// `user.name` or `user.email` is not set.
    Identity,
    /// Nothing staged to commit.
    NothingToCommit,
    /// A hook refused (`message` holds its output).
    HookFailed,
    /// The branch is checked out in another worktree.
    InOtherWorktree,
    /// Not fully merged: deleting needs force.
    NotMerged,
    /// No model can generate the message.
    NoModel,
    /// A request member is not acceptable.
    Invalid,
    /// The user cancelled.
    Cancelled,
    /// It ran past its time limit.
    TimedOut,
    /// Anything else (`message` holds git's words, redacted).
    Failed,
}

/// A failed operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFailure {
    /// Why.
    pub kind: GitFailureKind,
    /// A short description (git's words, redacted and cut).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Files concerned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Titles of the sessions that are busy.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<String>,
    /// The equivalent command, for "Run in terminal" after an authentication failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl GitFailure {
    /// A failure of `kind` with `message`.
    #[must_use]
    pub fn new(kind: GitFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: Some(message.into()),
            paths: Vec::new(),
            sessions: Vec::new(),
            command: None,
        }
    }

    /// A failure of `kind` without a message.
    #[must_use]
    pub fn of(kind: GitFailureKind) -> Self {
        Self {
            kind,
            message: None,
            paths: Vec::new(),
            sessions: Vec::new(),
            command: None,
        }
    }
}

/// A `core/git` event of a long operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GitEvent {
    /// Progress git reported.
    Progress {
        /// The session.
        session_id: String,
        /// The operation ([`GitCall::op_id`]).
        op_id: String,
        /// What git is doing (`Receiving objects`).
        phase: String,
        /// Percent done, when git reports it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        percent: Option<u64>,
    },
    /// The repository changed because of an operation: clients of the same file root refresh.
    Changed {
        /// The repository's top level.
        root: String,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn request_fields_are_camel_case_on_the_wire() {
        let request: GitRequest = serde_json::from_value(json!({
            "op": "undoRollback",
            "restoreId": "r-1",
        }))
        .expect("undoRollback");
        assert_eq!(request, GitRequest::UndoRollback { restore_id: "r-1".into() });
        let request: GitRequest = serde_json::from_value(json!({
            "op": "fileDiff",
            "scope": { "kind": "uncommitted" },
            "path": "b.txt",
            "oldPath": "a.txt",
            "ignoreWhitespace": true,
        }))
        .expect("fileDiff");
        assert_eq!(
            request,
            GitRequest::FileDiff {
                scope: GitScope::Uncommitted,
                path: "b.txt".into(),
                old_path: Some("a.txt".into()),
                ignore_whitespace: Some(true),
            }
        );
    }

    #[test]
    fn progress_events_are_camel_case_on_the_wire() {
        let event = GitEvent::Progress {
            session_id: "s".into(),
            op_id: "op".into(),
            phase: "Receiving objects".into(),
            percent: Some(40),
        };
        assert_eq!(
            serde_json::to_value(&event).expect("event"),
            json!({
                "type": "progress",
                "sessionId": "s",
                "opId": "op",
                "phase": "Receiving objects",
                "percent": 40,
            })
        );
    }
}
