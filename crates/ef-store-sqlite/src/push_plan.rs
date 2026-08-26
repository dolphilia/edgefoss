use std::collections::{BTreeMap, BTreeSet};

use ef_format::{
    Realm, decode_bundle_manifest, decode_change, decode_signature_record, decode_tree,
};
use sha2::{Digest, Sha256};

use super::{StoreError, bundle_object_path, verify_portable_bundle};

const MAX_PREFLIGHT_IDS: usize = 256;

/// One authority observation accepted by the fresh-public push profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicPushPreflightSnapshot {
    pub accepted_sequence: u64,
    pub missing_artifact_ids: Vec<String>,
    pub missing_blob_ids: Vec<String>,
    pub policy_epoch: u64,
    pub project_id: Option<String>,
    pub ref_generation: Option<u64>,
    pub ref_target: Option<String>,
}

/// A finalized-blob upload required before artifact publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicPushBlobStep {
    pub blob_id: String,
    pub byte_size: u64,
    pub object_path: String,
    pub operation_id: String,
}

/// Artifact kind used by the cloud publication adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicPushArtifactKind {
    ProjectGenesis,
    Tree,
    Change,
}

impl PublicPushArtifactKind {
    /// Returns the stable cloud publication spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProjectGenesis => "project.genesis",
            Self::Tree => "tree",
            Self::Change => "change",
        }
    }
}

/// One compare-and-swap ref mutation attached to a change publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicPushRefStep {
    pub expected_generation: u64,
    pub name: String,
}

/// One signed canonical artifact publication in dependency-safe order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicPushArtifactStep {
    pub artifact_id: String,
    pub artifact_path: String,
    pub expected_policy_epoch: u64,
    pub kind: PublicPushArtifactKind,
    pub operation_id: String,
    pub ref_update: Option<PublicPushRefStep>,
    pub signature_path: String,
}

/// A complete bounded mutation plan from one authority observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicPushPlan {
    pub artifacts: Vec<PublicPushArtifactStep>,
    pub blobs: Vec<PublicPushBlobStep>,
    pub head_artifact_id: String,
    pub project_id: String,
    pub realm: Realm,
    pub semantic_root: String,
}

/// The P5b1a name for a [`PublicPushPlan`] constrained to a fresh authority.
pub type FreshPublicPushPlan = PublicPushPlan;

/// Builds a deterministic fresh-authority public push plan from a fully
/// verified portable bundle and the exact P5b0 preflight observation.
///
/// # Errors
///
/// Rejects a non-public or oversized bundle, a non-fresh or mismatched
/// preflight, invalid bundle bytes, or a dependency order that cannot be
/// reconstructed.
pub fn plan_fresh_public_push(
    manifest_bytes: &[u8],
    objects: &BTreeMap<String, Vec<u8>>,
    snapshot: &PublicPushPreflightSnapshot,
) -> Result<FreshPublicPushPlan, StoreError> {
    plan_public_push(manifest_bytes, objects, snapshot, true)
}

/// Builds a deterministic incremental public push plan from a fully verified
/// bundle and one P5b0 authority observation.
///
/// # Errors
///
/// Rejects project or inventory inconsistencies and returns
/// [`StoreError::PushHeadConflict`] when the authority head is not in the local
/// linear history.
pub fn plan_incremental_public_push(
    manifest_bytes: &[u8],
    objects: &BTreeMap<String, Vec<u8>>,
    snapshot: &PublicPushPreflightSnapshot,
) -> Result<PublicPushPlan, StoreError> {
    plan_public_push(manifest_bytes, objects, snapshot, false)
}

