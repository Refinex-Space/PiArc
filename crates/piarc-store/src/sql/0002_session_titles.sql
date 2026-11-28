-- Schema version 2 (T18): the title the user gave a session in PiArc. Core's own state like
-- `pinned` and `archived`: it survives an index rebuild and is never written to Pi's JSONL.
ALTER TABLE sessions ADD COLUMN custom_title TEXT;
