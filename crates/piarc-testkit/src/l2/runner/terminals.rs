//! T34's terminal actions: what the terminal panel does with Core's public API — open a
//! terminal for the user in a session (`open_session_terminal`), type into it
//! (`terminal_write`), share it with the agent (`set_terminal_shared`).

use piarc_core::tool_io::UserTerminal;
use serde_json::Value;

use super::{Driver, call};

impl Driver<'_> {
    pub(super) async fn open_terminal(&mut self, session: Option<&str>) -> Result<(), String> {
        let id = self.session_id(session)?;
        let request = UserTerminal {
            size: (80, 24, 8, 16),
            restore: None,
            directory: None,
        };
        let opened = call(
            |done| self.core.open_session_terminal(id.clone(), request, done),
            "opening a terminal",
        )
        .await?;
        let terminal = opened["terminalId"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| format!("open_session_terminal answered {opened}"))?;
        self.terminals.insert(id, terminal);
        Ok(())
    }

    fn terminal(&self, session: Option<&str>) -> Result<u32, String> {
        let id = self.session_id(session)?;
        self.terminals
            .get(&id)
            .copied()
            .ok_or_else(|| "no terminal: open_terminal first".to_owned())
    }

    pub(super) fn type_terminal(&self, session: Option<&str>, text: &str) -> Result<(), String> {
        let terminal = self.terminal(session)?;
        self.core
            .terminal_write(terminal, text.as_bytes().to_vec())
            .map_err(|e| format!("typing: {e}"))
    }

    pub(super) async fn share_terminal(
        &self,
        session: Option<&str>,
        shared: bool,
    ) -> Result<(), String> {
        let terminal = self.terminal(session)?;
        call(
            |done| {
                self.core
                    .set_terminal_shared(terminal, shared, move |changed| {
                        done(changed.map(Value::Bool));
                    })
            },
            "sharing the terminal",
        )
        .await
        .map(drop)
    }
}
