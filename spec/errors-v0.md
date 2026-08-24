# EdgeFossil verifier errors v0

Profile identifier: `edgefossil-errors-v0`

Verifiers return a stable `code` and MAY return a diagnostic message and field
location. Tests and protocol decisions depend only on the code. Diagnostics
must not echo restricted content into a less privileged response or log.

## Format and schema codes

| code                   | meaning                                                  |
| ---------------------- | -------------------------------------------------------- |
| `invalid_cbor`         | malformed/truncated CBOR or trailing bytes               |
| `non_canonical`        | valid shape with a non-deterministic byte representation |
| `unsupported_type`     | CBOR type forbidden by the v0 profile                    |
| `invalid_text`         | invalid UTF-8 or non-NFC text                            |
| `duplicate_key`        | duplicate text map key                                   |
| `resource_limit`       | input, nesting, collection, or item-count limit exceeded |
| `invalid_schema`       | exact artifact schema or field constraint failed         |
| `invalid_artifact_id`  | artifact ID text is not canonical v0 SHA-256 form        |
| `artifact_id_mismatch` | supplied ID differs from the hash of canonical bytes     |

## Path codes

The path validator uses `empty_path`, `path_too_long`, `non_nfc`,
`absolute_path`, `trailing_slash`, `empty_segment`, `dot_segment`,
`segment_too_long`, `control_character`, `forbidden_character`,
`trailing_dot_or_space`, and `windows_reserved_name`. Their precedence and
meaning are normative in [`path-v0.md`](path-v0.md).

## Graph codes reserved for I2

| code                         | meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `cross_project_reference`    | source and target project IDs differ                |
| `parent_realm_mismatch`      | history parent is not in the source realm           |
| `realm_flow_denied`          | content reference points to a more restricted realm |
| `unknown_required_semantics` | required kind/schema/profile is unsupported         |
| `invalid_logical_clock`      | actor clock or parent relationship is invalid       |
| `invalid_signature`          | required signature is absent or invalid             |
| `path_collision`             | tree contains conflicting portable names or realms  |

## Precedence

Validation proceeds through transport limit, canonical CBOR, exact schema,
claimed artifact ID, graph resolution, realm flow, logical clock, policy, and
signature. The first failing stage determines the public code. An authority MAY
record a more detailed restricted diagnostic but MUST NOT vary public errors in
a way that reveals whether a restricted target exists.
