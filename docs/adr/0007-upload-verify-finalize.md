# ADR-0007: Upload, verify, then finalize

- Status: Accepted
- Date: 2026-08-24
- Owners: cloud lead
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

R2 upload success, checksum validation, RepositoryDO acceptance, and HTTP response are separate failure boundaries. Publishing an artifact before its bytes are durably present and verified can create permanently visible missing content. Retrying after a lost response can create duplicates or conflicting state.

## Decision

Blob publication is a state machine keyed by an idempotent `operation_id`:

```text
declared → staged → verified → finalized → referenced
                    ↘ rejected/orphaned
```

1. The client declares expected realm, SHA-256, size, media policy, and operation ID.
2. Bytes are uploaded to a non-visible staging key, through a Worker binding initially and direct multipart capability only if P7 adopts it.
3. The service verifies size and application SHA-256; multipart ETag is never treated as content identity.
4. Finalization records an immutable realm-specific physical key and verified state idempotently.
5. A canonical publish transaction accepts references only to matching finalized records.

Lost responses and repeated finalize requests return the stored operation result. Orphan staging/final objects remain unreachable and are removed only after a grace-period cleanup.

## Alternatives considered

- Publish metadata before upload: rejected because visible state may reference missing bytes.
- Trust client hash or multipart ETag: rejected because neither proves the intended complete bytes.
- Delete every failed upload immediately: rejected because retries and concurrent requests make immediate deletion unsafe.

## Consequences

- Blob availability has explicit intermediate states and cleanup work.
- Small and multipart uploads share acceptance semantics even when transfer mechanisms differ.
- Quota reservation, expiration, and cleanup are part of P7 rather than hidden request behavior.

## Verification

Failure injection covers disconnects before/after each state transition, corrupt size/hash, duplicate operation IDs, finalize response loss, concurrent cleanup, and attempts to publish staged/unverified blobs.
