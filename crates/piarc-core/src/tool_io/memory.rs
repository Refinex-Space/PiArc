//! The Host names visited directories. Core discovers documents under its own session scope.
//! A page belongs to one peer and one scan; a later page never rereads a changed source.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use piarc_host::Peer;
use piarc_protocol::memory::{FsMemoryParams, FsMemoryResult, MemorySnapshot};
use piarc_protocol::policy::ApprovalDecision;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

use super::{SessionIo, ToolIo, git_status, lock, memory_reader, policy, to_value};

#[derive(Default)]
pub(super) struct State {
    git: OnceCell<String>,
    opening: Mutex<Option<memory_reader::Collection>>,
    choices: Mutex<HashMap<PathBuf, bool>>,
    scan: AsyncMutex<()>,
    transfer: Mutex<Option<Transfer>>,
}

struct Transfer {
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
            self.collect_memory(&session, Vec::new(), HashMap::new()),
            session.memory.git_status(&session)
        );
        *lock(&session.memory.opening) = Some(files?);
        Ok(())
    }

    async fn collect_memory(
        &self,
        session: &SessionIo,
        dirs: Vec<String>,
        choices: HashMap<PathBuf, bool>,
    ) -> Result<memory_reader::Collection, ErrorObject> {
        let config = Arc::clone(&self.config);
        let scope = session.scope.clone();
        tokio::task::spawn_blocking(move || {
            let table = piarc_config::LayerTable::piarc(&config.data_dir, scope.root());
            // This setting governs the choice of two documents; project code is never enabled.
            let settings = piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
            let both = settings.get("/memory/readBoth").and_then(Value::as_bool) == Some(true);
            memory_reader::collect(
                &scope,
                config.memory_home.as_deref(),
                &config.data_dir,
                &dirs,
                both,
                |path| choices.get(path).copied(),
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
        let mut choices = lock(&session.memory.choices).clone();
        let dirs = p.directories.unwrap_or_default();
        let first = p.include_git == Some(true) && dirs.is_empty();
        let mut opening = if first {
            lock(&session.memory.opening).take()
        } else {
            None
        };
        let files = loop {
            if generation.is_cancelled() || peer.is_closed() {
                return Err(policy::denied("Memory import cancelled."));
            }
            let current = match opening.take() {
                Some(snapshot) => snapshot,
                None => {
                    self.collect_memory(&session, dirs.clone(), choices.clone())
                        .await?
                }
            };
            if current.pending.is_empty() {
                break current.files;
            }
            for path in current.pending {
                if choices.contains_key(&path) {
                    continue;
                }
                let decision = match &self.policy {
                    Some(svc) => {
                        policy::memory::approve(
                            svc,
                            &session,
                            &p.session_id,
                            &p.tool_call_id,
                            &path,
                            peer,
                            &generation,
                        )
                        .await?
                    }
                    None => ApprovalDecision::Deny,
                };
                let allow = decision != ApprovalDecision::Deny;
                choices.insert(path.clone(), allow);
                if matches!(
                    decision,
                    ApprovalDecision::AllowSession | ApprovalDecision::Deny
                ) {
                    lock(&session.memory.choices).insert(path, allow);
                }
            }
        };
        let git_status = if p.include_git == Some(true) {
            Some(session.memory.git_status(&session).await.to_owned())
        } else {
            None
        };
        let text = serde_json::to_string(&MemorySnapshot { files, git_status })
            .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?;
        let mut transfer = Transfer {
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
