use std::collections::BTreeMap;

use ef_store_sqlite::{
    PublicPushPlan, PublicPushPreflightSnapshot, StoreError, plan_fresh_public_push,
    plan_incremental_public_push,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    project_id: String,
    head_artifact_id: String,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
    fresh_push_plan: ExpectedPlan,
    incremental_push: IncrementalPush,
}

#[derive(Deserialize)]
struct IncrementalPush {
    head_artifact_id: String,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
    plan: ExpectedPlan,
}

#[derive(Deserialize)]
struct ExpectedPlan {
    snapshot: Snapshot,
    blobs: Vec<BlobStep>,
    artifacts: Vec<ArtifactStep>,
}

#[derive(Clone, Deserialize)]
struct Snapshot {
    accepted_sequence: u64,
    missing_artifact_ids: Vec<String>,
    missing_blob_ids: Vec<String>,
    policy_epoch: u64,
    project_id: Option<String>,
    ref_generation: Option<u64>,
    ref_target: Option<String>,
}

#[derive(Deserialize)]
struct BlobStep {
    blob_id: String,
    byte_size: u64,
    object_path: String,
    operation_id: String,
}

#[derive(Deserialize)]
struct ArtifactStep {
    artifact_id: String,
    artifact_path: String,
    expected_policy_epoch: u64,
    kind: String,
    operation_id: String,
    r#ref: Option<RefStep>,
    signature_path: String,
}

#[derive(Deserialize)]
struct RefStep {
    expected_generation: u64,
    name: String,
}

fn vector() -> Vector {
    serde_json::from_str(include_str!("../../../spec/vectors/public-clone-v0.json"))
        .expect("public clone vector")
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII hex"), 16)
                .expect("valid hex")
        })
        .collect()
}

fn inputs(
    manifest: &str,
    files: &BTreeMap<String, String>,
) -> (Vec<u8>, BTreeMap<String, Vec<u8>>) {
    (
        decode_hex(manifest),
        files
            .iter()
            .map(|(path, body)| (path.clone(), decode_hex(body)))
            .collect(),
    )
}

fn assert_plan(actual: &PublicPushPlan, expected: &ExpectedPlan) {
    assert_eq!(actual.blobs.len(), expected.blobs.len());
    for (actual, expected) in actual.blobs.iter().zip(&expected.blobs) {
        assert_eq!(actual.blob_id, expected.blob_id);
        assert_eq!(actual.byte_size, expected.byte_size);
        assert_eq!(actual.object_path, expected.object_path);
        assert_eq!(actual.operation_id, expected.operation_id);
    }
    assert_eq!(actual.artifacts.len(), expected.artifacts.len());
    for (actual, expected) in actual.artifacts.iter().zip(&expected.artifacts) {
        assert_eq!(actual.artifact_id, expected.artifact_id);
        assert_eq!(actual.artifact_path, expected.artifact_path);
        assert_eq!(actual.expected_policy_epoch, expected.expected_policy_epoch);
        assert_eq!(actual.kind.as_str(), expected.kind);
        assert_eq!(actual.operation_id, expected.operation_id);
        assert_eq!(actual.signature_path, expected.signature_path);
        match (&actual.ref_update, &expected.r#ref) {
            (None, None) => {}
            (Some(actual), Some(expected)) => {
                assert_eq!(actual.expected_generation, expected.expected_generation);
                assert_eq!(actual.name, expected.name);
            }
            _ => panic!("ref step differs"),
        }
    }
}

fn snapshot(value: &Snapshot) -> PublicPushPreflightSnapshot {
    PublicPushPreflightSnapshot {
        accepted_sequence: value.accepted_sequence,
        missing_artifact_ids: value.missing_artifact_ids.clone(),
        missing_blob_ids: value.missing_blob_ids.clone(),
        policy_epoch: value.policy_epoch,
        project_id: value.project_id.clone(),
        ref_generation: value.ref_generation,
        ref_target: value.ref_target.clone(),
    }
}

#[test]
fn verified_typescript_bundle_produces_the_exact_fresh_push_plan() {
    let vector = vector();
    let (manifest, objects) = inputs(&vector.manifest_cbor_hex, &vector.files);
    let plan = plan_fresh_public_push(
        &manifest,
        &objects,
        &snapshot(&vector.fresh_push_plan.snapshot),
    )
    .expect("fresh push plan");

    assert_eq!(plan.project_id, vector.project_id);
    assert_eq!(plan.head_artifact_id, vector.head_artifact_id);
    assert_eq!(plan.realm.as_str(), "public");
    assert_plan(&plan, &vector.fresh_push_plan);
}

