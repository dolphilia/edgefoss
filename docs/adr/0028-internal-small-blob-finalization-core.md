# ADR-0028: Build the small-blob finalization core before exposing writes

- Status: Accepted for P4b
- Date: 2026-08-25
- Owners: cloud lead
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4a established one fixed SQLite `RepositoryDO` and separate public and
restricted R2 bindings. P4b must prove staging, checksum verification,
write-once finalization, and retry behavior. The staging Worker is publicly
reachable, but owner authentication and scoped write capabilities are not yet
implemented. Exposing an unauthenticated upload route merely to exercise the
state machine would create a public mutation surface.

## Decision

Implement the first P4b slice as internal typed `RepositoryDO` RPC methods and
Workers runtime integration tests. Do not add an HTTP write route yet.

- `beginUpload` accepts only `public` or `members`, a lowercase SHA-256 blob ID,
  a UUID operation ID, and an integer size no larger than 16 MiB.
- Reusing an operation ID with the same request returns the same upload. Reuse
  with different input returns a machine-readable conflict.
- Random staging keys include the fixed Single Edition authority and realm.
- Finalize reads through the realm's R2 binding, pins the staged ETag, checks
  the bounded byte length, computes application SHA-256, and terminally rejects
  mismatches.
- Public final keys are project-scoped and content-addressed. Members final keys
  are random and never reveal the blob digest.
- Final R2 writes use a checksum and an `If-None-Match: *` equivalent condition.
  A losing concurrent writer verifies the existing object instead of
  overwriting it.
- SQLite chooses one canonical realm/blob row transactionally. Repeated or
  concurrent finalize calls return the stored result.
- Staging objects and losing final objects remain unreachable. Grace-period
  cleanup belongs to the later cleanup slice.

The repository application schema advances from 1 to 2. Existing schema 1
instances create `upload_sessions` and `blobs` tables before recording version 2. Unknown future schema versions fail closed.

## Alternatives considered

- Add `POST /api/v0/uploads` immediately: rejected until owner authentication
  can protect every mutation.
- Trust the client hash or multipart ETag: rejected; neither is the application
  SHA-256 identity.
- Use a hash-bearing key for members blobs: rejected because restricted object
  names must not become an existence oracle.
- Overwrite an existing final key: rejected; retries and concurrency must not
  silently replace accepted bytes.

## Consequences

The core state machine can be tested with real local DO and R2 bindings without
creating remote data or credentials. A later authenticated HTTP adapter can
map the typed results without changing storage semantics. The current small
path buffers at most 16 MiB for Web Crypto verification; larger and multipart
objects remain outside P4b and must use a streaming/direct-upload design.

## Verification

- a fresh local schema reports version 2;
- the existing staging schema 1 instance must upgrade and report version 2 at
  the remote deployment gate;
- identical declaration retry returns one upload;
- operation reuse with different input returns conflict;
- public and members bytes finalize only in their configured buckets;
- checksum mismatch is terminal and creates no reachable final row;
- response-loss retry and concurrent finalize return one stored result;
- no new public HTTP write route exists.
