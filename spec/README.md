# EdgeFossil v0 specifications

Status: **experimental draft**. These documents are normative for the v0
walking skeleton, but compatibility is not promised until the G1 gate is
accepted.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described by BCP 14 when they appear in capitals.

Read the documents in this order:

1. [`canonical-cbor-v0.md`](canonical-cbor-v0.md)
2. [`artifact-v0.md`](artifact-v0.md)
3. [`path-v0.md`](path-v0.md)
4. [`policy-v0.md`](policy-v0.md)
5. [`semantic-root-v0.md`](semantic-root-v0.md)

Machine-readable valid and invalid examples live in [`vectors/`](vectors/).
Rust and TypeScript implementations MUST consume the same files rather than
copying expected values into language-specific tests.

## Compatibility rule

An implementation advertises the exact profiles it accepts. A decoder MUST
reject an unknown profile or schema version; it MUST NOT guess, silently drop
unknown fields, or reinterpret bytes under a newer schema. Adding an optional
field therefore requires a new artifact schema even when the enclosing CBOR
profile is unchanged.
