//! Experimental realm-isolated directory bundle manifests.

use std::collections::{BTreeMap, HashSet};

use crate::{
    FormatError, FormatErrorCode, Realm, SemanticArtifact, SemanticRef, SemanticRootInput, Value,
    compute_semantic_root, decode_canonical, encode_value, expect_exact_keys, format_artifact_id,
    map_get, parse_artifact_id, verify_artifact_id,
};

const MAX_INVENTORY: usize = 65_535;

/// Exact schema-0 manifest for one realm bundle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BundleManifest {
    pub project: String,
    pub realm: Realm,
    pub policy_version: u64,
    pub semantic_root: String,
    pub artifacts: Vec<String>,
    pub blobs: Vec<String>,
    pub signatures: Vec<String>,
    pub refs: Vec<(String, String)>,
    pub base_roots: Vec<(Realm, String)>,
}

fn schema_error(message: &str) -> FormatError {
    FormatError::new(FormatErrorCode::InvalidSchema, message)
}

fn normalized_ids(
    values: &[String],
    label: &str,
    require_sorted: bool,
) -> Result<Vec<(String, [u8; 32])>, FormatError> {
    if values.len() > MAX_INVENTORY {
        return Err(FormatError::new(
            FormatErrorCode::ResourceLimit,
            format!("{label} inventory is too large"),
        ));
    }
    let original = values
        .iter()
        .map(|id| Ok((id.clone(), parse_artifact_id(id)?)))
        .collect::<Result<Vec<_>, FormatError>>()?;
    let mut sorted = original.clone();
    sorted.sort_by(|left, right| left.1.cmp(&right.1));
    if sorted.windows(2).any(|pair| pair[0].1 == pair[1].1) {
        return Err(schema_error(&format!(
            "{label} inventory contains a duplicate"
        )));
    }
    if require_sorted && original != sorted {
        return Err(schema_error(&format!(
            "{label} inventory is not sorted by raw digest"
        )));
    }
    Ok(sorted)
}

fn required_base_realms(realm: Realm) -> &'static [Realm] {
    match realm {
        Realm::Public => &[],
        Realm::Members => &[Realm::Public],
        Realm::Local => &[Realm::Public, Realm::Members],
    }
}

fn validate_base_roots(manifest: &BundleManifest) -> Result<(), FormatError> {
    let required = required_base_realms(manifest.realm);
    if manifest.base_roots.len() != required.len()
        || required.iter().any(|realm| {
            !manifest
                .base_roots
                .iter()
                .any(|(candidate, _)| candidate == realm)
        })
    {
        return Err(schema_error("base_roots do not match the bundle realm"));
    }
    let mut seen = HashSet::new();
    for (realm, root) in &manifest.base_roots {
        if !seen.insert(*realm as u8) {
            return Err(schema_error("base_roots contains a duplicate realm"));
        }
        parse_artifact_id(root)?;
    }
    Ok(())
}

/// Recomputes and verifies the portable meaning claimed by a bundle manifest.
///
/// # Errors
///
/// Returns a stable format error for malformed inventory or a mismatched root.
pub fn verify_bundle_manifest(manifest: &BundleManifest) -> Result<(), FormatError> {
    parse_artifact_id(&manifest.project)?;
    parse_artifact_id(&manifest.semantic_root)?;
    validate_base_roots(manifest)?;
    let artifacts = normalized_ids(&manifest.artifacts, "artifact", false)?;
    normalized_ids(&manifest.blobs, "blob", false)?;
    normalized_ids(&manifest.signatures, "signature", false)?;
    let result = compute_semantic_root(&SemanticRootInput {
        project: manifest.project.clone(),
        realm: manifest.realm,
        artifacts: artifacts
            .into_iter()
            .map(|(id, _)| SemanticArtifact {
                id,
                realm: manifest.realm,
            })
            .collect(),
        refs: manifest
            .refs
            .iter()
            .map(|(name, target)| SemanticRef {
                name: name.clone(),
                target: target.clone(),
                realm: manifest.realm,
            })
            .collect(),
        policy_version: manifest.policy_version,
    })?;
    if result.semantic_root != manifest.semantic_root {
        return Err(FormatError::new(
            FormatErrorCode::SemanticRootMismatch,
            "bundle semantic root does not match portable state",
        ));
    }
    Ok(())
}

