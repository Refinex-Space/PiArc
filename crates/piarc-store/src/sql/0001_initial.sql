-- Schema version 1 (T13): architecture section 9.2. Times are Unix milliseconds.

-- Workspaces the user opened. Trust is not stored here: it belongs to the repository's main
-- checkout (`project_trust`), shared by all worktrees of the repository.
CREATE TABLE workspaces (
    path           TEXT    PRIMARY KEY,
    display_name   TEXT    NOT NULL,
    main_checkout  TEXT    NOT NULL,
    last_opened_at INTEGER NOT NULL,
    default_mode   TEXT,
    default_model  TEXT
) STRICT;

-- Session index. Columns up to `index_error` are derived from the Pi JSONL file and rebuilt
-- from it; the columns after them are Core's own state and survive a rebuild.
CREATE TABLE sessions (
    id                 TEXT    PRIMARY KEY,
    file_path          TEXT    NOT NULL UNIQUE,
    cwd                TEXT,
    parent_session     TEXT,
    name               TEXT,
    first_message      TEXT,
    model_provider     TEXT,
    model_id           TEXT,
    message_count      INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_total         REAL    NOT NULL DEFAULT 0,
    created_at         INTEGER,
    updated_at         INTEGER,
    format_version     INTEGER,
    index_status       TEXT    NOT NULL CHECK (index_status IN ('indexed', 'unavailable')),
    index_error        TEXT,
    workspace_path     TEXT,
    status             TEXT,
    worktree           TEXT,
    pinned             INTEGER NOT NULL DEFAULT 0,
    archived           INTEGER NOT NULL DEFAULT 0,
    unread             INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX sessions_by_cwd ON sessions (cwd, updated_at);

-- Incremental sync state, one row per session file: how far it was read.
CREATE TABLE session_files (
    file_path     TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL,
    byte_offset   INTEGER NOT NULL,
    tail_start    INTEGER NOT NULL,
    tail_hash     BLOB    NOT NULL,
    last_entry_id TEXT,
    skipped_lines INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Permission decisions, approval results, hook results, sandbox denials (T20 onwards).
CREATE TABLE audit_events (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    session_id TEXT,
    workspace  TEXT,
    detail     TEXT    NOT NULL
) STRICT;

CREATE INDEX audit_events_by_session ON audit_events (session_id, at);

-- Background commands and subagents (T32).
CREATE TABLE background_tasks (
    id          TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('command', 'subagent')),
    description TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    output_path TEXT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    exit_code   INTEGER,
    metadata    TEXT
) STRICT;

-- Project trust, keyed by the canonical path of the repository's main checkout (T13,
-- architecture section 10.2). `snapshot` is the JSON list of executable items the user saw
-- when deciding.
CREATE TABLE project_trust (
    checkout   TEXT    PRIMARY KEY,
    decision   TEXT    NOT NULL CHECK (decision IN ('trusted', 'denied')),
    decided_at INTEGER NOT NULL,
    snapshot   TEXT    NOT NULL
) STRICT;
