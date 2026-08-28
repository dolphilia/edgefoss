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
4. [`realm-v0.md`](realm-v0.md)
5. [`policy-v0.md`](policy-v0.md)
6. [`errors-v0.md`](errors-v0.md)
7. [`graph-v0.md`](graph-v0.md)
8. [`signature-v0.md`](signature-v0.md)
9. [`semantic-root-v0.md`](semantic-root-v0.md)
10. [`bundle-v0.md`](bundle-v0.md)
11. [`push-v0.md`](push-v0.md)
12. [`sync-v0.md`](sync-v0.md)

Machine-readable valid and invalid examples live in [`vectors/`](vectors/).
Rust and TypeScript implementations MUST consume the same files rather than
copying expected values into language-specific tests.

[`vectors/public-clone-v0.json`](vectors/public-clone-v0.json) is an integration
vector rather than a new wire schema. It captures the exact signed
`edgefossil-bundle` output produced by the Workers complete-clone profile and
consumed by the Rust SQLite importer. Its `fresh_push_plan` is independently
reconstructed by Rust and executed by the Workers runtime.

## Compatibility rule

An implementation advertises the exact profiles it accepts. A decoder MUST
reject an unknown profile or schema version; it MUST NOT guess, silently drop
unknown fields, or reinterpret bytes under a newer schema. Adding an optional
field therefore requires a new artifact schema even when the enclosing CBOR
profile is unchanged.

For a registered kind and schema, missing or unknown fields are
`invalid_schema`. An unknown kind, schema, or required profile is
`unknown_required_semantics`. An implementation MAY retain the original bytes
in an explicitly opaque quarantine for forwarding or later upgrade, but this is
not acceptance: it MUST NOT publish them, resolve refs through them, include
them in a semantic root, or report their signature as accepted. Reprocessing
after an implementation upgrade starts validation again from the original
bytes.
