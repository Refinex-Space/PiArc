//! Whether a session exists in its workspace's Agent Host yet (I233).
//!
//! The session list reports a session open as soon as its actor starts, while Core is still
//! creating, resuming or adopting it in the Agent Host. Requests addressed to the session wait
//! here until that open finishes, so none reaches the Agent Host before the session does; a
//! session that never opens is closed, and closing cancels the waiting requests.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Set once the session was opened in an Agent Host; never cleared.
#[derive(Default)]
pub(crate) struct InHost {
    opened: AtomicBool,
    notify: Notify,
}

impl InHost {
    pub fn is_set(&self) -> bool {
        self.opened.load(Ordering::Acquire)
    }

    pub fn set(&self) {
        self.opened.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    /// Returns once the session is in the Agent Host.
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Registered before the check: a `set` in between still wakes this waiter.
            notified.as_mut().enable();
            if self.is_set() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::InHost;

    #[tokio::test]
    async fn waiters_continue_once_the_session_is_open() {
        let presence = Arc::new(InHost::default());
        let waiting = tokio::spawn({
            let presence = Arc::clone(&presence);
            async move { presence.wait().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiting.is_finished(),
            "waits while the session is not open"
        );
        presence.set();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("woken")
            .expect("joined");
        // Already open: no wait at all.
        tokio::time::timeout(Duration::from_millis(50), presence.wait())
            .await
            .expect("immediate");
    }
}