fn plan_public_push(
    manifest_bytes: &[u8],
    objects: &BTreeMap<String, Vec<u8>>,
    snapshot: &PublicPushPreflightSnapshot,
    require_fresh: bool,
) -> Result<PublicPushPlan, StoreError> {
    verify_portable_bundle(manifest_bytes, objects, &[])?;
    let manifest = decode_bundle_manifest(manifest_bytes)?;
    if manifest.realm != Realm::Public {
        return Err(invalid("fresh push supports only the public realm"));
    }
    if manifest.artifacts.len() > MAX_PREFLIGHT_IDS || manifest.blobs.len() > MAX_PREFLIGHT_IDS {
        return Err(invalid("bundle exceeds the fresh preflight bounds"));
    }
    validate_inventory(&manifest.artifacts, &manifest.blobs, snapshot)?;

    let decoded = decode_push_bundle(&manifest, objects)?;

    let head = manifest
        .refs
        .iter()
        .find(|(name, _)| name == "heads/main")
        .map(|(_, target)| target.clone())
        .ok_or_else(|| invalid("public heads/main is missing"))?;
    let tree_order = topological_trees(&decoded.trees)?;
    let change_order = chronological_changes(&head, &decoded.changes)?;
    let (change_start, base_generation) = if require_fresh {
        validate_fresh_snapshot(&manifest.artifacts, &manifest.blobs, snapshot)?;
        (0, 0)
    } else {
        validate_incremental_snapshot(
            &manifest.project,
            &decoded.trees,
            &decoded.changes,
            &change_order,
            snapshot,
        )?
    };
    let missing_artifacts = snapshot
        .missing_artifact_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let missing_blobs = snapshot
        .missing_blob_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let artifacts = build_artifact_steps(
        &manifest.project,
        &tree_order,
        &change_order[change_start..],
        base_generation,
        snapshot,
        &decoded.signatures,
    )?;
    let planned_artifacts = artifacts
        .iter()
        .map(|step| step.artifact_id.clone())
        .collect::<BTreeSet<_>>();
    if !missing_artifacts.is_subset(&planned_artifacts) {
        return Err(invalid("missing artifact is outside the mutation suffix"));
    }

    let blobs = build_blob_steps(
        &manifest.project,
        &manifest.blobs,
        &missing_blobs,
        objects,
        snapshot.policy_epoch,
    )?;

    Ok(PublicPushPlan {
        artifacts,
        blobs,
        head_artifact_id: head,
        project_id: manifest.project,
        realm: Realm::Public,
        semantic_root: manifest.semantic_root,
    })
}

struct DecodedPushBundle {
    changes: BTreeMap<String, ef_format::ChangeArtifact>,
    signatures: BTreeMap<String, String>,
    trees: BTreeMap<String, ef_format::TreeArtifact>,
}

