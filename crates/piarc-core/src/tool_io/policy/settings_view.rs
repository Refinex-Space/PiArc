//! The permission settings page (T23): every source's rules with their syntax status, edits
//! to PiArc's writable files, and the audit of decisions. The main process confirms new or
//! changed allow rules natively before an edit arrives here.
use piarc_config::executables::Item;
use piarc_config::{Category, PermissionLists, Scope as LayerScope, TrustState, ids};
use piarc_policy::rules::{Behavior, RuleSet, parse};
use serde::Deserialize;

use super::*;

/// One rule edit from the settings page.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuleChange {
    workspace: PathBuf,
    layer: String,
    behavior: Behavior,
    old: Option<String>,
    rule: Option<String>,
}

/// Filters of the audit view.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuditQuery {
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    tool: Option<String>,
    conclusion: Option<String>,
    since: Option<i64>,
    limit: Option<u32>,
}

/// Whether `rule` parses for `behavior`, and whether it is broad.
#[must_use]
pub(crate) fn check_rule(rule: &str, behavior: Behavior) -> Value {
    match parse(rule, behavior) {
        Ok(_) => json!({"broad": behavior == Behavior::Allow && RuleSet::is_broad(rule)}),
        Err(error) => json!({"error": error, "broad": false}),
    }
}

fn rows(lists: &PermissionLists, active: Option<&PermissionLists>) -> Vec<Value> {
    let entries = [
        (Behavior::Deny, &lists.deny),
        (Behavior::Ask, &lists.ask),
        (Behavior::Allow, &lists.allow),
    ];
    entries
        .into_iter()
        .flat_map(|(behavior, list)| list.iter().map(move |rule| (behavior, rule)))
        .map(|(behavior, rule)| {
            let applied = active.is_some_and(|a| match behavior {
                Behavior::Deny => a.deny.contains(rule),
                Behavior::Ask => a.ask.contains(rule),
                Behavior::Allow => a.allow.contains(rule),
            });
            let mut row = check_rule(rule, behavior);
            row["behavior"] = json!(behavior);
            row["rule"] = json!(rule);
            row["inactive"] = json!(!applied);
            row
        })
        .collect()
}

/// Every settings layer, files that do not exist yet included, so rules can be added.
fn layer_sources(
    data: &Path,
    root: &Path,
    all: &[PermissionLists],
    applied: &[PermissionLists],
) -> Vec<Value> {
    let table = LayerTable::piarc(data, root);
    table
        .layers()
        .iter()
        .rev()
        .filter(|l| l.id != ids::DEFAULTS)
        .map(|spec| {
            let empty = PermissionLists {
                layer: spec.id,
                scope: spec.scope,
                file: spec.file().map(Path::to_owned),
                writable: spec.writable,
                deny: Vec::new(),
                ask: Vec::new(),
                allow: Vec::new(),
            };
            let lists = all.iter().find(|l| l.layer == spec.id).unwrap_or(&empty);
            let active = applied.iter().find(|a| a.layer == spec.id);
            json!({
                "id": spec.id,
                "file": spec.file().map(display),
                "writable": spec.writable,
                "scope": match spec.scope {
                    LayerScope::Project => "project",
                    LayerScope::User => "user",
                    _ => "other",
                },
                "rules": rows(lists, active),
            })
        })
        .collect()
}

impl ToolIo {
    /// The rules of `workspace` (the most recently opened one when `None`) by source.
    pub(crate) async fn permission_view(
        &self,
        workspace: Option<PathBuf>,
    ) -> Result<Value, ErrorObject> {
        let services = self.services()?;
        let known: Vec<String> = services
            .storage
            .run(|db| db.workspaces())
            .await
            .map_err(|e| e.to_error_object())?
            .map_err(|e| e.to_error_object())?
            .into_iter()
            .map(|w| w.path)
            .collect();
        let Some(dir) = workspace.or_else(|| known.first().map(PathBuf::from)) else {
            return Ok(json!({"workspaces": known, "workspace": null, "sources": []}));
        };
        let root = dir.canonicalize().map_err(|e| {
            ErrorObject::new(
                ErrorKind::InvalidParams,
                format!("Unknown workspace: {e}"),
                false,
            )
        })?;
        let active = services.settings(&root).await?;
        let data = services.storage.dirs().data().to_owned();
        let all_root = root.clone();
        let all = tokio::task::spawn_blocking(move || {
            Settings::load(LayerTable::piarc(&data, &all_root), TrustState::Trusted)
                .permission_lists()
        })
        .await
        .map_err(|e| denied(e.to_string()))?;
        let applied = active.permission_lists();
        let mut sources = self.session_sources(&root);
        sources.extend(layer_sources(
            services.storage.dirs().data(),
            &root,
            &all,
            &applied,
        ));
        let shown = display(&root);
        let mut workspaces = known;
        if !workspaces.contains(&shown) {
            workspaces.insert(0, shown.clone());
        }
        Ok(json!({"workspaces": workspaces, "workspace": shown, "sources": sources}))
    }

