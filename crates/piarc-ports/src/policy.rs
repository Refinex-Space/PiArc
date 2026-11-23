//! Where the operating system keeps an administrator's policy for an application (T47, design
//! addendum `T47-auto-memory-and-managed-settings.md` section 6): the directory of its managed
//! files and its managed-preference or registry document. Core reads managed settings only
//! through this port, so tests point it at temporary directories and never touch system
//! directories or `HKLM`.

use std::path::PathBuf;

/// Whose policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolicyProduct {
    /// PiArc's own (`cn.piarc.desktop`, `HKLM\SOFTWARE\Policies\PiArc`, `…/PiArc/`).
    Piarc,
    /// Claude Code's (`com.anthropic.claudecode`, `HKLM\SOFTWARE\Policies\ClaudeCode`,
    /// `…/ClaudeCode/`), read only.
    ClaudeCode,
}

/// A policy document the operating system delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyDocument {
    /// The file, or the registry value (`HKLM\SOFTWARE\Policies\PiArc\Settings`).
    pub location: PathBuf,
    /// Its content.
    pub body: PolicyBody,
}

/// The content of a [`PolicyDocument`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyBody {
    /// JSON text (a registry string value).
    Json(Vec<u8>),
    /// A property list file's bytes (binary or XML).
    PropertyList(Vec<u8>),
    /// The document exists but the operating system denied reading it.
    Unreadable(String),
}

/// The administrator's places for one product.
pub trait PolicyStore: Send + Sync {
    /// The directory of the product's managed files (`managed-settings.json`,
    /// `managed-settings.d/`, `CLAUDE.md`, `managed-mcp.json`); `None` where the platform has
    /// none or it cannot be found.
    fn files_dir(&self, product: PolicyProduct) -> Option<PathBuf>;

    /// The product's managed-preference or policy-key documents, highest precedence first
    /// (macOS: the user channel's file, then the device channel's; Windows: the `HKLM` value).
    /// Absent documents are left out.
    fn documents(&self, product: PolicyProduct) -> Vec<PolicyDocument>;
}
