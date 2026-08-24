//! Transactional local `SQLite` storage for portable `EdgeFossil` state.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    error::Error,
    fmt,
    path::Path,
};

use edgefoss_core::BuiltRealmSnapshot;
use ef_format::{
    ArtifactMeta, ChangeArtifact, FormatError, GraphArtifactKind, GraphArtifactSummary, PathError,
    ProjectGenesis, Realm, SignatureRecord, TreeEntryMode, artifact_id, decode_change,
    decode_project_genesis, decode_signature_record, decode_tree, encode_change,
    encode_project_genesis, encode_signature_record, encode_tree, parse_artifact_id,
    validate_change_graph, validate_path, verify_artifact_id, verify_artifact_signature,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

const SCHEMA_VERSION: i64 = 4;
const MIGRATION_1: &str = include_str!("../migrations/0001_repository_identity.sql");
const MIGRATION_2: &str = include_str!("../migrations/0002_working_copy_tracking.sql");
const MIGRATION_3: &str = include_str!("../migrations/0003_working_snapshots.sql");
const MIGRATION_4: &str = include_str!("../migrations/0004_signed_checkpoints.sql");
const CHECKPOINT_REF: &str = "heads/main";
const MAX_HISTORY_LIMIT: usize = 1_000;
const MAX_DIFF_ENTRIES: usize = 100_000;

/// Storage failure with a stable distinction for initialization conflicts.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Format(FormatError),
    Path(PathError),
    AlreadyInitialized,
    Uninitialized,
    InvalidTracking(String),
    InvalidSnapshot(String),
    InvalidCheckpoint(String),
    InvalidRead(String),
    RefConflict(String),
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
            Self::InvalidSnapshot(message) => write!(formatter, "invalid snapshot: {message}"),
            Self::InvalidCheckpoint(message) => write!(formatter, "invalid checkpoint: {message}"),
            Self::InvalidRead(message) => write!(formatter, "invalid read request: {message}"),
            Self::RefConflict(message) => write!(formatter, "checkpoint conflict: {message}"),
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
            | Self::InvalidSnapshot(_)
            | Self::InvalidCheckpoint(_)
            | Self::InvalidRead(_)
            | Self::RefConflict(_)
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

/// One currently selected, unsigned working snapshot root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotRoot {
    pub realm: Realm,
    pub id: String,
    pub captured_at: String,
}

/// Immutable inputs a caller must bind while constructing one checkpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointBasis {
    pub project: String,
    pub realm: Realm,
    pub root: String,
    pub parent: Option<String>,
    pub expected_generation: u64,
    pub logical_clock: u64,
    pub actor_key: [u8; 32],
    pub artifacts_to_sign: Vec<String>,
}

/// Result of atomically accepting a signed checkpoint and advancing its ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointResult {
    pub change: String,
    pub generation: u64,
    pub stored_signatures: usize,
}

/// One accepted realm checkpoint ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointHead {
    pub realm: Realm,
    pub id: String,
    pub generation: u64,
}

/// One verified change projected from a realm's accepted checkpoint history.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryEntry {
    pub id: String,
    pub root: String,
    pub parent: Option<String>,
    pub logical_clock: u64,
    pub created_at: String,
    pub message: String,
}

/// Structural change between an accepted head and one unsigned working root.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffKind {
    Added,
    Modified,
    Deleted,
}

