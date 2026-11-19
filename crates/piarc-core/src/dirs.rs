//! The data and cache directories (architecture section 9.1). The main process computes them
//! (`apps/desktop/src/main/platform/data-dirs.ts`) and passes them in [`CoreConfig`]; Core
//! creates the layout below them.
//!
//! [`CoreConfig`]: crate::CoreConfig

use std::io;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// The directories Core keeps its state in, and the home directory it reads Claude Code's user
/// files from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirs {
    data: PathBuf,
    cache: PathBuf,
    home: Option<PathBuf>,
}

impl DataDirs {
    /// Both paths must be absolute.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a relative path.
    pub fn new(data: PathBuf, cache: PathBuf) -> Result<Self> {
        for (field, path) in [("dataDir", &data), ("cacheDir", &cache)] {
            if !path.is_absolute() {
                return Err(Error::InvalidArgument {
                    field,
                    reason: "must be an absolute path".into(),
                });
            }
        }
        Ok(Self {
            data,
            cache,
            home: None,
        })
    }

    /// The same directories with the home directory Claude Code's user files are read from
    /// (`CoreConfig::home`, set when Core starts).
    #[must_use]
    pub fn with_home(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    /// The home directory; `None` reads no user-level Claude Code file.
    #[must_use]
    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// The settings layers of `workspace`: PiArc's and Claude Code's (ADR-0005). Every Core
    /// consumer of settings uses this table.
    #[must_use]
    pub fn layers(&self, workspace: &Path) -> piarc_config::LayerTable {
        piarc_config::LayerTable::workspace(&self.data, workspace, self.home())
    }

    /// The data directory.
    #[must_use]
    pub fn data(&self) -> &Path {
        &self.data
    }

    /// The cache directory (discardable).
    #[must_use]
    pub fn cache(&self) -> &Path {
        &self.cache
    }

    /// `core.sqlite`.
    #[must_use]
    pub fn database(&self) -> PathBuf {
        self.data.join("core.sqlite")
    }

    /// Pi's agent directory `pi/` (SDK `agentDir`, `PI_CODING_AGENT_DIR`).
    #[must_use]
    pub fn pi(&self) -> PathBuf {
        self.data.join("pi")
    }

    /// Pi's session files, `pi/sessions/`.
    #[must_use]
    pub fn pi_sessions(&self) -> PathBuf {
        self.pi().join("sessions")
    }

    /// Per-session working files, `sessions/`.
    #[must_use]
    pub fn sessions(&self) -> PathBuf {
        self.data.join("sessions")
    }

    /// `logs/`.
    #[must_use]
    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }

    /// The user's PiArc settings, `settings.json`.
    #[must_use]
    pub fn user_settings(&self) -> PathBuf {
        self.data.join("settings.json")
    }

    /// Creates the layout of architecture section 9.1 (existing directories are kept).
    ///
    /// # Errors
    ///
    /// The I/O error of the first directory that cannot be created.
    pub fn create_layout(&self) -> io::Result<()> {
        let (agent_tmp, npm_cache) = crate::agent_host::agent_host_dirs(&self.data);
        let dirs = [
            self.data.clone(),
            self.pi_sessions(),
            self.sessions(),
            self.logs(),
            self.data.join("agents"),
            self.data.join("skills"),
            self.data.join("commands"),
            self.data.join("checkpoints").join("objects"),
            agent_tmp,
            npm_cache,
            self.cache.clone(),
        ];
        for dir in dirs {
            std::fs::create_dir_all(&dir)?;
        }
        Ok(())
    }
}
