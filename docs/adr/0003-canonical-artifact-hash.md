# ADR-0003: SHA-256 over deterministic CBOR

- Status: Accepted for v0 candidate
- Date: 2026-08-24
- Owners: core/format lead
- Decision deadline: G1
- Supersedes: none
- Superseded by: none

## Context

Rust, TypeScript, local storage, cloud authority, sync, and offline verification must derive one artifact identity from one logical body. Hashing language-native JSON or database rows would make identity depend on key order, number handling, Unicode behavior, or physical storage.

## Decision

For v0:

```text
artifact_id = SHA-256(deterministic_cbor(artifact_body))
```

The deterministic CBOR profile follows RFC 8949 core deterministic encoding and additionally:

- uses definite-length arrays, maps, byte strings, and text strings only;
- uses shortest integer and length encodings;
- orders map keys by their deterministic encoded bytes as required by the profile;
- rejects duplicate keys, floats, indefinite-length items, and tags unless a later schema explicitly permits one;
- accepts only valid UTF-8 text; domain schemas define normalization and portability rather than silently normalizing during encoding;
- excludes signatures, authority receipts, server sequence, physical storage keys, and derived projections from the artifact body;
- includes schema/kind version, project identity, and realm identity in the body.

SHA-256 is the only digest generated for v0. Text form follows ADR-0002.

## Alternatives considered

- Canonical JSON: rejected because integer/byte representation and canonicalization dependencies add ambiguity.
- BLAKE3: fast, but not available through standard Web Crypto and would add a second implementation path.
- Hashing an envelope containing signatures/receipts: rejected because authority migration or additional signatures would change portable identity.

## Consequences

- The encoder is security- and compatibility-critical and is implemented independently in Rust and TypeScript.
- Decoders preserve unknown non-required artifacts but reject unknown required semantics at the applicable boundary.
- Profile changes require a schema/format version; deployed artifacts are never silently rehashed.

## Verification

G1 requires cross-language valid/invalid vectors for ordering, integer boundaries, duplicate keys, invalid UTF-8, indefinite lengths, forbidden floats/tags, unknown fields, and corrupted digests.
