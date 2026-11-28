-- Core owns the lifecycle of directories returned by WorktreeCreate. Keep the
-- ownership after removal so reopening a session uses its hook again.
CREATE TABLE hook_worktrees (
    path TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    identity TEXT NOT NULL
) STRICT;
