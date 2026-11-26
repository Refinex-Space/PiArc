-- Chrome sign-ins imported into a workspace's browser partition (ADR-0090): one row per
-- workspace and site with the number of cookies, when and from which Chrome profile. The
-- cookies themselves are in Chromium's partition storage, never here. The agent's site cards
-- treat these sites as sensitive (B5.4).
CREATE TABLE browser_imports (
    workspace   TEXT    NOT NULL,
    site        TEXT    NOT NULL,
    count       INTEGER NOT NULL,
    profile     TEXT    NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (workspace, site)
) STRICT;
