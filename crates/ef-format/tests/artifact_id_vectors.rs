use ef_format::{FormatErrorCode, format_artifact_id, parse_artifact_id};
use serde::Deserialize;

#[derive(Deserialize)]
struct IdVectors {
    profile: String,
    valid: Vec<String>,
    invalid: Vec<String>,
}

fn vectors() -> IdVectors {
    serde_json::from_str(include_str!("../../../spec/vectors/artifact-id-v0.json"))
        .expect("valid artifact ID vector file")
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