/// One realm-owned path in the structural working diff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffEntry {
    pub kind: DiffKind,
    pub path: String,
    pub before: Option<TreeEntryMode>,
    pub after: Option<TreeEntryMode>,
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
                2 => MIGRATION_3,
                3 => MIGRATION_4,
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

    /// Atomically stores all objects and replaces every realm's working root.
    ///
    /// Existing content-addressed objects remain available, while realms absent
    /// from `snapshots` have their prior working roots cleared.
    ///
    /// # Errors
    ///
    /// Returns an error without advancing any root if IDs, metadata, realm
    /// ownership, dependencies, or storage constraints are invalid.
    pub fn replace_working_snapshots(
        &mut self,
        snapshots: &[BuiltRealmSnapshot],
        captured_at: &str,
    ) -> Result<(), StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let project = ef_format::format_artifact_id(&project_id);
        let genesis = self.project_genesis()?.ok_or(StoreError::Uninitialized)?;
        let mut seen_realms = std::collections::HashSet::new();
        for snapshot in snapshots {
            if !seen_realms.insert(snapshot.realm.as_str()) {
                return Err(StoreError::InvalidSnapshot(format!(
                    "duplicate {} realm",
                    snapshot.realm.as_str()
                )));
            }
            if snapshot.trees.last().map(|tree| tree.id.as_str()) != Some(snapshot.root.as_str()) {
                return Err(StoreError::InvalidSnapshot(
                    "root must be the last child-first tree".into(),
                ));
            }
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM working_snapshot_roots WHERE project_id = ?1",
            params![project_id.as_slice()],
        )?;
        for snapshot in snapshots {
            store_snapshot_blobs(&transaction, &project_id, snapshot)?;
            store_snapshot_trees(
                &transaction,
                &project_id,
                &project,
                genesis.actor_key,
                &genesis.created_at,
                snapshot,
            )?;
            store_snapshot_root(&transaction, &project_id, captured_at, snapshot)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Returns current unsigned working roots in disclosure order.
    ///
    /// # Errors
    ///
    /// Returns an error for uninitialized or malformed stored state.
    pub fn working_snapshot_roots(&self) -> Result<Vec<SnapshotRoot>, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let mut statement = self.connection.prepare(
            "SELECT realm, root_id, captured_at
             FROM working_snapshot_roots
             WHERE project_id = ?1
             ORDER BY CASE realm WHEN 'public' THEN 0 WHEN 'members' THEN 1 ELSE 2 END",
        )?;
        let rows = statement.query_map(params![project_id.as_slice()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (realm, digest, captured_at) = row?;
            let realm = parse_realm(&realm)?;
            let digest: [u8; 32] = digest
                .try_into()
                .map_err(|_| StoreError::Corrupt("snapshot root is not 32 bytes".into()))?;
            Ok(SnapshotRoot {
                realm,
                id: ef_format::format_artifact_id(&digest),
                captured_at,
            })
        })
        .collect()
    }

    /// Returns the immutable snapshot/ref inputs for one realm checkpoint.
    ///
    /// The returned generation and root are compare-and-swap expectations.
    /// Callers sign every listed artifact plus the change they construct.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing snapshot, unsupported key history, or
    /// malformed repository state.
    pub fn checkpoint_basis(&self, realm: Realm) -> Result<CheckpointBasis, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let project = ef_format::format_artifact_id(&project_id);
        let genesis = self.project_genesis()?.ok_or(StoreError::Uninitialized)?;
        let root = query_working_root(&self.connection, &project_id, realm)?.ok_or_else(|| {
            StoreError::InvalidCheckpoint(format!(
                "{} has no working snapshot; run ef snapshot first",
                realm.as_str()
            ))
        })?;
        let (parent, expected_generation, logical_clock) = match query_ref(
            &self.connection,
            &project_id,
            realm,
            CHECKPOINT_REF,
        )? {
            Some((parent, generation)) => {
                let parent_change =
                    load_change(&self.connection, &project_id, &project, realm, &parent)?;
                if parent_change.meta.actor_key != genesis.actor_key {
                    return Err(StoreError::InvalidCheckpoint(
                            "the current head uses a rotated actor key; key rotation is not supported in I3e"
                                .into(),
                        ));
                }
                let logical_clock =
                    parent_change
                        .meta
                        .logical_clock
                        .checked_add(1)
                        .ok_or_else(|| {
                            StoreError::InvalidCheckpoint("logical clock is exhausted".into())
                        })?;
                (Some(parent), generation, logical_clock)
            }
            None => (None, 0, 0),
        };
        let mut artifacts_to_sign = reachable_tree_ids(
            &self.connection,
            &project_id,
            &project,
            genesis.actor_key,
            realm,
            &root,
        )?;
        artifacts_to_sign.push(project.clone());
        artifacts_to_sign.sort();
        artifacts_to_sign.dedup();
        Ok(CheckpointBasis {
            project,
            realm,
            root,
            parent,
            expected_generation,
            logical_clock,
            actor_key: genesis.actor_key,
            artifacts_to_sign,
        })
    }

    /// Returns accepted realm checkpoint heads in disclosure order.
    ///
    /// # Errors
    ///
    /// Returns an error for uninitialized or malformed stored state.
    pub fn checkpoint_heads(&self) -> Result<Vec<CheckpointHead>, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let mut heads = Vec::new();
        for realm in [Realm::Public, Realm::Members, Realm::Local] {
            if let Some((id, generation)) =
                query_ref(&self.connection, &project_id, realm, CHECKPOINT_REF)?
            {
                heads.push(CheckpointHead {
                    realm,
                    id,
                    generation,
                });
            }
        }
        Ok(heads)
    }

    /// Reads newest-first verified history from one realm's accepted head.
    ///
    /// Only the selected realm ref and its linear parent chain are resolved.
    /// Stored signatures are revalidated before an entry is returned.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid limit, malformed/cross-realm history,
    /// missing signatures, or repository corruption.
    pub fn history(&self, realm: Realm, limit: usize) -> Result<Vec<HistoryEntry>, StoreError> {
        if !(1..=MAX_HISTORY_LIMIT).contains(&limit) {
            return Err(StoreError::InvalidRead(format!(
                "history limit must be between 1 and {MAX_HISTORY_LIMIT}"
            )));
        }
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let project = ef_format::format_artifact_id(&project_id);
        let genesis = self.project_genesis()?.ok_or(StoreError::Uninitialized)?;
        let Some((head, _)) = query_ref(&self.connection, &project_id, realm, CHECKPOINT_REF)?
        else {
            return Ok(Vec::new());
        };
        verify_stored_signature(&self.connection, &project_id, &project, &genesis.actor_key)?;

        let mut entries = Vec::with_capacity(limit);
        let mut next = Some(head);
        let mut seen = HashSet::new();
        while entries.len() < limit {
            let Some(id) = next.take() else {
                break;
            };
            if !seen.insert(id.clone()) {
                return Err(StoreError::Corrupt(
                    "checkpoint history contains a parent cycle".into(),
                ));
            }
            let change = load_verified_change(
                &self.connection,
                &project_id,
                &project,
                &genesis,
                realm,
                &id,
            )?;
            if change.meta.parents.len() > 1 {
                return Err(StoreError::InvalidRead(
                    "merge history is not supported by the I3f linear reader".into(),
                ));
            }
            let parent = change.meta.parents.first().cloned();
            entries.push(HistoryEntry {
                id,
                root: change.root,
                parent: parent.clone(),
                logical_clock: change.meta.logical_clock,
                created_at: change.meta.created_at,
                message: change.message,
            });
            next = parent;
        }
        Ok(entries)
    }

    /// Compares one realm's unsigned working snapshot with its accepted head.
    ///
    /// Directory target hashes are intentionally ignored so a child edit does
    /// not also report every ancestor directory as modified. Path presence,
    /// entry mode, file/blob target, and symlink target remain significant.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing working snapshot, invalid accepted
    /// signatures, malformed trees/blobs, or excessive diff size.
    pub fn working_diff(&self, realm: Realm) -> Result<Vec<DiffEntry>, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let project = ef_format::format_artifact_id(&project_id);
        let genesis = self.project_genesis()?.ok_or(StoreError::Uninitialized)?;
        let working_root =
            query_working_root(&self.connection, &project_id, realm)?.ok_or_else(|| {
                StoreError::InvalidRead(format!(
                    "{} has no working snapshot; run ef snapshot first",
                    realm.as_str()
                ))
            })?;
        let working = flatten_tree(
            &self.connection,
            &project_id,
            &project,
            &genesis,
            realm,
            &working_root,
            false,
        )?;
        let accepted = if let Some((head, _)) =
            query_ref(&self.connection, &project_id, realm, CHECKPOINT_REF)?
        {
            verify_stored_signature(&self.connection, &project_id, &project, &genesis.actor_key)?;
            let change = load_verified_change(
                &self.connection,
                &project_id,
                &project,
                &genesis,
                realm,
                &head,
            )?;
            flatten_tree(
                &self.connection,
                &project_id,
                &project,
                &genesis,
                realm,
                &change.root,
                true,
            )?
        } else {
            BTreeMap::new()
        };
        diff_tree_entries(&accepted, &working)
    }

    /// Atomically stores a signed change and advances the realm checkpoint ref.
    ///
    /// The operation rechecks both the unsigned working root and ref generation
    /// obtained from [`Self::checkpoint_basis`]. No artifact, signature, or ref
    /// mutation remains committed after a failed validation or stale basis.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid graph/signature data, a stale root/ref, or
    /// a storage failure.
    pub fn commit_checkpoint(
        &mut self,
        change: &ChangeArtifact,
        expected_generation: u64,
        signatures: &[SignatureRecord],
    ) -> Result<CheckpointResult, StoreError> {
        let project_id = self.project_digest()?.ok_or(StoreError::Uninitialized)?;
        let project = ef_format::format_artifact_id(&project_id);
        let genesis = self.project_genesis()?.ok_or(StoreError::Uninitialized)?;
        let body = encode_change(change)?;
        let change_id = artifact_id(&body);
        if change.meta.project != project || change.meta.actor_key != genesis.actor_key {
            return Err(StoreError::InvalidCheckpoint(
                "change project or actor does not match repository genesis".into(),
            ));
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let validated = validate_checkpoint_state(
            &transaction,
            &project_id,
            &project,
            &genesis,
            change,
            &change_id,
            expected_generation,
        )?;
        let encoded_signatures = validate_checkpoint_signatures(
            signatures,
            &validated.expected_artifacts,
            &genesis.actor_key,
        )?;

        store_change_body(
            &transaction,
            &project_id,
            change.meta.realm,
            &change_id,
            &body,
        )?;
        for (record, encoded) in &encoded_signatures {
            store_signature(&transaction, &project_id, record, encoded)?;
        }

        let generation = advance_checkpoint_ref(
            &transaction,
            &project_id,
            change.meta.realm,
            &change_id,
            validated.parent.as_deref(),
            expected_generation,
        )?;
        transaction.commit()?;
        Ok(CheckpointResult {
            change: change_id,
            generation,
            stored_signatures: encoded_signatures.len(),
        })
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

struct ValidatedCheckpoint {
    parent: Option<String>,
    expected_artifacts: BTreeSet<String>,
}

fn validate_checkpoint_state(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    project: &str,
    genesis: &ProjectGenesis,
    change: &ChangeArtifact,
    change_id: &str,
    expected_generation: u64,
) -> Result<ValidatedCheckpoint, StoreError> {
    let current_root =
        query_working_root(transaction, project_id, change.meta.realm)?.ok_or_else(|| {
            StoreError::RefConflict("working snapshot was removed before checkpoint".into())
        })?;
    if change.root != current_root {
        return Err(StoreError::RefConflict(
            "working snapshot changed before checkpoint".into(),
        ));
    }
    let parent = match query_ref(transaction, project_id, change.meta.realm, CHECKPOINT_REF)? {
        Some((target, generation)) if generation == expected_generation => Some(target),
        None if expected_generation == 0 => None,
        _ => {
            return Err(StoreError::RefConflict(
                "realm head generation changed before checkpoint".into(),
            ));
        }
    };
    let expected_parents: Vec<String> = parent.iter().cloned().collect();
    if change.meta.parents != expected_parents {
        return Err(StoreError::RefConflict(
            "change parent does not match the current realm head".into(),
        ));
    }
    validate_checkpoint_clock(
        transaction,
        project_id,
        project,
        genesis,
        change,
        parent.as_deref(),
    )?;

    let mut summaries = BTreeMap::new();
    summaries.insert(
        change.root.clone(),
        load_graph_summary(transaction, project_id, project, &change.root)?,
    );
    if let Some(parent) = &parent {
        summaries.insert(
            parent.clone(),
            load_graph_summary(transaction, project_id, project, parent)?,
        );
    }
    validate_change_graph(change, |id| summaries.get(id).cloned())?;

    let mut expected_artifacts = reachable_tree_ids(
        transaction,
        project_id,
        project,
        genesis.actor_key,
        change.meta.realm,
        &change.root,
    )?;
    expected_artifacts.push(project.to_owned());
    expected_artifacts.push(change_id.to_owned());
    Ok(ValidatedCheckpoint {
        parent,
        expected_artifacts: expected_artifacts.into_iter().collect(),
    })
}

fn validate_checkpoint_clock(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    project: &str,
    genesis: &ProjectGenesis,
    change: &ChangeArtifact,
    parent: Option<&str>,
) -> Result<(), StoreError> {
    let expected_clock = if let Some(parent) = parent {
        let parent_change =
            load_change(transaction, project_id, project, change.meta.realm, parent)?;
        if parent_change.meta.actor_key != genesis.actor_key {
            return Err(StoreError::InvalidCheckpoint(
                "the current head uses an unsupported actor key".into(),
            ));
        }
        parent_change
            .meta
            .logical_clock
            .checked_add(1)
            .ok_or_else(|| StoreError::InvalidCheckpoint("logical clock is exhausted".into()))?
    } else {
        0
    };
    if change.meta.logical_clock != expected_clock {
        return Err(StoreError::InvalidCheckpoint(
            "change logical clock does not follow the current realm head".into(),
        ));
    }
    Ok(())
}

fn advance_checkpoint_ref(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    change_id: &str,
    parent: Option<&str>,
    expected_generation: u64,
) -> Result<u64, StoreError> {
    let generation = expected_generation
        .checked_add(1)
        .ok_or_else(|| StoreError::InvalidCheckpoint("ref generation is exhausted".into()))?;
    let generation_sql = i64::try_from(generation).map_err(|_| {
        StoreError::InvalidCheckpoint("ref generation exceeds SQLite integer range".into())
    })?;
    let change_digest = parse_artifact_id(change_id)?;
    if expected_generation == 0 {
        transaction.execute(
            "INSERT INTO refs(project_id, realm, name, target_id, generation)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project_id.as_slice(),
                realm.as_str(),
                CHECKPOINT_REF,
                change_digest.as_slice(),
                generation_sql
            ],
        )?;
        return Ok(generation);
    }
    let prior_generation = i64::try_from(expected_generation).map_err(|_| {
        StoreError::InvalidCheckpoint("ref generation exceeds SQLite integer range".into())
    })?;
    let parent_digest = parse_artifact_id(
        parent.ok_or_else(|| StoreError::Corrupt("checkpoint ref lost its target".into()))?,
    )?;
    let changed = transaction.execute(
        "UPDATE refs SET target_id = ?1, generation = ?2
         WHERE project_id = ?3 AND realm = ?4 AND name = ?5
           AND target_id = ?6 AND generation = ?7",
        params![
            change_digest.as_slice(),
            generation_sql,
            project_id.as_slice(),
            realm.as_str(),
            CHECKPOINT_REF,
            parent_digest.as_slice(),
            prior_generation
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::RefConflict(
            "realm head changed while committing checkpoint".into(),
        ));
    }
    Ok(generation)
}

fn query_working_root(
    connection: &Connection,
    project_id: &[u8; 32],
    realm: Realm,
) -> Result<Option<String>, StoreError> {
    let digest = connection
        .query_row(
            "SELECT root_id FROM working_snapshot_roots
             WHERE project_id = ?1 AND realm = ?2",
            params![project_id.as_slice(), realm.as_str()],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?;
    digest
        .map(|digest| {
            let digest: [u8; 32] = digest
                .try_into()
                .map_err(|_| StoreError::Corrupt("working snapshot root is not 32 bytes".into()))?;
            Ok(ef_format::format_artifact_id(&digest))
        })
        .transpose()
}

fn query_ref(
    connection: &Connection,
    project_id: &[u8; 32],
    realm: Realm,
    name: &str,
) -> Result<Option<(String, u64)>, StoreError> {
    let row = connection
        .query_row(
            "SELECT target_id, generation FROM refs
             WHERE project_id = ?1 AND realm = ?2 AND name = ?3",
            params![project_id.as_slice(), realm.as_str(), name],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    row.map(|(digest, generation)| {
        let digest: [u8; 32] = digest
            .try_into()
            .map_err(|_| StoreError::Corrupt("ref target is not 32 bytes".into()))?;
        let generation = u64::try_from(generation)
            .map_err(|_| StoreError::Corrupt("ref generation is negative".into()))?;
        if generation == 0 {
            return Err(StoreError::Corrupt("stored ref generation is zero".into()));
        }
        Ok((ef_format::format_artifact_id(&digest), generation))
    })
    .transpose()
}

fn load_artifact_row(
    connection: &Connection,
    project_id: &[u8; 32],
    id: &str,
) -> Result<(String, String, i64, Vec<u8>), StoreError> {
    let digest = parse_artifact_id(id)?;
    let (stored_project, realm, kind, schema, body): (Vec<u8>, String, String, i64, Vec<u8>) =
        connection
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
            .ok_or_else(|| StoreError::Corrupt(format!("referenced artifact {id} is missing")))?;
    if stored_project.as_slice() != project_id {
        return Err(StoreError::Corrupt(
            "artifact row belongs to another project".into(),
        ));
    }
    verify_artifact_id(&body, id)?;
    Ok((realm, kind, schema, body))
}

fn load_change(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    realm: Realm,
    id: &str,
) -> Result<ChangeArtifact, StoreError> {
    let (stored_realm, kind, schema, body) = load_artifact_row(connection, project_id, id)?;
    if stored_realm != realm.as_str() || kind != "change" || schema != 0 {
        return Err(StoreError::Corrupt(
            "checkpoint ref target is not a same-realm schema-0 change".into(),
        ));
    }
    let change = decode_change(&body)?;
    if change.meta.project != project || change.meta.realm != realm {
        return Err(StoreError::Corrupt(
            "change body does not match stored project and realm".into(),
        ));
    }
    Ok(change)
}

fn load_tree(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    actor_key: [u8; 32],
    realm: Realm,
    id: &str,
) -> Result<ef_format::TreeArtifact, StoreError> {
    let (stored_realm, kind, schema, body) = load_artifact_row(connection, project_id, id)?;
    if stored_realm != realm.as_str() || kind != "tree" || schema != 0 {
        return Err(StoreError::InvalidCheckpoint(
            "working root reaches a non-tree or cross-realm artifact".into(),
        ));
    }
    let tree = decode_tree(&body)?;
    if tree.meta.project != project
        || tree.meta.realm != realm
        || tree.meta.actor_key != actor_key
        || tree.meta.logical_clock != 0
    {
        return Err(StoreError::InvalidCheckpoint(
            "working tree metadata does not match the checkpoint actor and realm".into(),
        ));
    }
    Ok(tree)
}

fn reachable_tree_ids(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    actor_key: [u8; 32],
    realm: Realm,
    root: &str,
) -> Result<Vec<String>, StoreError> {
    let mut pending = vec![root.to_owned()];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let tree = load_tree(connection, project_id, project, actor_key, realm, &id)?;
        for entry in tree.entries {
            match entry.mode {
                TreeEntryMode::File | TreeEntryMode::Executable => {
                    let digest = parse_artifact_id(&entry.target)?;
                    let exists = connection
                        .query_row(
                            "SELECT 1 FROM blobs
                             WHERE project_id = ?1 AND realm = ?2 AND digest = ?3",
                            params![project_id.as_slice(), realm.as_str(), digest.as_slice()],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    if !exists {
                        return Err(StoreError::InvalidCheckpoint(
                            "working tree references a missing same-realm blob".into(),
                        ));
                    }
                }
                TreeEntryMode::Directory => pending.push(entry.target),
                TreeEntryMode::Symlink => {}
            }
        }
    }
    let mut ids: Vec<_> = seen.into_iter().collect();
    ids.sort();
    Ok(ids)
}

fn load_graph_summary(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    id: &str,
) -> Result<GraphArtifactSummary, StoreError> {
    let (realm, kind, schema, body) = load_artifact_row(connection, project_id, id)?;
    if schema != 0 {
        return Err(StoreError::InvalidCheckpoint(
            "change graph reaches an unsupported artifact schema".into(),
        ));
    }
    let realm = parse_realm(&realm)?;
    let (kind, meta): (GraphArtifactKind, ArtifactMeta) = match kind.as_str() {
        "tree" => (GraphArtifactKind::Tree, decode_tree(&body)?.meta),
        "change" => (GraphArtifactKind::Change, decode_change(&body)?.meta),
        _ => {
            return Err(StoreError::InvalidCheckpoint(
                "change graph reaches an unsupported artifact kind".into(),
            ));
        }
    };
    if meta.project != project || meta.realm != realm {
        return Err(StoreError::Corrupt(
            "artifact envelope does not match its storage metadata".into(),
        ));
    }
    Ok(GraphArtifactSummary {
        project: meta.project,
        realm,
        kind,
        actor_key: meta.actor_key,
        logical_clock: meta.logical_clock,
    })
}

fn verify_stored_signature(
    connection: &Connection,
    project_id: &[u8; 32],
    artifact: &str,
    actor_key: &[u8; 32],
) -> Result<(), StoreError> {
    let artifact_digest = parse_artifact_id(artifact)?;
    let stored = connection
        .query_row(
            "SELECT storage_digest, project_id, canonical_record
             FROM signatures WHERE artifact_id = ?1 AND actor_key = ?2",
            params![artifact_digest.as_slice(), actor_key.as_slice()],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::Corrupt("accepted artifact signature is missing".into()))?;
    let storage_digest: [u8; 32] = stored
        .0
        .try_into()
        .map_err(|_| StoreError::Corrupt("signature storage digest is not 32 bytes".into()))?;
    if stored.1.as_slice() != project_id
        || ef_format::format_artifact_id(&storage_digest) != artifact_id(&stored.2)
    {
        return Err(StoreError::Corrupt(
            "stored artifact signature metadata is invalid".into(),
        ));
    }
    let record = decode_signature_record(&stored.2)
        .map_err(|_| StoreError::Corrupt("stored artifact signature is invalid".into()))?;
    verify_artifact_signature(&record, artifact, actor_key)
        .map_err(|_| StoreError::Corrupt("stored artifact signature is invalid".into()))
}

fn load_verified_change(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    genesis: &ProjectGenesis,
    realm: Realm,
    id: &str,
) -> Result<ChangeArtifact, StoreError> {
    let change = load_change(connection, project_id, project, realm, id)?;
    if change.meta.actor_key != genesis.actor_key {
        return Err(StoreError::Corrupt(
            "accepted change actor is not supported by this repository version".into(),
        ));
    }
    verify_stored_signature(connection, project_id, id, &change.meta.actor_key)?;
    load_tree(
        connection,
        project_id,
        project,
        genesis.actor_key,
        realm,
        &change.root,
    )?;
    verify_stored_signature(connection, project_id, &change.root, &genesis.actor_key)?;

    let mut summaries = BTreeMap::new();
    summaries.insert(
        change.root.clone(),
        load_graph_summary(connection, project_id, project, &change.root)?,
    );
    for parent in &change.meta.parents {
        summaries.insert(
            parent.clone(),
            load_graph_summary(connection, project_id, project, parent)?,
        );
    }
    validate_change_graph(&change, |candidate| summaries.get(candidate).cloned())?;
    Ok(change)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TreeState {
    mode: TreeEntryMode,
    target: Option<String>,
}

fn flatten_tree(
    connection: &Connection,
    project_id: &[u8; 32],
    project: &str,
    genesis: &ProjectGenesis,
    realm: Realm,
    root: &str,
    require_signatures: bool,
) -> Result<BTreeMap<String, TreeState>, StoreError> {
    let tree_ids = reachable_tree_ids(
        connection,
        project_id,
        project,
        genesis.actor_key,
        realm,
        root,
    )?;
    if require_signatures {
        for id in &tree_ids {
            verify_stored_signature(connection, project_id, id, &genesis.actor_key)?;
        }
    }

    let mut flattened = BTreeMap::new();
    let mut pending = vec![(root.to_owned(), String::new())];
    while let Some((tree_id, prefix)) = pending.pop() {
        let tree = load_tree(
            connection,
            project_id,
            project,
            genesis.actor_key,
            realm,
            &tree_id,
        )?;
        for entry in tree.entries {
            let path = if prefix.is_empty() {
                entry.name
            } else {
                format!("{prefix}/{}", entry.name)
            };
            validate_path(&path).map_err(|error| StoreError::Corrupt(error.to_string()))?;
            let target = if entry.mode == TreeEntryMode::Directory {
                None
            } else {
                Some(entry.target.clone())
            };
            if flattened
                .insert(
                    path.clone(),
                    TreeState {
                        mode: entry.mode,
                        target,
                    },
                )
                .is_some()
            {
                return Err(StoreError::Corrupt(
                    "tree graph produces a duplicate repository path".into(),
                ));
            }
            if flattened.len() > MAX_DIFF_ENTRIES {
                return Err(StoreError::InvalidRead(format!(
                    "tree exceeds the I3f diff limit of {MAX_DIFF_ENTRIES} paths"
                )));
            }
            if entry.mode == TreeEntryMode::Directory {
                pending.push((entry.target, path));
            }
        }
    }
    Ok(flattened)
}

fn diff_tree_entries(
    before: &BTreeMap<String, TreeState>,
    after: &BTreeMap<String, TreeState>,
) -> Result<Vec<DiffEntry>, StoreError> {
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).cloned().collect();
    let mut diff = Vec::new();
    for path in paths {
        let old = before.get(&path);
        let new = after.get(&path);
        let kind = match (old, new) {
            (None, Some(_)) => Some(DiffKind::Added),
            (Some(_), None) => Some(DiffKind::Deleted),
            (Some(old), Some(new)) if old != new => Some(DiffKind::Modified),
            _ => None,
        };
        if let Some(kind) = kind {
            diff.push(DiffEntry {
                kind,
                path,
                before: old.map(|entry| entry.mode),
                after: new.map(|entry| entry.mode),
            });
            if diff.len() > MAX_DIFF_ENTRIES {
                return Err(StoreError::InvalidRead(format!(
                    "diff exceeds the I3f limit of {MAX_DIFF_ENTRIES} paths"
                )));
            }
        }
    }
    Ok(diff)
}

fn validate_checkpoint_signatures(
    signatures: &[SignatureRecord],
    expected_artifacts: &BTreeSet<String>,
    actor_key: &[u8; 32],
) -> Result<Vec<(SignatureRecord, Vec<u8>)>, StoreError> {
    if signatures.len() != expected_artifacts.len() {
        return Err(StoreError::InvalidCheckpoint(
            "signature set does not exactly cover the checkpoint artifacts".into(),
        ));
    }
    let mut seen = BTreeSet::new();
    let mut encoded = Vec::with_capacity(signatures.len());
    for record in signatures {
        if !expected_artifacts.contains(&record.artifact) || !seen.insert(record.artifact.clone()) {
            return Err(StoreError::InvalidCheckpoint(
                "signature set does not exactly cover the checkpoint artifacts".into(),
            ));
        }
        verify_artifact_signature(record, &record.artifact, actor_key)?;
        encoded.push((record.clone(), encode_signature_record(record)?));
    }
    if &seen != expected_artifacts {
        return Err(StoreError::InvalidCheckpoint(
            "signature set does not exactly cover the checkpoint artifacts".into(),
        ));
    }
    encoded.sort_by(|left, right| left.0.artifact.cmp(&right.0.artifact));
    Ok(encoded)
}

fn store_change_body(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    id: &str,
    body: &[u8],
) -> Result<(), StoreError> {
    let digest = parse_artifact_id(id)?;
    transaction.execute(
        "INSERT INTO artifacts(
             id, project_id, realm, kind, schema_version, canonical_body
         ) VALUES (?1, ?2, ?3, 'change', 0, ?4)
         ON CONFLICT(id) DO NOTHING",
        params![
            digest.as_slice(),
            project_id.as_slice(),
            realm.as_str(),
            body
        ],
    )?;
    let existing: (Vec<u8>, String, String, i64, Vec<u8>) = transaction.query_row(
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
    if existing.0.as_slice() != project_id
        || existing.1 != realm.as_str()
        || existing.2 != "change"
        || existing.3 != 0
        || existing.4 != body
    {
        return Err(StoreError::Corrupt(
            "change artifact ID is bound to different content".into(),
        ));
    }
    Ok(())
}

fn store_signature(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    record: &SignatureRecord,
    encoded: &[u8],
) -> Result<(), StoreError> {
    let storage_id = artifact_id(encoded);
    let storage_digest = parse_artifact_id(&storage_id)?;
    let artifact_digest = parse_artifact_id(&record.artifact)?;
    transaction.execute(
        "INSERT INTO signatures(
             storage_digest, project_id, artifact_id, actor_key, canonical_record
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT DO NOTHING",
        params![
            storage_digest.as_slice(),
            project_id.as_slice(),
            artifact_digest.as_slice(),
            record.actor_key.as_slice(),
            encoded
        ],
    )?;
    let existing: (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) = transaction.query_row(
        "SELECT storage_digest, project_id, actor_key, canonical_record
         FROM signatures WHERE artifact_id = ?1 AND actor_key = ?2",
        params![artifact_digest.as_slice(), record.actor_key.as_slice()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    if existing.0.as_slice() != storage_digest
        || existing.1.as_slice() != project_id
        || existing.2.as_slice() != record.actor_key
        || existing.3 != encoded
    {
        return Err(StoreError::Corrupt(
            "artifact signature is bound to different content".into(),
        ));
    }
    Ok(())
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

fn parse_realm(value: &str) -> Result<Realm, StoreError> {
    match value {
        "public" => Ok(Realm::Public),
        "members" => Ok(Realm::Members),
        "local" => Ok(Realm::Local),
        _ => Err(StoreError::Corrupt(format!("unknown realm {value}"))),
    }
}

fn store_snapshot_blobs(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    snapshot: &BuiltRealmSnapshot,
) -> Result<(), StoreError> {
    for blob in &snapshot.blobs {
        verify_artifact_id(&blob.bytes, &blob.id)?;
        let digest = parse_artifact_id(&blob.id)?;
        transaction.execute(
            "INSERT INTO blobs(project_id, realm, digest, content)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, realm, digest) DO NOTHING",
            params![
                project_id.as_slice(),
                snapshot.realm.as_str(),
                digest.as_slice(),
                blob.bytes
            ],
        )?;
        let existing: Vec<u8> = transaction.query_row(
            "SELECT content FROM blobs
             WHERE project_id = ?1 AND realm = ?2 AND digest = ?3",
            params![
                project_id.as_slice(),
                snapshot.realm.as_str(),
                digest.as_slice()
            ],
            |row| row.get(0),
        )?;
        if existing != blob.bytes {
            return Err(StoreError::Corrupt("blob digest collision".into()));
        }
    }
    Ok(())
}

fn store_snapshot_trees(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    project: &str,
    actor_key: [u8; 32],
    captured_at: &str,
    snapshot: &BuiltRealmSnapshot,
) -> Result<(), StoreError> {
    for tree in &snapshot.trees {
        if tree.artifact.meta.project != project
            || tree.artifact.meta.realm != snapshot.realm
            || tree.artifact.meta.actor_key != actor_key
            || tree.artifact.meta.logical_clock != 0
            || tree.artifact.meta.created_at != captured_at
        {
            return Err(StoreError::InvalidSnapshot(
                "tree metadata does not match the working snapshot".into(),
            ));
        }
        let body = encode_tree(&tree.artifact)?;
        verify_artifact_id(&body, &tree.id)?;
        require_tree_entries(
            transaction,
            project_id,
            snapshot.realm,
            &tree.artifact.entries,
        )?;
        store_tree_body(transaction, project_id, snapshot.realm, &tree.id, &body)?;
    }
    Ok(())
}

fn require_tree_entries(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    entries: &[ef_format::TreeEntry],
) -> Result<(), StoreError> {
    for entry in entries {
        match entry.mode {
            TreeEntryMode::File | TreeEntryMode::Executable => {
                require_blob(transaction, project_id, realm, &entry.target)?;
            }
            TreeEntryMode::Directory => {
                require_tree(transaction, project_id, realm, &entry.target)?;
            }
            TreeEntryMode::Symlink => {}
        }
    }
    Ok(())
}

fn store_tree_body(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    id: &str,
    body: &[u8],
) -> Result<(), StoreError> {
    let digest = parse_artifact_id(id)?;
    transaction.execute(
        "INSERT INTO artifacts(
             id, project_id, realm, kind, schema_version, canonical_body
         ) VALUES (?1, ?2, ?3, 'tree', 0, ?4)
         ON CONFLICT(id) DO NOTHING",
        params![
            digest.as_slice(),
            project_id.as_slice(),
            realm.as_str(),
            body
        ],
    )?;
    let existing: (Vec<u8>, String, String, i64, Vec<u8>) = transaction.query_row(
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
    if existing.0.as_slice() != project_id
        || existing.1 != realm.as_str()
        || existing.2 != "tree"
        || existing.3 != 0
        || existing.4 != body
    {
        return Err(StoreError::Corrupt(
            "tree artifact ID is bound to different content".into(),
        ));
    }
    Ok(())
}

fn store_snapshot_root(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    captured_at: &str,
    snapshot: &BuiltRealmSnapshot,
) -> Result<(), StoreError> {
    let root = parse_artifact_id(&snapshot.root)?;
    require_tree(transaction, project_id, snapshot.realm, &snapshot.root)?;
    transaction.execute(
        "INSERT INTO working_snapshot_roots(project_id, realm, root_id, captured_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            project_id.as_slice(),
            snapshot.realm.as_str(),
            root.as_slice(),
            captured_at
        ],
    )?;
    Ok(())
}

fn require_blob(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    id: &str,
) -> Result<(), StoreError> {
    let digest = parse_artifact_id(id)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM blobs
             WHERE project_id = ?1 AND realm = ?2 AND digest = ?3",
            params![project_id.as_slice(), realm.as_str(), digest.as_slice()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(StoreError::InvalidSnapshot(format!(
            "missing {} blob {id}",
            realm.as_str()
        )));
    }
    Ok(())
}

fn require_tree(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &[u8; 32],
    realm: Realm,
    id: &str,
) -> Result<(), StoreError> {
    let digest = parse_artifact_id(id)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM artifacts
             WHERE id = ?1 AND project_id = ?2 AND realm = ?3
               AND kind = 'tree' AND schema_version = 0",
            params![digest.as_slice(), project_id.as_slice(), realm.as_str()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(StoreError::InvalidSnapshot(format!(
            "missing {} tree {id}",
            realm.as_str()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{
        LocalRepository, MIGRATION_1, SCHEMA_VERSION, StoreError, TrackingCounts, TrackingMode,
        TrackingRule, TrackingScope,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use edgefoss_core::{SnapshotInput, SnapshotInputKind, build_realm_snapshots};
    use ef_format::{
        ArtifactMeta, ChangeArtifact, ProjectGenesis, Realm, SignatureRecord, TreeEntryMode,
        artifact_id, artifact_signature_message, encode_change, encode_project_genesis,
        encode_tree, parse_artifact_id,
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

    fn sign(signing_key: &SigningKey, artifact: &str) -> SignatureRecord {
        let message = artifact_signature_message(artifact).unwrap();
        SignatureRecord {
            artifact: artifact.into(),
            actor_key: signing_key.verifying_key().to_bytes(),
            signature: signing_key.sign(&message).to_bytes(),
        }
    }

    fn signed_repository() -> (LocalRepository, ProjectGenesis, String, SigningKey) {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let genesis = ProjectGenesis {
            name: "Signed".into(),
            nonce: [10; 32],
            actor_key: signing_key.verifying_key().to_bytes(),
            created_at: "2026-08-24T00:00:00Z".into(),
        };
        let project = repository.init_project(&genesis).unwrap();
        let snapshots = build_realm_snapshots(
            &project,
            genesis.actor_key,
            &genesis.created_at,
            &[
                SnapshotInput {
                    path: "file.txt".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"signed".to_vec(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "members.txt".into(),
                    realm: Realm::Members,
                    kind: SnapshotInputKind::File {
                        bytes: b"restricted".to_vec(),
                        executable: false,
                    },
                },
            ],
        )
        .unwrap();
        repository
            .replace_working_snapshots(&snapshots, "2026-08-24T00:00:01Z")
            .unwrap();
        (repository, genesis, project, signing_key)
    }

    fn change_for_basis(
        basis: &super::CheckpointBasis,
        created_at: &str,
        message: &str,
    ) -> ChangeArtifact {
        ChangeArtifact {
            meta: ArtifactMeta {
                project: basis.project.clone(),
                realm: basis.realm,
                parents: basis.parent.clone().into_iter().collect(),
                actor_key: basis.actor_key,
                logical_clock: basis.logical_clock,
                created_at: created_at.into(),
            },
            root: basis.root.clone(),
            message: message.into(),
        }
    }

    fn signatures_for_basis(
        basis: &super::CheckpointBasis,
        change: &ChangeArtifact,
        signing_key: &SigningKey,
    ) -> (String, Vec<SignatureRecord>) {
        let change_id = artifact_id(&encode_change(change).unwrap());
        let mut ids = basis.artifacts_to_sign.clone();
        ids.push(change_id.clone());
        let signatures = ids.iter().map(|id| sign(signing_key, id)).collect();
        (change_id, signatures)
    }

    fn commit_realm(
        repository: &mut LocalRepository,
        signing_key: &SigningKey,
        realm: Realm,
        created_at: &str,
        message: &str,
    ) -> String {
        let basis = repository.checkpoint_basis(realm).unwrap();
        let change = change_for_basis(&basis, created_at, message);
        let (change_id, signatures) = signatures_for_basis(&basis, &change, signing_key);
        repository
            .commit_checkpoint(&change, basis.expected_generation, &signatures)
            .unwrap();
        change_id
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
            assert_eq!(migration_count, 4);
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
    fn atomically_persists_realm_isolated_snapshot_objects_and_roots() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let genesis = genesis(8);
        let project = repository.init_project(&genesis).unwrap();
        let captured_at = "2026-08-24T00:00:01Z";
        let snapshots = build_realm_snapshots(
            &project,
            genesis.actor_key,
            &genesis.created_at,
            &[
                SnapshotInput {
                    path: "public.txt".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"same".to_vec(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "members.txt".into(),
                    realm: Realm::Members,
                    kind: SnapshotInputKind::File {
                        bytes: b"same".to_vec(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "link".into(),
                    realm: Realm::Local,
                    kind: SnapshotInputKind::Symlink {
                        target: "public.txt".into(),
                    },
                },
            ],
        )
        .unwrap();
        repository
            .replace_working_snapshots(&snapshots, captured_at)
            .unwrap();

        let roots = repository.working_snapshot_roots().unwrap();
        assert_eq!(roots.len(), 3);
        assert_eq!(roots[0].realm, Realm::Public);
        assert_eq!(roots[1].realm, Realm::Members);
        assert_eq!(roots[2].realm, Realm::Local);
        assert!(roots.iter().all(|root| root.captured_at == captured_at));
        let blob_rows: i64 = repository
            .connection
            .query_row("SELECT count(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(blob_rows, 2, "same bytes remain isolated by realm");
        repository.quick_check().unwrap();

        repository
            .replace_working_snapshots(&[], "2026-08-24T00:00:02Z")
            .unwrap();
        assert!(repository.working_snapshot_roots().unwrap().is_empty());
        let retained_blobs: i64 = repository
            .connection
            .query_row("SELECT count(*) FROM blobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            retained_blobs, 2,
            "root replacement leaves deduplicated objects"
        );
    }

    #[test]
    fn failed_snapshot_replacement_preserves_previous_roots() {
        let mut repository = LocalRepository::open_in_memory().unwrap();
        let genesis = genesis(9);
        let project = repository.init_project(&genesis).unwrap();
        let captured_at = "2026-08-24T00:00:01Z";
        let mut snapshots = build_realm_snapshots(
            &project,
            genesis.actor_key,
            &genesis.created_at,
            &[SnapshotInput {
                path: "file.txt".into(),
                realm: Realm::Public,
                kind: SnapshotInputKind::File {
                    bytes: b"first".to_vec(),
                    executable: false,
                },
            }],
        )
        .unwrap();
        repository
            .replace_working_snapshots(&snapshots, captured_at)
            .unwrap();
        let previous = repository.working_snapshot_roots().unwrap();

        let mut missing_dependency = snapshots.clone();
        missing_dependency[0].trees[0].artifact.entries[0].target =
            format!("sha256:{}", "00".repeat(32));
        let body = encode_tree(&missing_dependency[0].trees[0].artifact).unwrap();
        let tree_id = artifact_id(&body);
        missing_dependency[0].trees[0].id.clone_from(&tree_id);
        missing_dependency[0].root = tree_id;
        assert!(
            repository
                .replace_working_snapshots(&missing_dependency, captured_at)
                .is_err()
        );
        assert_eq!(repository.working_snapshot_roots().unwrap(), previous);

        snapshots[0].blobs[0].id = format!("sha256:{}", "00".repeat(32));
        assert!(
            repository
                .replace_working_snapshots(&snapshots, captured_at)
                .is_err()
        );
        assert_eq!(repository.working_snapshot_roots().unwrap(), previous);
    }

    #[test]
    fn signed_checkpoint_atomically_advances_one_realm_head() {
        let (mut repository, _, _, signing_key) = signed_repository();
        let basis = repository.checkpoint_basis(Realm::Public).unwrap();
        assert_eq!(basis.expected_generation, 0);
        assert_eq!(basis.logical_clock, 0);
        assert_eq!(basis.parent, None);
        let change = change_for_basis(&basis, "2026-08-24T00:00:02Z", "first");
        let (change_id, signatures) = signatures_for_basis(&basis, &change, &signing_key);
        let result = repository
            .commit_checkpoint(&change, basis.expected_generation, &signatures)
            .unwrap();
        assert_eq!(result.change, change_id);
        assert_eq!(result.generation, 1);
        assert_eq!(result.stored_signatures, signatures.len());
        assert_eq!(
            repository.checkpoint_heads().unwrap(),
            vec![super::CheckpointHead {
                realm: Realm::Public,
                id: change_id.clone(),
                generation: 1,
            }]
        );

        let next = repository.checkpoint_basis(Realm::Public).unwrap();
        assert_eq!(next.parent.as_deref(), Some(change_id.as_str()));
        assert_eq!(next.expected_generation, 1);
        assert_eq!(next.logical_clock, 1);
    }

    #[test]
    fn invalid_signature_and_stale_root_leave_no_checkpoint_residue() {
        let (mut repository, genesis, project, signing_key) = signed_repository();
        let first = repository.checkpoint_basis(Realm::Public).unwrap();
        let first_change = change_for_basis(&first, "2026-08-24T00:00:02Z", "first");
        let (_, first_signatures) = signatures_for_basis(&first, &first_change, &signing_key);
        repository
            .commit_checkpoint(&first_change, first.expected_generation, &first_signatures)
            .unwrap();

        let next = repository.checkpoint_basis(Realm::Public).unwrap();
        let next_change = change_for_basis(&next, "2026-08-24T00:00:03Z", "second");
        let (rejected_id, mut bad_signatures) =
            signatures_for_basis(&next, &next_change, &signing_key);
        bad_signatures.last_mut().unwrap().signature[0] ^= 1;
        assert!(
            repository
                .commit_checkpoint(&next_change, next.expected_generation, &bad_signatures)
                .is_err()
        );
        assert_eq!(repository.checkpoint_heads().unwrap()[0].generation, 1);
        let rejected_digest = parse_artifact_id(&rejected_id).unwrap();
        let rejected_rows: i64 = repository
            .connection
            .query_row(
                "SELECT count(*) FROM artifacts WHERE id = ?1",
                params![rejected_digest.as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rejected_rows, 0, "failed signature leaves no change row");

        let replacement = build_realm_snapshots(
            &project,
            genesis.actor_key,
            &genesis.created_at,
            &[SnapshotInput {
                path: "file.txt".into(),
                realm: Realm::Public,
                kind: SnapshotInputKind::File {
                    bytes: b"changed".to_vec(),
                    executable: false,
                },
            }],
        )
        .unwrap();
        repository
            .replace_working_snapshots(&replacement, "2026-08-24T00:00:04Z")
            .unwrap();
        let (_, valid_signatures) = signatures_for_basis(&next, &next_change, &signing_key);
        assert!(matches!(
            repository.commit_checkpoint(&next_change, next.expected_generation, &valid_signatures),
            Err(StoreError::RefConflict(_))
        ));
        assert_eq!(repository.checkpoint_heads().unwrap()[0].generation, 1);
        let stale_rows: i64 = repository
            .connection
            .query_row(
                "SELECT count(*) FROM artifacts WHERE id = ?1",
                params![rejected_digest.as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_rows, 0, "stale root leaves no change row");
    }

    #[test]
    fn verified_history_and_working_diff_remain_realm_scoped() {
        let (mut repository, genesis, project, signing_key) = signed_repository();
        assert!(matches!(
            repository.history(Realm::Public, 0),
            Err(StoreError::InvalidRead(_))
        ));
        assert!(matches!(
            repository.history(Realm::Public, 1_001),
            Err(StoreError::InvalidRead(_))
        ));
        let public_preview = repository.working_diff(Realm::Public).unwrap();
        assert_eq!(public_preview.len(), 1);
        assert_eq!(public_preview[0].kind, super::DiffKind::Added);
        assert_eq!(public_preview[0].path, "file.txt");
        assert!(!public_preview[0].path.contains("members"));

        let public_id = commit_realm(
            &mut repository,
            &signing_key,
            Realm::Public,
            "2026-08-24T00:00:02Z",
            "public message",
        );
        let members_id = commit_realm(
            &mut repository,
            &signing_key,
            Realm::Members,
            "2026-08-24T00:00:03Z",
            "restricted message",
        );
        let public_history = repository.history(Realm::Public, 20).unwrap();
        assert_eq!(public_history.len(), 1);
        assert_eq!(public_history[0].id, public_id);
        assert_eq!(public_history[0].message, "public message");
        assert_ne!(public_history[0].id, members_id);
        assert!(repository.working_diff(Realm::Public).unwrap().is_empty());
        assert!(repository.working_diff(Realm::Members).unwrap().is_empty());

        let replacement = build_realm_snapshots(
            &project,
            genesis.actor_key,
            &genesis.created_at,
            &[
                SnapshotInput {
                    path: "file.txt".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"changed".to_vec(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "script.sh".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"#!/bin/sh\n".to_vec(),
                        executable: true,
                    },
                },
                SnapshotInput {
                    path: "members.txt".into(),
                    realm: Realm::Members,
                    kind: SnapshotInputKind::File {
                        bytes: b"restricted".to_vec(),
                        executable: false,
                    },
                },
            ],
        )
        .unwrap();
        repository
            .replace_working_snapshots(&replacement, "2026-08-24T00:00:04Z")
            .unwrap();
        let public_diff = repository.working_diff(Realm::Public).unwrap();
        assert_eq!(public_diff.len(), 2);
        assert_eq!(public_diff[0].kind, super::DiffKind::Modified);
        assert_eq!(public_diff[0].path, "file.txt");
        assert_eq!(public_diff[1].kind, super::DiffKind::Added);
        assert_eq!(public_diff[1].path, "script.sh");
        assert_eq!(public_diff[1].after, Some(TreeEntryMode::Executable));
        assert!(repository.working_diff(Realm::Members).unwrap().is_empty());

        let second_id = commit_realm(
            &mut repository,
            &signing_key,
            Realm::Public,
            "2026-08-24T00:00:05Z",
            "second public",
        );
        let newest = repository.history(Realm::Public, 1).unwrap();
        assert_eq!(newest[0].id, second_id);
        assert_eq!(newest[0].parent.as_deref(), Some(public_id.as_str()));
    }

    #[test]
    fn read_model_rejects_a_corrupt_accepted_signature() {
        let (mut repository, _, _, signing_key) = signed_repository();
        let head = commit_realm(
            &mut repository,
            &signing_key,
            Realm::Public,
            "2026-08-24T00:00:02Z",
            "signed",
        );
        let head_digest = parse_artifact_id(&head).unwrap();
        repository
            .connection
            .execute(
                "UPDATE signatures SET canonical_record = X'00' WHERE artifact_id = ?1",
                params![head_digest.as_slice()],
            )
            .unwrap();
        assert!(matches!(
            repository.history(Realm::Public, 20),
            Err(StoreError::Corrupt(_))
        ));
        assert!(matches!(
            repository.working_diff(Realm::Public),
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
