//! Canonical encoding and schema validation for portable `EdgeFossil` artifacts.

use std::{error::Error, fmt};

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

mod path;
mod realm;

pub use path::{PathError, PathErrorCode, validate_path};
pub use realm::{ParseRealmError, Realm, ReferenceClass, can_reference};

/// Maximum encoded size of an artifact body in v0.
pub const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;

/// Stable machine-readable failure category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FormatErrorCode {
    InvalidCbor,
    NonCanonical,
    UnsupportedType,
    InvalidText,
    DuplicateKey,
    ResourceLimit,
    InvalidSchema,
    InvalidArtifactId,
}

/// A rejected encoded value or artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatError {
    /// Stable failure category.
    pub code: FormatErrorCode,
    message: String,
}

impl FormatError {
    fn new(code: FormatErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for FormatError {}

/// Logical inputs to the `project.genesis` schema 0 artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectGenesis {
    /// Public-safe, NFC project display name.
    pub name: String,
    /// Per-project cryptographically random value.
    pub nonce: [u8; 32],
    /// Initial owner's Ed25519 public key.
    pub actor_key: [u8; 32],
    /// UTC RFC 3339 timestamp with whole-second precision.
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Value {
    UInt(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Self>),
    Map(Vec<(String, Self)>),
    Bool(bool),
    Null,
}

fn is_nfc(value: &str) -> bool {
    value.nfc().eq(value.chars())
}

fn push_head(output: &mut Vec<u8>, major: u8, argument: u64) {
    match argument {
        0..=23 => output.push((major << 5) | u8::try_from(argument).expect("small argument")),
        24..=0xff => {
            output.push((major << 5) | 0x18);
            output.push(u8::try_from(argument).expect("uint8 argument"));
        }
        0x100..=0xffff => {
            output.push((major << 5) | 0x19);
            output.extend_from_slice(
                &u16::try_from(argument)
                    .expect("uint16 argument")
                    .to_be_bytes(),
            );
        }
        0x1_0000..=0xffff_ffff => {
            output.push((major << 5) | 0x1a);
            output.extend_from_slice(
                &u32::try_from(argument)
                    .expect("uint32 argument")
                    .to_be_bytes(),
            );
        }
        _ => {
            output.push((major << 5) | 0x1b);
            output.extend_from_slice(&argument.to_be_bytes());
        }
    }
}

fn encode_value(value: &Value) -> Result<Vec<u8>, FormatError> {
    let mut output = Vec::new();
    match value {
        Value::UInt(number) => push_head(&mut output, 0, *number),
        Value::Bytes(bytes) => {
            push_head(
                &mut output,
                2,
                u64::try_from(bytes.len()).map_err(|_| {
                    FormatError::new(FormatErrorCode::ResourceLimit, "byte string is too large")
                })?,
            );
            output.extend_from_slice(bytes);
        }
        Value::Text(text) => {
            if !is_nfc(text) {
                return Err(FormatError::new(
                    FormatErrorCode::InvalidText,
                    "text must already be Unicode NFC",
                ));
            }
            push_head(
                &mut output,
                3,
                u64::try_from(text.len()).map_err(|_| {
                    FormatError::new(FormatErrorCode::ResourceLimit, "text is too large")
                })?,
            );
            output.extend_from_slice(text.as_bytes());
        }
        Value::Array(values) => {
            push_head(
                &mut output,
                4,
                u64::try_from(values.len()).map_err(|_| {
                    FormatError::new(FormatErrorCode::ResourceLimit, "array is too large")
                })?,
            );
            for item in values {
                output.extend_from_slice(&encode_value(item)?);
            }
        }
        Value::Map(entries) => {
            let mut encoded_entries = Vec::with_capacity(entries.len());
            for (key, entry_value) in entries {
                let key_bytes = encode_value(&Value::Text(key.clone()))?;
                let value_bytes = encode_value(entry_value)?;
                encoded_entries.push((key, key_bytes, value_bytes));
            }
            encoded_entries.sort_by(|left, right| left.1.cmp(&right.1));
            if encoded_entries
                .windows(2)
                .any(|pair| pair[0].0 == pair[1].0)
            {
                return Err(FormatError::new(
                    FormatErrorCode::DuplicateKey,
                    "map contains duplicate keys",
                ));
            }
            push_head(
                &mut output,
                5,
                u64::try_from(encoded_entries.len()).map_err(|_| {
                    FormatError::new(FormatErrorCode::ResourceLimit, "map is too large")
                })?,
            );
            for (_, key_bytes, value_bytes) in encoded_entries {
                output.extend_from_slice(&key_bytes);
                output.extend_from_slice(&value_bytes);
            }
        }
        Value::Bool(false) => output.push(0xf4),
        Value::Bool(true) => output.push(0xf5),
        Value::Null => output.push(0xf6),
    }
    Ok(output)
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    items: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, FormatError> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(FormatError::new(
                FormatErrorCode::ResourceLimit,
                "artifact exceeds 1 MiB",
            ));
        }
        Ok(Self {
            bytes,
            offset: 0,
            items: 0,
        })
    }

