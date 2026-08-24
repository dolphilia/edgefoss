# EdgeFossil experimental realm bundle v0

Profile identifier: `edgefossil-bundle-v0`

Status: experimental candidate. A v0 bundle is a directory containing one
realm's portable state. Directory packaging (tar, zip, or transport framing) is
not semantic; unpacked path names and file bytes are.

## Isolation and composition

One bundle has exactly one `realm`. Its inventories contain only objects owned
by that realm. A `public` bundle is independently restorable. A `members` bundle
requires the exact public semantic root recorded in `base_roots`; a `local`
bundle requires exact public and members roots. Importers MUST verify bases
before resolving cross-realm content references.

Required `base_roots` keys are therefore exact:

| bundle realm | keys                |
| ------------ | ------------------- |
| `public`     | none                |
| `members`    | `public`            |
| `local`      | `public`, `members` |

This design never requires copying restricted objects into a less restricted
bundle. A complete project export is the verified composition of its available
realm bundles, not a fourth mixed-realm bundle profile.

## Directory layout

The root contains exactly `manifest.cbor` plus inventoried object files:

```text
manifest.cbor
artifacts/<64-lowercase-hex>.cbor
blobs/<64-lowercase-hex>.bin
signatures/<64-lowercase-hex>.cbor
```

The filename digest is SHA-256 of the exact file bytes. Artifact filenames are
also their artifact IDs. Blob filenames identify raw blob bytes. Signature
filenames are storage digests of canonical signature-record bytes; they do not
change the signed artifact ID. Symlinks, alternate spellings, unlisted files,
and missing listed files are errors.

## Manifest schema 0

`manifest.cbor` uses `edgefossil-cbor-v0` and has exactly:

| field            | type              | rule                                                |
| ---------------- | ----------------- | --------------------------------------------------- |
| `format`         | text              | `edgefossil-bundle`                                 |
| `version`        | uint              | `0`                                                 |
| `experimental`   | bool              | `true`                                              |
| `project`        | bytes             | 32-byte `project.genesis` digest                    |
| `realm`          | text              | one built-in realm                                  |
| `policy_version` | uint              | portable uint64 policy version                      |
| `semantic_root`  | bytes             | claimed 32-byte root for this exact realm state     |
| `artifacts`      | array of bytes    | owned artifact digests                              |
| `blobs`          | array of bytes    | owned raw-blob digests                              |
| `signatures`     | array of bytes    | signature-record storage digests                    |
| `refs`           | map text → bytes  | selected realm ref names to owned artifact digests  |
| `base_roots`     | map realm → bytes | exact less-restricted semantic roots required above |

Each inventory has at most 65,535 entries, is strictly sorted by raw digest,
and rejects duplicates. Ref constraints are those of
`edgefossil-semantic-root-v0`; a ref target occurs in `artifacts`.

The manifest is not itself inventoried and does not receive an artifact ID.
Changing operational archive metadata therefore cannot change portable state.

## Verification order

A reader performs these steps without publishing partial state:

1. reject unsafe or non-exact directory paths;
2. decode canonical `manifest.cbor` and its exact schema;
3. validate realm, base-root shape, inventories, refs, and IDs;
4. require every inventoried file and reject every unlisted file;
5. SHA-256 each object and compare it with its filename/inventory digest;
6. decode known artifact/signature schemas and validate their project, realm,
   graph, blob, and signature relationships in the composed base view;
7. recompute this realm's semantic root from `artifacts`, `refs`, and
   `policy_version`; and
8. stage the complete verified result before one atomic import commit.

Steps 1–5 are container verification. Steps 6–8 are repository import
verification. Passing the former does not authorize an artifact or prove that a
required base bundle is present.

## Error mapping

- absent listed file: `missing_bundle_object`;
- unlisted file: `unexpected_bundle_object`;
- object digest mismatch: `bundle_object_mismatch`;
- recomputed realm root mismatch: `semantic_root_mismatch`.

Malformed manifest fields use the existing CBOR/schema/ID errors. Readers MUST
not disclose restricted filenames or contents through a less privileged error
surface.

## Shared fixture

[`vectors/bundle-v0.json`](vectors/bundle-v0.json) is a virtual directory for a
minimal public project containing only `project.genesis`. It fixes the manifest
bytes and object path and includes container/root failure mutations. The
standalone reader under `tools/` consumes this file without importing either
production codec.
