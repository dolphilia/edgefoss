# ADR-0026: Start the cloud authority with one fixed SQLite Durable Object

- Status: Accepted for P4a
- Date: 2026-08-25
- Owners: cloud lead, core lead
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

The approved staging resources now exist, but the `RepositoryDO` namespace can
only be reconciled by deploying a Worker. P4a needs to prove the smallest
stateful topology before blob upload, artifact acceptance, authentication, or
asynchronous delivery is added. Activating a Queue consumer before its event
contract and idempotent handler exist would risk acknowledging or dead-lettering
messages without applying the intended projection.

The first cloud profile is the Single Edition. It has one project authority and
does not need a project registry or a routing Durable Object.

## Decision

The dynamic Worker uses one deterministic Durable Object name,
`edgefoss-single-project-v0`, behind the `REPOSITORY` binding. Its class is a
declarative `exports` entry with `state: created` and `storage: sqlite`; legacy
Durable Object migrations are not used. The first lookup supplies the approved
best-effort `apac-ne` location hint and no jurisdiction restriction.

`RepositoryDO` synchronously creates a strict `edgefoss_meta` table and records
schema version 1 with `INSERT OR IGNORE`. Its initial RPC surface contains only
`health()`. `GET /health` traverses the Worker-to-DO RPC boundary and reports
the schema version, SQLite storage, Single Edition, and the presence of the
three realm-separated R2 bindings. `HEAD /health` performs the same dependency
check without returning a body. Responses use `Cache-Control: no-store` and do
not reveal bucket names, Durable Object IDs, account data, or credentials.

`PUBLIC_BLOBS`, `RESTRICTED_BLOBS`, and `EXPORTS` are explicit non-inheritable
bindings in every Wrangler environment. Production uses its own names and has
`workers.dev` disabled. The provisioned Queue and DLQ remain unbound until P4d
defines the outbox event contract, retry behavior, and idempotent consumer.

## Alternatives considered

- Add a registry Durable Object now. Rejected because a fixed name is sufficient
  for the approved one-project edition and avoids a second coordination point.
- Use a random Durable Object ID. Rejected because every Worker instance must
  route the Single Edition to the same authority without storing another ID.
- Use legacy `migrations`. Rejected because the current declarative class export
  owns namespace lifecycle and exactly matches the reviewed manifest.
- Enable the Queue consumer in P4a. Rejected because its safe processing contract
  belongs to P4d; creating a Queue does not require consuming from it immediately.
- Probe R2 by writing sentinel objects from `/health`. Rejected because a health
  read must not create application data. Resource existence and privacy are
  checked separately by read-only `cloud:verify`.

## Consequences

The first staging health request creates the fixed Durable Object instance and
initializes its SQLite schema. Subsequent construction and health calls are
idempotent. The deployment proves Worker routing, DO namespace reconciliation,
SQLite access, and binding topology without implementing a partial publish path.

The R2 portion of `/health` is a configuration assertion, not an object-level
read/write test. P4b will provide real staging, verification, and finalize
operations. Queue resources remain idle until P4d.

## Verification

- Workers Vitest calls the public health route and `RepositoryDO.health()` twice;
- generated types resolve the DO RPC namespace and all three R2 bindings;
- staging and production Wrangler dry-runs list the exact environment-specific
  DO and R2 bindings;
- read-only `cloud:verify` reports all three staging buckets private, both Queues
  ready, and the DO pending only the Worker deployment;
- the first remote deployment and health smoke are deferred until this change is
  committed and GitHub Actions is green.

References:

- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
