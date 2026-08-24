CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL
) STRICT;

CREATE TABLE repository (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    project_id BLOB NOT NULL UNIQUE CHECK (length(project_id) = 32),
    format_status TEXT NOT NULL CHECK (format_status = 'experimental'),
    FOREIGN KEY (project_id) REFERENCES artifacts(id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE artifacts (
    id BLOB PRIMARY KEY CHECK (length(id) = 32),
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    realm TEXT NOT NULL CHECK (realm IN ('public', 'members', 'local')),
    kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
    canonical_body BLOB NOT NULL CHECK (length(canonical_body) <= 1048576),
    FOREIGN KEY (project_id) REFERENCES repository(project_id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX artifacts_project_realm_kind
    ON artifacts(project_id, realm, kind, id);

INSERT INTO schema_migrations(version, description)
VALUES (1, 'repository identity and canonical artifact storage');
PRAGMA user_version = 1;
