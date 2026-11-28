-- Worktrees and full-text search (T35, architecture sections 6.12, 9.2, 9.3).
--
-- Core's own columns of a session in a worktree: its branch (the directory is the existing
-- `worktree` column), when its worktree is due for cleanup after archiving, whether the
-- cleanup found uncommitted changes and waits for the user, and when it was removed (the
-- branch stays, so the worktree can be added again).
ALTER TABLE sessions ADD COLUMN worktree_branch TEXT;
ALTER TABLE sessions ADD COLUMN worktree_cleanup_at INTEGER;
ALTER TABLE sessions ADD COLUMN worktree_confirm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN worktree_removed_at INTEGER;

-- The searchable text of each session: user messages and the text of assistant replies, one
-- row per entry, derived from the session files like the other index columns.
CREATE TABLE session_text (
    id         INTEGER PRIMARY KEY,
    session_id TEXT    NOT NULL,
    entry_id   TEXT,
    role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    at         INTEGER,
    text       TEXT    NOT NULL
) STRICT;

CREATE INDEX session_text_by_session ON session_text (session_id);

-- Trigram tokens find substrings in any script, Chinese included; queries shorter than three
-- characters are answered from `session_text` instead.
CREATE VIRTUAL TABLE session_fts USING fts5(
    text,
    content = 'session_text',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER session_text_added AFTER INSERT ON session_text BEGIN
    INSERT INTO session_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER session_text_removed AFTER DELETE ON session_text BEGIN
    INSERT INTO session_fts (session_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Existing sessions are read again so that their text is indexed.
DELETE FROM session_files;
