-- NULL on upgrade makes the first sync establish a verified baseline.
ALTER TABLE session_files ADD COLUMN file_identity TEXT;
ALTER TABLE session_files ADD COLUMN modified_ns TEXT;
