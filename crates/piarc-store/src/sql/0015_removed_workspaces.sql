-- A workspace the user removed from the sidebar: its row stays (default mode and model) but
-- it is not listed, nor are its sessions, until the folder is opened again.
ALTER TABLE workspaces ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
