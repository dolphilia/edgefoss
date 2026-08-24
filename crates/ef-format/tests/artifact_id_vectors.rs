use ef_format::{FormatErrorCode, format_artifact_id, parse_artifact_id, verify_artifact_id};
use serde::Deserialize;

#[derive(Deserialize)]
struct IdVectors {
    profile: String,
    valid: Vec<String>,
    invalid: Vec<String>,
    hash_cases: Vec<HashCase>,
}

#[derive(Deserialize)]
struct HashCase {
    name: String,
    body_hex: String,
    artifact_id: String,
}

fn vectors() -> IdVectors {
    serde_json::from_str(include_str!("../../../spec/vectors/artifact-id-v0.json"))
        .expect("valid artifact ID vector file")
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

#[test]
fn valid_ids_round_trip() {
    let vectors = vectors();
    assert_eq!(vectors.profile, "edgefossil-artifact-id-v0");
    for identifier in vectors.valid {
        let digest = parse_artifact_id(&identifier).expect("valid artifact ID");
        assert_eq!(format_artifact_id(&digest), identifier);
    }
}

#[test]
fn invalid_ids_are_rejected() {
    for identifier in vectors().invalid {
        let error = parse_artifact_id(&identifier).expect_err("invalid artifact ID");
        assert_eq!(
            error.code,
            FormatErrorCode::InvalidArtifactId,
            "{identifier:?}"
        );
    }
}

#[test]
fn body_hashes_and_mismatches_are_checked() {
    for case in vectors().hash_cases {
        let body = decode_hex(&case.body_hex);
        assert_eq!(
            verify_artifact_id(&body, &case.artifact_id),
            Ok(()),
            "{}",
            case.name
        );
        let error = verify_artifact_id(
            &body,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect_err("mismatched ID");
        assert_eq!(
            error.code,
            FormatErrorCode::ArtifactIdMismatch,
            "{}",
            case.name
        );
    }
}
