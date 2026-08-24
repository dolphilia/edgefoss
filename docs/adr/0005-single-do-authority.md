# ADR-0005: One RepositoryDO per project authority

- Status: Accepted for first cloud profile
- Date: 2026-08-24
- Owners: cloud lead
- Decision deadline: D2
- Supersedes: none
- Superseded by: none

## Context

Artifact acceptance must serialize ACL revocation, operation deduplication, blob verification, ref updates, receipts, projections, and outbox insertion. A stateless Worker plus eventually consistent storage cannot provide that order without a coordination authority.

## Decision

The first writable cloud profile uses one SQLite-backed `RepositoryDO` for one project. The project is the coordination atom; this is not one global Durable Object shared by unrelated projects. A future Multi Edition keeps one RepositoryDO per project and routes by portable project identity.

The stateless Edge Worker handles bounded request parsing, authentication envelope validation, routing, and response formatting. The RepositoryDO:

- exposes typed RPC methods;
- owns authority SQLite state and synchronous transactional mutations;
- routes deterministically from portable project identity;
- persists correctness-critical state before using in-memory caches;
- uses constructor concurrency blocking only for bounded schema initialization;
- uses alarms to drain a transactional outbox idempotently.

External R2/network I/O is not held inside a canonical SQLite transaction. Upload verification occurs before an acceptance transaction, and transaction-time checks confirm the verified record still matches.

## Alternatives considered

- D1 as first write authority: rejected because concurrent project mutations require explicit coordination beyond a relational database.
- R2-only CAS authority: retained as a research profile, not the first correctness path.
- One DO per ref/file: rejected initially because atomic artifact/ref/ACL/projection changes would span authorities.

## Consequences

- A project has a serialized write path and measurable per-project throughput ceiling.
- Independent projects can scale across separate DO instances in a future multi-project deployment.
- D2 may reject this profile based on measured latency, cost, or growth, while portable format remains unchanged.
- SQLite schema migration and RPC compatibility become explicit operational concerns.

## Verification

P4 tests duplicate/lost responses, concurrent publish/revoke, ref conflict, missing blobs, Queue outage, alarm retries, migration, overload, and fresh-instance behavior in local runtime and remote staging.
