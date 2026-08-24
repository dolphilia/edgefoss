//! Portable `EdgeFossil` domain primitives.
//!
//! Cloudflare resource identifiers and runtime bindings must not enter this
//! crate.

use std::{collections::BTreeMap, error::Error, fmt};

use ef_format::{
    ArtifactMeta, FormatError, Realm, TreeArtifact, TreeEntry, TreeEntryMode, artifact_id,
    encode_tree, validate_path,
};

/// The compatibility status used while the v0 format remains experimental.
pub const FORMAT_STATUS: &str = "experimental";

/// Returns the stable product name used by cross-runtime smoke tests.
#[must_use]
pub const fn product_name() -> &'static str {
    "EdgeFossil"
}

/// One filesystem entry selected for a working snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotInput {
    pub path: String,
    pub realm: Realm,
    pub kind: SnapshotInputKind,
}

/// Snapshot input content after the filesystem adapter has read it safely.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapshotInputKind {
    Directory,
    File { bytes: Vec<u8>, executable: bool },
    Symlink { target: String },
}

/// One content-addressed raw blob owned by a snapshot realm.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltBlob {
    pub id: String,
    pub bytes: Vec<u8>,
}

/// One canonical tree and its artifact ID, ordered child before parent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltTree {
    pub id: String,
    pub artifact: TreeArtifact,
}

/// The complete new working root for one realm.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltRealmSnapshot {
    pub realm: Realm,
    pub blobs: Vec<BuiltBlob>,
    pub trees: Vec<BuiltTree>,
    pub root: String,
}

/// Snapshot construction failure before any storage mutation.
#[derive(Debug)]
pub enum SnapshotError {
    Format(FormatError),
    InvalidPath(String),
    PathConflict(String),
    RealmCollision(String),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Format(error) => write!(formatter, "format error: {error}"),
            Self::InvalidPath(path) => write!(formatter, "invalid snapshot path: {path}"),
            Self::PathConflict(path) => write!(formatter, "snapshot path conflict: {path}"),
            Self::RealmCollision(path) => write!(formatter, "snapshot realm collision: {path}"),
        }
    }
}

impl Error for SnapshotError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Format(error) => Some(error),
            Self::InvalidPath(_) | Self::PathConflict(_) | Self::RealmCollision(_) => None,
        }
    }
}

impl From<FormatError> for SnapshotError {
    fn from(error: FormatError) -> Self {
        Self::Format(error)
    }
}

#[derive(Default)]
struct DirectoryNode {
    entries: BTreeMap<String, NodeEntry>,
}

enum NodeEntry {
    Directory(DirectoryNode),
    Leaf(TreeEntry),
}

/// Builds canonical blob and tree objects independently for every non-empty
/// realm represented by the selected inputs.
///
/// # Errors
///
/// Returns an error for invalid paths, file/directory conflicts, cross-realm
/// duplicate paths, or an invalid canonical tree.
pub fn build_realm_snapshots(
    project: &str,
    actor_key: [u8; 32],
    created_at: &str,
    inputs: &[SnapshotInput],
) -> Result<Vec<BuiltRealmSnapshot>, SnapshotError> {
    let mut ownership = BTreeMap::new();
    for input in inputs {
        validate_path(&input.path)
            .map_err(|error| SnapshotError::InvalidPath(format!("{}: {error}", input.path)))?;
        if ownership
            .insert(input.path.clone(), input.realm)
            .is_some_and(|realm| realm != input.realm)
        {
            return Err(SnapshotError::RealmCollision(input.path.clone()));
        }
    }

    let mut snapshots = Vec::new();
    for realm in [Realm::Public, Realm::Members, Realm::Local] {
        let realm_inputs = inputs
            .iter()
            .filter(|input| input.realm == realm)
            .collect::<Vec<_>>();
        if realm_inputs.is_empty() {
            continue;
        }
        snapshots.push(build_realm_snapshot(
            project,
            actor_key,
            created_at,
            realm,
            &realm_inputs,
        )?);
    }
    Ok(snapshots)
}

fn build_realm_snapshot(
    project: &str,
    actor_key: [u8; 32],
    created_at: &str,
    realm: Realm,
    inputs: &[&SnapshotInput],
) -> Result<BuiltRealmSnapshot, SnapshotError> {
    let meta = ArtifactMeta {
        project: project.into(),
        realm,
        parents: Vec::new(),
        actor_key,
        logical_clock: 0,
        created_at: created_at.into(),
    };
    let mut root = DirectoryNode::default();
    let mut blobs = BTreeMap::new();
    for input in inputs {
        let segments = input.path.split('/').collect::<Vec<_>>();
        let entry = match &input.kind {
            SnapshotInputKind::Directory => None,
            SnapshotInputKind::File { bytes, executable } => {
                let id = artifact_id(bytes);
                blobs.entry(id.clone()).or_insert_with(|| bytes.clone());
                Some(TreeEntry {
                    name: String::new(),
                    mode: if *executable {
                        TreeEntryMode::Executable
                    } else {
                        TreeEntryMode::File
                    },
                    target: id,
                })
            }
            SnapshotInputKind::Symlink { target } => Some(TreeEntry {
                name: String::new(),
                mode: TreeEntryMode::Symlink,
                target: target.clone(),
            }),
        };
        insert_path(&mut root, &segments, entry, &input.path)?;
    }

    let mut trees = Vec::new();
    let root_id = build_tree(root, &meta, &mut trees)?;
    Ok(BuiltRealmSnapshot {
        realm,
        blobs: blobs
            .into_iter()
            .map(|(id, bytes)| BuiltBlob { id, bytes })
            .collect(),
        trees,
        root: root_id,
    })
}

