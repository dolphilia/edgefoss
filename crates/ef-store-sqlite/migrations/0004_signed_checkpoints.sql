CREATE TABLE signatures (
    storage_digest BLOB PRIMARY KEY CHECK (length(storage_digest) = 32),
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    artifact_id BLOB NOT NULL CHECK (length(artifact_id) = 32),
    actor_key BLOB NOT NULL CHECK (length(actor_key) = 32),
    canonical_record BLOB NOT NULL CHECK (length(canonical_record) <= 1048576),
    UNIQUE (artifact_id, actor_key),
    FOREIGN KEY (project_id) REFERENCES repository(project_id),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
) STRICT;

CREATE TABLE refs (
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    realm TEXT NOT NULL CHECK (realm IN ('public', 'members', 'local')),
    name TEXT NOT NULL CHECK (
        length(CAST(name AS BLOB)) BETWEEN 1 AND 255
    ),
    target_id BLOB NOT NULL CHECK (length(target_id) = 32),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    PRIMARY KEY (project_id, realm, name),
    FOREIGN KEY (project_id) REFERENCES repository(project_id),
    FOREIGN KEY (target_id) REFERENCES artifacts(id)
) STRICT;

CREATE INDEX signatures_project_artifact
    ON signatures(project_id, artifact_id, actor_key);

CREATE INDEX refs_project_realm
    ON refs(project_id, realm, name);

INSERT INTO schema_migrations(version, description)
VALUES (4, 'signed artifacts and generation-based realm refs');
PRAGMA user_version = 4;