    fn decode(mut self) -> Result<Value, FormatError> {
        let value = self.item(0)?;
        if self.offset != self.bytes.len() {
            return Err(FormatError::new(
                FormatErrorCode::InvalidCbor,
                "trailing bytes after CBOR item",
            ));
        }
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, FormatError> {
        let value = self.bytes.get(self.offset).copied().ok_or_else(|| {
            FormatError::new(FormatErrorCode::InvalidCbor, "unexpected end of input")
        })?;
        self.offset += 1;
        Ok(value)
    }

    fn argument(&mut self, additional: u8) -> Result<u64, FormatError> {
        if additional < 24 {
            return Ok(u64::from(additional));
        }
        if additional == 31 {
            return Err(FormatError::new(
                FormatErrorCode::UnsupportedType,
                "indefinite length is forbidden",
            ));
        }
        let width = match additional {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => {
                return Err(FormatError::new(
                    FormatErrorCode::InvalidCbor,
                    "reserved additional information",
                ));
            }
        };
        let mut value = 0_u64;
        for _ in 0..width {
            value = (value << 8) | u64::from(self.byte()?);
        }
        let minimum = match width {
            1 => 24,
            2 => 0x100,
            4 => 0x1_0000,
            8 => 0x1_0000_0000,
            _ => unreachable!(),
        };
        if value < minimum {
            return Err(FormatError::new(
                FormatErrorCode::NonCanonical,
                "non-shortest CBOR argument",
            ));
        }
        Ok(value)
    }

    fn length(value: u64) -> Result<usize, FormatError> {
        let value = usize::try_from(value).map_err(|_| {
            FormatError::new(FormatErrorCode::ResourceLimit, "CBOR length is too large")
        })?;
        if value > MAX_ARTIFACT_BYTES {
            return Err(FormatError::new(
                FormatErrorCode::ResourceLimit,
                "CBOR collection is too large",
            ));
        }
        Ok(value)
    }

    fn slice(&mut self, length: usize) -> Result<&'a [u8], FormatError> {
        let end = self.offset.checked_add(length).ok_or_else(|| {
            FormatError::new(FormatErrorCode::ResourceLimit, "CBOR length overflow")
        })?;
        let value = self.bytes.get(self.offset..end).ok_or_else(|| {
            FormatError::new(FormatErrorCode::InvalidCbor, "truncated CBOR value")
        })?;
        self.offset = end;
        Ok(value)
    }

    fn item(&mut self, depth: usize) -> Result<Value, FormatError> {
        if depth > 64 {
            return Err(FormatError::new(
                FormatErrorCode::ResourceLimit,
                "CBOR nesting exceeds 64",
            ));
        }
        self.items += 1;
        if self.items > 65_536 {
            return Err(FormatError::new(
                FormatErrorCode::ResourceLimit,
                "too many CBOR items",
            ));
        }
        let initial = self.byte()?;
        let major = initial >> 5;
        let additional = initial & 0x1f;
        if major == 7 {
            return match additional {
                20 => Ok(Value::Bool(false)),
                21 => Ok(Value::Bool(true)),
                22 => Ok(Value::Null),
                _ => Err(FormatError::new(
                    FormatErrorCode::UnsupportedType,
                    "unsupported simple or floating-point value",
                )),
            };
        }
        if matches!(major, 1 | 6) {
            return Err(FormatError::new(
                FormatErrorCode::UnsupportedType,
                "negative integers and tags are forbidden",
            ));
        }
        let argument = self.argument(additional)?;
        match major {
            0 => Ok(Value::UInt(argument)),
            2 => {
                let length = Self::length(argument)?;
                Ok(Value::Bytes(self.slice(length)?.to_vec()))
            }
            3 => {
                let length = Self::length(argument)?;
                let text = std::str::from_utf8(self.slice(length)?).map_err(|_| {
                    FormatError::new(FormatErrorCode::InvalidText, "text is not valid UTF-8")
                })?;
                if !is_nfc(text) {
                    return Err(FormatError::new(
                        FormatErrorCode::InvalidText,
                        "text must already be Unicode NFC",
                    ));
                }
                Ok(Value::Text(text.to_owned()))
            }
            4 => {
                let length = Self::length(argument)?;
                let mut values = Vec::with_capacity(length);
                for _ in 0..length {
                    values.push(self.item(depth + 1)?);
                }
                Ok(Value::Array(values))
            }
            5 => self.map(argument, depth),
            _ => Err(FormatError::new(
                FormatErrorCode::UnsupportedType,
                format!("CBOR major type {major} is forbidden"),
            )),
        }
    }

