-- Extension packages (T40): Claude Code plugins and Pi packages Core installed. Whether a
-- package is on, and for which workspaces, is in the settings (`plugins`); `confirmed` is the
-- set of executable items the user confirmed (a JSON array of item names, ADR-0058).
CREATE TABLE packages (
    id           TEXT    PRIMARY KEY NOT NULL,
    kind         TEXT    NOT NULL,
    source_kind  TEXT    NOT NULL,
    location     TEXT    NOT NULL,
    path         TEXT    NOT NULL,
    git_commit   TEXT,
    version      TEXT,
    integrity    TEXT,
    confirmed    TEXT    NOT NULL DEFAULT '[]',
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;
