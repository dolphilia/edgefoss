# ADR-0043: Preflight public push against one bounded authority snapshot

- Status: Accepted for P5b0 local implementation
- Date: 2026-08-26
- Owners: sync, protocol, and cloud authority leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4 already provides idempotent owner-only blob upload and artifact publication,
but a local repository has no sync contract for deciding what the cloud lacks
or which policy epoch and ref generation must fence its later writes. Blindly
replaying a complete bundle wastes requests and still leaves the client to
guess the current authority state.

The first P5b increment must not expose a partially specified write protocol.
It should establish the authority-side planning boundary without adding an HTTP
route, credential, schema migration, binding, or remote mutation.

## Decision

Add an internal RepositoryDO RPC for protocol 0 public push preflight. The
caller supplies one project ID and sorted, unique inventories of at most 256
artifact IDs and 256 blob IDs. The only admitted principal, realm, and protocol
are `owner`, `public`, and `0`.

Within one synchronous SQLite transaction, the RPC returns:

- artifact and finalized public-blob IDs absent from the authority;
- the current stored project ID or `null` before genesis;
- policy epoch and accepted repository sequence;
- the current public `heads/main` target and generation, or `null`;
- the exact inventory bounds.

An initialized authority for another project returns only
`project_conflict`. Malformed, duplicate, unsorted, or oversized input returns
the stable `push_preflight_invalid` result. Repeating the same preflight without
intervening writes is byte-equivalent.

This snapshot is advisory, not a lease. Every later upload, artifact publish,
policy check, and ref compare-and-swap remains authoritative and must revalidate
its own input. Existing P4 operation IDs provide mutation deduplication; the
preflight itself has no operation ID because it writes nothing.

## Atomicity boundary

The project fence, missing-object lookup, meta values, and ref are read inside
one RepositoryDO SQLite transaction. Durable Object request serialization and
SQLite transactional storage make this a coherent authority observation. No
result reserves a generation or prevents another writer from advancing policy
or refs after the transaction ends.

## Scope boundary

P5b0 is internal and public-realm-only. It does not add `AUTH` or `PUBLISH` to
HTTP `HELLO`, an HTTP preflight route, a Rust network client, members push,
pagination, upload orchestration, operation-ID derivation, or automatic
conflict resolution. It changes no schema, binding, secret, Queue, R2 object,
staging state, or production state.

## Consequences

- a future client can avoid already finalized blobs and accepted artifacts;
- project mismatch fails before any write or authority inventory disclosure;
- current policy/ref fences come from the same observation;
- per-ID SQLite lookups are bounded but not yet suitable for million-object
  inventories, so larger bundles will require pages;
- a successful preflight never implies that a later CAS or policy check will
  succeed.

## Verification

- an empty authority reports all requested IDs missing and a null project/ref;
- after canonical publication and blob finalization, only an unknown ID remains;
- the snapshot reports exact sequence, policy epoch, head, and generation;
- exact retry returns the same result;
- another project returns only `project_conflict`;
- duplicate, unsorted, malformed, and 257-item input is rejected;
- the full local gate and named staging/production dry-runs pass before commit.
