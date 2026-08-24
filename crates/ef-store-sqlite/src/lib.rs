//! Transactional local `SQLite` storage for portable `EdgeFossil` state.

use std::{error::Error, fmt, path::Path};

use ef_format::{
    FormatError, PathError, ProjectGenesis, Realm, artifact_id, decode_project_genesis,
    encode_project_genesis, parse_artifact_id, validate_path, verify_artifact_id,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

const SCHEMA_VERSION: i64 = 2;
const MIGRATION_1: &str = include_str!("../migrations/0001_repository_identity.sql");
const MIGRATION_2: &str = include_str!("../migrations/0002_working_copy_tracking.sql");

/// Storage failure with a stable distinction for initialization conflicts.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Format(FormatError),
    Path(PathError),
    AlreadyInitialized,
    Uninitialized,
    InvalidTracking(String),
    Corrupt(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite error: {error}"),
            Self::Format(error) => write!(formatter, "format error: {error}"),
            Self::Path(error) => write!(formatter, "path error: {error}"),
            Self::AlreadyInitialized => {
                formatter.write_str("repository already has another project")
            }
            Self::Uninitialized => formatter.write_str("repository is not initialized"),
            Self::InvalidTracking(message) => write!(formatter, "invalid tracking rule: {message}"),
            Self::Corrupt(message) => write!(formatter, "repository corruption: {message}"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Format(error) => Some(error),
            Self::Path(error) => Some(error),
            Self::AlreadyInitialized
            | Self::Uninitialized
            | Self::InvalidTracking(_)
            | Self::Corrupt(_) => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<FormatError> for StoreError {
    fn from(error: FormatError) -> Self {
        Self::Format(error)
    }
}

impl From<PathError> for StoreError {
    fn from(error: PathError) -> Self {
        Self::Path(error)
    }
}

/// Whether a working-copy selector denotes one path or a directory subtree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackingScope {
    Path,
    Prefix,
}

impl TrackingScope {
    /// Returns the stable CLI/storage spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Path => "path",
            Self::Prefix => "prefix",
        }
    }

    fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "path" => Ok(Self::Path),
            "prefix" => Ok(Self::Prefix),
            _ => Err(StoreError::Corrupt(format!(
                "unknown tracking selector kind {value}"
            ))),
        }
    }
}

/// The history destination selected for a working-copy path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackingMode {
    None,
    Local,
    Project,
}

impl TrackingMode {
    /// Returns the stable CLI/storage spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Local => "local",
            Self::Project => "project",
        }
    }

    fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "none" => Ok(Self::None),
            "local" => Ok(Self::Local),
            "project" => Ok(Self::Project),
            _ => Err(StoreError::Corrupt(format!(
                "unknown tracking mode {value}"
            ))),
        }
    }
}

/// One device-local selector and its intended tracking destination.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrackingRule {
    selector: String,
    scope: TrackingScope,
    mode: TrackingMode,
    realm: Option<Realm>,
}

impl TrackingRule {
    /// Constructs and validates a working-copy tracking rule.
    ///
    /// # Errors
    ///
    /// Returns an error for a non-portable selector or an inconsistent
    /// tracking/realm combination.
    pub fn new(
        selector: impl Into<String>,
        scope: TrackingScope,
        mode: TrackingMode,
        realm: Option<Realm>,
    ) -> Result<Self, StoreError> {
        let selector = selector.into();
        validate_path(&selector)?;
        let valid = matches!(
            (mode, realm),
            (TrackingMode::None, None)
                | (TrackingMode::Local, Some(Realm::Local))
                | (TrackingMode::Project, Some(Realm::Public | Realm::Members))
        );
        if !valid {
            return Err(StoreError::InvalidTracking(
                "none has no realm, local uses local, and project uses public or members".into(),
            ));
        }
        Ok(Self {
            selector,
            scope,
            mode,
            realm,
        })
    }

    /// Returns the canonical path or directory-prefix selector.
    #[must_use]
    pub fn selector(&self) -> &str {
        &self.selector
    }

    /// Returns whether this selector is exact or covers a subtree.
    #[must_use]
    pub const fn scope(&self) -> TrackingScope {
        self.scope
    }

    /// Returns the selected history destination.
    #[must_use]
    pub const fn mode(&self) -> TrackingMode {
        self.mode
    }

    /// Returns the artifact realm, or `None` for untracked state.
    #[must_use]
    pub const fn realm(&self) -> Option<Realm> {
        self.realm
    }
}

