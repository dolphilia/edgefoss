//! Transactional local `SQLite` storage for portable `EdgeFossil` state.

use std::{error::Error, fmt, path::Path};

use ef_format::{
    FormatError, ProjectGenesis, artifact_id, decode_project_genesis, encode_project_genesis,
    parse_artifact_id, verify_artifact_id,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

const SCHEMA_VERSION: i64 = 1;
const MIGRATION_1: &str = include_str!("../migrations/0001_repository_identity.sql");

/// Storage failure with a stable distinction for initialization conflicts.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Format(FormatError),
    AlreadyInitialized,
    Corrupt(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite error: {error}"),
            Self::Format(error) => write!(formatter, "format error: {error}"),
            Self::AlreadyInitialized => {
                formatter.write_str("repository already has another project")
            }
            Self::Corrupt(message) => write!(formatter, "repository corruption: {message}"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::Format(error) => Some(error),
            Self::AlreadyInitialized | Self::Corrupt(_) => None,
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
        let version: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match version {
            0 => {
                let transaction = self
                    .connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)?;
                transaction.execute_batch(MIGRATION_1)?;
                transaction.commit()?;
            }
            SCHEMA_VERSION => {}
            other => {
                return Err(StoreError::Corrupt(format!(
                    "unsupported schema version {other}"
                )));
            }
        }
        Ok(())
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
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{LocalRepository, SCHEMA_VERSION, StoreError};
    use ef_format::ProjectGenesis;

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
