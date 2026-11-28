//! In-app updates (ADR-0111): the Core API of the About page (`update*` functions of the NAPI
//! module) and its status snapshots on `core/updates`. Core reads the signed release manifest
//! of the latest GitHub release through the user's proxy, compares versions, downloads the
//! platform's artefacts and verifies them; the main process installs them.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Where the update flow stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// Nothing checked yet in this run.
    #[default]
    Idle,
    /// Reading the latest release.
    Checking,
    /// The running version is the latest.
    UpToDate,
    /// A newer release exists and nothing is downloaded yet.
    Available,
    /// The newer release is being downloaded.
    Downloading,
    /// The newer release is downloaded and verified: ready to install.
    Ready,
    /// The last check or download failed (`problem` says why).
    Failed,
}

/// Why updates cannot work in this build at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UpdateUnavailable {
    /// The build trusts no release key (ADR-0024 rule 5), so nothing can verify.
    NoTrustedKey,
    /// No artefact is published for this operating system and architecture.
    Platform,
}

/// A newer release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    /// SemVer of the release.
    pub version: String,
    /// Release date (`YYYY-MM-DD`).
    pub date: String,
    /// A security update (ADR-0018 rule 8).
    pub security: bool,
    /// Release notes in Markdown by locale (`en`, `zh-CN`); the client picks its language and
    /// falls back to `en`.
    pub notes: BTreeMap<String, String>,
    /// Bytes this platform downloads.
    pub size: u64,
    /// The release's page on GitHub.
    pub page_url: String,
}

/// Download progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// Bytes on disk.
    pub received: u64,
    /// Bytes in all.
    pub total: u64,
}

/// Why the last check or download failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProblem {
    /// Stable code: `network`, `proxy`, `tls`, `timeout`, `refused`, `integrity` (signature,
    /// size or hash), `notFound` (no release published yet), `disk`, `diskFull`, `cancelled`.
    pub code: String,
    /// Technical detail (English), shown under the localized reason.
    pub message: String,
}

/// The update flow's snapshot: answered by every `update*` call and sent on `core/updates`
/// whenever it changes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    /// The running version.
    pub current: String,
    /// Present when updates cannot work in this build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<UpdateUnavailable>,
    /// Milliseconds since the Unix epoch of the last completed check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<i64>,
    /// The newer release (`available`, `downloading`, `ready`, and `failed` after one was
    /// found).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<UpdateRelease>,
    /// While `downloading`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<UpdateProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<UpdateProblem>,
}

/// What the main process installs once the state is `ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", tag = "platform")]
pub enum UpdateInstall {
    /// The verified `PiArc-<version>-macos-<arch>.zip` (and the DMG's page for the manual way).
    Macos {
        version: String,
        /// Absolute path of the verified ZIP.
        archive: String,
    },
    /// The directory holding the verified `releases.win-<arch>.json` and its Full package: a
    /// Velopack `FileSource`.
    Windows {
        version: String,
        /// Absolute path of the directory.
        feed: String,
    },
}
