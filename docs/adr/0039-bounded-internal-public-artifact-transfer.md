# ADR-0039: Bound and verify public artifact transfer before clone assembly

- Status: Accepted for P5a2a
- Date: 2026-08-25
- Owners: sync, storage, and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a1 exposes a stable anonymous inventory of public artifact IDs and kinds, but
an ID list is not a clone. The cloud authority stores canonical artifact bodies
and detached signatures, while the existing local importer accepts only a
complete verified realm bundle containing its manifest, refs, reachable blobs,
and signatures.

Returning bodies directly from inventory would mix snapshot reconciliation,
transfer budgets, graph closure, and local transactionality. It would also risk
advertising `TRANSFER` before replay and members-data non-disclosure are proven.

## Decision

Introduce two internal RepositoryDO RPC operations:

- `beginPublicTransfer()` captures one public-only snapshot boundary and policy
  epoch. The returned anchor starts before the first artifact and can also seed
  the existing internal inventory query.
- `publicArtifactTransfer()` accepts that snapshot and a strictly sorted,
  duplicate-free WANT set of 1–16 artifact IDs. It returns canonical artifact
  bodies and canonical detached-signature records up to 2 MiB per response.

Each lookup requires the same project, `anonymous` principal, protocol 0,
`public` view, current policy epoch, `realm='public'`, and an accepted sequence
at or below the captured snapshot. A members artifact, nonexistent artifact,
or artifact accepted after the snapshot returns the same generic
`artifact_unavailable` result.

Before returning a frame, the authority recomputes its artifact ID, reconstructs
the canonical signature record from stored actor/signature bytes, and verifies
the signature. Corrupt accepted storage fails closed. Because artifacts and
signature records are immutable and canonically encoded, retrying the same WANT
against the same snapshot returns byte-identical frames. A client can resume by
requesting only IDs it has not yet verified locally.

The start-of-snapshot anchor uses an empty `afterArtifactId` sentinel only on the
internal RPC boundary. Externally received inventory cursors remain encrypted;
no internal sequence or policy field is serialized by the current HTTP adapter.

## Scope boundary

This increment transfers artifact and detached-signature bytes only. It does not
transfer R2 blobs, refs, a bundle manifest, promised-blob metadata, or a complete
reachable graph. It does not call the Rust local importer and does not claim that
fresh clone/pull is complete.

There is no new HTTP route or advertised capability, cursor format, schema
migration, binding, secret, Cloudflare resource, R2 read/write, Queue event,
remote deployment, or production change.

## Consequences

- transfer requests and memory use have explicit application bounds;
- public and inaccessible IDs are indistinguishable at the transfer boundary;
- transfer is pinned to the same accepted-state and policy snapshot as internal
  inventory;
- integrity is checked at both the authority and eventual client boundaries;
- disconnect recovery needs no server-side session row;
- P5a2b must still define public ref/graph closure, blob transfer, bundle
  assembly, and atomic fresh local import.

## Verification

- a snapshot inventories and transfers exactly its public artifact set;
- a later public artifact is unavailable through the older snapshot;
- members, later, and nonexistent IDs return the same result;
- every returned body recomputes to its requested ID;
- every returned canonical signature verifies against its artifact actor;
- exact retry returns byte-identical bodies and signatures;
- empty, duplicate, unsorted, oversized, or malformed WANT input rejects;
- a policy epoch change makes the snapshot stale;
- schema remains 5 and the current HTTP/HELLO surface is unchanged.

## Current platform references

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Invoke Durable Object methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
