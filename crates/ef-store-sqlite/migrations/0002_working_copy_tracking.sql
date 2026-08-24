CREATE TABLE working_copy_tracking (
    project_id BLOB NOT NULL CHECK (length(project_id) = 32),
    selector TEXT NOT NULL CHECK (
        length(CAST(selector AS BLOB)) BETWEEN 1 AND 4096
    ),
    selector_kind TEXT NOT NULL CHECK (selector_kind IN ('path', 'prefix')),
    tracking TEXT NOT NULL CHECK (tracking IN ('none', 'local', 'project')),
    realm TEXT,
    PRIMARY KEY (project_id, selector_kind, selector),
    FOREIGN KEY (project_id) REFERENCES repository(project_id),
    CHECK (
        (tracking = 'none' AND realm IS NULL)
        OR (tracking = 'local' AND realm IS NOT NULL AND realm = 'local')
        OR (
            tracking = 'project'
            AND realm IS NOT NULL
            AND realm IN ('public', 'members')
        )
    )
) STRICT;

CREATE INDEX working_copy_tracking_project_selector
    ON working_copy_tracking(project_id, selector, selector_kind);

INSERT INTO schema_migrations(version, description)
VALUES (2, 'working-copy tracking intent');
PRAGMA user_version = 2;
