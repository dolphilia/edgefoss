# ADR 0013: Build realm-isolated unsigned working snapshots before checkpoints

- Status: accepted
- Date: 2026-08-24
- Decision owners: core, local CLI, storage, and format maintainers
- Applies to: I3d local repository alpha

## Context

I3c records which working-copy paths should have project, local, or no history,
but it intentionally does not read content. The next slice needs to prove that
the same tracking decisions can produce portable raw-blob IDs and canonical
tree artifacts without allowing restricted content to perturb the public root.

A snapshot is not yet a historical change. Creating changes, advancing refs,
and signing require private-key lifecycle and causal-clock decisions that should
be exercised together in the following checkpoint increment.

## Decision

- `ef snapshot` enumerates only non-`none` exact/prefix tracking selections and
  reevaluates every discovered path using exact-first, longest-prefix rules.
- Regular file bytes become raw SHA-256 blobs. Executable mode is preserved on
  Unix. Directories become canonical schema-0 trees in child-before-parent
  order. Symbolic-link targets remain tree-entry text and create no blob.
- Public, members, and local inputs build independent tree roots. The local
  adapter requires each working tree to reference blobs and child trees owned
  by that same realm. Identical bytes in different realms have the same logical
  digest but separate `(project, realm, digest)` SQLite rows.
- SQLite schema version 3 adds realm-owned blobs and one unsigned working root
  per realm. Objects and all new roots are validated and committed in one
  `IMMEDIATE` transaction. A failed replacement leaves every old root visible.
  Removed roots are cleared together; content-addressed objects are retained for
  later reuse and garbage collection.
- Tree metadata uses the genesis actor, logical clock zero, and genesis
  timestamp. This deliberately makes identical unsigned tree content stable
  across later scans. Actual capture time is separate operational metadata on
  `working_snapshot_roots`; future signed changes carry their own event time and
  causal clock.
- The filesystem adapter does not follow symbolic-link directory entries. It
  rejects lexical symlink targets that escape the repository and verifies that
  tracked directories canonicalize below the repository root.
- File reads compare path/open-file identity and metadata before and after the
  bounded read. The I3d alpha limit is 16 MiB per file; large-blob handling stays
  in its planned later increment.
- `ef status` reports the three current working roots. These roots are local
  staging state and are not refs, checkpoints, semantic roots, or export heads.

## Consequences

- A members-only content change cannot alter the public working root, and local
  bytes cannot become a dependency of a project tree.
- Blob/tree identity is verified again at the storage boundary rather than
  trusting the builder.
- Empty directories explicitly reached by a tracking prefix are representable.
- Unchanged trees deduplicate despite repeated snapshots because their portable
  metadata is stable. Capture time remains inspectable without changing IDs.
- SQLite holds blob bytes in this local-alpha slice. R2 separation and opaque
  restricted physical keys remain remote-authority concerns.
- Snapshot does not produce signed history, diff semantics, tombstones, refs,
  portable policy, bundle export, or cleanup of unreachable objects.

## Residual risks and deferred work

- Metadata comparisons detect ordinary concurrent edits but do not claim a
  complete defense against a malicious process racing directory operations.
  Descriptor-relative traversal and platform-specific filesystem probes belong
  to hardening before trusted checkout/dogfooding.
- The portable path profile detects ASCII collision keys. Snapshot construction
  does not yet probe additional case/normalization collisions of the target
  filesystem.
- Tracking a non-existing ignore target and pruning an ignored subtree before
  enumeration remain policy/ignore work.

## Rejected alternatives

- Create and sign a change during `snapshot`: rejected because observation and
  intentional history publication need distinct review and key boundaries.
- Build one complete tree and filter it for public output: rejected because
  restricted paths, IDs, counts, and content could affect public identity.
- Cross-realm blob rows keyed only by digest: rejected because physical
  deduplication would weaken the realm separation required by later storage.
- Use wall-clock capture time inside every tree: rejected because rescanning an
  unchanged public realm after a members-only edit would churn the public root.

## Verification

Core tests cover deduplicated raw blobs, executable entries, child-first trees,
realm-root independence, and portable/path-structure collisions. Storage tests
cover realm-isolated duplicate bytes, atomic root replacement, object retention,
ID/dependency validation, rollback, and schema migration. CLI subprocess tests
cover a three-realm snapshot, ignored content, members-only root changes,
status roots, and escaping-symlink rollback.
