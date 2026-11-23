//! The `Memory` tool's I/O (T47, design addendum sections 2–3): `memory/status` when a session
//! opens and `memory/apply` for each allowed call. The store is [`crate::auto_memory`].
//!
//! - Auto memory is on unless a settings layer turns `autoMemoryEnabled` off (a project file can
//!   only turn it off; managed settings lock it). Subagents get neither the index nor the tool.
//! - The tool exists only for a trusted project (section 2.4); the index joins every main
//!   session's memory snapshot ([`ToolIo::auto_memory_index`]).
//! - `memory/apply` consumes the permission of the same call (`policy::claim_memory`); a
//!   `restore` read after a compaction needs none and only reads. Every save and delete is one
//!   `audit_events` row (`kind: "memory"`).

use std::path::Path;

use piarc_host::Peer;
use piarc_protocol::memory::{
    MemoryAction, MemoryApplyParams, MemoryApplyResult, MemoryFile, MemoryKind, MemoryStatusParams,
    MemoryStatusResult,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};

use super::{SessionIo, ToolIo, policy, to_value};
use crate::auto_memory::{MemoryError, NewTopic, Store};

fn internal(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(ErrorKind::InternalError, error.to_string(), false)
}

/// A refusal the model reads as the tool's error.
fn refused(error: &MemoryError) -> ErrorObject {
    let kind = match error {
        MemoryError::Io(_) => ErrorKind::IoError,
        _ => ErrorKind::InvalidParams,
    };
    ErrorObject::new(kind, error.to_string(), false)
}

fn action_name(action: MemoryAction) -> &'static str {
    match action {
        MemoryAction::Read => "read",
        MemoryAction::Save => "save",
        MemoryAction::Delete => "delete",
    }
}

impl ToolIo {
    /// Whether auto memory is on for the repository of `project`.
    pub(crate) async fn auto_memory_on(&self, project: &Path) -> bool {
        let table = self.layers(project);
        tokio::task::spawn_blocking(move || {
            let settings = piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
            settings.get("/autoMemoryEnabled") != Some(&Value::Bool(false))
        })
        .await
        .unwrap_or(false)
    }

    /// The memory store of `project`'s repository (its main checkout).
    async fn memory_store(&self, project: &Path) -> Result<Store, ErrorObject> {
        let data = self.config.data_dir.clone();
        let project = project.to_owned();
        tokio::task::spawn_blocking(move || {
            let checkout = piarc_git::resolve(&project).map_err(internal)?;
            Ok(Store::new(&data, &checkout.main))
        })
        .await
        .map_err(internal)?
    }

    /// The index as the last document of a main session's memory snapshot, when auto memory is
    /// on and keeps any memory.
    pub(super) async fn auto_memory_index(&self, s: &SessionIo) -> Option<MemoryFile> {
        if s.subagent.is_some() || !self.auto_memory_on(s.project()).await {
            return None;
        }
        let store = self.memory_store(s.project()).await.ok()?;
        index_file(store).await
    }

