-- Subagents (T31, ADR-0048): a child session's file starts with a `piarc.subagent` entry
-- naming its parent and type. Both columns are derived from the file (cleared and read again
-- by a rebuild); the sidebar leaves such sessions out.
ALTER TABLE sessions ADD COLUMN subagent_parent TEXT;
ALTER TABLE sessions ADD COLUMN subagent_type TEXT;

-- A write a subagent made is recorded under its main session's turn, with the subagent's own
-- session id here (NULL: the main session wrote it).
ALTER TABLE checkpoint_files ADD COLUMN subagent_session TEXT;
