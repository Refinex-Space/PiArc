-- Background tasks (T32, ADR-0049): the table of schema v1 was never written. It is rebuilt
-- for the task manager: the main session a task belongs to, its workspace, title, working
-- directory and output size; `kind` has no CHECK so later kinds (T33's terminal tasks) need
-- no rebuild. `metadata` holds the rest of Core's record as JSON.
DROP TABLE background_tasks;

CREATE TABLE background_tasks (
    id               TEXT    PRIMARY KEY,
    session_id       TEXT    NOT NULL,
    owner_session_id TEXT    NOT NULL,
    workspace        TEXT    NOT NULL,
    kind             TEXT    NOT NULL,
    title            TEXT    NOT NULL,
    cwd              TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    output_path      TEXT,
    output_bytes     INTEGER NOT NULL DEFAULT 0,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    exit_code        INTEGER,
    metadata         TEXT    NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX background_tasks_by_owner ON background_tasks (owner_session_id, started_at);
CREATE INDEX background_tasks_by_workspace ON background_tasks (workspace, started_at);
