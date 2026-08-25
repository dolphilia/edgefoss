# ADR-0036: Close G4 with an owner policy-epoch linearization fence

- Status: Accepted for P4e
- Date: 2026-08-25
- Owners: authority and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P4d completed the transactional outbox and bounded Queue failure matrix, but G4
still requires an ACL revocation and a concurrent publish to linearize into one
authority order. The current Single Edition authority deliberately exposes only
the `owner` principal; member invitations, credential revocation, and the full
ACL artifact model belong to later realm and identity work.

The schema 4 publish transaction already compares every request's expected
policy epoch with the authority's current `policy_epoch`. What was missing was
an authority mutation that advances that epoch atomically and remembers its own
operation result.

## Decision

Add an internal `RepositoryDO.advancePolicyEpoch()` RPC as a revocation-class
fence. Its input contains exactly the owner principal, an operation ID, and the
expected current epoch. In one synchronous SQLite transaction it:

1. rejects an operation ID already used by upload or publish;
2. rejects mutation before project initialization without storing residue;
3. returns the stored result for an exact retry;
4. stores a stable policy conflict when the expected epoch is stale;
5. otherwise increments the policy epoch exactly once and stores the accepted
   result.

Policy operation records use namespaced rows in the existing generic
`edgefoss_meta` key/value table. This avoids changing schema version 5 merely to
prove the ordering primitive. Upload and publish also reject operation IDs
already used by a policy mutation, preserving a global operation namespace.

A publish accepted before the fence remains canonical at its recorded epoch. A
publish that reaches the transaction after the fence carries a stale epoch and
returns a stable `policy_conflict`. No already accepted artifact, receipt, ref,
or outbox event is retroactively deleted.

## Scope boundary

This fence models the ordering effect required by revocation; it is not the full
member ACL model and does not claim to revoke a concrete member credential.
There is deliberately no HTTP route. The first increment is internal RPC plus
Workers runtime tests only, with no migration, remote deploy, Queue/R2 change,
new secret, or new Cloudflare resource.

When member ACL artifacts are implemented, their accepted mutation must advance
the same epoch in the same authority transaction. The temporary meta-backed
operation record can then migrate to a typed policy-operation table without
changing the externally visible replay semantics.

## Consequences

- publish and revocation-class policy changes share the RepositoryDO's single
  coordination order;
- stale offline publishes fail closed instead of crossing a revocation fence;
- retry results remain stable even after later policy changes;
- the operation ID namespace remains shared across upload, publish, and policy
  mutation;
- P5 does not need to invent authorization ordering during sync.

## Verification

- 100 exact policy-operation retries return one accepted epoch advance;
- changed input with the same operation ID returns `operation_conflict`;
- a stale policy operation keeps its original conflict after later advances;
- a concurrent publish and fence produce only a valid before-or-after result;
- a fence completed before publish rejects the stale publish;
- canonical artifacts accepted before the fence remain intact;
- no HTTP route, schema version, binding, or remote resource changes.

## Current platform references

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Invoke Durable Object methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
