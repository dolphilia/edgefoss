use std::collections::BTreeMap;

use ef_format::{
    BundleManifest, FormatErrorCode, Realm, decode_bundle_manifest, encode_bundle_manifest,
    verify_bundle_manifest, verify_bundle_objects,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    manifest: ManifestJson,
    manifest_cbor_hex: String,
    files: BTreeMap<String, String>,
    invalid: Vec<InvalidJson>,
}

#[derive(Deserialize)]
struct ManifestJson {
    project: String,
    realm: String,
    policy_version: u64,
    semantic_root: String,
    artifacts: Vec<String>,
    blobs: Vec<String>,
    signatures: Vec<String>,
    refs: BTreeMap<String, String>,
    base_roots: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct InvalidJson {
    mutation: String,
    error: String,
}

fn vector() -> Vector {
    serde_json::from_str(include_str!("../../../spec/vectors/bundle-v0.json"))
        .expect("valid bundle vector")
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

fn manifest(value: &ManifestJson) -> BundleManifest {
    BundleManifest {
        project: value.project.clone(),
        realm: value.realm.parse().expect("realm"),
        policy_version: value.policy_version,
        semantic_root: value.semantic_root.clone(),
        artifacts: value.artifacts.clone(),
        blobs: value.blobs.clone(),
        signatures: value.signatures.clone(),
        refs: value.refs.clone().into_iter().collect(),
        base_roots: value
            .base_roots
            .iter()
            .map(|(realm, root)| (realm.parse().expect("base realm"), root.clone()))
            .collect(),
    }
}

fn objects(value: &Vector) -> BTreeMap<String, Vec<u8>> {
    value
        .files
        .iter()
        .map(|(path, body)| (path.clone(), decode_hex(body)))
        .collect()
}

fn code(value: &str) -> FormatErrorCode {
    match value {
        "missing_bundle_object" => FormatErrorCode::MissingBundleObject,
        "unexpected_bundle_object" => FormatErrorCode::UnexpectedBundleObject,
        "bundle_object_mismatch" => FormatErrorCode::BundleObjectMismatch,
        "semantic_root_mismatch" => FormatErrorCode::SemanticRootMismatch,
        "invalid_schema" => FormatErrorCode::InvalidSchema,
        other => panic!("unknown code: {other}"),
    }
}

#[test]
fn bundle_manifest_and_objects_match_shared_vector() {
    let vector = vector();
    let manifest = manifest(&vector.manifest);
    let encoded = encode_bundle_manifest(&manifest).expect("encode manifest");
    assert_eq!(encoded, decode_hex(&vector.manifest_cbor_hex));
    assert_eq!(decode_bundle_manifest(&encoded), Ok(manifest.clone()));
    assert_eq!(verify_bundle_manifest(&manifest), Ok(()));
    assert_eq!(verify_bundle_objects(&manifest, &objects(&vector)), Ok(()));
}

#[test]
fn invalid_bundle_mutations_match_shared_vector() {
    let vector = vector();
    for invalid in &vector.invalid {
        let mut manifest = manifest(&vector.manifest);
        let mut objects = objects(&vector);
        let error = match invalid.mutation.as_str() {
            "missing_object" => {
                objects.clear();
                verify_bundle_objects(&manifest, &objects).unwrap_err()
            }
            "unexpected_object" => {
                objects.insert("extra".into(), Vec::new());
                verify_bundle_objects(&manifest, &objects).unwrap_err()
            }
            "object_mismatch" => {
                objects.values_mut().next().unwrap()[0] ^= 1;
                verify_bundle_objects(&manifest, &objects).unwrap_err()
            }
            "semantic_root" => {
                manifest.semantic_root = format!("sha256:{}", "0".repeat(64));
                verify_bundle_manifest(&manifest).unwrap_err()
            }
            "public_base_root" => {
                manifest.base_roots = vec![(Realm::Public, format!("sha256:{}", "0".repeat(64)))];
                verify_bundle_manifest(&manifest).unwrap_err()
            }
            other => panic!("unknown mutation: {other}"),
        };
        assert_eq!(error.code, code(&invalid.error), "{}", invalid.mutation);
    }
}
