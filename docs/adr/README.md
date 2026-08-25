# Architecture decision records

ADRs capture decisions that constrain implementation or compatibility. Research notes may explore alternatives; an accepted ADR states the chosen boundary and consequences.

| ADR                                                                    | Title                                               | Status                           |
| ---------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------- |
| [0001](0001-state-layers.md)                                           | Separate portable, authority, and derived state     | Accepted                         |
| [0002](0002-artifact-id-text.md)                                       | Artifact ID text representation                     | Accepted for v0 candidate        |
| [0003](0003-canonical-artifact-hash.md)                                | SHA-256 over deterministic CBOR                     | Accepted for v0 candidate        |
| [0004](0004-realm-artifact-graph.md)                                   | Realm-separated artifact graph                      | Accepted for v0 candidate        |
| [0005](0005-single-do-authority.md)                                    | One RepositoryDO per project authority              | Accepted for first cloud profile |
| [0006](0006-r2-realm-separation.md)                                    | Separate public, restricted, and export R2 bindings | Accepted                         |
| [0007](0007-upload-verify-finalize.md)                                 | Upload, verify, then finalize                       | Accepted                         |
| [0008](0008-ref-compare-and-swap.md)                                   | Generation-based ref compare-and-swap               | Accepted                         |
| [0009](0009-portable-backup-vs-pitr.md)                                | Separate portable backup from authority PITR        | Accepted                         |
| [0010](0010-local-sqlite-foundation.md)                                | Strict transactional SQLite for local storage       | Accepted for local alpha         |
| [0011](0011-local-repository-cli-boundary.md)                          | Local repository CLI and filesystem boundary        | Accepted for local alpha         |
| [0012](0012-working-copy-tracking-intent.md)                           | Keep tracking intent device-local                   | Accepted for local alpha         |
| [0013](0013-realm-isolated-working-snapshots.md)                       | Build realm-isolated unsigned snapshots             | Accepted for local alpha         |
| [0014](0014-local-signed-realm-checkpoints.md)                         | Sign and advance realm checkpoints atomically       | Accepted for local alpha         |
| [0015](0015-realm-scoped-local-read-model.md)                          | Derive local reads from one realm                   | Accepted for local alpha         |
| [0016](0016-accepted-public-bundle-export-verification.md)             | Export and verify accepted public graph first       | Accepted for local alpha         |
| [0017](0017-explicit-composed-realm-bundles.md)                        | Compose restricted bundles from verified bases      | Accepted for local alpha         |
| [0018](0018-transactional-portable-bundle-import.md)                   | Reconstruct accepted SQLite state from bundles      | Accepted for local alpha         |
| [0019](0019-external-process-kill-sqlite-durability.md)                | Test SQLite recovery after external process kill    | Accepted for local alpha         |
| [0020](0020-reproducible-local-scale-baselines.md)                     | Separate constrained fixtures from timed commands   | Accepted for local alpha         |
| [0021](0021-deterministic-public-static-projection.md)                 | Project public bundles into paged static sites      | Accepted for single-static       |
| [0022](0022-assets-only-static-deployment-profile.md)                  | Keep static deployment scriptless and explicit      | Accepted for single-static       |
| [0023](0023-bounded-static-content-chunks.md)                          | Pack current text into bounded static chunks        | Accepted for single-static       |
| [0024](0024-reviewed-cloud-resource-manifest.md)                       | Review cloud resources before provisioning          | Accepted for P4a0                |
| [0025](0025-u2-gated-cloud-provisioning.md)                            | Gate idempotent provisioning on exact U2 approval   | Accepted for P4a0                |
| [0026](0026-minimal-single-project-stateful-topology.md)               | Start with one fixed SQLite Durable Object          | Accepted for P4a                 |
| [0027](0027-manual-main-only-staging-ci-deploy.md)                     | Gate staging CI deploy behind manual main execution | Accepted                         |
| [0028](0028-internal-small-blob-finalization-core.md)                  | Build upload core before exposing writes            | Accepted for P4b                 |
| [0029](0029-owner-authenticated-small-upload-adapter.md)               | Authenticate the first HTTP upload adapter          | Accepted for P4b                 |
| [0030](0030-transactional-canonical-artifact-publication.md)           | Publish canonical artifacts and refs atomically     | Accepted for P4c                 |
| [0031](0031-owner-authenticated-canonical-publish-adapter.md)          | Expose bounded owner artifact publication           | Accepted for P4c                 |
| [0032](0032-transactional-authority-outbox-and-bounded-alarm-drain.md) | Persist and drain authority events safely           | Accepted for P4d                 |
| [0033](0033-owner-only-outbox-observation-and-single-event-smoke.md)   | Observe delivery without exposing events            | Accepted for P4d                 |
| [0034](0034-staging-first-queue-activation.md)                         | Activate the first Queue path in staging            | Accepted for P4d                 |
| [0035](0035-bounded-queue-failure-matrix.md)                           | Bound app failures without faking DLQ delivery      | Accepted for P4d                 |
| [0036](0036-owner-policy-epoch-linearization-fence.md)                 | Linearize publish against a policy epoch fence      | Accepted for P4e                 |
| [0037](0037-internal-public-sync-inventory-snapshot.md)                | Page an internal public sync snapshot               | Accepted for P5a0                |

Use [the ADR template](0000-template.md) for new decisions. Accepted decisions can be superseded but are not rewritten to hide their original rationale.
