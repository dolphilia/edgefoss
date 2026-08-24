# ADR-0010: Start local storage with strict transactional SQLite

- Status: Accepted for local alpha
- Date: 2026-08-24
- Owners: core and storage leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P2 needs a crash-resistant local authority that preserves canonical artifact
bytes without coupling portable state to Cloudflare. The first slice only needs
repository identity and genesis persistence, but it must establish a migration
and transaction pattern that later blob, ref, and working-copy tables can
follow.

Using the host SQLite library would make local/CI behavior depend on the
operator's installed version. Adding all forecast P2 tables in migration 1
would instead freeze constraints before their write invariants are executable.

## Decision

Create `ef-store-sqlite` with `rusqlite` 0.40.2 and its `bundled` feature. Pin
the resolved SQLite implementation in `Cargo.lock` and use numbered SQL files
embedded in the binary.

Schema version 1 contains only:

- a migration ledger;
- one singleton repository identity row; and
- immutable canonical artifact rows keyed by raw 32-byte SHA-256 digests.

Tables are `STRICT`. Digest length, realm, schema version, and 1 MiB artifact
limits are checked in SQLite as defense in depth. The genesis artifact and
repository identity reference each other through deferred foreign keys and are
inserted in one `IMMEDIATE` transaction.

Every connection enables foreign keys, WAL journal mode, `synchronous=FULL`,
`trusted_schema=OFF`, and a five-second busy timeout. Initialization is
idempotent only for byte-identical genesis state; another project is rejected
and rolled back. Reads recompute the artifact ID, decode the canonical schema,
and verify stored project/realm/kind/schema metadata.

Blob, ref, policy, and working-copy tables are deliberately deferred to the
increment that implements their invariants. They will be additive numbered
migrations rather than edits to migration 1.

## Alternatives considered

- System SQLite: rejected because local and CI feature/version behavior would
  vary by machine.
- A custom file format: rejected because transaction, recovery, indexing, and
  migration machinery would have to be rebuilt before SCM behavior.
- One forecast schema for all P2 features: rejected because unexercised columns
  and constraints would become accidental compatibility commitments.
- Store artifact IDs as text primary keys: rejected because the portable text
  form is reconstructible and raw digests are smaller and unambiguous.

## Consequences

- The initial bundled SQLite dependency increases compile time and binary size.
- Portable bundle/artifact formats remain independent of physical SQL layout.
- WAL sidecar handling is operational state and never appears in exports.
- Each later migration needs transaction, reopen, corruption, and recovery
  tests before use by a command.

## Verification

I3a tests migration of an empty database, shared-vector genesis identity,
idempotent initialization, rollback on a second project, metadata corruption
detection, WAL/foreign-key/FULL settings, reopen persistence, and
`PRAGMA quick_check`.

- [rusqlite 0.40.2 package](https://crates.io/crates/rusqlite/0.40.2)
- [rusqlite documentation](https://docs.rs/rusqlite/0.40.2/rusqlite/)
