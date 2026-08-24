use ef_format::{
    FormatErrorCode, SignatureRecord, artifact_signature_message, decode_signature_record,
    encode_signature_record, verify_artifact_signature,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct SignatureVector {
    profile: String,
    artifact: String,
    actor_key_hex: String,
    message_hex: String,
    signature_hex: String,
    record_cbor_hex: String,
}

fn vector() -> SignatureVector {
    serde_json::from_str(include_str!("../../../spec/vectors/signature-v0.json"))
        .expect("valid signature vector")
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

fn record(vector: &SignatureVector) -> SignatureRecord {
    SignatureRecord {
        artifact: vector.artifact.clone(),
        actor_key: decode_hex(&vector.actor_key_hex)
            .try_into()
            .expect("32-byte public key"),
        signature: decode_hex(&vector.signature_hex)
            .try_into()
            .expect("64-byte signature"),
    }
}

#[test]
fn signature_vector_encodes_decodes_and_verifies() {
    let vector = vector();
    assert_eq!(vector.profile, "edgefossil-signature-v0");
    let record = record(&vector);
    assert_eq!(
        artifact_signature_message(&record.artifact),
        Ok(decode_hex(&vector.message_hex))
    );
    let encoded = encode_signature_record(&record).expect("valid record");
    assert_eq!(encoded, decode_hex(&vector.record_cbor_hex));
    assert_eq!(decode_signature_record(&encoded), Ok(record.clone()));
    assert_eq!(
        verify_artifact_signature(&record, &record.artifact, &record.actor_key),
        Ok(())
    );
}

#[test]
fn signature_mutations_are_rejected_without_detail() {
    let vector = vector();
    let record = record(&vector);

    let mut bad_signature = record.clone();
    bad_signature.signature[0] ^= 1;
    let error = verify_artifact_signature(
        &bad_signature,
        &bad_signature.artifact,
        &bad_signature.actor_key,
    )
    .expect_err("modified signature");
    assert_eq!(error.code, FormatErrorCode::InvalidSignature);

    let mut other_key = record.actor_key;
    other_key[0] ^= 1;
    let error = verify_artifact_signature(&record, &record.artifact, &other_key)
        .expect_err("actor binding mismatch");
    assert_eq!(error.code, FormatErrorCode::InvalidSignature);

    let other_artifact = format!("sha256:{}", "0".repeat(64));
    let error = verify_artifact_signature(&record, &other_artifact, &record.actor_key)
        .expect_err("artifact binding mismatch");
    assert_eq!(error.code, FormatErrorCode::InvalidSignature);
}
