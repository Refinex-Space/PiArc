//! The settings window's sandbox page (T39): what the sandbox is for a workspace, where each
//! allowed domain and `denyRead` path comes from, where commands may write, which project values
//! do not apply, and edits to the user's own values (the only ones the page changes).

use std::path::PathBuf;

use piarc_config::diagnostics::IgnoreReason;
use piarc_config::sandbox::{ALLOWED_DOMAINS, AUTO_ALLOW, DENY_READ, ENABLED, Entry, Origin};
use piarc_config::{Settings, TrustState, ids};
use piarc_fs::display;
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_sandbox::proxy::Allowlist;
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::ToolIo;
use super::super::policy::denied;

/// Most entries the page writes to one list.
const MAX_ENTRIES: usize = 256;

/// The user's values the page may change; absent fields stay as they are.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SandboxChange {
    enabled: Option<bool>,
    auto_allow: Option<bool>,
    allowed_domains: Option<Vec<String>>,
    deny_read: Option<Vec<String>>,
}

impl ToolIo {
    /// The sandbox page's view of `workspace` (the most recently opened one when `None`; the
    /// user's files alone when there is none).
    pub(crate) async fn sandbox_view(
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
        let root = match workspace.or_else(|| known.first().map(PathBuf::from)) {
            Some(dir) => Some(dir.canonicalize().map_err(|e| {
                ErrorObject::new(
                    ErrorKind::InvalidParams,
                    format!("Unknown workspace: {e}"),
                    false,
                )
            })?),
            None => None,
        };
        let settings = match &root {
            Some(root) => services.settings(root).await?,
            None => {
                let data = services.storage.dirs().data().to_owned();
                let table = services.storage.dirs().layers(&data);
                tokio::task::spawn_blocking(move || Settings::load(table, TrustState::Untrusted))
                    .await
                    .map_err(|e| denied(e.to_string()))?
            }
        };
        let tmp = services
            .storage
            .dirs()
            .data()
            .join("sessions")
            .join("<session>")
            .join("tmp");
        let shown = root.as_deref().map(display);
        let mut workspaces = known;
        if let Some(shown) = &shown
            && !workspaces.contains(shown)
        {
            workspaces.insert(0, shown.clone());
        }
        let mut view = self.sandbox_values(&settings);
        view["workspaces"] = json!(workspaces);
        view["workspace"] = json!(shown);
        view["writable"] = json!(writable(&settings, root.as_deref(), &tmp));
        Ok(view)
    }

    /// The view's values that come from the merged settings and the platform.
    fn sandbox_values(&self, settings: &Settings) -> Value {
        let resolved = piarc_config::sandbox::resolve(
            settings,
            self.config.sandbox.enterprise.as_ref(),
            self.config.home.as_deref(),
        );
        let platform = self.config.sandbox.platform.as_ref();
        let supported = platform.is_some();
        let available = platform.is_some_and(|p| p.available())
            && !self
                .sandbox_health
                .broken
                .load(std::sync::atomic::Ordering::Relaxed);
        let user = settings.layer(ids::USER);
        let user_list = |pointer: &str| -> Vec<String> {
            user.and_then(|v| v.pointer(pointer))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        };
        let user_flag = |pointer: &str| {
            user.and_then(|v| v.pointer(pointer))
                .and_then(Value::as_bool)
        };
        let deny_read: Vec<Value> = resolved
            .deny_read
            .iter()
            .map(|e| {
                entry(&Entry {
                    value: display(&e.value),
                    origin: e.origin,
                    layer: e.layer,
                })
            })
            .collect();
        json!({
            "platform": {"supported": supported, "available": available},
            "enabled": resolved.enabled,
            "autoAllow": resolved.auto_allow,
            "user": {
                "enabled": user_flag(ENABLED),
                "autoAllow": user_flag(AUTO_ALLOW),
                "allowedDomains": user_list(ALLOWED_DOMAINS),
                "denyRead": user_list(DENY_READ),
            },
            "allowedDomains": resolved.allowed_domains.iter().map(entry).collect::<Vec<_>>(),
            "denyRead": deny_read,
            "ignored": ignored(settings, supported),
        })
    }