fn insert_path(
    directory: &mut DirectoryNode,
    segments: &[&str],
    leaf: Option<TreeEntry>,
    full_path: &str,
) -> Result<(), SnapshotError> {
    let Some((name, remainder)) = segments.split_first() else {
        return Err(SnapshotError::InvalidPath(full_path.into()));
    };
    if remainder.is_empty() {
        match leaf {
            Some(mut leaf) => {
                leaf.name = (*name).into();
                if directory.entries.contains_key(*name) {
                    return Err(SnapshotError::PathConflict(full_path.into()));
                }
                directory
                    .entries
                    .insert((*name).into(), NodeEntry::Leaf(leaf));
            }
            None => match directory.entries.entry((*name).into()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(NodeEntry::Directory(DirectoryNode::default()));
                }
                std::collections::btree_map::Entry::Occupied(entry)
                    if matches!(entry.get(), NodeEntry::Directory(_)) => {}
                std::collections::btree_map::Entry::Occupied(_) => {
                    return Err(SnapshotError::PathConflict(full_path.into()));
                }
            },
        }
        return Ok(());
    }

    let entry = directory
        .entries
        .entry((*name).into())
        .or_insert_with(|| NodeEntry::Directory(DirectoryNode::default()));
    let NodeEntry::Directory(child) = entry else {
        return Err(SnapshotError::PathConflict(full_path.into()));
    };
    insert_path(child, remainder, leaf, full_path)
}

fn build_tree(
    directory: DirectoryNode,
    meta: &ArtifactMeta,
    output: &mut Vec<BuiltTree>,
) -> Result<String, SnapshotError> {
    let mut entries = Vec::with_capacity(directory.entries.len());
    for (name, entry) in directory.entries {
        match entry {
            NodeEntry::Directory(child) => entries.push(TreeEntry {
                name,
                mode: TreeEntryMode::Directory,
                target: build_tree(child, meta, output)?,
            }),
            NodeEntry::Leaf(entry) => entries.push(entry),
        }
    }
    let artifact = TreeArtifact {
        meta: meta.clone(),
        entries,
    };
    let id = artifact_id(&encode_tree(&artifact)?);
    output.push(BuiltTree {
        id: id.clone(),
        artifact,
    });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::{
        FORMAT_STATUS, SnapshotError, SnapshotInput, SnapshotInputKind, build_realm_snapshots,
        product_name,
    };
    use ef_format::{Realm, TreeEntryMode};

    const PROJECT: &str = "sha256:78ac6588c390ceb2d29f2be9ff9e001d8af391985c0cf865b365ed69b786656e";

    #[test]
    fn exposes_bootstrap_metadata() {
        assert_eq!(product_name(), "EdgeFossil");
        assert_eq!(FORMAT_STATUS, "experimental");
    }

    #[test]
    fn builds_deduplicated_blobs_and_child_first_trees() {
        let snapshots = build_realm_snapshots(
            PROJECT,
            [0x20; 32],
            "2026-08-24T00:00:00Z",
            &[
                SnapshotInput {
                    path: "src".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::Directory,
                },
                SnapshotInput {
                    path: "src/a.rs".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"same".to_vec(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "src/b.rs".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: b"same".to_vec(),
                        executable: true,
                    },
                },
            ],
        )
        .unwrap();
        assert_eq!(snapshots.len(), 1);
        let snapshot = &snapshots[0];
        assert_eq!(snapshot.blobs.len(), 1);
        assert_eq!(snapshot.trees.len(), 2);
        assert_eq!(snapshot.trees.last().unwrap().id, snapshot.root);
        let child = &snapshot.trees[0].artifact.entries;
        assert_eq!(child[0].mode, TreeEntryMode::File);
        assert_eq!(child[1].mode, TreeEntryMode::Executable);
    }

    #[test]
    fn realm_roots_are_built_independently() {
        let base = SnapshotInput {
            path: "public.txt".into(),
            realm: Realm::Public,
            kind: SnapshotInputKind::File {
                bytes: b"public".to_vec(),
                executable: false,
            },
        };
        let public_only = build_realm_snapshots(
            PROJECT,
            [0x20; 32],
            "2026-08-24T00:00:00Z",
            std::slice::from_ref(&base),
        )
        .unwrap();
        let with_members = build_realm_snapshots(
            PROJECT,
            [0x20; 32],
            "2026-08-24T00:00:00Z",
            &[
                base,
                SnapshotInput {
                    path: "private.txt".into(),
                    realm: Realm::Members,
                    kind: SnapshotInputKind::File {
                        bytes: b"members".to_vec(),
                        executable: false,
                    },
                },
            ],
        )
        .unwrap();
        assert_eq!(public_only[0].root, with_members[0].root);
        assert_eq!(with_members.len(), 2);
    }

    #[test]
    fn rejects_portable_name_and_file_directory_collisions() {
        let collision = build_realm_snapshots(
            PROJECT,
            [0x20; 32],
            "2026-08-24T00:00:00Z",
            &[
                SnapshotInput {
                    path: "A".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::Directory,
                },
                SnapshotInput {
                    path: "a".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::Directory,
                },
            ],
        );
        assert!(matches!(collision, Err(SnapshotError::Format(_))));

        let conflict = build_realm_snapshots(
            PROJECT,
            [0x20; 32],
            "2026-08-24T00:00:00Z",
            &[
                SnapshotInput {
                    path: "file".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::File {
                        bytes: Vec::new(),
                        executable: false,
                    },
                },
                SnapshotInput {
                    path: "file/child".into(),
                    realm: Realm::Public,
                    kind: SnapshotInputKind::Directory,
                },
            ],
        );
        assert!(matches!(conflict, Err(SnapshotError::PathConflict(_))));
    }
}
