# Architecture decision records

ADRs capture decisions that constrain implementation or compatibility. Research notes may explore alternatives; an accepted ADR states the chosen boundary and consequences.

| ADR                                                        | Title                                               | Status                           |
| ---------------------------------------------------------- | --------------------------------------------------- | -------------------------------- |
| [0001](0001-state-layers.md)                               | Separate portable, authority, and derived state     | Accepted                         |
| [0002](0002-artifact-id-text.md)                           | Artifact ID text representation                     | Accepted for v0 candidate        |
| [0003](0003-canonical-artifact-hash.md)                    | SHA-256 over deterministic CBOR                     | Accepted for v0 candidate        |
| [0004](0004-realm-artifact-graph.md)                       | Realm-separated artifact graph                      | Accepted for v0 candidate        |
| [0005](0005-single-do-authority.md)                        | One RepositoryDO per project authority              | Accepted for first cloud profile |
| [0006](0006-r2-realm-separation.md)                        | Separate public, restricted, and export R2 bindings | Accepted                         |
| [0007](0007-upload-verify-finalize.md)                     | Upload, verify, then finalize                       | Accepted                         |
| [0008](0008-ref-compare-and-swap.md)                       | Generation-based ref compare-and-swap               | Accepted                         |
| [0009](0009-portable-backup-vs-pitr.md)                    | Separate portable backup from authority PITR        | Accepted                         |
| [0010](0010-local-sqlite-foundation.md)                    | Strict transactional SQLite for local storage       | Accepted for local alpha         |
| [0011](0011-local-repository-cli-boundary.md)              | Local repository CLI and filesystem boundary        | Accepted for local alpha         |
| [0012](0012-working-copy-tracking-intent.md)               | Keep tracking intent device-local                   | Accepted for local alpha         |
| [0013](0013-realm-isolated-working-snapshots.md)           | Build realm-isolated unsigned snapshots             | Accepted for local alpha         |
| [0014](0014-local-signed-realm-checkpoints.md)             | Sign and advance realm checkpoints atomically       | Accepted for local alpha         |
| [0015](0015-realm-scoped-local-read-model.md)              | Derive local reads from one realm                   | Accepted for local alpha         |
| [0016](0016-accepted-public-bundle-export-verification.md) | Export and verify accepted public graph first       | Accepted for local alpha         |
| [0017](0017-explicit-composed-realm-bundles.md)            | Compose restricted bundles from verified bases      | Accepted for local alpha         |
| [0018](0018-transactional-portable-bundle-import.md)       | Reconstruct accepted SQLite state from bundles      | Accepted for local alpha         |
| [0019](0019-external-process-kill-sqlite-durability.md)    | Test SQLite recovery after external process kill    | Accepted for local alpha         |
| [0020](0020-reproducible-local-scale-baselines.md)         | Separate constrained fixtures from timed commands   | Accepted for local alpha         |
| [0021](0021-deterministic-public-static-projection.md)     | Project public bundles into paged static sites      | Accepted for single-static       |
| [0022](0022-assets-only-static-deployment-profile.md)      | Keep static deployment scriptless and explicit      | Accepted for single-static       |
| [0023](0023-bounded-static-content-chunks.md)              | Pack current text into bounded static chunks        | Accepted for single-static       |
| [0024](0024-reviewed-cloud-resource-manifest.md)           | Review cloud resources before provisioning          | Accepted for P4a0                |

Use [the ADR template](0000-template.md) for new decisions. Accepted decisions can be superseded but are not rewritten to hide their original rationale.