    /// Writes the user's sandbox values (`<data dir>/settings.json`) and answers the new view.
    pub(crate) async fn set_sandbox_settings(
        &self,
        workspace: Option<PathBuf>,
        change: SandboxChange,
    ) -> Result<Value, ErrorObject> {
        let services = self.services()?;
        let mut writes: Vec<(&'static str, Value)> = Vec::new();
        if let Some(enabled) = change.enabled {
            writes.push((ENABLED, Value::Bool(enabled)));
        }
        if let Some(auto) = change.auto_allow {
            writes.push((AUTO_ALLOW, Value::Bool(auto)));
        }
        if let Some(domains) = change.allowed_domains {
            let domains = clean(domains, "allowedDomains")?;
            if let Some(bad) = domains
                .iter()
                .find(|d| Allowlist::new([d.as_str()]).is_err())
            {
                return Err(ErrorObject::new(
                    ErrorKind::InvalidParams,
                    format!("{bad:?} is not a domain or *.domain pattern"),
                    false,
                ));
            }
            writes.push((ALLOWED_DOMAINS, json!(domains)));
        }
        if let Some(paths) = change.deny_read {
            writes.push((DENY_READ, json!(clean(paths, "denyRead")?)));
        }
        let data = services.storage.dirs().data().to_owned();
        let table = services.storage.dirs().layers(&data);
        tokio::task::spawn_blocking(move || {
            for (pointer, value) in writes {
                piarc_config::write_value(&table, ids::USER, pointer, Some(value))?;
            }
            Ok::<_, piarc_config::WriteError>(())
        })
        .await
        .map_err(|e| denied(e.to_string()))?
        .map_err(|e| denied(e.to_string()))?;
        self.sandbox_view(workspace).await
    }
}

/// Where sandboxed commands of `root` may write: the workspace, its added directories, each
/// session's temporary directory (`tmp`, with a placeholder for the session).
fn writable(
    settings: &Settings,
    root: Option<&std::path::Path>,
    tmp: &std::path::Path,
) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(root) = root {
        out.push(json!({"kind":"workspace","path":display(root)}));
        for dir in settings
            .get("/permissions/additionalDirectories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            out.push(json!({"kind":"added","path":display(&root.join(dir))}));
        }
    }
    out.push(json!({"kind":"sessionTmp","path":display(tmp)}));
    out
}

fn entry(e: &Entry<String>) -> Value {
    json!({"value": e.value, "origin": e.origin, "layer": e.layer, "editable": e.origin == Origin::User})
}

/// Trimmed, non-empty, distinct entries; at most [`MAX_ENTRIES`] of at most 4,096 characters.
fn clean(list: Vec<String>, field: &str) -> Result<Vec<String>, ErrorObject> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let item = item.trim().to_owned();
        if item.is_empty() || out.contains(&item) {
            continue;
        }
        if item.chars().count() > 4096 || item.chars().any(char::is_control) {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                format!("{field}: an entry is too long or has control characters"),
                false,
            ));
        }
        out.push(item);
    }
    if out.len() > MAX_ENTRIES {
        return Err(ErrorObject::new(
            ErrorKind::InvalidParams,
            format!("{field}: at most {MAX_ENTRIES} entries"),
            false,
        ));
    }
    Ok(out)
}

/// The sandbox values of the files that do not apply: a project's loosening ones, and on a
/// platform without a sandbox those that turn it or its auto-approval on.
fn ignored(settings: &Settings, supported: bool) -> Vec<Value> {
    let mut reports = settings.diagnostics();
    if !supported {
        piarc_config::diagnostics::mark_platform_unsupported(&mut reports, &[ENABLED, AUTO_ALLOW]);
    }
    reports
        .iter()
        .flat_map(|report| {
            report
                .ignored
                .iter()
                .filter(|k| {
                    k.pointer.starts_with("/sandbox/")
                        && matches!(k.reason, IgnoreReason::ProjectSandbox | IgnoreReason::Platform)
                })
                .map(move |k| {
                    json!({"layer": report.layer, "file": display(&report.file), "pointer": k.pointer, "reason": k.reason})
                })
        })
        .collect()
}
