use std::fmt::Write;
use std::fs;

use ef_format::{
    FormatErrorCode, Realm, SemanticArtifact, SemanticRef, SemanticRootInput, compute_semantic_root,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    project: String,
    artifacts: Vec<ArtifactJson>,
    refs: Vec<RefJson>,
    expected: Vec<ExpectedJson>,
    invalid: Vec<InvalidJson>,
}

#[derive(Clone, Deserialize)]
struct ArtifactJson {
    id: String,
    realm: String,
}

#[derive(Clone, Deserialize)]
struct RefJson {
    name: String,
    target: String,
    realm: String,
}

#[derive(Deserialize)]
struct ExpectedJson {
    realm: String,
    artifact_set_root_hex: String,
    descriptor_cbor_hex: String,
    semantic_root: String,
}

#[derive(Deserialize)]
struct InvalidJson {
    name: String,
    mutation: String,
    error: String,
}

fn realm(value: &str) -> Realm {
    value.parse().expect("vector realm")
}

fn load() -> Vector {
    let path = format!(
        "{}/../../spec/vectors/semantic-root-v0.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(path).expect("read vectors")).expect("parse vectors")
}

fn base(vector: &Vector, selected_realm: Realm) -> SemanticRootInput {
    SemanticRootInput {
        project: vector.project.clone(),
        realm: selected_realm,
        artifacts: vector
            .artifacts
            .iter()
            .map(|artifact| SemanticArtifact {
                id: artifact.id.clone(),
                realm: realm(&artifact.realm),
            })
            .collect(),
        refs: vector
            .refs
            .iter()
            .map(|reference| SemanticRef {
                name: reference.name.clone(),
                target: reference.target.clone(),
                realm: realm(&reference.realm),
            })
            .collect(),
        policy_version: 0,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            write!(output, "{byte:02x}").expect("write to string");
            output
        },
    )
}

fn code(value: &str) -> FormatErrorCode {
    match value {
        "invalid_schema" => FormatErrorCode::InvalidSchema,
        "invalid_artifact_id" => FormatErrorCode::InvalidArtifactId,
        "unknown_required_semantics" => FormatErrorCode::UnknownRequiredSemantics,
        other => panic!("unknown error code: {other}"),
    }
}

#[test]
fn semantic_roots_match_shared_vectors() {
    let vector = load();
    for expected in &vector.expected {
        let result = compute_semantic_root(&base(&vector, realm(&expected.realm))).unwrap();
        assert_eq!(
            hex(&result.artifact_set_root),
            expected.artifact_set_root_hex
        );
        assert_eq!(hex(&result.descriptor), expected.descriptor_cbor_hex);
        assert_eq!(result.semantic_root, expected.semantic_root);
    }
}

#[test]
fn invalid_semantic_inputs_match_shared_vectors() {
    let vector = load();
    for invalid in &vector.invalid {
        let mut input = base(&vector, Realm::Public);
        match invalid.mutation.as_str() {
            "duplicate_artifact" => input.artifacts.push(input.artifacts[0].clone()),
            "duplicate_ref" => input.refs.push(input.refs[0].clone()),
            "missing_ref_target" => {
                input.refs = vec![SemanticRef {
                    target:
                        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                            .into(),
                    ..input.refs[0].clone()
                }];
            }
            "invalid_ref_name" => {
                input.refs = vec![SemanticRef {
                    name: "heads/../main".into(),
                    ..input.refs[0].clone()
                }];
            }
            "invalid_artifact_id" => {
                input.artifacts = vec![SemanticArtifact {
                    id: "sha256:bad".into(),
                    realm: Realm::Public,
                }];
                input.refs.clear();
            }
            "invalid_project_id" => input.project = "sha256:bad".into(),
            other => panic!("unknown mutation: {other}"),
        }
        let error = compute_semantic_root(&input).expect_err(&invalid.name).code;
        assert_eq!(error, code(&invalid.error), "{}", invalid.name);
    }
}

#[test]
fn public_root_is_independent_of_members_only_inputs() {
    let vector = load();
    let expected = compute_semantic_root(&base(&vector, Realm::Public))
        .unwrap()
        .semantic_root;
    for byte in 0_u8..128 {
        let mut input = base(&vector, Realm::Public);
        input.artifacts.reverse();
        let pair = format!("{byte:02x}");
        input.artifacts.push(SemanticArtifact {
            id: format!("sha256:{}", pair.repeat(32)),
            realm: Realm::Members,
        });
        input.artifacts.push(SemanticArtifact {
            id: "sha256:bad".into(),
            realm: Realm::Members,
        });
        input.refs.reverse();
        input.refs.push(SemanticRef {
            name: "../ignored".into(),
            target: "sha256:bad".into(),
            realm: Realm::Members,
        });
        assert_eq!(
            compute_semantic_root(&input).unwrap().semantic_root,
            expected
        );
    }
}
