-- MCP servers (T36): what the user turned on or off for a workspace in the settings window.
-- The definitions stay in the configuration files; a row overrides their `enabled`.
CREATE TABLE mcp_servers (
    workspace  TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    changed_at INTEGER NOT NULL,
    PRIMARY KEY (workspace, name)
) STRICT;