    /// Rules allowed in the open sessions of `root`.
    fn session_sources(&self, root: &Path) -> Vec<Value> {
        self.sessions_in(root)
            .into_iter()
            .filter_map(|(id, session)| {
                let rules: Vec<Value> = lock(&session.policy)
                    .rules
                    .iter()
                    .map(|rule| {
                        let mut row = check_rule(rule, Behavior::Allow);
                        row["behavior"] = json!("allow");
                        row["rule"] = json!(rule);
                        row["inactive"] = json!(false);
                        row
                    })
                    .collect();
                (!rules.is_empty())
                    .then(|| json!({"id":"session","sessionId":id,"writable":false,"rules":rules}))
            })
            .collect()
    }

    fn sessions_in(&self, root: &Path) -> Vec<(String, Arc<SessionIo>)> {
        let mut found: Vec<(String, Arc<SessionIo>)> = lock(&self.sessions)
            .iter()
            .filter(|(_, s)| s.scope.root() == root)
            .map(|(id, s)| (id.clone(), Arc::clone(s)))
            .collect();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found
    }

    /// Apply one edit to a writable file and answer the new view.
    pub(crate) async fn update_permission_rule(
        &self,
        change: RuleChange,
    ) -> Result<Value, ErrorObject> {
        let services = self.services()?;
        let invalid = |m: String| ErrorObject::new(ErrorKind::InvalidParams, m, false);
        let layer = match change.layer.as_str() {
            "projectLocal" => ids::PROJECT_LOCAL,
            "project" => ids::PROJECT,
            "user" => ids::USER,
            other => {
                return Err(invalid(format!(
                    "{other:?} is not a writable settings file"
                )));
            }
        };
        if let Some(rule) = &change.rule {
            parse(rule, change.behavior)
                .map_err(|e| invalid(format!("Invalid rule {rule:?}: {e}")))?;
        }
        let root = change
            .workspace
            .canonicalize()
            .map_err(|e| invalid(format!("Unknown workspace: {e}")))?;
        let table = LayerTable::piarc(services.storage.dirs().data(), &root);
        let (old, rule, key) = (
            change.old.clone(),
            change.rule.clone(),
            change.behavior.key(),
        );
        let file = tokio::task::spawn_blocking(move || {
            piarc_config::edit_permission_rule(&table, layer, key, old.as_deref(), rule.as_deref())
        })
        .await
        .map_err(|e| denied(e.to_string()))?
        .map_err(|e| invalid(e.to_string()))?;
        // The user confirmed this allow rule natively: it joins the project's trust snapshot
        // (only when the project is already trusted).
        if let (Behavior::Allow, Some(rule), true) =
            (change.behavior, &change.rule, layer != ids::USER)
        {
            let source = file
                .strip_prefix(&root)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            let item = Item {
                category: Category::AllowRule,
                source,
                name: rule.clone(),
            };
            services
                .trust
                .confirm_items(&root, vec![item])
                .await
                .map_err(|e| e.to_error_object())?;
        }
        self.permission_view(Some(root)).await
    }

    /// Permission decisions matching `query`, newest first.
    pub(crate) async fn audit_events(&self, query: AuditQuery) -> Result<Value, ErrorObject> {
        let services = self.services()?;
        let workspace = query.workspace.map(|w| {
            w.canonicalize()
                .map(|p| display(&p))
                .unwrap_or_else(|_| display(&w))
        });
        let filter = piarc_store::AuditFilter {
            session_id: query.session_id,
            workspace,
            kind: Some("permission".into()),
            tool: query.tool,
            conclusion: query.conclusion,
            since: query.since,
            until: None,
            limit: query.limit.unwrap_or(200).min(1000),
        };
        let events = services
            .storage
            .run(move |db| db.filter_audit_events(&filter))
            .await
            .map_err(|e| e.to_error_object())?
            .map_err(|e| e.to_error_object())?;
        let events: Vec<Value> = events
            .into_iter()
            .map(|e| {
                json!({"at": e.at, "sessionId": e.session_id, "workspace": e.workspace,
                    "detail": serde_json::from_str::<Value>(&e.detail).unwrap_or(Value::Null)})
            })
            .collect();
        Ok(json!({"events": events}))
    }
}
