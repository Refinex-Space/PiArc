//! The settings window's "Memory" page and the managed settings' lock view (T47, design
//! addendum `T47-auto-memory-and-managed-settings.md` sections 4.2 and 5.4).
//!
//! - `memory_view`: the workspace repository's notes, the switches (user, project, whether
//!   managed settings lock them), the directory and Claude Code's memory for an import.
//! - `memory_edit`: the user's edits (`save`, `delete`, `deleteAll`, `import`, `setEnabled`);
//!   every change to the notes is one `audit_events` row (`kind: "memory"`, `by: user` or
//!   `import`). The switches go through the settings writers, which refuse a locked setting.
//! - `managed_settings`: what managed settings lock, for the settings window's lock marks.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::Hub;
use crate::auto_memory::{MemoryError, NewTopic, Store, claude_dir};
use crate::error::{Error, Result};

fn invalid(field: &'static str, reason: impl Into<String>) -> Error {
    Error::InvalidArgument {
        field,
        reason: reason.into(),
    }
}

fn memory_error(error: MemoryError) -> Error {
    match error {
        MemoryError::Io(error) => Error::Internal {
            reason: error.to_string(),
        },
        other => invalid("memory", other.to_string()),
    }
}

fn blocking_failed(error: tokio::task::JoinError) -> Error {
    Error::Internal {
        reason: format!("a memory task failed: {error}"),
    }
}

/// The notes of Claude Code's directory, by count.
fn claude_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|e| e == "md")
                && p.file_name()
                    .is_some_and(|n| n != crate::auto_memory::INDEX_FILE)
        })
        .count()
}

impl Hub {
    /// What managed settings lock (`piarc_config::managed::view`).
    pub async fn managed_settings(&self) -> Result<Value> {
        Ok(piarc_config::managed::view(
            &self.ctx.storage.dirs().managed().snapshot().managed,
        ))
    }

    /// The memory page of `workspace`.
    ///
    /// # Errors
    ///
    /// The workspace or the settings cannot be read.
    pub async fn memory_view(&self, workspace: PathBuf) -> Result<Value> {
        let root = piarc_git::canonical(&workspace)?;
        let settings = self.ctx.trust.permission_settings(&root).await?;
        let on = |value: Option<&Value>| value != Some(&Value::Bool(false));
        let enabled = on(settings.get("/autoMemoryEnabled"));
        let user = on(settings.user_value("/autoMemoryEnabled"));
        let project = on(settings
            .layer(piarc_config::ids::PROJECT_LOCAL)
            .and_then(|v| v.get("autoMemoryEnabled")));
        let locked = settings.is_locked("/autoMemoryEnabled");
        let trusted = settings.trust().is_trusted();
        let data = self.ctx.storage.dirs().data().to_owned();
        let home = self.ctx.storage.dirs().home().map(Path::to_owned);
        let (store, memories, claude) = tokio::task::spawn_blocking(move || {
            let checkout = piarc_git::resolve(&root)?.main;
            let store = Store::new(&data, &checkout);
            let memories = store.list().map_err(|e| Error::Internal {
                reason: e.to_string(),
            })?;
            let claude = home.map(|home| claude_dir(&home, &checkout));
            Ok::<_, Error>((store, memories, claude))
        })
        .await
        .map_err(blocking_failed)??;
        let claude = claude
            .filter(|dir| dir.is_dir())
            .map(|dir| json!({ "path": piarc_fs::display(&dir), "count": claude_count(&dir) }));
        Ok(json!({
            "enabled": enabled,
            "userEnabled": user,
            "projectEnabled": project,
            "locked": locked,
            "trusted": trusted,
            "directory": piarc_fs::display(store.dir()),
            "memories": memories,
            "claude": claude,
        }))
    }

