-- File snapshots (ADR-0011, ADR-0044). One row per user turn of a session, in turn order; one
-- row per write through Core, in write order. Hashes are hex SHA-256 of objects in
-- `<data>/checkpoints/objects/`; a missing hash means the file did not exist.
CREATE TABLE checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    turn_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, turn_id)
) STRICT;

CREATE TABLE checkpoint_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints (id) ON DELETE CASCADE,
    path          TEXT    NOT NULL,
    before_hash   TEXT,
    after_hash    TEXT,
    operation     TEXT    NOT NULL
        CHECK (operation IN ('create', 'modify', 'restore', 'undo', 'discard')),
    restore_id    TEXT
) STRICT;

CREATE INDEX checkpoint_files_checkpoint ON checkpoint_files (checkpoint_id);

-- When each session last used its snapshots (opened, or a checkpoint created), for the 30-day
-- cleanup.
CREATE TABLE checkpoint_sessions (
    session_id  TEXT    PRIMARY KEY,
    accessed_at INTEGER NOT NULL
) STRICT;
