//! Detached Ed25519 signature records for artifact IDs.

use ed25519_dalek::{Signature, VerifyingKey};

use crate::{
    FormatError, FormatErrorCode, Value, decode_canonical, encode_value, expect_exact_keys,
    map_get, parse_artifact_id,
};

const DOMAIN: &[u8] = b"EdgeFossil artifact signature v0\0";

/// One detached schema-0 artifact signature.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureRecord {
    pub artifact: String,
    pub actor_key: [u8; 32],
    pub signature: [u8; 64],
}

fn invalid_signature() -> FormatError {
    FormatError::new(
        FormatErrorCode::InvalidSignature,
        "artifact signature is invalid",
    )
}

/// Constructs the domain-separated bytes signed for one artifact ID.
///
/// # Errors
///
/// Returns an error if the artifact ID is not canonical.
pub fn artifact_signature_message(artifact_id: &str) -> Result<Vec<u8>, FormatError> {
    let digest = parse_artifact_id(artifact_id)?;
    let mut message = Vec::with_capacity(DOMAIN.len() + digest.len());
    message.extend_from_slice(DOMAIN);
    message.extend_from_slice(&digest);
    Ok(message)
}

/// Encodes a canonical detached signature record.
///
/// # Errors
///
/// Returns an error if the artifact ID is not canonical.
pub fn encode_signature_record(record: &SignatureRecord) -> Result<Vec<u8>, FormatError> {
    parse_artifact_id(&record.artifact)?;
    encode_value(&Value::Map(vec![
        ("format".into(), Value::Text("edgefossil-signature".into())),
        ("version".into(), Value::UInt(0)),
        ("artifact".into(), Value::Text(record.artifact.clone())),
        ("actor_key".into(), Value::Bytes(record.actor_key.to_vec())),
        ("signature".into(), Value::Bytes(record.signature.to_vec())),
    ]))
}

/// Decodes a canonical detached signature record.
///
/// # Errors
///
/// Returns an error for non-canonical bytes or invalid record fields.
pub fn decode_signature_record(bytes: &[u8]) -> Result<SignatureRecord, FormatError> {
    let Value::Map(record) = decode_canonical(bytes)? else {
        return Err(invalid_signature());
    };
    expect_exact_keys(
        &record,
        &["format", "version", "artifact", "actor_key", "signature"],
        "signature record",
    )
    .map_err(|_| invalid_signature())?;
    if !matches!(map_get(&record, "format"), Some(Value::Text(value)) if value == "edgefossil-signature")
        || !matches!(map_get(&record, "version"), Some(Value::UInt(0)))
    {
        return Err(invalid_signature());
    }
    let Some(Value::Text(artifact)) = map_get(&record, "artifact") else {
        return Err(invalid_signature());
    };
    let Some(Value::Bytes(actor_key)) = map_get(&record, "actor_key") else {
        return Err(invalid_signature());
    };
    let Some(Value::Bytes(signature)) = map_get(&record, "signature") else {
        return Err(invalid_signature());
    };
    parse_artifact_id(artifact).map_err(|_| invalid_signature())?;
    Ok(SignatureRecord {
        artifact: artifact.clone(),
        actor_key: actor_key
            .as_slice()
            .try_into()
            .map_err(|_| invalid_signature())?,
        signature: signature
            .as_slice()
            .try_into()
            .map_err(|_| invalid_signature())?,
    })
}

/// Verifies a detached signature and its binding to decoded artifact fields.
///
/// # Errors
///
/// Returns `InvalidSignature` without distinguishing key, ID, or signature
/// failures.
pub fn verify_artifact_signature(
    record: &SignatureRecord,
    expected_artifact_id: &str,
    expected_actor_key: &[u8; 32],
) -> Result<(), FormatError> {
    if record.artifact != expected_artifact_id || &record.actor_key != expected_actor_key {
        return Err(invalid_signature());
    }
    let key = VerifyingKey::from_bytes(&record.actor_key).map_err(|_| invalid_signature())?;
    let signature = Signature::from_bytes(&record.signature);
    let message = artifact_signature_message(&record.artifact).map_err(|_| invalid_signature())?;
    key.verify_strict(&message, &signature)
        .map_err(|_| invalid_signature())
}
