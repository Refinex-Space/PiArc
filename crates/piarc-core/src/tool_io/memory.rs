//! The Host names visited directories. Core discovers documents under its own session scope.
//! A page belongs to one peer and one scan; a later page never rereads a changed source.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use piarc_host::Peer;
use piarc_protocol::memory::{FsMemoryParams, FsMemoryResult, MemoryFile, MemorySnapshot};
use piarc_protocol::policy::ApprovalDecision;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};
use tokio_util::sync::CancellationToken;

use super::{SessionIo, ToolIo, git_status, lock, memory_reader, policy, to_value};
use memory_reader::ImportAccess;

#[derive(Default)]
pub(super) struct State {
    git: OnceCell<String>,
    opening: Mutex<Option<memory_reader::Collection>>,
    choices: Mutex<HashMap<PathBuf, ImportAccess>>,
    scan: AsyncMutex<()>,
    transfer: Mutex<Option<Transfer>>,
}

struct Transfer {
    generation: CancellationToken,
    peer: Peer,
    call: String,
    text: String,
    offset: usize,
}

impl Transfer {
    fn page(&mut self) -> FsMemoryResult {
        let end = self.text.floor_char_boundary(
            self.offset
                .saturating_add(piarc_protocol::fs::MAX_READ_CHUNK as usize)
                .min(self.text.len()),
        );
        let chunk = self.text[self.offset..end].to_owned();
        self.offset = end;
        FsMemoryResult {
            chunk,
            next_offset: (end < self.text.len()).then_some(end as u64),
        }
    }
}

impl State {
    fn next_page(&self, peer: &Peer, call: &str, offset: u64) -> Result<Value, ErrorObject> {
        let mut stored = lock(&self.transfer);
        if stored.as_ref().is_some_and(|t| t.generation.is_cancelled()) {
            *stored = None;
        }
        let transfer = stored
            .as_mut()
            .filter(|t| {
                t.peer.same_connection(peer)
                    && t.call == call
                    && u64::try_from(t.offset) == Ok(offset)
            })
            .ok_or_else(|| policy::denied("This memory page is no longer available."))?;
        let page = transfer.page();
        if page.next_offset.is_none() {
            *stored = None;
        }
        to_value(&page)
    }

    async fn git_status(&self, session: &SessionIo) -> &str {
        self.git
            .get_or_init(|| {
                git_status::snapshot(
                    session.scope.root().to_owned(),
                    session.scope.cwd().to_owned(),
                )
            })
            .await
    }
}

impl ToolIo {
    /// Called before returning a new session to the client. Permission dialogs need a live
    /// session, so unresolved imports wait for the first prompt.
    pub(crate) async fn capture_opening_memory(&self, id: &str) -> Result<(), ErrorObject> {
        let session = self.session(id)?;
        let (files, _) = tokio::join!(
            self.collect_memory(
                &session,
                Vec::new(),
                memory_reader::RuleQuery::default(),
                HashMap::new()
            ),
            session.memory.git_status(&session)
        );
        *lock(&session.memory.opening) = Some(files?);
        Ok(())
    }

    async fn collect_memory(
        &self,
        session: &SessionIo,
        dirs: Vec<String>,
        rules: memory_reader::RuleQuery,
        choices: HashMap<PathBuf, ImportAccess>,
    ) -> Result<memory_reader::Collection, ErrorObject> {
        let config = Arc::clone(&self.config);
        let scope = session.scope.clone();
        let project = session.project().to_owned();
        tokio::task::spawn_blocking(move || {
            let table = piarc_config::LayerTable::workspace(
                &config.data_dir,
                &project,
                config.home.as_deref(),
            );
            // This setting governs the choice of two documents; project code is never enabled.
            let settings = piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
            let both = settings.get("/memory/readBoth").and_then(Value::as_bool) == Some(true);
            memory_reader::collect(
                &scope,
                config.home.as_deref(),
                &config.data_dir,
                &dirs,
                both,
                &rules,
                |path| choices.get(path).cloned(),
            )
        })
        .await
        .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?
        .map_err(|e| ErrorObject::new(ErrorKind::IoError, e.to_string(), false))
    }

