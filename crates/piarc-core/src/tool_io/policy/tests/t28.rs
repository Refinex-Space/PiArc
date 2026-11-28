//! T28 through the real Core settings: `fileCheckpointingEnabled` from the merged layers decides
//! whether turns get checkpoints and writes get snapshots.
use super::*;
use crate::checkpoints::{CheckpointConfig, Checkpoints};

impl Fixture {
    /// The fixture with Core's snapshot store, as the runtime builds `ToolIo`.
    async fn with_checkpoints() -> (Self, Checkpoints) {
        let mut f = Self::new().await;
        let cp =
            Checkpoints::open(f.storage.clone(), CheckpointConfig::default()).expect("checkpoints");
        let placeholder = ToolIo::new(ToolIoConfig::new(f.root.join("unused")));
        let io = std::mem::replace(&mut f.io, placeholder);
        f.io = io.with_checkpoints(cp.clone());
        (f, cp)
    }

    fn settings(&self, rel: &str, text: &str) {
        let path = self.root.join("workspace").join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("settings dir");
        std::fs::write(path, text).expect("settings");
    }

    /// Runs what `turn_started` runs in the background, to its end.
    async fn start_turn(&self, turn: &str) {
        let s = self.io.session(SESSION).expect("session");
        self.io
            .checkpoint_creation(&s, SESSION, turn)
            .expect("Core keeps snapshots")
            .await;
    }

    async fn snapshots_on(&self) -> bool {
        let s = self.io.session(SESSION).expect("session");
        self.io.checkpoints_for(&s).await.is_some()
    }
}

#[tokio::test]
async fn file_checkpointing_follows_the_merged_settings() {
    let (f, cp) = Fixture::with_checkpoints().await;
    assert!(f.snapshots_on().await, "on by default");
    f.start_turn("turn-on").await;
    assert!(
        cp.checkpoint_of(SESSION, "turn-on")
            .expect("read")
            .is_some()
    );

    // Claude Code's project file turns it off: no checkpoint, no snapshot store for writes, no
    // code rewind to that turn.
    f.settings(
        ".claude/settings.json",
        r#"{"fileCheckpointingEnabled": false}"#,
    );
    assert!(!f.snapshots_on().await);
    f.start_turn("turn-off").await;
    assert!(
        cp.checkpoint_of(SESSION, "turn-off")
            .expect("read")
            .is_none()
    );
    let preview =
        f.io.rewind_preview(SESSION, "turn-off")
            .await
            .expect("preview");
    assert!(!preview.code_available);
    assert!(
        f.io.rewind_preview(SESSION, "turn-on")
            .await
            .expect("preview")
            .code_available,
        "turns recorded while it was on keep their snapshots"
    );

    // PiArc's project file is a higher layer.
    f.settings(
        ".piarc/settings.json",
        r#"{"permissions":{"allow":["Read(known)"]},"fileCheckpointingEnabled": true}"#,
    );
    assert!(f.snapshots_on().await);
}
