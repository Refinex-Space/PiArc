-- Exact, workspace-specific user consent to include an external file in model context.
CREATE TABLE memory_imports (
    workspace TEXT NOT NULL,
    target    TEXT NOT NULL,
    PRIMARY KEY (workspace, target)
) STRICT;
