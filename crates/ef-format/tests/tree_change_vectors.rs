use std::str::FromStr;

use ef_format::{
    ArtifactMeta, ChangeArtifact, FormatErrorCode, Realm, TreeArtifact, TreeEntry, TreeEntryMode,
    artifact_id, decode_change, decode_tree, encode_change, encode_tree,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct ArtifactVector {
    profile: String,
    project: String,
    actor_key_hex: String,
    tree: TreeVector,
    change: ChangeVector,
    invalid_trees: Vec<InvalidTree>,
    invalid_changes: Vec<InvalidChange>,
}

#[derive(Deserialize)]
struct TreeVector {
    realm: String,
    logical_clock: u64,
    created_at: String,
    entries: Vec<EntryVector>,
    canonical_cbor_hex: String,
    artifact_id: String,
}

#[derive(Clone, Deserialize)]
struct EntryVector {
    name: String,
    mode: String,
    target: String,
}

#[derive(Deserialize)]
struct ChangeVector {
    realm: String,
    logical_clock: u64,
    created_at: String,
    root: String,
    message: String,
    canonical_cbor_hex: String,
    artifact_id: String,
}

#[derive(Deserialize)]
struct InvalidTree {
    name: String,
    entries: Vec<EntryVector>,
    error: String,
}

#[derive(Deserialize)]
struct InvalidChange {
    name: String,
    root: String,
    message: String,
    error: String,
}

fn vectors() -> ArtifactVector {
    serde_json::from_str(include_str!("../../../spec/vectors/tree-change-v0.json"))
        .expect("valid tree/change vectors")
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid hex")
        })
        .collect()
}

fn mode(value: &str) -> TreeEntryMode {
    match value {
        "file" => TreeEntryMode::File,
        "executable" => TreeEntryMode::Executable,
        "directory" => TreeEntryMode::Directory,
        "symlink" => TreeEntryMode::Symlink,
        _ => panic!("unknown test mode"),
    }
}

fn entries(values: &[EntryVector]) -> Vec<TreeEntry> {
    values
        .iter()
        .map(|entry| TreeEntry {
            name: entry.name.clone(),
            mode: mode(&entry.mode),
            target: entry.target.clone(),
        })
        .collect()
}

fn actor_key(vector: &ArtifactVector) -> [u8; 32] {
    decode_hex(&vector.actor_key_hex)
        .try_into()
        .expect("32-byte actor key")
}

fn error_name(code: FormatErrorCode) -> &'static str {
    match code {
        FormatErrorCode::InvalidArtifactId => "invalid_artifact_id",
        FormatErrorCode::InvalidSchema => "invalid_schema",
        FormatErrorCode::PathCollision => "path_collision",
        _ => "unexpected_error",
    }
}

#[test]
fn tree_vector_encodes_hashes_and_decodes() {
    let vector = vectors();
    assert_eq!(vector.profile, "edgefossil-artifact-v0");
    let key = actor_key(&vector);
    let tree = TreeArtifact {
        meta: ArtifactMeta {
            project: vector.project.clone(),
            realm: Realm::from_str(&vector.tree.realm).expect("realm"),
            parents: Vec::new(),
            actor_key: key,
            logical_clock: vector.tree.logical_clock,
            created_at: vector.tree.created_at,
        },
        entries: entries(&vector.tree.entries),
    };
    let encoded = encode_tree(&tree).expect("valid tree");
    assert_eq!(encoded, decode_hex(&vector.tree.canonical_cbor_hex));
    assert_eq!(artifact_id(&encoded), vector.tree.artifact_id);
    let mut expected = tree;
    expected
        .entries
        .sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    assert_eq!(decode_tree(&encoded), Ok(expected));
}

#[test]
fn change_vector_encodes_hashes_and_decodes() {
    let vector = vectors();
    let key = actor_key(&vector);
    let change = ChangeArtifact {
        meta: ArtifactMeta {
            project: vector.project.clone(),
            realm: Realm::from_str(&vector.change.realm).expect("realm"),
            parents: Vec::new(),
            actor_key: key,
            logical_clock: vector.change.logical_clock,
            created_at: vector.change.created_at,
        },
        root: vector.change.root,
        message: vector.change.message,
    };
    let encoded = encode_change(&change).expect("valid change");
    assert_eq!(encoded, decode_hex(&vector.change.canonical_cbor_hex));
    assert_eq!(artifact_id(&encoded), vector.change.artifact_id);
    assert_eq!(decode_change(&encoded), Ok(change));
}

#[test]
fn invalid_tree_vectors_are_rejected() {
    let vector = vectors();
    let key = actor_key(&vector);
    for invalid in vector.invalid_trees {
        let tree = TreeArtifact {
            meta: ArtifactMeta {
                project: vector.project.clone(),
                realm: Realm::Public,
                parents: Vec::new(),
                actor_key: key,
                logical_clock: 1,
                created_at: vector.tree.created_at.clone(),
            },
            entries: entries(&invalid.entries),
        };
        let error = encode_tree(&tree).expect_err("invalid tree");
        assert_eq!(error_name(error.code), invalid.error, "{}", invalid.name);
    }
}

#[test]
fn invalid_change_vectors_are_rejected() {
    let vector = vectors();
    let key = actor_key(&vector);
    for invalid in vector.invalid_changes {
        let change = ChangeArtifact {
            meta: ArtifactMeta {
                project: vector.project.clone(),
                realm: Realm::Public,
                parents: Vec::new(),
                actor_key: key,
                logical_clock: 2,
                created_at: vector.change.created_at.clone(),
            },
            root: invalid.root,
            message: invalid.message,
        };
        let error = encode_change(&change).expect_err("invalid change");
        assert_eq!(error_name(error.code), invalid.error, "{}", invalid.name);
    }
}
