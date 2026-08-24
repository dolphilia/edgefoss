//! Realm-isolated portable semantic-root calculation.

use std::collections::HashSet;

use sha2::{Digest, Sha256};

use crate::{
    FormatError, FormatErrorCode, Realm, Value, encode_value, format_artifact_id,
    parse_artifact_id, validate_path,
};

const MAX_REALM_ARTIFACTS: usize = 65_535;
const MAX_REALM_REFS: usize = 4_096;

/// One immutable artifact candidate for a semantic-root view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticArtifact {
    pub id: String,
    pub realm: Realm,
}

/// One named ref candidate for a semantic-root view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticRef {
    pub name: String,
    pub target: String,
    pub realm: Realm,
}

/// Inputs for one realm's semantic root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticRootInput {
    pub project: String,
    pub realm: Realm,
    pub artifacts: Vec<SemanticArtifact>,
    pub refs: Vec<SemanticRef>,
    pub policy_version: u64,
}

/// Reproducible intermediate and final semantic-root values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticRootResult {
    pub artifact_set_root: [u8; 32],
    pub descriptor: Vec<u8>,
    pub semantic_root: String,
}

fn schema_error(message: &str) -> FormatError {
    FormatError::new(FormatErrorCode::InvalidSchema, message)
}

fn validate_ref_name(name: &str) -> Result<(), FormatError> {
    if name.len() > 255 {
        return Err(schema_error("ref name exceeds 255 UTF-8 bytes"));
    }
    validate_path(name).map_err(|_| schema_error("ref name violates edgefossil-path-v0"))
}

/// Computes one realm's portable semantic root while ignoring other realms.
///
/// # Errors
///
/// Returns a stable format error for invalid IDs, duplicate selected inputs,
/// invalid ref names, missing selected ref targets, or resource limits.
pub fn compute_semantic_root(input: &SemanticRootInput) -> Result<SemanticRootResult, FormatError> {
    let project = parse_artifact_id(&input.project)?;
    let mut selected_artifacts = input
        .artifacts
        .iter()
        .filter(|artifact| artifact.realm == input.realm)
        .map(|artifact| Ok((artifact.id.as_str(), parse_artifact_id(&artifact.id)?)))
        .collect::<Result<Vec<_>, FormatError>>()?;
    if selected_artifacts.len() > MAX_REALM_ARTIFACTS {
        return Err(FormatError::new(
            FormatErrorCode::ResourceLimit,
            "realm artifact set is too large",
        ));
    }
    selected_artifacts.sort_by(|left, right| left.1.cmp(&right.1));
    if selected_artifacts
        .windows(2)
        .any(|pair| pair[0].1 == pair[1].1)
    {
        return Err(schema_error("realm artifact set contains a duplicate"));
    }
    let selected_ids = selected_artifacts
        .iter()
        .map(|(id, _)| *id)
        .collect::<HashSet<_>>();
    let artifact_set_bytes = encode_value(&Value::Array(
        selected_artifacts
            .iter()
            .map(|(_, digest)| Value::Bytes(digest.to_vec()))
            .collect(),
    ))?;
    let artifact_set_root: [u8; 32] = Sha256::digest(artifact_set_bytes).into();

    let selected_refs = input
        .refs
        .iter()
        .filter(|reference| reference.realm == input.realm)
        .collect::<Vec<_>>();
    if selected_refs.len() > MAX_REALM_REFS {
        return Err(FormatError::new(
            FormatErrorCode::ResourceLimit,
            "realm ref set is too large",
        ));
    }
    let mut seen_ref_names = HashSet::new();
    let mut refs = Vec::with_capacity(selected_refs.len());
    for reference in selected_refs {
        validate_ref_name(&reference.name)?;
        if !seen_ref_names.insert(reference.name.as_str()) {
            return Err(schema_error("realm ref name is duplicated"));
        }
        let target = parse_artifact_id(&reference.target)?;
        if !selected_ids.contains(reference.target.as_str()) {
            return Err(FormatError::new(
                FormatErrorCode::UnknownRequiredSemantics,
                "realm ref target is not in the realm artifact set",
            ));
        }
        refs.push((reference.name.clone(), Value::Bytes(target.to_vec())));
    }

    let descriptor = encode_value(&Value::Map(vec![
        (
            "format".into(),
            Value::Text("edgefossil-semantic-root".into()),
        ),
        ("version".into(), Value::UInt(0)),
        ("project".into(), Value::Bytes(project.to_vec())),
        ("realm".into(), Value::Text(input.realm.as_str().into())),
        (
            "artifact_set_root".into(),
            Value::Bytes(artifact_set_root.to_vec()),
        ),
        ("refs".into(), Value::Map(refs)),
        ("policy_version".into(), Value::UInt(input.policy_version)),
    ]))?;
    let semantic_digest: [u8; 32] = Sha256::digest(&descriptor).into();
    let semantic_root = format_artifact_id(&semantic_digest);
    Ok(SemanticRootResult {
        artifact_set_root,
        descriptor,
        semantic_root,
    })
}