    fn map(&mut self, argument: u64, depth: usize) -> Result<Value, FormatError> {
        let length = Self::length(argument)?;
        let mut entries = Vec::with_capacity(length);
        let mut previous_key_bytes: Option<&[u8]> = None;
        for _ in 0..length {
            let key_start = self.offset;
            let key = self.item(depth + 1)?;
            let key_end = self.offset;
            let key_bytes = &self.bytes[key_start..key_end];
            let Value::Text(key) = key else {
                return Err(FormatError::new(
                    FormatErrorCode::UnsupportedType,
                    "map keys must be text",
                ));
            };
            if entries.iter().any(|(existing, _)| existing == &key) {
                return Err(FormatError::new(
                    FormatErrorCode::DuplicateKey,
                    format!("duplicate map key: {key}"),
                ));
            }
            if previous_key_bytes.is_some_and(|previous| previous >= key_bytes) {
                return Err(FormatError::new(
                    FormatErrorCode::NonCanonical,
                    "map keys are not in canonical order",
                ));
            }
            let value = self.item(depth + 1)?;
            entries.push((key, value));
            previous_key_bytes = Some(key_bytes);
        }
        Ok(Value::Map(entries))
    }
}

fn decode_canonical(bytes: &[u8]) -> Result<Value, FormatError> {
    let value = Decoder::new(bytes)?.decode()?;
    if encode_value(&value)? != bytes {
        return Err(FormatError::new(
            FormatErrorCode::NonCanonical,
            "CBOR bytes do not match deterministic re-encoding",
        ));
    }
    Ok(value)
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'Z'
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        std::str::from_utf8(&bytes[start..end])
            .ok()
            .and_then(|text| text.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(0, 4),
        number(5, 7),
        number(8, 10),
        number(11, 13),
        number(14, 16),
        number(17, 19),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&month)
        && (1..=days[usize::try_from(month - 1).expect("month index")]).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

fn validate_genesis(genesis: &ProjectGenesis) -> Result<(), FormatError> {
    if genesis.name.is_empty() || genesis.name.len() > 128 || !is_nfc(&genesis.name) {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "name must be NFC and 1-128 UTF-8 bytes",
        ));
    }
    if !valid_timestamp(&genesis.created_at) {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "created_at must be a valid UTC RFC 3339 second",
        ));
    }
    Ok(())
}

/// Encodes one schema-0 `project.genesis` artifact.
///
/// # Errors
///
/// Returns an error when an input violates the schema or canonical text limits.
pub fn encode_project_genesis(genesis: &ProjectGenesis) -> Result<Vec<u8>, FormatError> {
    validate_genesis(genesis)?;
    let payload = Value::Map(vec![
        ("name".into(), Value::Text(genesis.name.clone())),
        ("nonce".into(), Value::Bytes(genesis.nonce.to_vec())),
        ("policy_version".into(), Value::UInt(0)),
    ]);
    encode_value(&Value::Map(vec![
        ("format".into(), Value::Text("edgefossil-artifact".into())),
        ("version".into(), Value::UInt(0)),
        ("kind".into(), Value::Text("project.genesis".into())),
        ("schema".into(), Value::UInt(0)),
        ("realm".into(), Value::Text("public".into())),
        ("parents".into(), Value::Array(Vec::new())),
        ("actor_key".into(), Value::Bytes(genesis.actor_key.to_vec())),
        ("logical_clock".into(), Value::UInt(0)),
        ("created_at".into(), Value::Text(genesis.created_at.clone())),
        ("payload".into(), payload),
    ]))
}

fn map_get<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    entries
        .iter()
        .find_map(|(candidate, value)| (candidate == key).then_some(value))
}

fn expect_exact_keys(entries: &[(String, Value)], expected: &[&str]) -> Result<(), FormatError> {
    if entries.len() != expected.len()
        || entries
            .iter()
            .any(|(key, _)| !expected.contains(&key.as_str()))
    {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "fields do not match project.genesis schema 0",
        ));
    }
    Ok(())
}

