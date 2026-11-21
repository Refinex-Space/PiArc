//! The client's view of skills, slash commands and output styles (T37, ADR-0054): the lists a
//! workspace offers and switching the output style. The running Agent Host answers the lists
//! (it merges its own sources: plugins and MCP prompts, T40); without one Core answers from
//! the files.

use std::path::PathBuf;

use piarc_protocol::skills::{
    CommandsList, ResourcesListCommands, ResourcesListParams, ResourcesListSkills, ResourcesReload,
    ResourcesReloadParams, SkillsList,
};
use serde::Serialize;
use serde_json::Value;

use super::{Hub, host_error};
use crate::error::{Error, Result};

/// Longest output style name accepted.
const MAX_STYLE_CHARS: usize = 64;

fn encode(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the list: {e}"),
    })
}

impl Hub {
    /// The slash commands and output styles of `workspace` from `cwd` (the root when absent).
    pub async fn list_commands(&self, workspace: PathBuf, cwd: Option<PathBuf>) -> Result<Value> {
        let handle = self.workspace(workspace.clone()).await?;
        if let Some(supervisor) = handle.peek().await {
            let params = ResourcesListParams {
                cwd: cwd.map(|c| c.to_string_lossy().into_owned()),
            };
            let list = supervisor
                .call::<ResourcesListCommands>(params)
                .await
                .map_err(host_error)?;
            return encode(&list);
        }
        let cwd = cwd.unwrap_or_else(|| workspace.clone());
        let (_, view) = self
            .ctx
            .tool_io
            .skills_view(&workspace, &cwd)
            .await
            .map_err(|e| Error::feature(&e))?;
        encode(&CommandsList {
            commands: view.commands,
            output_styles: view.output_styles,
            output_style: view.output_style,
            issues: view.issues,
        })
    }

    /// The skills of `workspace` from `cwd` (the root when absent).
    pub async fn list_skills(&self, workspace: PathBuf, cwd: Option<PathBuf>) -> Result<Value> {
        let handle = self.workspace(workspace.clone()).await?;
        if let Some(supervisor) = handle.peek().await {
            let params = ResourcesListParams {
                cwd: cwd.map(|c| c.to_string_lossy().into_owned()),
            };
            let list = supervisor
                .call::<ResourcesListSkills>(params)
                .await
                .map_err(host_error)?;
            return encode(&list);
        }
        let cwd = cwd.unwrap_or_else(|| workspace.clone());
        let (_, view) = self
            .ctx
            .tool_io
            .skills_view(&workspace, &cwd)
            .await
            .map_err(|e| Error::feature(&e))?;
        encode(&SkillsList {
            skills: view.skills,
            issues: view.issues,
        })
    }

    /// Sets the output style (`outputStyle`): in `workspace`'s `.piarc/settings.local.json`
    /// (`/output-style`), or in the user's `settings.json` without a workspace; `None` removes
    /// the choice. The sessions get the new style with their next run.
    pub async fn set_output_style(
        &self,
        workspace: Option<PathBuf>,
        name: Option<String>,
    ) -> Result<Value> {
        if let Some(name) = &name
            && (name.trim().is_empty() || name.chars().count() > MAX_STYLE_CHARS)
        {
            return Err(Error::InvalidArgument {
                field: "name",
                reason: format!("an output style name of 1-{MAX_STYLE_CHARS} characters"),
            });
        }
        let value = name.map(Value::String);
        let dirs = self.ctx.storage.dirs().clone();
        let target = workspace.clone();
        tokio::task::spawn_blocking(move || match workspace {
            Some(workspace) => piarc_config::write_value(
                &dirs.layers(&workspace),
                piarc_config::ids::PROJECT_LOCAL,
                "/outputStyle",
                value,
            )
            .map(|_| ())
            .map_err(Error::from),
            None => crate::client_settings::write_user_value(dirs.data(), "/outputStyle", value),
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("writing the output style failed: {e}"),
        })??;
        // The running Agent Host hears now, not after the watcher's debounce: the next prompt
        // already carries the new style.
        if let Some(workspace) = target {
            let handle = self.workspace(workspace).await?;
            if let Some(supervisor) = handle.peek().await {
                supervisor
                    .call::<ResourcesReload>(ResourcesReloadParams {})
                    .await
                    .map_err(host_error)?;
            }
        }
        Ok(Value::Null)
    }
}