    /// One edit of the memory page; answers the page anew.
    ///
    /// # Errors
    ///
    /// An unknown edit, a refused note (name, size, the project is full), a locked switch or a
    /// failed write.
    pub async fn memory_edit(&self, workspace: PathBuf, edit_json: String) -> Result<Value> {
        let edit: Value = serde_json::from_str(&edit_json)
            .map_err(|e| invalid("edit", format!("not JSON: {e}")))?;
        let root = piarc_git::canonical(&workspace)?;
        let op = edit["op"].as_str().unwrap_or_default().to_owned();
        if op == "setEnabled" {
            self.set_memory_enabled(&root, &edit).await?;
            return self.memory_view(root).await;
        }
        let data = self.ctx.storage.dirs().data().to_owned();
        let home = self.ctx.storage.dirs().home().map(Path::to_owned);
        let project = root.clone();
        let details = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
            let checkout = piarc_git::resolve(&project)?.main;
            let store = Store::new(&data, &checkout);
            let text = |key: &str| edit[key].as_str().unwrap_or_default().to_owned();
            match op.as_str() {
                "save" => {
                    let (name, kind, description, content) =
                        (text("name"), text("type"), text("description"), text("content"));
                    let saved = store
                        .save(
                            &NewTopic {
                                name: &name,
                                description: &description,
                                kind: &kind,
                                body: &content,
                            },
                            "user",
                        )
                        .map_err(memory_error)?;
                    Ok(vec![json!({ "action": "save", "name": name, "type": kind,
                        "created": saved.created, "bytes": content.len(), "sha256": saved.sha256, "by": "user" })])
                }
                "delete" => {
                    let name = text("name");
                    let topic = store.delete(&name).map_err(memory_error)?;
                    Ok(vec![json!({ "action": "delete", "name": name, "type": topic.kind, "by": "user" })])
                }
                "deleteAll" => {
                    let mut rows = Vec::new();
                    for topic in store.list().map_err(|e| memory_error(e.into()))? {
                        store.delete(&topic.name).map_err(memory_error)?;
                        rows.push(json!({ "action": "delete", "name": topic.name, "type": topic.kind, "by": "user" }));
                    }
                    Ok(rows)
                }
                "import" => {
                    let home = home.ok_or_else(|| invalid("import", "no home directory"))?;
                    let imported = store
                        .import_claude(&claude_dir(&home, &checkout))
                        .map_err(memory_error)?;
                    Ok(imported
                        .imported
                        .iter()
                        .map(|name| json!({ "action": "import", "name": name, "by": "import" }))
                        .collect())
                }
                other => Err(invalid("op", format!("unknown memory edit {other:?}"))),
            }
        })
        .await
        .map_err(blocking_failed)??;
        self.audit_memory(&root, details).await?;
        self.memory_view(root).await
    }

    async fn set_memory_enabled(&self, root: &Path, edit: &Value) -> Result<()> {
        let enabled = edit["enabled"]
            .as_bool()
            .ok_or_else(|| invalid("enabled", "a boolean"))?;
        let dirs = self.ctx.storage.dirs().clone();
        let root = root.to_owned();
        let scope = edit["scope"].as_str().unwrap_or_default().to_owned();
        tokio::task::spawn_blocking(move || match scope.as_str() {
            "user" => crate::client_settings::write_user_value(
                dirs.data(),
                dirs.managed(),
                "/autoMemoryEnabled",
                Some(Value::Bool(enabled)),
            ),
            // A project file can only turn auto memory off: on removes the key.
            "project" => piarc_config::write_value(
                &dirs.layers(&root),
                piarc_config::ids::PROJECT_LOCAL,
                "/autoMemoryEnabled",
                (!enabled).then_some(Value::Bool(false)),
            )
            .map(drop)
            .map_err(Error::from),
            _ => Err(invalid("scope", "user or project")),
        })
        .await
        .map_err(blocking_failed)?
    }

    async fn audit_memory(&self, root: &Path, details: Vec<Value>) -> Result<()> {
        let workspace = piarc_fs::display(root);
        self.ctx
            .storage
            .run(move |db| {
                details.iter().try_for_each(|detail| {
                    db.append_audit(&piarc_store::AuditEvent {
                        at: crate::storage::now_ms(),
                        kind: "memory".into(),
                        session_id: None,
                        workspace: Some(workspace.clone()),
                        detail: detail.to_string(),
                    })
                    .map(drop)
                })
            })
            .await??;
        Ok(())
    }
}
