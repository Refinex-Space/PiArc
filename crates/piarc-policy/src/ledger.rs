//! Pending requests in arrival order. Core serializes ledger mutations and publishes the
//! resulting snapshot. The payload typically owns the channel that wakes the waiting caller.

use piarc_protocol::policy::{AnswerStatus, ApprovalAnswer, ApprovalRequest};

/// The authoritative set of requests awaiting one valid answer.
#[derive(Debug)]
pub struct Ledger<T> {
    pending: Vec<(ApprovalRequest, T)>,
}

impl<T> Default for Ledger<T> {
    fn default() -> Self {
        Self {
            pending: Vec::new(),
        }
    }
}

impl<T> Ledger<T> {
    /// Insert a new, unique request. Returns false on an identifier collision.
    pub fn insert(&mut self, request: ApprovalRequest, pending: T) -> bool {
        if self.pending().any(|r| r.request_id == request.request_id) {
            return false;
        }
        self.pending.push((request, pending));
        true
    }

    /// The immutable card data for the next snapshot, oldest first.
    pub fn pending(&self) -> impl Iterator<Item = &ApprovalRequest> {
        self.pending.iter().map(|(r, _)| r)
    }

    /// Atomically take ownership of the valid request for the winning responder.
    ///
    /// # Errors
    ///
    /// An absent request was already handled. A mismatch leaves the real request pending.
    pub fn claim(&mut self, answer: &ApprovalAnswer) -> Result<(ApprovalRequest, T), AnswerStatus> {
        let position = self
            .pending
            .iter()
            .position(|(r, _)| r.request_id == answer.request_id)
            .ok_or(AnswerStatus::AlreadyHandled)?;
        let (request, _) = &self.pending[position];
        if request.session_id != answer.session_id
            || request.revision != answer.revision
            || request.connection_epoch != answer.connection_epoch
        {
            return Err(AnswerStatus::Stale);
        }
        Ok(self.pending.remove(position))
    }

    /// Take the first request matching the caller's identity and connection.
    pub fn take_if(
        &mut self,
        matches: impl Fn(&ApprovalRequest, &T) -> bool,
    ) -> Option<(ApprovalRequest, T)> {
        let i = self
            .pending
            .iter()
            .position(|(request, wait)| matches(request, wait))?;
        Some(self.pending.remove(i))
    }

    /// Take all the interrupted session's requests; Core answers each one with a refusal.
    pub fn cancel_session(&mut self, id: &str) -> Vec<(ApprovalRequest, T)> {
        self.cancel_session_if(id, |_| true)
    }

    /// Remove only matching requests when work for a following turn has already begun.
    pub fn cancel_session_if(
        &mut self,
        id: &str,
        mut matches: impl FnMut(&ApprovalRequest) -> bool,
    ) -> Vec<(ApprovalRequest, T)> {
        self.pending
            .extract_if(.., |(r, _)| r.session_id == id && matches(r))
            .collect()
    }

    /// Take requests from previous connections of this session. Core denies them on restore.
    pub fn invalidate(&mut self, id: &str, epoch: u64) -> Vec<(ApprovalRequest, T)> {
        self.pending
            .extract_if(.., |(r, _)| {
                r.session_id == id && r.connection_epoch != epoch
            })
            .collect()
    }
}
