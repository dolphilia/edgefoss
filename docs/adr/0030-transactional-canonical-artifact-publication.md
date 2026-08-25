# ADR-0030: Publish canonical artifacts and refs atomically

- Status: Accepted for P4c
- Date: 2026-08-25
- Owners: cloud and protocol leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4b established an authenticated, finalized blob record before an artifact can
refer to it. P4c must now preserve the portable CBOR identity and Ed25519
signature rules while making artifact acceptance, operation dedupe, authority
ordering, and realm-head compare-and-swap one linearizable authority decision.
Performing any of those writes in separate requests would permit visible
artifacts with missing content, lost ref updates, or different results after a
lost response.

## Decision

RepositoryDO application schema 4 adds authority metadata and strict SQLite
tables for canonical artifacts, edges, attestations, receipts, realm refs, and
publish operations. The first slice exposes only a typed internal
`publishArtifact` RPC; it does not add a public HTTP publish route.

Before entering the SQLite transaction, the Worker:

1. bounds the artifact at the protocol's 1 MiB limit and the signature record
   at 1 KiB;
2. decodes canonical CBOR with the shared `@edgefoss/protocol` implementation;
3. recomputes the artifact ID and accepts only registered genesis, tree, and
   change schema 0 artifacts;
4. rejects the local realm and non-cloud refs;
5. verifies the separate Ed25519 signature against the envelope actor key; and
6. computes a request hash bound to the principal, artifact, signature, policy
   epoch, and ref expectation.

One synchronous `transactionSync()` then performs:

```text
global operation-ID collision check
  -> stored operation replay or request conflict
  -> current policy epoch check
  -> project identity and bootstrap owner-key check
  -> finalized blob and accepted artifact reference checks
  -> heads/main generation CAS
  -> artifact, edge, attestation, and receipt insertion
  -> realm ref update
  -> repo sequence update
  -> operation result storage
```

Genesis fixes the single deployment's project ID and bootstrap owner Ed25519
key. Until ACL artifacts are implemented, later cloud artifacts must use that
same actor key and the authenticated principal remains `owner`. Public content
may resolve only public dependencies. Members content may resolve public or
members content, while change parents and roots remain in the change's own
realm.

The initial named-ref surface is deliberately one ref per realm,
`heads/main`. An absent ref requires expected generation 0. A successful create
returns generation 1; later updates require an exact generation and increment
it. There is no last-write-wins fallback.

Accepted results and policy/ref conflicts are stored for exact operation retry.
A repeated operation with different input returns `operation_conflict`.
Repairable prerequisite failures such as a missing finalized blob return a
typed rejection but do not consume the operation ID, so the client can satisfy
the prerequisite and retry the same request. Expected rejections cross the RPC
boundary as data rather than uncaught exceptions.

## Alternatives considered

- Validate portable objects separately in the Worker and trust a decoded input
  in the DO: rejected because the authority must share the executable canonical
  profile and bind the request hash to the verified identity.
- Insert an artifact before attempting ref CAS: rejected because a stale ref
  request must not partially accept an otherwise unreachable artifact.
- Automatically overwrite a stale ref: rejected by ADR-0008 because it loses a
  concurrent history.
- Add HTTP publication and a remote synthetic project immediately: deferred
  until schema 4 migration is independently healthy, matching the P4b rollout
  pattern.
- Enable Queue/outbox now: deferred to P4d; no consumer is added by this schema.

## Consequences

The Worker now imports the workspace protocol package directly, ensuring local
and cloud validation use the same canonical implementation. Duplicate tree
references are stored with set semantics. JavaScript-safe authority counters
are checked before increment, while portable uint64 logical clocks are stored
as decimal text to avoid SQLite-to-JavaScript precision loss.

The next deployment migrates the existing staging authority from schema 3 to
4 and updates the exact health audit. It creates no project artifact, advances
no ref, performs no R2 write, and enables no Queue consumer. An authenticated
HTTP adapter and bounded remote publish smoke remain a later P4c increment.

## Verification

- signed genesis, finalized public blob, tree, and change are accepted in
  authority sequence;
- the same accepted operation returns the exact result 100 times;
- operation reuse with different ref input conflicts;
- stale policy and ref results are stable across retry;
- two concurrent generation-1 updates yield one generation-2 acceptance and
  one stable conflict;
- missing blobs leave no artifact or operation residue and the same request can
  succeed after finalization;
- public artifacts cannot identify members-only blobs;
- a non-genesis actor key and invalid signature are rejected;
- duplicate references to one blob do not violate edge uniqueness.

## Current platform references

- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects best practices](https://developers.cloudflare.com/durable-objects/best-practices/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