/// Encodes a normalized experimental bundle manifest.
///
/// # Errors
///
/// Returns an error for an invalid inventory or semantic-root claim.
pub fn encode_bundle_manifest(manifest: &BundleManifest) -> Result<Vec<u8>, FormatError> {
    verify_bundle_manifest(manifest)?;
    let artifacts = normalized_ids(&manifest.artifacts, "artifact", false)?;
    let blobs = normalized_ids(&manifest.blobs, "blob", false)?;
    let signatures = normalized_ids(&manifest.signatures, "signature", false)?;
    encode_value(&Value::Map(vec![
        ("format".into(), Value::Text("edgefossil-bundle".into())),
        ("version".into(), Value::UInt(0)),
        ("experimental".into(), Value::Bool(true)),
        (
            "project".into(),
            Value::Bytes(parse_artifact_id(&manifest.project)?.to_vec()),
        ),
        ("realm".into(), Value::Text(manifest.realm.as_str().into())),
        (
            "policy_version".into(),
            Value::UInt(manifest.policy_version),
        ),
        (
            "semantic_root".into(),
            Value::Bytes(parse_artifact_id(&manifest.semantic_root)?.to_vec()),
        ),
        (
            "artifacts".into(),
            Value::Array(
                artifacts
                    .into_iter()
                    .map(|(_, digest)| Value::Bytes(digest.to_vec()))
                    .collect(),
            ),
        ),
        (
            "blobs".into(),
            Value::Array(
                blobs
                    .into_iter()
                    .map(|(_, digest)| Value::Bytes(digest.to_vec()))
                    .collect(),
            ),
        ),
        (
            "signatures".into(),
            Value::Array(
                signatures
                    .into_iter()
                    .map(|(_, digest)| Value::Bytes(digest.to_vec()))
                    .collect(),
            ),
        ),
        (
            "refs".into(),
            Value::Map(
                manifest
                    .refs
                    .iter()
                    .map(|(name, target)| {
                        Ok((
                            name.clone(),
                            Value::Bytes(parse_artifact_id(target)?.to_vec()),
                        ))
                    })
                    .collect::<Result<Vec<_>, FormatError>>()?,
            ),
        ),
        (
            "base_roots".into(),
            Value::Map(
                manifest
                    .base_roots
                    .iter()
                    .map(|(realm, root)| {
                        Ok((
                            realm.as_str().into(),
                            Value::Bytes(parse_artifact_id(root)?.to_vec()),
                        ))
                    })
                    .collect::<Result<Vec<_>, FormatError>>()?,
            ),
        ),
    ]))
}

fn decode_id_array(value: Option<&Value>, label: &str) -> Result<Vec<String>, FormatError> {
    let Some(Value::Array(values)) = value else {
        return Err(schema_error(&format!("{label} inventory must be an array")));
    };
    let ids = values
        .iter()
        .map(|value| match value {
            Value::Bytes(digest) => {
                let digest: [u8; 32] = digest
                    .as_slice()
                    .try_into()
                    .map_err(|_| schema_error("inventory digest must be 32 bytes"))?;
                Ok(format_artifact_id(&digest))
            }
            _ => Err(schema_error("inventory digest must be bytes")),
        })
        .collect::<Result<Vec<_>, FormatError>>()?;
    normalized_ids(&ids, label, true)?;
    Ok(ids)
}

fn decode_id_map(value: Option<&Value>, label: &str) -> Result<Vec<(String, String)>, FormatError> {
    let Some(Value::Map(values)) = value else {
        return Err(schema_error(&format!("{label} must be a map")));
    };
    values
        .iter()
        .map(|(key, value)| match value {
            Value::Bytes(digest) => {
                let digest: [u8; 32] = digest
                    .as_slice()
                    .try_into()
                    .map_err(|_| schema_error("map digest must be 32 bytes"))?;
                Ok((key.clone(), format_artifact_id(&digest)))
            }
            _ => Err(schema_error("map digest must be bytes")),
        })
        .collect()
}

