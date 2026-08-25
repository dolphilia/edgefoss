use std::collections::BTreeMap;

use ef_format::Realm;
use ef_store_sqlite::{LocalRepository, StoreError, verify_portable_bundle};
use serde::Deserialize;

#[derive(Deserialize)]
struct PublicCloneVector {
    profile: String,
    project_id: String,
    head_artifact_id: String,
    ref_generation: u64,
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
