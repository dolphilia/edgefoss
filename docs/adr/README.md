# Architecture decision records

ADRs capture decisions that constrain implementation or compatibility. Research notes may explore alternatives; an accepted ADR states the chosen boundary and consequences.

| ADR                                     | Title                                               | Status                           |
| --------------------------------------- | --------------------------------------------------- | -------------------------------- |
| [0001](0001-state-layers.md)            | Separate portable, authority, and derived state     | Accepted                         |
| [0002](0002-artifact-id-text.md)        | Artifact ID text representation                     | Accepted for v0 candidate        |
| [0003](0003-canonical-artifact-hash.md) | SHA-256 over deterministic CBOR                     | Accepted for v0 candidate        |
| [0004](0004-realm-artifact-graph.md)    | Realm-separated artifact graph                      | Accepted for v0 candidate        |
| [0005](0005-single-do-authority.md)     | One RepositoryDO per project authority              | Accepted for first cloud profile |
| [0006](0006-r2-realm-separation.md)     | Separate public, restricted, and export R2 bindings | Accepted                         |
| [0007](0007-upload-verify-finalize.md)  | Upload, verify, then finalize                       | Accepted                         |
| [0008](0008-ref-compare-and-swap.md)    | Generation-based ref compare-and-swap               | Accepted                         |
| [0009](0009-portable-backup-vs-pitr.md) | Separate portable backup from authority PITR        | Accepted                         |
| [0010](0010-local-sqlite-foundation.md) | Strict transactional SQLite for local storage       | Accepted for local alpha         |

Use [the ADR template](0000-template.md) for new decisions. Accepted decisions can be superseded but are not rewritten to hide their original rationale.
