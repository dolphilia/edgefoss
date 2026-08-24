CREATE TABLE blobs (
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    realm TEXT NOT NULL CHECK (realm IN ('public', 'members', 'local')),
    digest BLOB NOT NULL CHECK (length(digest) = 32),
    content BLOB NOT NULL,
    PRIMARY KEY (project_id, realm, digest),
    FOREIGN KEY (project_id) REFERENCES repository(project_id)
) STRICT;

CREATE TABLE working_snapshot_roots (
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    realm TEXT NOT NULL CHECK (realm IN ('public', 'members', 'local')),
    root_id BLOB NOT NULL CHECK (length(root_id) = 32),
    captured_at TEXT NOT NULL,
    PRIMARY KEY (project_id, realm),
    FOREIGN KEY (project_id) REFERENCES repository(project_id),
    FOREIGN KEY (root_id) REFERENCES artifacts(id)
) STRICT;

CREATE INDEX blobs_project_realm_digest
    ON blobs(project_id, realm, digest);

INSERT INTO schema_migrations(version, description)
VALUES (3, 'realm-isolated blobs and working snapshot roots');
PRAGMA user_version = 3;
