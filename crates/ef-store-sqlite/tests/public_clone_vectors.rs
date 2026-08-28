use std::collections::BTreeMap;

use ef_format::Realm;
use ef_store_sqlite::{
    LocalRepository, PublicReconcileOutcome, StoreError, verify_portable_bundle,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct PublicCloneVector {
    profile: String,
    project_id: String,
    head_artifact_id: String,
    ref_generation: u64,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
    incremental_push: IncrementalBundle,
}

#[derive(Deserialize)]
struct IncrementalBundle {
    head_artifact_id: String,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
}

fn vector() -> PublicCloneVector {
    serde_json::from_str(include_str!("../../../spec/vectors/public-clone-v0.json"))
        .expect("valid public clone vector")
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

fn objects(vector: &PublicCloneVector) -> BTreeMap<String, Vec<u8>> {
    vector
        .files
        .iter()
        .map(|(path, body)| (path.clone(), decode_hex(body)))
        .collect()
}

#[test]
fn imports_exact_worker_clone_into_fresh_store_and_reexports_identically() {
    let vector = vector();
    assert_eq!(vector.profile, "edgefossil-public-clone-v0");
    let manifest_bytes = decode_hex(&vector.manifest_cbor_hex);
    let objects = objects(&vector);
    let verified = verify_portable_bundle(&manifest_bytes, &objects, &[])
        .expect("Worker clone output must pass deep Rust verification");
    assert_eq!(verified.project(), vector.project_id);
    assert_eq!(verified.realm(), Realm::Public);

    let mut repository = LocalRepository::open_in_memory().expect("fresh local repository");
    assert_eq!(repository.project_id().expect("read empty identity"), None);
    let imported = repository
        .import_bundle(&manifest_bytes, &objects, &[])
        .expect("atomically import verified Worker clone");
    assert_eq!(imported.project, vector.project_id);
    assert_eq!(imported.realm, Realm::Public);
    assert_eq!(imported.generation, vector.ref_generation);

    let reexported = repository
        .export_bundle(Realm::Public, &[])
        .expect("re-export imported public state");
    assert_eq!(reexported.manifest_bytes, manifest_bytes);
    assert_eq!(reexported.objects, objects);
    assert_eq!(reexported.manifest.refs[0].1, vector.head_artifact_id);

    assert!(matches!(
        repository.import_bundle(&manifest_bytes, &reexported.objects, &[]),
        Err(StoreError::InvalidImport(_))
    ));
    assert_eq!(
        repository
            .export_bundle(Realm::Public, &[])
            .expect("failed replay must preserve imported state"),
        reexported
    );
}

#[test]
fn rejected_worker_clone_leaves_fresh_store_empty_and_retryable() {
    let vector = vector();
    let manifest_bytes = decode_hex(&vector.manifest_cbor_hex);
    let objects = objects(&vector);
    let mut corrupt = objects.clone();
    corrupt
        .values_mut()
        .next()
        .expect("vector contains objects")[0] ^= 1;

    let mut repository = LocalRepository::open_in_memory().expect("fresh local repository");
    assert!(
        repository
            .import_bundle(&manifest_bytes, &corrupt, &[])
            .is_err()
    );
    assert_eq!(repository.project_id().expect("read empty identity"), None);
    repository
        .import_bundle(&manifest_bytes, &objects, &[])
        .expect("valid retry after rejected clone");
    let reexported = repository
        .export_bundle(Realm::Public, &[])
        .expect("re-export accepted retry");
    assert_eq!(reexported.manifest_bytes, manifest_bytes);
    assert_eq!(reexported.objects, objects);
}

#[test]
fn reconciles_verified_descendant_and_replays_as_an_exact_noop() {
    let vector = vector();
    let initial_manifest = decode_hex(&vector.manifest_cbor_hex);
    let initial_objects = objects(&vector);
    let remote_manifest = decode_hex(&vector.incremental_push.manifest_cbor_hex);
    let remote_objects = vector
        .incremental_push
        .files
        .iter()
        .map(|(path, body)| (path.clone(), decode_hex(body)))
        .collect::<BTreeMap<_, _>>();
    let mut repository = LocalRepository::open_in_memory().expect("fresh local repository");
    repository
        .import_bundle(&initial_manifest, &initial_objects, &[])
        .expect("initial clone");

    let advanced = repository
        .reconcile_public_bundle(&remote_manifest, &remote_objects)
        .expect("remote descendant fast-forward");
    assert_eq!(advanced.outcome, PublicReconcileOutcome::FastForwarded);
    assert_eq!(advanced.local_head, vector.head_artifact_id);
    assert_eq!(
        advanced.remote_head,
        vector.incremental_push.head_artifact_id
    );
    assert_eq!(advanced.generation, 2);
    assert_eq!(
        repository
            .export_bundle(Realm::Public, &[])
            .expect("export reconciled state")
            .objects,
        remote_objects
    );

    let replay = repository
        .reconcile_public_bundle(&remote_manifest, &remote_objects)
        .expect("exact reconciliation replay");
    assert_eq!(replay.outcome, PublicReconcileOutcome::AlreadyCurrent);
    assert_eq!(replay.generation, 2);
}

#[test]
fn reports_remote_ancestor_as_local_ahead_without_rollback() {
    let vector = vector();
    let initial_manifest = decode_hex(&vector.manifest_cbor_hex);
    let initial_objects = objects(&vector);
    let remote_manifest = decode_hex(&vector.incremental_push.manifest_cbor_hex);
    let remote_objects = vector
        .incremental_push
        .files
        .iter()
        .map(|(path, body)| (path.clone(), decode_hex(body)))
        .collect::<BTreeMap<_, _>>();
    let mut repository = LocalRepository::open_in_memory().expect("fresh local repository");
    repository
        .import_bundle(&remote_manifest, &remote_objects, &[])
        .expect("clone descendant");

    let result = repository
        .reconcile_public_bundle(&initial_manifest, &initial_objects)
        .expect("recognize local-ahead history");
    assert_eq!(result.outcome, PublicReconcileOutcome::LocalAhead);
    assert_eq!(result.local_head, vector.incremental_push.head_artifact_id);
    assert_eq!(result.remote_head, vector.head_artifact_id);
    assert_eq!(result.generation, 2);
    assert_eq!(
        repository
            .export_bundle(Realm::Public, &[])
            .expect("local state stays ahead")
            .objects,
        remote_objects
    );
}
