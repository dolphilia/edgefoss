use ef_format::{
    FormatErrorCode, ProjectGenesis, artifact_id, decode_project_genesis, encode_project_genesis,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct VectorFile {
    profile: String,
    valid: Vec<ValidVector>,
    invalid: Vec<InvalidVector>,
}

#[derive(Deserialize)]
struct ValidVector {
    name: String,
    input: VectorInput,
    canonical_cbor_hex: String,
    artifact_id: String,
}

#[derive(Deserialize)]
struct VectorInput {
    project_name: String,
    nonce_hex: String,
    actor_key_hex: String,
    created_at: String,
}

#[derive(Deserialize)]
struct InvalidVector {
    name: String,
    cbor_hex: String,
    error: String,
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2), "fixture hex length");
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("ASCII fixture hex");
            u8::from_str_radix(text, 16).expect("valid fixture hex")
        })
        .collect()
}

fn vectors() -> VectorFile {
    serde_json::from_str(include_str!(
        "../../../spec/vectors/project-genesis-v0.json"
    ))
    .expect("valid vector file")
}

fn error_name(code: FormatErrorCode) -> &'static str {
    match code {
        FormatErrorCode::InvalidCbor => "invalid_cbor",
        FormatErrorCode::NonCanonical => "non_canonical",
        FormatErrorCode::UnsupportedType => "unsupported_type",
        FormatErrorCode::InvalidText => "invalid_text",
        FormatErrorCode::DuplicateKey => "duplicate_key",
        FormatErrorCode::ResourceLimit => "resource_limit",
        FormatErrorCode::InvalidSchema => "invalid_schema",
    }
}

#[test]
fn valid_vectors_round_trip() {
    let vectors = vectors();
    assert_eq!(vectors.profile, "edgefossil-artifact-v0");
    for vector in vectors.valid {
        let genesis = ProjectGenesis {
            name: vector.input.project_name,
            nonce: decode_hex(&vector.input.nonce_hex)
                .try_into()
                .expect("32-byte nonce"),
            actor_key: decode_hex(&vector.input.actor_key_hex)
                .try_into()
                .expect("32-byte actor key"),
            created_at: vector.input.created_at,
        };
        let encoded = encode_project_genesis(&genesis).expect("valid genesis input");
        assert_eq!(
            encoded,
            decode_hex(&vector.canonical_cbor_hex),
            "{}",
            vector.name
        );
        assert_eq!(artifact_id(&encoded), vector.artifact_id, "{}", vector.name);
        assert_eq!(
            decode_project_genesis(&encoded),
            Ok(genesis),
            "{}",
            vector.name
        );
    }
}

#[test]
fn invalid_vectors_are_rejected() {
    for vector in vectors().invalid {
        let error = decode_project_genesis(&decode_hex(&vector.cbor_hex))
            .expect_err("invalid vector must be rejected");
        assert_eq!(error_name(error.code), vector.error, "{}", vector.name);
    }
}
