# EdgeFossil canonical CBOR profile v0

Profile identifier: `edgefossil-cbor-v0`

## Purpose

Artifact identifiers are hashes of encoded bytes. Every conforming encoder
must therefore produce exactly the same bytes for the same value.

## Allowed data model

An EdgeFossil v0 value is one of:

- an unsigned integer in `0..=2^64-1`;
- a byte string;
- a valid UTF-8 text string normalized to Unicode NFC;
- a definite-length array of allowed values;
- a definite-length map whose keys are distinct NFC text strings and whose
  values are allowed values;
- `false`, `true`, or `null` only where an artifact schema explicitly permits
  that value.

Negative integers, floating-point values, `undefined`, other simple values,
CBOR tags, and indefinite-length items are forbidden. Artifact schemas SHOULD
prefer omission to nullable fields.

## Encoding

Encoders MUST implement RFC 8949 section 4.2.1 core deterministic encoding,
with the tighter data-model restrictions above:

1. Integer arguments and the lengths of byte strings, text strings, arrays,
   and maps use the shortest representation.
2. Every length is definite.
3. Map keys are ordered by bytewise lexicographic comparison of each key's
   deterministic CBOR encoding. This is the RFC 8949 core order, **not** the
   legacy length-first order from section 4.2.3.
4. No self-described-CBOR tag or other prefix is emitted. Exactly one top-level
   item is encoded.

Text-key-only maps make duplicate-key comparison exact: two keys are duplicates
when their normalized Unicode scalar sequences are equal.

## Decoding and rejection

A format decoder MUST:

1. reject malformed CBOR, trailing bytes, unsupported major/simple types,
   invalid UTF-8, non-NFC text, duplicate keys, and resource-limit violations;
2. validate the artifact schema, including unknown and missing fields;
3. deterministically re-encode the decoded value; and
4. reject it as `non_canonical` unless the re-encoded bytes equal the input.

Before schema validation, a v0 decoder MUST enforce these interoperable limits:

- encoded input is at most 1,048,576 bytes;
- nesting below the top-level item is at most 64 levels;
- the complete decoded value contains at most 65,536 items, counting map keys
  and values separately; and
- any declared byte string, text string, array, or map length is at most
  1,048,576 before allocation or iteration.

Schemas impose tighter field limits where needed. Implementations MAY apply a
smaller transport limit before claiming that an input is an artifact, but such
a deployment limit is not a different conformance result. Larger content
belongs in blobs.

## Hashing

For an artifact body `B` accepted by this profile:

```text
digest      = SHA-256(B)
artifact_id = "sha256:" || lowercase_hex(digest)
```

The text identifier is exactly 71 ASCII characters. Uppercase hexadecimal,
missing algorithm prefixes, abbreviated digests, and surrounding whitespace
are invalid. Signatures, attestations, and authority receipts are not part of
`B`.

## Normative reference

- [RFC 8949, section 4.2.1: Core Deterministic Encoding Requirements](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1)