    /// `memory/status`.
    pub(super) async fn memory_status(&self, p: MemoryStatusParams) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let enabled = s.subagent.is_none() && self.auto_memory_on(s.project()).await;
        let trusted = match &self.policy {
            Some(services) => services.trust.state(s.project()).await.is_trusted(),
            None => false,
        };
        to_value(&MemoryStatusResult {
            enabled,
            tool: enabled && trusted,
        })
    }

    /// `memory/apply`.
    pub(super) async fn memory_apply(
        &self,
        p: MemoryApplyParams,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let action = action_name(p.action);
        if p.restore {
            if p.action != MemoryAction::Read || p.name.is_none() {
                return Err(policy::denied("A restore only reads one memory."));
            }
        } else {
            policy::claim_memory(&s, &p.tool_call_id, action, p.name.as_deref(), peer)?;
        }
        if s.subagent.is_some() || !self.auto_memory_on(s.project()).await {
            return Err(ErrorObject::new(
                ErrorKind::PermissionDenied,
                "Auto memory is turned off; nothing was read or saved.",
                false,
            ));
        }
        let store = self.memory_store(s.project()).await?;
        let result = match p.action {
            MemoryAction::Read => read(store, p.name).await?,
            MemoryAction::Save | MemoryAction::Delete => {
                if !p.restore && !self.memory_writable(&s).await {
                    return Err(ErrorObject::new(
                        ErrorKind::PermissionDenied,
                        "This project is not trusted: memories are not saved or deleted here.",
                        false,
                    ));
                }
                self.write_memory(&s, &p, store).await?
            }
        };
        to_value(&result)
    }

    async fn memory_writable(&self, s: &SessionIo) -> bool {
        match &self.policy {
            Some(services) => services.trust.state(s.project()).await.is_trusted(),
            None => false,
        }
    }

    async fn write_memory(
        &self,
        s: &SessionIo,
        p: &MemoryApplyParams,
        store: Store,
    ) -> Result<MemoryApplyResult, ErrorObject> {
        let name = p.name.clone().unwrap_or_default();
        let (text, detail) = if p.action == MemoryAction::Save {
            let saved = {
                let store = store.clone();
                let (name, kind, description, body, by) = (
                    name.clone(),
                    p.kind.clone().unwrap_or_default(),
                    p.description.clone().unwrap_or_default(),
                    p.content.clone().unwrap_or_default(),
                    p.session_id.clone(),
                );
                tokio::task::spawn_blocking(move || {
                    store.save(
                        &NewTopic {
                            name: &name,
                            description: &description,
                            kind: &kind,
                            body: &body,
                        },
                        &by,
                    )
                })
                .await
                .map_err(internal)?
                .map_err(|e| refused(&e))?
            };
            let verb = if saved.created { "Saved" } else { "Updated" };
            (
                format!("{verb} memory \"{name}\". Its index line:\n{}", saved.line),
                json!({
                    "action": "save", "name": name, "type": p.kind, "created": saved.created,
                    "bytes": p.content.as_deref().map_or(0, str::len), "sha256": saved.sha256,
                }),
            )
        } else {
            let deleted = {
                let (store, name) = (store.clone(), name.clone());
                tokio::task::spawn_blocking(move || store.delete(&name))
                    .await
                    .map_err(internal)?
                    .map_err(|e| refused(&e))?
            };
            (
                format!("Deleted memory \"{name}\"."),
                json!({ "action": "delete", "name": name, "type": deleted.kind }),
            )
        };
        let mut detail = detail;
        if let Value::Object(map) = &mut detail {
            map.insert("by".into(), json!("agent"));
            map.insert("toolCallId".into(), json!(p.tool_call_id));
            map.insert("memory".into(), json!(piarc_fs::display(store.dir())));
        }
        if let Some(services) = &self.policy {
            services
                .record("memory", &p.session_id, s.project(), &detail)
                .await?;
        }
        Ok(MemoryApplyResult {
            text,
            index: index_file(store).await,
            changed: true,
        })
    }
}

/// The injected index of `store` as a memory document.
async fn index_file(store: Store) -> Option<MemoryFile> {
    tokio::task::spawn_blocking(move || {
        let content = store.injected().ok()??;
        Some(MemoryFile {
            path: piarc_fs::display(&store.index_path()),
            content,
            paths: None,
            kind: Some(MemoryKind::AutoMemory),
        })
    })
    .await
    .ok()
    .flatten()
}

/// A `read`: the whole index, or one memory with what it is and who saved it.
async fn read(store: Store, name: Option<String>) -> Result<MemoryApplyResult, ErrorObject> {
    let text = tokio::task::spawn_blocking(move || -> Result<String, MemoryError> {
        match name {
            None => Ok(store
                .index()?
                .unwrap_or_else(|| "No memories are saved for this repository yet.".to_owned())),
            Some(name) => {
                let topic = store
                    .read(&name)?
                    .ok_or_else(|| MemoryError::Missing(name.clone()))?;
                let by = match topic.session.as_str() {
                    "user" => "the user".to_owned(),
                    "import" => "an import from Claude Code".to_owned(),
                    id => format!("session {}", id.chars().take(8).collect::<String>()),
                };
                let day = topic.modified.get(..10).unwrap_or("an unknown date");
                Ok(format!(
                    "Memory \"{}\" ({}, saved {day} by {by}): {}\n\n{}",
                    topic.name, topic.kind, topic.description, topic.body
                ))
            }
        }
    })
    .await
    .map_err(internal)?
    .map_err(|e| refused(&e))?;
    Ok(MemoryApplyResult {
        text,
        index: None,
        changed: false,
    })
}
