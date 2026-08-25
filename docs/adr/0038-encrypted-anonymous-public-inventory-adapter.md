# ADR-0038: Expose public inventory through encrypted short-lived cursors

- Status: Accepted for P5a1
- Date: 2026-08-25
- Owners: sync and security leads
- Decision deadline: complete
- Supersedes: none
- Superseded by: none

## Context

P5a0 established a bounded public inventory but deliberately kept its
continuation anchor inside the RepositoryDO. The anchor contains a public-only
snapshot high-water mark plus project, principal, view, protocol, and policy
bindings. Base64-encoding that object would expose receipt-sequence gaps and
would let a client alter snapshot or binding fields.

The first external adapter must remain anonymous for the public view, reject
ambiguous query strings, and avoid requiring another user-managed secret before
the protocol proves useful.

## Decision

Add two anonymous, read-only HTTP routes:

```text
GET /api/v0/sync/hello?protocol=0&view=public
GET /api/v0/inventory?project=...&protocol=0&view=public&limit=...&cursor=...
```

`cursor` is optional on the first inventory page. Query keys are allowlisted,
required exactly once, and parsed canonically. Inventory remains bounded to
1–1,000 entries. Both success and error responses use `Cache-Control: no-store`.

The RepositoryDO seals its internal anchor with AES-256-GCM using a random
96-bit nonce and fixed protocol-specific additional authenticated data. The
token is prefixed `efoss_cursor_v0_`, expires after 600 seconds, and contains
the project/principal/view/protocol/policy/snapshot binding only inside the
authenticated ciphertext. Malformed and authentication-failed tokens collapse
to the same `cursor_invalid` response. Policy changes produce `cursor_stale`.

The 256-bit cursor key is generated with Web Crypto only when a response first
needs a continuation token. It is stored under a namespaced row in the existing
RepositoryDO `edgefoss_meta` table. It is never returned by RPC, HTTP, logs, or
configuration. This avoids a new user-managed Cloudflare secret and keeps
schema version 5.

`HELLO` advertises only the implemented `HELLO`/`INVENTORY` phases, opaque
cursor semantics, 600-second TTL, ordering, and page maximum.

## Scope boundary

The adapter exposes artifact ID and kind only for artifacts already classified
`public`. It does not expose bodies, blob references, paths, sizes, receipt
sequences, totals, refs, members data, owner APIs, or credentials.

`AUTH`, `WANT`, `TRANSFER`, `ACK`, `DONE`, local import, and complete clone/pull
remain unimplemented. Cursor key rotation and a previous-key overlap window are
deferred until a rotation operation or restricted view requires them.

No schema migration, binding, Queue, R2 operation, or production change is part
of the local increment.

## Remote activation gate

Deploying this adapter makes staging public artifact IDs and kinds anonymously
enumerable. Before a remote deploy, the account owner must explicitly approve
that exposure. The owner must also approve the first paginated inventory probe,
which may persist exactly one random `sync_cursor_key_v0` meta row. No new
Cloudflare resource, secret, or credential is needed.

## Consequences

- internal snapshot fields and receipt gaps are confidential on the wire;
- cursor alteration is detected before inventory lookup;
- cursor replay is bounded by TTL and policy epoch;
- query ambiguity and unbounded pages fail closed;
- cursor key lifecycle belongs to the same single-project authority;
- staging activation needs an explicit public-data checkpoint even though no
  external infrastructure is added.

## Verification

- anonymous `HELLO` returns only implemented capabilities;
- public inventory excludes members artifacts across pages;
- ciphertext does not contain project or artifact ID text;
- tampering returns one generic `cursor_invalid` error;
- policy advance returns `cursor_stale`;
- an explicit future time returns `cursor_expired`;
- duplicate, unknown, empty, and over-limit query parameters reject;
- non-GET methods return `405` with `Allow: GET`;
- one cursor key row is created while schema remains 5;
- application error logs contain only path, never query or token.

## Current platform references

- [Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
