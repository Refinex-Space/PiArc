-- Schema version 17 (ADR-0106): the title Core generated from a session's first message. Core's
-- own state like `custom_title`: it survives an index rebuild and is never written to Pi's JSONL.
-- A user's title (`custom_title`) and Pi's session name come first.
ALTER TABLE sessions ADD COLUMN auto_title TEXT;