    pub(super) async fn memory_snapshot(
        &self,
        p: FsMemoryParams,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id)?;
        if let Some(offset) = p.offset {
            return session.memory.next_page(peer, &p.tool_call_id, offset);
        }
        let generation = policy::memory::generation(&session);
        let _guard = session.memory.scan.lock().await;
        policy::memory::begin(&session, p.turn_id.clone(), &generation);
        let mut choices = lock(&session.memory.choices).clone();
        let dirs = p.directories.as_deref().unwrap_or_default();
        let opening = if p.include_git == Some(true) && dirs.is_empty() {
            lock(&session.memory.opening).clone()
        } else {
            lock(&session.memory.opening).take();
            None
        };
        let scan = Scan {
            io: self,
            session: &session,
            params: &p,
            peer,
            generation,
        };
        let initial = match opening {
            Some(opening) => Some(scan.resolve(opening, &mut choices).await?),
            None => None,
        };
        let rules = memory_reader::RuleQuery {
            files: p
                .files
                .iter()
                .flatten()
                .map(|f| session.scope.cwd().join(f))
                .collect(),
            active: p.rules.clone().unwrap_or_default(),
        };
        let latest = self
            .collect_memory(&session, dirs.to_vec(), rules, choices.clone())
            .await?;
        let inactive_rules = latest.inactive_rules;
        let latest = scan.resolve(latest, &mut choices).await?;
        let (files, current_files) = match initial {
            Some(original) if original != latest => (original, Some(latest)),
            _ => (latest, None),
        };
        let git_status = if p.include_git == Some(true) {
            Some(session.memory.git_status(&session).await.to_owned())
        } else {
            None
        };
        let text = serde_json::to_string(&MemorySnapshot {
            files,
            current_files,
            git_status,
            inactive_rules: inactive_rules.then_some(true),
        })
        .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?;
        if scan.generation.is_cancelled() || peer.is_closed() {
            return Err(policy::denied("Memory import cancelled."));
        }
        let mut transfer = Transfer {
            generation: scan.generation,
            peer: peer.clone(),
            call: p.tool_call_id,
            text,
            offset: 0,
        };
        let page = transfer.page();
        *lock(&session.memory.transfer) = page.next_offset.is_some().then_some(transfer);
        to_value(&page)
    }
}

/// One logical read, including any nested imports discovered after confirmation.
struct Scan<'a> {
    io: &'a ToolIo,
    session: &'a SessionIo,
    params: &'a FsMemoryParams,
    peer: &'a Peer,
    generation: CancellationToken,
}

impl Scan<'_> {
    async fn resolve(
        &self,
        mut current: memory_reader::Collection,
        choices: &mut HashMap<PathBuf, ImportAccess>,
    ) -> Result<Vec<MemoryFile>, ErrorObject> {
        loop {
            if self.generation.is_cancelled() || self.peer.is_closed() {
                return Err(policy::denied("Memory import cancelled."));
            }
            let Some(inputs) = current.inputs else {
                return Ok(current.files);
            };
            for path in current.pending {
                if choices.contains_key(&path) {
                    continue;
                }
                let (decision, feedback) = match &self.io.policy {
                    Some(svc) => {
                        policy::memory::approve(
                            svc,
                            self.session,
                            &self.params.session_id,
                            &self.params.tool_call_id,
                            &path,
                            self.peer,
                            &self.generation,
                        )
                        .await?
                    }
                    None => (ApprovalDecision::Deny, None),
                };
                let access = if decision == ApprovalDecision::Deny {
                    ImportAccess::Denied(feedback)
                } else {
                    ImportAccess::Allowed
                };
                if matches!(
                    decision,
                    ApprovalDecision::AllowSession | ApprovalDecision::Deny
                ) {
                    lock(&self.session.memory.choices).insert(path.clone(), access.clone());
                }
                choices.insert(path, access);
            }
            let scope = self.session.scope.clone();
            let home = self.io.config.home.clone();
            let decisions = choices.clone();
            current = tokio::task::spawn_blocking(move || {
                inputs.expand(&scope, home.as_deref(), |path| decisions.get(path).cloned())
            })
            .await
            .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?
            .map_err(|e| ErrorObject::new(ErrorKind::IoError, e.to_string(), false))?;
        }
    }
}

/// The memory documents a session opened at `root` starts with (T41's configuration
/// diagnostics): the same discovery as `fs/memory`, without conditional rules; an import that
/// needs the user's approval is not read and stays marked in the text.
///
/// # Errors
///
/// The workspace cannot be bound, or a memory file cannot be read.
pub(crate) fn memory_documents(
    root: &std::path::Path,
    home: Option<&std::path::Path>,
    data: &std::path::Path,
    read_both: bool,
) -> std::io::Result<Vec<piarc_protocol::memory::MemoryFile>> {
    let scope = piarc_fs::Scope::new(root, root).map_err(std::io::Error::other)?;
    let query = memory_reader::RuleQuery {
        files: Vec::new(),
        active: Vec::new(),
    };
    let collection = memory_reader::collect(&scope, home, data, &[], read_both, &query, |_| None)?;
    Ok(collection.files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_keep_utf8_and_require_the_same_connection_call_and_cursor() {
        let (peer, _rx) = Peer::channel(2);
        let (other, _other_rx) = Peer::channel(2);
        let text = format!(
            "{}中界",
            "x".repeat(piarc_protocol::fs::MAX_READ_CHUNK as usize - 1)
        );
        let mut transfer = Transfer {
            generation: CancellationToken::new(),
            peer: peer.clone(),
            call: "snapshot".into(),
            text: text.clone(),
            offset: 0,
        };
        let first = transfer.page();
        let offset = first.next_offset.expect("another page");
        let state = State::default();
        *lock(&state.transfer) = Some(transfer);
        assert!(state.next_page(&other, "snapshot", offset).is_err());
        assert!(state.next_page(&peer, "changed", offset).is_err());
        assert!(state.next_page(&peer, "snapshot", offset + 1).is_err());
        let last = state.next_page(&peer, "snapshot", offset).unwrap();
        assert_eq!(first.chunk + last["chunk"].as_str().unwrap(), text);
        assert!(state.next_page(&peer, "snapshot", offset).is_err());
    }
}
