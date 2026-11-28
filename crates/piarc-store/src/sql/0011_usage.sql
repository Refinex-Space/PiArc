-- Usage and cost (T41): one row per model request a session file records (an assistant
-- message's usage, or an auxiliary call's `piarc.auxiliaryUsage` entry), derived from the JSONL
-- like `session_text` and rebuilt with it; `model_prices` keeps the catalog prices Core last saw
-- (pi-ai's `cost` as JSON), so a report has them without an Agent Host. User prices are in the
-- settings (`modelPrices`).
CREATE TABLE usage_records (
    session_id             TEXT    NOT NULL,
    entry_id               TEXT,
    at                     INTEGER,
    kind                   TEXT    NOT NULL,
    purpose                TEXT,
    provider               TEXT    NOT NULL,
    model                  TEXT    NOT NULL,
    input_tokens           INTEGER NOT NULL,
    output_tokens          INTEGER NOT NULL,
    cache_read_tokens      INTEGER NOT NULL,
    cache_write_tokens     INTEGER NOT NULL,
    cache_write_1h_tokens  INTEGER NOT NULL,
    reasoning_tokens       INTEGER NOT NULL
) STRICT;
CREATE INDEX usage_records_session ON usage_records (session_id);
CREATE INDEX usage_records_model ON usage_records (provider, model);

CREATE TABLE model_prices (
    provider   TEXT    NOT NULL,
    model      TEXT    NOT NULL,
    price      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model)
) STRICT;

-- Existing sessions are read again from the start, which fills `usage_records`.
DELETE FROM session_files;