fn decode_push_bundle(
    manifest: &ef_format::BundleManifest,
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<DecodedPushBundle, StoreError> {
    let mut signatures = BTreeMap::new();
    for signature_id in &manifest.signatures {
        let path = bundle_object_path("signatures", signature_id);
        let record = decode_signature_record(&objects[&path])?;
        signatures.insert(record.artifact, path);
    }
    let mut trees = BTreeMap::new();
    let mut changes = BTreeMap::new();
    for artifact_id in &manifest.artifacts {
        if artifact_id == &manifest.project {
            continue;
        }
        let body = &objects[&bundle_object_path("artifacts", artifact_id)];
        if let Ok(tree) = decode_tree(body) {
            trees.insert(artifact_id.clone(), tree);
        } else if let Ok(change) = decode_change(body) {
            changes.insert(artifact_id.clone(), change);
        } else {
            return Err(invalid("verified artifact kind cannot be planned"));
        }
    }
    Ok(DecodedPushBundle {
        changes,
        signatures,
        trees,
    })
}

fn build_artifact_steps(
    project_id: &str,
    tree_order: &[String],
    remaining_changes: &[String],
    base_generation: u64,
    snapshot: &PublicPushPreflightSnapshot,
    signatures: &BTreeMap<String, String>,
) -> Result<Vec<PublicPushArtifactStep>, StoreError> {
    let missing = snapshot
        .missing_artifact_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut steps = Vec::new();
    if missing.contains(project_id) {
        steps.push(artifact_step(
            project_id,
            PublicPushArtifactKind::ProjectGenesis,
            None,
            project_id,
            snapshot.policy_epoch,
            signatures,
        )?);
    }
    for artifact_id in tree_order.iter().filter(|id| missing.contains(*id)) {
        steps.push(artifact_step(
            artifact_id,
            PublicPushArtifactKind::Tree,
            None,
            project_id,
            snapshot.policy_epoch,
            signatures,
        )?);
    }
    for (offset, artifact_id) in remaining_changes.iter().enumerate() {
        let expected_generation = base_generation
            .checked_add(u64::try_from(offset).map_err(|_| invalid("generation overflow"))?)
            .ok_or_else(|| invalid("generation overflow"))?;
        steps.push(artifact_step(
            artifact_id,
            PublicPushArtifactKind::Change,
            Some(expected_generation),
            project_id,
            snapshot.policy_epoch,
            signatures,
        )?);
    }
    Ok(steps)
}

fn build_blob_steps(
    project_id: &str,
    blob_ids: &[String],
    missing: &BTreeSet<String>,
    objects: &BTreeMap<String, Vec<u8>>,
    policy_epoch: u64,
) -> Result<Vec<PublicPushBlobStep>, StoreError> {
    blob_ids
        .iter()
        .filter(|blob_id| missing.contains(*blob_id))
        .map(|blob_id| {
            let object_path = bundle_object_path("blobs", blob_id);
            let byte_size = u64::try_from(objects[&object_path].len())
                .map_err(|_| invalid("blob byte size exceeds u64"))?;
            Ok(PublicPushBlobStep {
                blob_id: blob_id.clone(),
                byte_size,
                object_path,
                operation_id: operation_id(&[
                    "upload",
                    project_id,
                    "public",
                    blob_id,
                    &byte_size.to_string(),
                    &policy_epoch.to_string(),
                ]),
            })
        })
        .collect()
}

fn validate_inventory(
    artifact_ids: &[String],
    blob_ids: &[String],
    snapshot: &PublicPushPreflightSnapshot,
) -> Result<(), StoreError> {
    validate_missing_ids(&snapshot.missing_artifact_ids, artifact_ids)?;
    validate_missing_ids(&snapshot.missing_blob_ids, blob_ids)?;
    if snapshot.ref_generation.is_some() != snapshot.ref_target.is_some() {
        return Err(invalid("ref target and generation presence differ"));
    }
    Ok(())
}

fn validate_missing_ids(missing: &[String], inventory: &[String]) -> Result<(), StoreError> {
    if missing.len() > MAX_PREFLIGHT_IDS
        || missing.windows(2).any(|pair| pair[0] >= pair[1])
        || missing
            .iter()
            .any(|candidate| inventory.binary_search(candidate).is_err())
    {
        return Err(invalid("preflight missing inventory is invalid"));
    }
    Ok(())
}

fn validate_fresh_snapshot(
    artifact_ids: &[String],
    blob_ids: &[String],
    snapshot: &PublicPushPreflightSnapshot,
) -> Result<(), StoreError> {
    if snapshot.accepted_sequence != 0
        || snapshot.policy_epoch != 0
        || snapshot.project_id.is_some()
        || snapshot.ref_generation.is_some()
        || snapshot.ref_target.is_some()
    {
        return Err(invalid("authority snapshot is not fresh"));
    }
    if snapshot.missing_artifact_ids != artifact_ids || snapshot.missing_blob_ids != blob_ids {
        return Err(invalid("preflight inventory does not match the bundle"));
    }
    Ok(())
}

fn validate_incremental_snapshot(
    project_id: &str,
    trees: &BTreeMap<String, ef_format::TreeArtifact>,
    changes: &BTreeMap<String, ef_format::ChangeArtifact>,
    change_order: &[String],
    snapshot: &PublicPushPreflightSnapshot,
) -> Result<(usize, u64), StoreError> {
    let missing_artifacts = snapshot
        .missing_artifact_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let missing_blobs = snapshot
        .missing_blob_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();

    match snapshot.project_id.as_deref() {
        None => {
            if snapshot.accepted_sequence != 0
                || snapshot.policy_epoch != 0
                || snapshot.ref_target.is_some()
                || !missing_artifacts.contains(project_id)
            {
                return Err(invalid("uninitialized authority snapshot is inconsistent"));
            }
            Ok((0, 0))
        }
        Some(stored_project) => {
            if snapshot.accepted_sequence == 0 {
                return Err(invalid("initialized authority sequence is zero"));
            }
            if stored_project != project_id {
                return Err(invalid("authority project differs from the bundle"));
            }
            if missing_artifacts.contains(project_id) {
                return Err(invalid("initialized authority reports genesis missing"));
            }
            let Some(remote_head) = snapshot.ref_target.as_deref() else {
                return Ok((0, 0));
            };
            let remote_index = change_order
                .iter()
                .position(|candidate| candidate == remote_head)
                .ok_or_else(|| StoreError::PushHeadConflict(remote_head.to_owned()))?;
            let change_start = remote_index + 1;
            let (prefix_artifacts, prefix_blobs) =
                accepted_prefix(project_id, trees, changes, &change_order[..change_start])?;
            if !missing_artifacts.is_disjoint(&prefix_artifacts)
                || !missing_blobs.is_disjoint(&prefix_blobs)
            {
                return Err(invalid(
                    "authority head prefix reports a reachable object missing",
                ));
            }
            Ok((
                change_start,
                snapshot
                    .ref_generation
                    .ok_or_else(|| invalid("remote ref generation is missing"))?,
            ))
        }
    }
}

fn accepted_prefix(
    project_id: &str,
    trees: &BTreeMap<String, ef_format::TreeArtifact>,
    changes: &BTreeMap<String, ef_format::ChangeArtifact>,
    accepted_changes: &[String],
) -> Result<(BTreeSet<String>, BTreeSet<String>), StoreError> {
    fn collect_tree(
        id: &str,
        trees: &BTreeMap<String, ef_format::TreeArtifact>,
        artifacts: &mut BTreeSet<String>,
        blobs: &mut BTreeSet<String>,
    ) -> Result<(), StoreError> {
        if !artifacts.insert(id.to_owned()) {
            return Ok(());
        }
        let tree = trees
            .get(id)
            .ok_or_else(|| invalid("accepted prefix tree is absent"))?;
        for entry in &tree.entries {
            match entry.mode {
                ef_format::TreeEntryMode::Directory => {
                    collect_tree(&entry.target, trees, artifacts, blobs)?;
                }
                ef_format::TreeEntryMode::Symlink => {}
                ef_format::TreeEntryMode::File | ef_format::TreeEntryMode::Executable => {
                    blobs.insert(entry.target.clone());
                }
            }
        }
        Ok(())
    }

    let mut artifacts = BTreeSet::from([project_id.to_owned()]);
    let mut blobs = BTreeSet::new();
    for change_id in accepted_changes {
        artifacts.insert(change_id.clone());
        let change = changes
            .get(change_id)
            .ok_or_else(|| invalid("accepted prefix change is absent"))?;
        collect_tree(&change.root, trees, &mut artifacts, &mut blobs)?;
    }
    Ok((artifacts, blobs))
}

fn topological_trees(
    trees: &BTreeMap<String, ef_format::TreeArtifact>,
) -> Result<Vec<String>, StoreError> {
    fn visit(
        id: &str,
        trees: &BTreeMap<String, ef_format::TreeArtifact>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        output: &mut Vec<String>,
    ) -> Result<(), StoreError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_owned()) {
            return Err(invalid("tree dependency contains a cycle"));
        }
        let tree = trees
            .get(id)
            .ok_or_else(|| invalid("tree dependency is absent"))?;
        for child in tree
            .entries
            .iter()
            .filter(|entry| entry.mode == ef_format::TreeEntryMode::Directory)
        {
            visit(&child.target, trees, visiting, visited, output)?;
        }
        visiting.remove(id);
        visited.insert(id.to_owned());
        output.push(id.to_owned());
        Ok(())
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut output = Vec::with_capacity(trees.len());
    for id in trees.keys() {
        visit(id, trees, &mut visiting, &mut visited, &mut output)?;
    }
    Ok(output)
}