/// Counts of explicit working-copy tracking rules by history destination.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TrackingCounts {
    pub none: usize,
    pub local: usize,
    pub project: usize,
}

/// One open local repository database.
pub struct LocalRepository {
    connection: Connection,
}

impl LocalRepository {
    /// Opens or creates a repository database and applies known migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if `SQLite` cannot open, configure, or migrate the file.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    /// Opens an in-memory repository, primarily for tests and ephemeral tools.
    ///
    /// # Errors
    ///
    /// Returns an error if `SQLite` configuration or migration fails.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, StoreError> {
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA trusted_schema = OFF;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;",
        )?;
        let mut repository = Self { connection };
        repository.migrate()?;
        Ok(repository)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        loop {
            let version: i64 = self
                .connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))?;
            let migration = match version {
                0 => MIGRATION_1,
                1 => MIGRATION_2,
                SCHEMA_VERSION => return Ok(()),
                other => {
                    return Err(StoreError::Corrupt(format!(
                        "unsupported schema version {other}"
                    )));
                }
            };
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(migration)?;
            transaction.commit()?;
        }
    }

    /// Returns the current local schema version.
    ///
    /// # Errors
    ///
    /// Returns an error when the version cannot be queried.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// Initializes the database with one canonical project genesis artifact.
    ///
    /// Repeating the same initialization is idempotent. A different project is
    /// rejected without altering the existing repository.
    ///
    /// # Errors
    ///
    /// Returns a format, `SQLite`, corruption, or initialization-conflict error.
    pub fn init_project(&mut self, genesis: &ProjectGenesis) -> Result<String, StoreError> {
        let body = encode_project_genesis(genesis)?;
        let project_id = artifact_id(&body);
        let digest = parse_artifact_id(&project_id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT project_id FROM repository WHERE singleton = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing.as_slice() != digest {
                return Err(StoreError::AlreadyInitialized);
            }
            let (stored_project, realm, kind, schema_version, existing_body): (
                Vec<u8>,
                String,
                String,
                i64,
                Vec<u8>,
            ) = transaction.query_row(
                "SELECT project_id, realm, kind, schema_version, canonical_body
                 FROM artifacts WHERE id = ?1",
                params![digest.as_slice()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            if stored_project.as_slice() != digest
                || realm != "public"
                || kind != "project.genesis"
                || schema_version != 0
                || existing_body != body
            {
                return Err(StoreError::Corrupt(
                    "genesis row does not match repository identity".into(),
                ));
            }
            transaction.commit()?;
            return Ok(project_id);
        }

        transaction.execute(
            "INSERT INTO artifacts(id, project_id, realm, kind, schema_version, canonical_body)
             VALUES (?1, ?1, 'public', 'project.genesis', 0, ?2)",
            params![digest.as_slice(), body],
        )?;
        transaction.execute(
            "INSERT INTO repository(singleton, project_id, format_status)
             VALUES (1, ?1, 'experimental')",
            params![digest.as_slice()],
        )?;
        transaction.commit()?;
        Ok(project_id)
    }

    /// Returns the initialized project ID, if any.
    ///
    /// # Errors
    ///
    /// Returns an error for `SQLite` failure or malformed stored identity bytes.
    pub fn project_id(&self) -> Result<Option<String>, StoreError> {
        let digest = self
            .connection
            .query_row(
                "SELECT project_id FROM repository WHERE singleton = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        digest
            .map(|digest| {
                let digest: [u8; 32] = digest
                    .try_into()
                    .map_err(|_| StoreError::Corrupt("project_id is not 32 bytes".into()))?;
                Ok(ef_format::format_artifact_id(&digest))
            })
            .transpose()
    }

    /// Loads and revalidates the canonical project genesis artifact.
    ///
    /// # Errors
    ///
    /// Returns an error for `SQLite` failure, malformed stored bytes, or an ID
    /// mismatch. A never-initialized database returns `None`.
    pub fn project_genesis(&self) -> Result<Option<ProjectGenesis>, StoreError> {
        let Some(project_id) = self.project_id()? else {
            return Ok(None);
        };
        let digest = parse_artifact_id(&project_id)?;
        let (stored_project, realm, kind, schema_version, body): (
            Vec<u8>,
            String,
            String,
            i64,
            Vec<u8>,
        ) = self
            .connection
            .query_row(
                "SELECT project_id, realm, kind, schema_version, canonical_body
                 FROM artifacts WHERE id = ?1",
                params![digest.as_slice()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::Corrupt("genesis artifact is missing".into()))?;
        if stored_project.as_slice() != digest
            || realm != "public"
            || kind != "project.genesis"
            || schema_version != 0
        {
            return Err(StoreError::Corrupt(
                "genesis row metadata is invalid".into(),
            ));
        }
        verify_artifact_id(&body, &project_id)?;
        Ok(Some(decode_project_genesis(&body)?))
    }

    /// Runs `SQLite`'s lightweight structural integrity check.
    ///
    /// # Errors
    ///
    /// Returns an error if `SQLite` reports damage or the check cannot run.
    pub fn quick_check(&self) -> Result<(), StoreError> {
        let result: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if result != "ok" {
            return Err(StoreError::Corrupt(result));
        }
        Ok(())
    }

    /// Inserts or replaces one device-local working-copy tracking rule.
    ///
    /// This state is not a portable policy artifact and is not stored in the
    /// artifact graph.
    ///
    /// # Errors
    ///
    /// Returns an error when the repository is uninitialized or the write
    /// cannot be committed.
    pub fn set_tracking_rule(&mut self, rule: &TrackingRule) -> Result<(), StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO working_copy_tracking(
                 project_id, selector, selector_kind, tracking, realm
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_id, selector_kind, selector) DO UPDATE SET
                 tracking = excluded.tracking,
                 realm = excluded.realm",
            params![
                project_id.as_slice(),
                rule.selector,
                rule.scope.as_str(),
                rule.mode.as_str(),
                rule.realm.map(Realm::as_str)
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Lists explicit tracking rules in deterministic selector order.
    ///
    /// # Errors
    ///
    /// Returns an error for uninitialized, unreadable, or invalid stored state.
    pub fn tracking_rules(&self) -> Result<Vec<TrackingRule>, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let mut statement = self.connection.prepare(
            "SELECT selector, selector_kind, tracking, realm
             FROM working_copy_tracking
             WHERE project_id = ?1
             ORDER BY selector, selector_kind",
        )?;
        let rows = statement.query_map(params![project_id.as_slice()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (selector, scope, mode, realm) = row?;
            decode_tracking_rule(selector, &scope, &mode, realm.as_deref())
        })
        .collect()
    }

    /// Resolves one path using exact-first, longest-prefix precedence.
    ///
    /// A missing rule resolves to `None`, meaning the implicit `none` default.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid path or unreadable stored state.
    pub fn resolve_tracking(&self, path: &str) -> Result<Option<TrackingRule>, StoreError> {
        validate_path(path)?;
        let rules = self.tracking_rules()?;
        if let Some(rule) = rules
            .iter()
            .find(|rule| rule.scope == TrackingScope::Path && rule.selector == path)
        {
            return Ok(Some(rule.clone()));
        }
        Ok(rules
            .into_iter()
            .filter(|rule| {
                rule.scope == TrackingScope::Prefix
                    && (path == rule.selector
                        || path
                            .strip_prefix(&rule.selector)
                            .is_some_and(|suffix| suffix.starts_with('/')))
            })
            .max_by_key(|rule| rule.selector.len()))
    }

    /// Counts explicit rules by tracking destination.
    ///
    /// # Errors
    ///
    /// Returns an error for uninitialized, unreadable, or invalid stored state.
    pub fn tracking_counts(&self) -> Result<TrackingCounts, StoreError> {
        let mut counts = TrackingCounts::default();
        for rule in self.tracking_rules()? {
            match rule.mode {
                TrackingMode::None => counts.none += 1,
                TrackingMode::Local => counts.local += 1,
                TrackingMode::Project => counts.project += 1,
            }
        }
        Ok(counts)
    }

    fn project_digest(&self) -> Result<Option<[u8; 32]>, StoreError> {
        let digest = self
            .connection
            .query_row(
                "SELECT project_id FROM repository WHERE singleton = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        digest
            .map(|digest| {
                digest
                    .try_into()
                    .map_err(|_| StoreError::Corrupt("project_id is not 32 bytes".into()))
            })
            .transpose()
    }
}

fn decode_tracking_rule(
    selector: String,
    scope: &str,
    mode: &str,
    realm: Option<&str>,
) -> Result<TrackingRule, StoreError> {
    let scope = TrackingScope::parse(scope)?;
    let mode = TrackingMode::parse(mode)?;
    let realm = match realm {
        Some("public") => Some(Realm::Public),
        Some("members") => Some(Realm::Members),
        Some("local") => Some(Realm::Local),
        Some(other) => {
            return Err(StoreError::Corrupt(format!(
                "unknown tracking realm {other}"
            )));
        }
        None => None,
    };
    TrackingRule::new(selector, scope, mode, realm)
        .map_err(|error| StoreError::Corrupt(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{
        LocalRepository, MIGRATION_1, SCHEMA_VERSION, StoreError, TrackingCounts, TrackingMode,
        TrackingRule, TrackingScope,
    };
    use ef_format::{
        ProjectGenesis, Realm, artifact_id, encode_project_genesis, parse_artifact_id,
    };
    use rusqlite::{Connection, params};

    fn genesis(nonce_byte: u8) -> ProjectGenesis {
        ProjectGenesis {
            name: "EdgeFossil".into(),
            nonce: [nonce_byte; 32],
            actor_key: [0x20; 32],
            created_at: "2026-08-24T00:00:00Z".into(),
        }
    }

    fn temporary_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "edgefoss-store-{}-{}.sqlite3",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    #[test]
    fn migrates_empty_database() {
        let repository = LocalRepository::open_in_memory().unwrap();
        assert_eq!(repository.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(repository.project_id().unwrap(), None);
        repository.quick_check().unwrap();
    }

    #[test]
    fn migrates_schema_one_database_without_losing_identity() {
        let path = temporary_path();
        let _ = fs::remove_file(&path);
        let genesis = genesis(7);
        {
            let mut connection = Connection::open(&path).unwrap();
            connection.execute_batch(MIGRATION_1).unwrap();
            let body = encode_project_genesis(&genesis).unwrap();
            let project_id = artifact_id(&body);
            let digest = parse_artifact_id(&project_id).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO artifacts(
                         id, project_id, realm, kind, schema_version, canonical_body
                     ) VALUES (?1, ?1, 'public', 'project.genesis', 0, ?2)",
                    params![digest.as_slice(), body],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO repository(singleton, project_id, format_status)
                     VALUES (1, ?1, 'experimental')",
                    params![digest.as_slice()],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        {
            let repository = LocalRepository::open(&path).unwrap();
            assert_eq!(repository.schema_version().unwrap(), SCHEMA_VERSION);
            let migration_count: i64 = repository
                .connection
                .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(migration_count, 2);
            assert_eq!(repository.project_genesis().unwrap(), Some(genesis));
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn initialization_is_idempotent_and_revalidated() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let genesis = genesis(1);
        let project_id = repository.init_project(&genesis).unwrap();
        assert_eq!(repository.init_project(&genesis).unwrap(), project_id);
        assert_eq!(
            repository.project_id().unwrap().as_deref(),
            Some(project_id.as_str())
        );
        assert_eq!(repository.project_genesis().unwrap(), Some(genesis));
    }

    #[test]
    fn persists_the_shared_project_genesis_identity() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let genesis = ProjectGenesis {
            name: "EdgeFossil".into(),
            nonce: std::array::from_fn(|index| u8::try_from(index).unwrap()),
            actor_key: std::array::from_fn(|index| u8::try_from(index + 0x20).unwrap()),
            created_at: "2026-08-24T00:00:00Z".into(),
        };
        let project_id = repository.init_project(&genesis).unwrap();
        assert_eq!(
            project_id,
            "sha256:78ac6588c390ceb2d29f2be9ff9e001d8af391985c0cf865b365ed69b786656e"
        );
        assert_eq!(repository.project_genesis().unwrap(), Some(genesis));
    }

    #[test]
    fn rejects_a_second_project_without_mutation() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let first = genesis(1);
        let first_id = repository.init_project(&first).unwrap();
        assert!(matches!(
            repository.init_project(&genesis(2)),
            Err(StoreError::AlreadyInitialized)
        ));
        assert_eq!(repository.project_id().unwrap(), Some(first_id));
        assert_eq!(repository.project_genesis().unwrap(), Some(first));
    }

    #[test]
    fn detects_corrupt_genesis_metadata() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        repository.init_project(&genesis(4)).unwrap();
        repository
            .connection
            .execute("UPDATE artifacts SET kind = 'tree'", [])
            .unwrap();
        assert!(matches!(
            repository.project_genesis(),
            Err(StoreError::Corrupt(_))
        ));
    }

    #[test]
    fn tracking_requires_an_initialized_repository() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let rule = TrackingRule::new(
            "src",
            TrackingScope::Prefix,
            TrackingMode::Project,
            Some(Realm::Public),
        )
        .unwrap();
        assert!(matches!(
            repository.set_tracking_rule(&rule),
            Err(StoreError::Uninitialized)
        ));
    }

    #[test]
    fn validates_tracking_mode_and_realm_combinations() {
        assert!(TrackingRule::new("src", TrackingScope::Prefix, TrackingMode::None, None).is_ok());
        assert!(
            TrackingRule::new(
                "notes",
                TrackingScope::Prefix,
                TrackingMode::Local,
                Some(Realm::Local)
            )
            .is_ok()
        );
        assert!(
            TrackingRule::new(
                "ops",
                TrackingScope::Prefix,
                TrackingMode::Project,
                Some(Realm::Members)
            )
            .is_ok()
        );
        assert!(matches!(
            TrackingRule::new(
                "bad",
                TrackingScope::Path,
                TrackingMode::Project,
                Some(Realm::Local)
            ),
            Err(StoreError::InvalidTracking(_))
        ));
    }

    #[test]
    fn schema_rejects_missing_realm_for_tracked_rows() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        repository.init_project(&genesis(6)).unwrap();
        let project_id = repository.project_digest().unwrap().unwrap();
        let result = repository.connection.execute(
            "INSERT INTO working_copy_tracking(
                 project_id, selector, selector_kind, tracking, realm
             ) VALUES (?1, 'src', 'prefix', 'project', NULL)",
            params![project_id.as_slice()],
        );
        assert!(result.is_err());
    }

    #[test]
    fn persists_and_resolves_tracking_with_exact_first_longest_prefix() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        repository.init_project(&genesis(5)).unwrap();
        for rule in [
            TrackingRule::new(
                "src",
                TrackingScope::Prefix,
                TrackingMode::Project,
                Some(Realm::Public),
            )
            .unwrap(),
            TrackingRule::new(
                "src/internal",
                TrackingScope::Prefix,
                TrackingMode::Project,
                Some(Realm::Members),
            )
            .unwrap(),
            TrackingRule::new(
                "src/internal/README.md",
                TrackingScope::Path,
                TrackingMode::None,
                None,
            )
            .unwrap(),
            TrackingRule::new(
                "notes",
                TrackingScope::Prefix,
                TrackingMode::Local,
                Some(Realm::Local),
            )
            .unwrap(),
        ] {
            repository.set_tracking_rule(&rule).unwrap();
        }

        assert_eq!(
            repository
                .resolve_tracking("src/lib.rs")
                .unwrap()
                .unwrap()
                .realm,
            Some(Realm::Public)
        );
        assert_eq!(
            repository
                .resolve_tracking("src/internal/mod.rs")
                .unwrap()
                .unwrap()
                .realm,
            Some(Realm::Members)
        );
        assert_eq!(
            repository
                .resolve_tracking("src/internal/README.md")
                .unwrap()
                .unwrap()
                .mode,
            TrackingMode::None
        );
        assert!(
            repository
                .resolve_tracking("src-other/file")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            repository.tracking_counts().unwrap(),
            TrackingCounts {
                none: 1,
                local: 1,
                project: 2,
            }
        );

        let replacement = TrackingRule::new(
            "src/internal/README.md",
            TrackingScope::Path,
            TrackingMode::Local,
            Some(Realm::Local),
        )
        .unwrap();
        repository.set_tracking_rule(&replacement).unwrap();
        assert_eq!(
            repository
                .resolve_tracking("src/internal/README.md")
                .unwrap(),
            Some(replacement)
        );
    }

    #[test]
    fn persists_across_reopen() {
        let path = temporary_path();
        let _ = fs::remove_file(&path);
        let genesis = genesis(3);
        let project_id = {
            let mut repository = LocalRepository::open(&path).unwrap();
            repository.init_project(&genesis).unwrap()
        };
        {
            let repository = LocalRepository::open(&path).unwrap();
            assert_eq!(repository.project_id().unwrap(), Some(project_id));
            assert_eq!(repository.project_genesis().unwrap(), Some(genesis));
            let journal_mode: String = repository
                .connection
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            let foreign_keys: i64 = repository
                .connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap();
            let synchronous: i64 = repository
                .connection
                .query_row("PRAGMA synchronous", [], |row| row.get(0))
                .unwrap();
            assert_eq!(journal_mode, "wal");
            assert_eq!(foreign_keys, 1);
            assert_eq!(synchronous, 2);
            repository.quick_check().unwrap();
        }
        fs::remove_file(path).unwrap();
    }
}
