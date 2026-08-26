use std::collections::BTreeMap;

use ef_store_sqlite::{PublicPushPreflightSnapshot, StoreError, plan_fresh_public_push};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    project_id: String,
    head_artifact_id: String,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
    fresh_push_plan: ExpectedPlan,
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

fn inputs(vector: &Vector) -> (Vec<u8>, BTreeMap<String, Vec<u8>>) {
    (
        decode_hex(&vector.manifest_cbor_hex),
        vector
            .files
            .iter()
            .map(|(path, body)| (path.clone(), decode_hex(body)))
            .collect(),
    )
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
    let (manifest, objects) = inputs(&vector);
    let plan = plan_fresh_public_push(
        &manifest,
        &objects,
        &snapshot(&vector.fresh_push_plan.snapshot),
    )
    .expect("fresh push plan");

    assert_eq!(plan.project_id, vector.project_id);
    assert_eq!(plan.head_artifact_id, vector.head_artifact_id);
    assert_eq!(plan.realm.as_str(), "public");
    assert_eq!(plan.blobs.len(), vector.fresh_push_plan.blobs.len());
    for (actual, expected) in plan.blobs.iter().zip(&vector.fresh_push_plan.blobs) {
        assert_eq!(actual.blob_id, expected.blob_id);
        assert_eq!(actual.byte_size, expected.byte_size);
        assert_eq!(actual.object_path, expected.object_path);
        assert_eq!(actual.operation_id, expected.operation_id);
    }
    assert_eq!(plan.artifacts.len(), vector.fresh_push_plan.artifacts.len());
    for (actual, expected) in plan.artifacts.iter().zip(&vector.fresh_push_plan.artifacts) {
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

#[test]
fn fresh_plan_rejects_nonfresh_or_incomplete_preflight_observations() {
    let vector = vector();
    let (manifest, objects) = inputs(&vector);
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
