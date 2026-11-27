-- The Pi package market (ADR-0102): npm packages with the `pi-package` keyword as the registry
-- search answered, cached so the market opens without a request and works offline. `kw_kinds`
-- are the resource kinds the keywords name, `manifest_kinds` those of the package's `pi`
-- manifest at `manifest_version` (bits: 1 extension, 2 skill, 4 prompt, 8 theme); the manifest
-- decides once it describes the current version. `indexed` marks rows of the popularity index
-- (the last full sync, generation `sync_gen`); rows only a search found have `indexed = 0`.
CREATE TABLE market_packages (
    name              TEXT    PRIMARY KEY NOT NULL,
    version           TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    keywords          TEXT    NOT NULL DEFAULT '[]',
    publisher         TEXT    NOT NULL DEFAULT '',
    license           TEXT,
    updated_ms        INTEGER NOT NULL DEFAULT 0,
    downloads_monthly INTEGER NOT NULL DEFAULT 0,
    insecure          INTEGER NOT NULL DEFAULT 0,
    npm_url           TEXT,
    repo_url          TEXT,
    homepage_url      TEXT,
    kw_kinds          INTEGER NOT NULL DEFAULT 0,
    manifest_kinds    INTEGER,
    manifest_version  TEXT,
    deprecated        INTEGER NOT NULL DEFAULT 0,
    indexed           INTEGER NOT NULL DEFAULT 0,
    sync_gen          INTEGER NOT NULL DEFAULT 0,
    seen_ms           INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX market_packages_downloads ON market_packages (downloads_monthly DESC, name);
CREATE INDEX market_packages_updated ON market_packages (updated_ms DESC, name);

-- The one row of the market's sync state.
CREATE TABLE market_sync (
    id          INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    gen         INTEGER NOT NULL DEFAULT 0,
    state       TEXT    NOT NULL DEFAULT 'idle',
    done        INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    started_ms  INTEGER NOT NULL DEFAULT 0,
    finished_ms INTEGER NOT NULL DEFAULT 0,
    ok_ms       INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
) STRICT;
