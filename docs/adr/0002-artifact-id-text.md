# ADR-0002: Artifact ID text representation

- Status: Accepted for v0 candidate
- Date: 2026-08-24
- Owners: core/format lead
- Decision deadline: G1
- Supersedes: none
- Superseded by: none

## Context

The binary artifact ID is the 32-byte SHA-256 digest of the canonical artifact body. CLI output, SQLite keys, JSON APIs, bundles, logs used in safe test fixtures, and sync messages also need one portable textual representation. The representation must be identical in Rust and TypeScript, sortable as bytes under ordinary binary collation, unambiguous about its algorithm, and easy to validate without locale behavior.

## Decision

The v0 canonical text form is:

```text
sha256:<64 lowercase hexadecimal digits>
```

Rules:

- The prefix is exactly ASCII `sha256:`.
- The payload is exactly 64 characters from `[0-9a-f]` and represents 32 digest bytes in big-endian display order.
- Parsers reject uppercase, missing prefixes, whitespace, separators, abbreviations, and non-canonical encodings.
- APIs and persistent text columns emit only this canonical form.
- In-memory code uses a fixed-size digest type rather than an unchecked string.
- Prefix matching may be a user-interface convenience only after ambiguity checks; abbreviated IDs never enter artifacts or protocol messages.

This ADR specifies representation, not authorization. Restricted artifact IDs remain restricted information and must not be exposed merely because their encoding is standardized.

## Alternatives considered

- **Unprefixed hex**: simple but prevents explicit algorithm agility and makes type confusion easier.
- **Base32**: shorter and case-insensitive variants exist, but requires choosing and policing an alphabet/padding profile across runtimes.
- **Base64url**: compact but lexical order differs from digest-byte order and canonical padding rules are less visually obvious.
- **Multihash/multibase**: extensible but adds dependencies and format surface before a second algorithm is justified.

## Consequences

- IDs are 71 ASCII characters and larger than base32/base64 alternatives.
- Validation is small and consistent across Rust, TypeScript, SQLite constraints, and shell tooling.
- A future digest algorithm receives a new explicit prefix and a compatibility decision; existing SHA-256 IDs do not change.

## Verification

G1 vectors must include all-zero/all-`ff` digests, leading-zero bytes, uppercase rejection, wrong length, bad prefix, invalid characters, and Rust/TypeScript encode/decode round trips.