#[test]
fn fresh_plan_rejects_nonfresh_or_incomplete_preflight_observations() {
    let vector = vector();
    let (manifest, objects) = inputs(&vector.manifest_cbor_hex, &vector.files);
    let mut nonfresh = snapshot(&vector.fresh_push_plan.snapshot);
    nonfresh.accepted_sequence = 1;
    assert!(matches!(
        plan_fresh_public_push(&manifest, &objects, &nonfresh),
        Err(StoreError::InvalidPushPlan(_))
    ));

    let mut incomplete = snapshot(&vector.fresh_push_plan.snapshot);
    incomplete.missing_artifact_ids.pop();
    assert!(matches!(
        plan_fresh_public_push(&manifest, &objects, &incomplete),
        Err(StoreError::InvalidPushPlan(_))
    ));
}

#[test]
fn verified_typescript_bundle_produces_exact_incremental_suffix_and_retry_plan() {
    let vector = vector();
    let fixture = &vector.incremental_push;
    let (manifest, objects) = inputs(&fixture.manifest_cbor_hex, &fixture.files);
    let first =
        plan_incremental_public_push(&manifest, &objects, &snapshot(&fixture.plan.snapshot))
            .expect("incremental push plan");
    let retry =
        plan_incremental_public_push(&manifest, &objects, &snapshot(&fixture.plan.snapshot))
            .expect("identical incremental retry plan");

    assert_eq!(first, retry);
    assert_eq!(first.project_id, vector.project_id);
    assert_eq!(first.head_artifact_id, fixture.head_artifact_id);
    assert_plan(&first, &fixture.plan);
}

#[test]
fn incremental_plan_resumes_partial_fresh_push_and_converges_to_empty() {
    let vector = vector();
    let (manifest, objects) = inputs(&vector.manifest_cbor_hex, &vector.files);
    let fresh = &vector.fresh_push_plan.snapshot;

    let after_blob = PublicPushPreflightSnapshot {
        missing_blob_ids: Vec::new(),
        ..snapshot(fresh)
    };
    let blob_retry = plan_incremental_public_push(&manifest, &objects, &after_blob)
        .expect("resume after blob response loss");
    assert!(blob_retry.blobs.is_empty());
    assert_eq!(blob_retry.artifacts.len(), 3);

    let after_non_ref_artifacts = PublicPushPreflightSnapshot {
        accepted_sequence: 2,
        missing_artifact_ids: vec![vector.head_artifact_id.clone()],
        missing_blob_ids: Vec::new(),
        project_id: Some(vector.project_id.clone()),
        ..snapshot(fresh)
    };
    let ref_resume = plan_incremental_public_push(&manifest, &objects, &after_non_ref_artifacts)
        .expect("resume before first ref");
    assert_eq!(ref_resume.artifacts.len(), 1);
    assert_eq!(ref_resume.artifacts[0].artifact_id, vector.head_artifact_id);
    assert_eq!(
        ref_resume.artifacts[0]
            .ref_update
            .as_ref()
            .expect("ref update")
            .expected_generation,
        0
    );

    let converged = PublicPushPreflightSnapshot {
        accepted_sequence: 3,
        missing_artifact_ids: Vec::new(),
        missing_blob_ids: Vec::new(),
        project_id: Some(vector.project_id.clone()),
        ref_generation: Some(1),
        ref_target: Some(vector.head_artifact_id.clone()),
        ..snapshot(fresh)
    };
    let empty = plan_incremental_public_push(&manifest, &objects, &converged)
        .expect("fully converged plan");
    assert!(empty.artifacts.is_empty());
    assert!(empty.blobs.is_empty());
}

#[test]
fn incremental_plan_rejects_unknown_heads_and_inconsistent_accepted_prefixes() {
    let vector = vector();
    let fixture = &vector.incremental_push;
    let (manifest, objects) = inputs(&fixture.manifest_cbor_hex, &fixture.files);

    let mut diverged = snapshot(&fixture.plan.snapshot);
    diverged.ref_target = Some(format!("sha256:{}", "ff".repeat(32)));
    assert!(matches!(
        plan_incremental_public_push(&manifest, &objects, &diverged),
        Err(StoreError::PushHeadConflict(_))
    ));

    let mut impossible_initialized = snapshot(&fixture.plan.snapshot);
    impossible_initialized.accepted_sequence = 0;
    assert!(matches!(
        plan_incremental_public_push(&manifest, &objects, &impossible_initialized),
        Err(StoreError::InvalidPushPlan(_))
    ));

    let tree_id = vector.fresh_push_plan.artifacts[1].artifact_id.clone();
    let mut corrupt_prefix = snapshot(&fixture.plan.snapshot);
    corrupt_prefix.missing_artifact_ids = vec![tree_id, fixture.head_artifact_id.clone()];
    corrupt_prefix.missing_artifact_ids.sort();
    assert!(matches!(
        plan_incremental_public_push(&manifest, &objects, &corrupt_prefix),
        Err(StoreError::InvalidPushPlan(_))
    ));
}