/// Decodes and validates one schema-0 `project.genesis` artifact.
///
/// # Errors
///
/// Returns an error for malformed, non-canonical, unsupported, or schema-invalid
/// input.
pub fn decode_project_genesis(bytes: &[u8]) -> Result<ProjectGenesis, FormatError> {
    let Value::Map(envelope) = decode_canonical(bytes)? else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "artifact must be a map",
        ));
    };
    let envelope_keys = [
        "format",
        "version",
        "kind",
        "schema",
        "realm",
        "parents",
        "actor_key",
        "logical_clock",
        "created_at",
        "payload",
    ];
    expect_exact_keys(&envelope, &envelope_keys)?;
    let constants_valid = matches!(map_get(&envelope, "format"), Some(Value::Text(value)) if value == "edgefossil-artifact")
        && matches!(map_get(&envelope, "version"), Some(Value::UInt(0)))
        && matches!(map_get(&envelope, "kind"), Some(Value::Text(value)) if value == "project.genesis")
        && matches!(map_get(&envelope, "schema"), Some(Value::UInt(0)))
        && matches!(map_get(&envelope, "realm"), Some(Value::Text(value)) if value == "public")
        && matches!(map_get(&envelope, "parents"), Some(Value::Array(values)) if values.is_empty())
        && matches!(map_get(&envelope, "logical_clock"), Some(Value::UInt(0)));
    if !constants_valid {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "project.genesis envelope constants are invalid",
        ));
    }
    let Some(Value::Bytes(actor_key)) = map_get(&envelope, "actor_key") else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "actor_key must be bytes",
        ));
    };
    let Some(Value::Text(created_at)) = map_get(&envelope, "created_at") else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "created_at must be text",
        ));
    };
    let Some(Value::Map(payload)) = map_get(&envelope, "payload") else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "payload must be a map",
        ));
    };
    expect_exact_keys(payload, &["name", "nonce", "policy_version"])?;
    let (Some(Value::Text(name)), Some(Value::Bytes(nonce))) =
        (map_get(payload, "name"), map_get(payload, "nonce"))
    else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "payload values are invalid",
        ));
    };
    if !matches!(map_get(payload, "policy_version"), Some(Value::UInt(0))) {
        return Err(FormatError::new(
            FormatErrorCode::InvalidSchema,
            "policy_version must be 0",
        ));
    }
    let genesis = ProjectGenesis {
        name: name.clone(),
        nonce: nonce.as_slice().try_into().map_err(|_| {
            FormatError::new(FormatErrorCode::InvalidSchema, "nonce must be 32 bytes")
        })?,
        actor_key: actor_key.as_slice().try_into().map_err(|_| {
            FormatError::new(FormatErrorCode::InvalidSchema, "actor_key must be 32 bytes")
        })?,
        created_at: created_at.clone(),
    };
    validate_genesis(&genesis)?;
    Ok(genesis)
}

/// Computes the canonical text artifact identifier for already encoded bytes.
#[must_use]
pub fn artifact_id(canonical_body: &[u8]) -> String {
    let digest = Sha256::digest(canonical_body);
    format_artifact_id(&digest.into())
}

/// Formats one raw SHA-256 digest as a canonical artifact identifier.
#[must_use]
pub fn format_artifact_id(digest: &[u8; 32]) -> String {
    let mut identifier = String::with_capacity(71);
    identifier.push_str("sha256:");
    for byte in digest {
        use fmt::Write as _;
        write!(&mut identifier, "{byte:02x}").expect("writing to String cannot fail");
    }
    identifier
}

/// Parses one canonical artifact identifier into its raw SHA-256 digest.
///
/// # Errors
///
/// Returns an error for the wrong algorithm, length, case, or non-hexadecimal
/// text.
pub fn parse_artifact_id(value: &str) -> Result<[u8; 32], FormatError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(FormatError::new(
            FormatErrorCode::InvalidArtifactId,
            "artifact ID must use the sha256 algorithm prefix",
        ));
    };
    if hex.len() != 64
        || !hex
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(FormatError::new(
            FormatErrorCode::InvalidArtifactId,
            "artifact ID must contain 64 lowercase hexadecimal characters",
        ));
    }
    let mut digest = [0_u8; 32];
    for (output, pair) in digest.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
        let nibble = |byte| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        };
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            return Err(FormatError::new(
                FormatErrorCode::InvalidArtifactId,
                "artifact ID contains non-hexadecimal text",
            ));
        };
        *output = (high << 4) | low;
    }
    Ok(digest)
}
