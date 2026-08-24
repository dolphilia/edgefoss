use ef_format::{PathErrorCode, validate_path};
use serde::Deserialize;

#[derive(Deserialize)]
struct PathVectors {
    profile: String,
    valid: Vec<PathInput>,
    invalid: Vec<InvalidPath>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PathInput {
    Literal(String),
    Repeat { repeat: String, count: usize },
}

impl PathInput {
    fn expand(&self) -> String {
        match self {
            Self::Literal(value) => value.clone(),
            Self::Repeat { repeat, count } => repeat.repeat(*count),
        }
    }
}

#[derive(Deserialize)]
struct InvalidPath {
    name: String,
    path: PathInput,
    error: String,
}

fn vectors() -> PathVectors {
    serde_json::from_str(include_str!("../../../spec/vectors/path-v0.json"))
        .expect("valid path vector file")
}

fn error_name(code: PathErrorCode) -> &'static str {
    match code {
        PathErrorCode::EmptyPath => "empty_path",
        PathErrorCode::PathTooLong => "path_too_long",
        PathErrorCode::NonNfc => "non_nfc",
        PathErrorCode::AbsolutePath => "absolute_path",
        PathErrorCode::TrailingSlash => "trailing_slash",
        PathErrorCode::EmptySegment => "empty_segment",
        PathErrorCode::DotSegment => "dot_segment",
        PathErrorCode::SegmentTooLong => "segment_too_long",
        PathErrorCode::ControlCharacter => "control_character",
        PathErrorCode::ForbiddenCharacter => "forbidden_character",
        PathErrorCode::TrailingDotOrSpace => "trailing_dot_or_space",
        PathErrorCode::WindowsReservedName => "windows_reserved_name",
    }
}

#[test]
fn valid_paths_are_accepted() {
    let vectors = vectors();
    assert_eq!(vectors.profile, "edgefossil-path-v0");
    for input in vectors.valid {
        let path = input.expand();
        assert_eq!(validate_path(&path), Ok(()), "{path}");
    }
}

#[test]
fn invalid_paths_are_rejected_consistently() {
    for vector in vectors().invalid {
        let error =
            validate_path(&vector.path.expand()).expect_err("invalid path must be rejected");
        assert_eq!(error_name(error.code), vector.error, "{}", vector.name);
    }
}
