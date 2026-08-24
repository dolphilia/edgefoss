# ADR-0008: Generation-based ref compare-and-swap

- Status: Accepted
- Date: 2026-08-24
- Owners: core and cloud leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

Offline clients and multiple devices can update the same branch/checkpoint ref concurrently. Last-write-wins based on request arrival or client timestamp silently discards a valid history and is vulnerable to clock skew.

## Decision

A realm ref contains at least `(realm_id, name, target_artifact_id, generation)`. Mutation supplies the expected generation and proposed target:

- matching generation updates target and increments generation atomically;
- absent ref creation requires the explicit initial expectation;
- stale expectation returns a typed conflict with current generation and an authorized current target;
- no automatic last-write-wins fallback exists.

Artifact insertion, referenced-blob checks, ACL/policy epoch validation, ref CAS, receipt, projection update, operation-result storage, and outbox insert occur in one RepositoryDO SQLite transaction. `repo_seq` orders authority receipts but is not part of portable artifact identity.

## Alternatives considered

- Client timestamp LWW: rejected because clocks and malicious timestamps are not an authority order.
- Request arrival LWW: rejected because a lost response/retry can overwrite unseen work.
- Distributed locks held by clients: rejected because disconnects and lease recovery complicate correctness.

## Consequences

- Clients must surface, retain, merge, or explicitly abandon conflicts.
- Retry of the same operation returns its original accepted/rejected result.
- Public responses cannot include a restricted current target when reporting a conflict.

## Verification

P4 races publish/publish and revoke/publish at transaction boundaries. P5 runs two-device offline conflicts in both synchronization orders and verifies that neither artifact disappears.