/// Decodes the exact canonical schema-0 bundle manifest.
///
/// # Errors
///
/// Returns an error for non-canonical bytes or invalid fields.
pub fn decode_bundle_manifest(bytes: &[u8]) -> Result<BundleManifest, FormatError> {
    let Value::Map(map) = decode_canonical(bytes)? else {
        return Err(schema_error("bundle manifest must be a map"));
    };
    expect_exact_keys(
        &map,
        &[
            "format",
            "version",
            "experimental",
            "project",
            "realm",
            "policy_version",
            "semantic_root",
            "artifacts",
            "blobs",
            "signatures",
            "refs",
            "base_roots",
        ],
        "bundle manifest",
    )?;
    if !matches!(map_get(&map, "format"), Some(Value::Text(value)) if value == "edgefossil-bundle")
        || !matches!(map_get(&map, "version"), Some(Value::UInt(0)))
        || !matches!(map_get(&map, "experimental"), Some(Value::Bool(true)))
    {
        return Err(schema_error("bundle manifest constants are invalid"));
    }
    let Some(Value::Bytes(project)) = map_get(&map, "project") else {
        return Err(schema_error("bundle project must be bytes"));
    };
    let project: [u8; 32] = project
        .as_slice()
        .try_into()
        .map_err(|_| schema_error("bundle project must be 32 bytes"))?;
    let Some(Value::Text(realm)) = map_get(&map, "realm") else {
        return Err(schema_error("bundle realm must be text"));
    };
    let realm = realm
        .parse::<Realm>()
        .map_err(|_| schema_error("bundle realm is unknown"))?;
    let Some(Value::UInt(policy_version)) = map_get(&map, "policy_version") else {
        return Err(schema_error("policy_version must be uint"));
    };
    let Some(Value::Bytes(semantic_root)) = map_get(&map, "semantic_root") else {
        return Err(schema_error("semantic_root must be bytes"));
    };
    let semantic_root: [u8; 32] = semantic_root
        .as_slice()
        .try_into()
        .map_err(|_| schema_error("semantic_root must be 32 bytes"))?;
    let refs = decode_id_map(map_get(&map, "refs"), "refs")?;
    let base_roots = decode_id_map(map_get(&map, "base_roots"), "base_roots")?
        .into_iter()
        .map(|(base_realm, root)| {
            Ok((
                base_realm
                    .parse::<Realm>()
                    .map_err(|_| schema_error("base_roots contains an unknown realm"))?,
                root,
            ))
        })
        .collect::<Result<Vec<_>, FormatError>>()?;
    let manifest = BundleManifest {
        project: format_artifact_id(&project),
        realm,
        policy_version: *policy_version,
        semantic_root: format_artifact_id(&semantic_root),
        artifacts: decode_id_array(map_get(&map, "artifacts"), "artifact")?,
        blobs: decode_id_array(map_get(&map, "blobs"), "blob")?,
        signatures: decode_id_array(map_get(&map, "signatures"), "signature")?,
        refs,
        base_roots,
    };
    validate_base_roots(&manifest)?;
    Ok(manifest)
}

fn object_path(kind: &str, id: &str) -> String {
    let extension = if kind == "blobs" { "bin" } else { "cbor" };
    format!("{kind}/{}.{extension}", &id[7..])
}

/// Verifies that a directory bundle contains exactly its inventoried objects.
///
/// # Errors
///
/// Returns a stable bundle-object error for missing, extra, or mismatched data.
pub fn verify_bundle_objects(
    manifest: &BundleManifest,
    objects: &BTreeMap<String, Vec<u8>>,
) -> Result<(), FormatError> {
    let mut expected = BTreeMap::new();
    for (kind, ids) in [
        ("artifacts", &manifest.artifacts),
        ("blobs", &manifest.blobs),
        ("signatures", &manifest.signatures),
    ] {
        for id in ids {
            expected.insert(object_path(kind, id), id);
        }
    }
    for (path, id) in &expected {
        let Some(body) = objects.get(path) else {
            return Err(FormatError::new(
                FormatErrorCode::MissingBundleObject,
                format!("missing bundle object: {path}"),
            ));
        };
        if verify_artifact_id(body, id).is_err() {
            return Err(FormatError::new(
                FormatErrorCode::BundleObjectMismatch,
                format!("bundle object mismatch: {path}"),
            ));
        }
    }
    if let Some(path) = objects.keys().find(|path| !expected.contains_key(*path)) {
        return Err(FormatError::new(
            FormatErrorCode::UnexpectedBundleObject,
            format!("unexpected bundle object: {path}"),
        ));
    }
    Ok(())
}