fn chronological_changes(
    head: &str,
    changes: &BTreeMap<String, ef_format::ChangeArtifact>,
) -> Result<Vec<String>, StoreError> {
    let mut newest_first = Vec::with_capacity(changes.len());
    let mut seen = BTreeSet::new();
    let mut next = Some(head.to_owned());
    while let Some(id) = next.take() {
        if !seen.insert(id.clone()) {
            return Err(invalid("change ancestry contains a cycle"));
        }
        let change = changes
            .get(&id)
            .ok_or_else(|| invalid("change ancestry is incomplete"))?;
        newest_first.push(id);
        next = change.meta.parents.first().cloned();
    }
    if newest_first.len() != changes.len() {
        return Err(invalid("change plan is not the exact bundle history"));
    }
    newest_first.reverse();
    Ok(newest_first)
}

fn artifact_step(
    artifact_id: &str,
    kind: PublicPushArtifactKind,
    expected_generation: Option<u64>,
    project_id: &str,
    policy_epoch: u64,
    signatures: &BTreeMap<String, String>,
) -> Result<PublicPushArtifactStep, StoreError> {
    let signature_path = signatures
        .get(artifact_id)
        .cloned()
        .ok_or_else(|| invalid("artifact signature path is missing"))?;
    let generation = expected_generation.map_or_else(|| "-".into(), |value| value.to_string());
    Ok(PublicPushArtifactStep {
        artifact_id: artifact_id.to_owned(),
        artifact_path: bundle_object_path("artifacts", artifact_id),
        expected_policy_epoch: policy_epoch,
        kind,
        operation_id: operation_id(&[
            "publish",
            project_id,
            "public",
            artifact_id,
            &policy_epoch.to_string(),
            &generation,
        ]),
        ref_update: expected_generation.map(|expected_generation| PublicPushRefStep {
            expected_generation,
            name: "heads/main".into(),
        }),
        signature_path,
    })
}

fn operation_id(fields: &[&str]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"edgefoss:push-operation:v0\0");
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            digest.update(b"\0");
        }
        digest.update(field.as_bytes());
    }
    let hash = digest.finalize();
    let mut bytes: [u8; 16] = hash[..16].try_into().expect("SHA-256 prefix");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidPushPlan(message.into())
}
